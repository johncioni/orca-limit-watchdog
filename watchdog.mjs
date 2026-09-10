#!/usr/bin/env node
// orca-watchdog — detects rate-limited Orca agent terminals and sends a
// resume prompt after the limit resets. Zero dependencies. See README.md.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runObservedCheck, atomicWriteFile, readRegularSync } from './lib/operations.mjs';
import { appendActivity, maintainLogs } from './lib/logs.mjs';

export const RESUME_TEXT = 'Session rate limit has reset. Resume where you left off.';

const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'orca-watchdog');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOCK_FILE = path.join(STATE_DIR, 'lock');
const DISABLED_FILE = path.join(STATE_DIR, 'disabled');

const ORCA = process.env.ORCA_CLI
  || (fs.existsSync('/usr/local/bin/orca') ? '/usr/local/bin/orca' : 'orca');

const MIN = 60_000;
export const OUTAGE_RESUME_TEXT = 'The API outage appears to be over. Resume where you left off.';

// Per-kind schedule (spec §4). bufferMs: wait past resetAt before sending;
// rearmMs: banner still present this long after a send = failed attempt;
// deadlineMs: give up this long after detection regardless of attempts.
export const SCHEDULE = Object.freeze({
  limit: Object.freeze({ bufferMs: 2 * MIN, retrySpacingMs: 30 * MIN, rearmMs: 10 * MIN, maxSends: 3, deadlineMs: null,
    resumeText: RESUME_TEXT }),
  outage: Object.freeze({ bufferMs: 0, retrySpacingMs: 30 * MIN, rearmMs: 10 * MIN, maxSends: 6, deadlineMs: 24 * 60 * MIN,
    initialDelayMs: 10 * MIN, resumeText: OUTAGE_RESUME_TEXT }),
  'limit-open': Object.freeze({ bufferMs: 0, retrySpacingMs: 30 * MIN, rearmMs: 10 * MIN,
    maxSends: 6, deadlineMs: 24 * 60 * MIN, resumeText: RESUME_TEXT }),
});
const KINDS = Object.keys(SCHEDULE);
const PLATFORMS = ['claude', 'codex', 'unknown'];
const STATUSES = ['waiting', 'resumed', 'gave_up', 'awaiting-user', 'dismissed'];
const GRACE_PAST_MS = 2 * 60 * MIN; // absolute time this recently past = already reset
// A still-present limit banner whose parsed reset jumps at least this much LATER
// than the stored one is honoured before a due send (DOG-24). Above any sub-tick
// reparse jitter of a counting-down relative banner; only a real shift trips it.
const RESET_REFRESH_MIN_MS = 5 * MIN;
const TAIL_LINES = 15;
const READ_BUDGET_MS = 3 * MIN;    // stop reading terminals before the 4-min tick deadline
const READ_CONCURRENCY = 4;        // parallel `terminal read`s per tick; orca serialises beyond a few

// --- pure logic (unit-tested) ---

// `\d{1,4}` (not `\d+`) so a pathological long-digit line cannot backtrack
// super-linearly against `[- ]hour` and stall the shared event loop (DOG-24);
// no real banner states a five-digit hour count. Window lines are also length-
// capped before any regex runs (see WINDOW_LINE_MAX / toWindow).
const LIMIT_RE = /((usage|rate|session|weekly|daily|\d{1,4}[- ]hour)\s+limit|quota)/i;
const REACHED_RE = /(reached|hit|exceeded)/i;
const RESET_RE = /(resets?\b|try again|available|come back)/i;
const VETO_RE = /approaching[^\n]*limit/i;

// Claude Code's persistent status footer ("Context … │ Usage … (resets in 3h 8m)")
// is on screen in every Claude terminal and always satisfies RESET_RE. It is
// chrome, never evidence: dropped before the limit rule runs.
const FOOTER_RE = /│\s*Usage\s/;

// CSI (ESC [ … final), OSC (ESC ] … BEL|ST), charset selects (ESC ( B),
// two-byte escapes (ESC = > 7 8 c D E H M N O Z), and stray C0/DEL bytes.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78cDEHMNOZ]|[\x00-\x08\x0b-\x1f\x7f]/g;
export function stripAnsi(s) { return String(s).replace(ANSI_RE, ''); }

// Credential shapes redacted from every logged terminal fragment. The last
// pattern (32+ opaque chars, no "/") also catches raw JWT/API-key material we
// have no prefix for; ordinary words and short git hashes are far below that
// length, and "/" is excluded so a long path is not swallowed as one run.
const SECRET_RES = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bBearer\s+\S+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(?<![/\w])[A-Za-z0-9+=_-]{32,}(?![/\w])/g,
];
// A secret-shaped field name (key/token/secret/password/…) followed by = or :
// and a value. Redacts the VALUE only (keeping the name), which catches opaque,
// slash-bearing tokens the length/prefix rules above deliberately skip to spare
// filesystem paths — a path has no such field name before it (DOG-24).
const SECRET_ASSIGN_RE = /\b([\w.-]*(?:key|token|secret|password|passwd|pwd|credential)[\w.-]*)(\s*[=:]\s*)(\S+)/gi;
export function sanitize(text, limit = 200) {
  let s = stripAnsi(text).replace(/\s+/g, ' ').trim();
  for (const re of SECRET_RES) s = s.replace(re, '[redacted]');
  s = s.replace(SECRET_ASSIGN_RE, (_m, name, sep) => `${name}${sep}[redacted]`);
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

// Outage banners are platform-owned TUI shapes; there is deliberately no
// generic rule. `platforms` gates which terminal identities a row applies to.
const OUTAGE_PATTERNS = [
  { id: 'claude-api-error', platforms: ['claude', 'unknown'],
    re: /^(⎿\s*)?API Error: (5\d\d\b|Connection error\b|.*\boverloaded_error\b)/i },
  { id: 'codex-api-error', platforms: ['codex'],
    // Codex TUI history marker "■" (a U+200A hair space may follow) + one of its
    // fixed error texts (codex-rs/protocol/src/error.rs). 429 is the rate-limit
    // path and deliberately not listed.
    re: /^■\s*(stream disconnected before completion\b|We're currently experiencing high demand\b|Selected model is at capacity\b|exceeded retry limit, last status: 5\d\d\b|Error while reading the server response\b|Connection failed:|unexpected status 5\d\d\b|request timed out\b)/ },
];
const RETRY_RE = /retrying in \d|attempt \d+\s*(\/|of)\s*\d+|Reconnecting\.\.\. (\d+\/\d+|waiting for network)|esc to interrupt/i;
// Lines allowed AFTER the error for it to count as the final, stalled banner.
const CHROME_RES = [
  /^$/,
  /^[─│╭╮╰╯┃━┌┐└┘├┤⎿\s]+$/,
  /^>(\s.*)?$/,
  /^›(\s+Ask Codex to do anything)?\s*$/,
  /^\d+% context left$/,
  /^Context \d+% used\b/,
  /^─+\s*Worked for [^─]*─+$/,
  /^⎿/,
  /^(\? for shortcuts|Press |Esc |esc |Retry|⏵|⏸|✗|✓)/,
];
const isChrome = (l) => CHROME_RES.some((re) => re.test(l));
// The Claude usage footer ("Context … │ Usage … (resets in …)") is the bottom
// line of every Claude terminal, printed below the input box. It is chrome, not
// the agent moving on, so the final-block checks that decide whether a banner is
// still the stalled last thing on screen must tolerate it (DOG-24).
const isTrailingChrome = (l) => isChrome(l) || FOOTER_RE.test(l);
const lastIndex = (arr, pred) => { let i = -1; arr.forEach((x, j) => { if (pred(x)) i = j; }); return i; };

export function shouldLog(level, env = process.env) {
  return level !== 'debug' || Boolean(env.WATCHDOG_DEBUG);
}

// runtime_unavailable is Orca's structured "not running"; a bare "Command failed"
// is the CLI erroring without JSON (daemon socket churn after an Orca update).
// Both mean "nothing to observe this tick", not a watchdog fault.
export function isUnavailableError(e) {
  return e?.code === 'runtime_unavailable' || /^Command failed:/.test(e?.message ?? '');
}

export function readBudgetExceeded(startedAt, now) {
  return now - startedAt > READ_BUDGET_MS;
}

// Untrusted terminal content: cap each line before any regex runs so a single
// enormous line cannot make a scan super-linear. Banners are short (bannerText
// is capped at 600); this bound is far above any legitimate one (DOG-24).
const WINDOW_LINE_MAX = 2000;
const toWindow = (lines) => lines.slice(-TAIL_LINES).map((l) => stripAnsi(l).trim().slice(0, WINDOW_LINE_MAX));

export function hasOutageLine(lines) {
  const window = toWindow(lines);
  return OUTAGE_PATTERNS.some((p) => window.some((l) => p.re.test(l)));
}

// Named Codex limit forms, bounded to three physical lines below. Only the
// time clause admits clock/date text; another sentence cannot join the block.
const CODEX_429_RE = /^■\s*exceeded retry limit, last status: 429\b/;
const CODEX_TIME = String.raw`(?:[A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})? )?(?:\d{1,2}(?::\d{2})?(?: ?[ap]\.?m\.?)?)`;
const CODEX_TRY = `try again at ${CODEX_TIME}\\.?`;
const CODEX_LIMIT_FORMS = [
  new RegExp(`^■\\s*exceeded retry limit, last status: 429(?: Too Many Requests)?(?:[.]? ${CODEX_TRY})?$`, 'i'),
  new RegExp(`^■\\s*You've hit your usage limit\\.(?: Upgrade to Pro \\(https?://\\S+\\), visit https?://\\S+ to purchase more credits(?: or ${CODEX_TRY})?\\.?| ${CODEX_TRY})?$`, 'i'),
  /^■\s*usage limit reached, try again later\.?$/i,
];

export function detectBanner(lines, platform = 'unknown', now = new Date()) {
  const window = toWindow(lines);
  const codexCandidate = (l) => platform === 'codex' && /^■\s*/.test(l)
    && (CODEX_429_RE.test(l) || (LIMIT_RE.test(l) && REACHED_RE.test(l)));
  const c = lastIndex(window, codexCandidate);
  let codexLimit = null;
  if (c >= 0 && !VETO_RE.test(window[c]) && lastIndex(window, (l) => RETRY_RE.test(l)) < c) {
    for (let end = c; end < Math.min(c + 3, window.length); end++) {
      const block = window.slice(c, end + 1).join(' ');
      if (!CODEX_LIMIT_FORMS.some((re) => re.test(block))) continue;
      if (!window.slice(end + 1).every(isChrome)) continue;
      const resetAt = parseResetTime(block, now)?.toISOString() ?? null;
      const kind = resetAt ? 'limit' : 'limit-open';
      codexLimit = { kind, resetAt, bannerText: sanitize(block, 600), matchedLine: window[c],
        patternId: kind, index: resetAt ? end : c };
      break;
    }
  }

  // --- limit rule (unchanged semantics; now on stripped lines) ---
  // Drop soft "approaching … limit" warning lines first, so such a warning can
  // neither be mistaken for a reached-banner nor veto a genuine reached-banner
  // that happens to share the same 15-line window (per-line veto, not whole-window).
  const kept = window.filter((l) => !VETO_RE.test(l) && !FOOTER_RE.test(l));
  const text = kept.join('\n');
  let limit = null;
  // The limit phrase and the reached word must sit on ONE line: a banner says
  // "usage limit reached"; prose and logs scatter the words across lines.
  const reachedLine = (l) => LIMIT_RE.test(l) && REACHED_RE.test(l);
  if (c < 0 && kept.some(reachedLine) && RESET_RE.test(text)) {
    const isRelevant = (l) => !VETO_RE.test(l) && !FOOTER_RE.test(l) && (LIMIT_RE.test(l) || RESET_RE.test(l));
    const l = lastIndex(window, isRelevant);
    // Same final-block guard the Codex limit and outage rules use: a banner the
    // agent already scrolled past (ordinary output between it and an idle empty
    // box) is stale and must not re-fire a resume send (DOG-24).
    if (window.slice(l + 1).every(isTrailingChrome)) {
      limit = { kind: 'limit', bannerText: sanitize(window.filter(isRelevant).join(' | '), 600),
        matchedLine: window[l], patternId: 'limit', index: l };
    }
  }

  if (codexLimit) limit = codexLimit;

  // --- outage rule ---
  let outage = null;
  for (const p of OUTAGE_PATTERNS) {
    if (!p.platforms.includes(platform)) continue;
    const e = lastIndex(window, (l) => p.re.test(l));
    if (e < 0) continue;
    if (lastIndex(window, (l) => RETRY_RE.test(l)) >= e) continue;   // still retrying
    if (!window.slice(e + 1).every(isTrailingChrome)) continue;       // stale: agent moved on
    outage = { kind: 'outage', bannerText: sanitize(window[e], 200),
      matchedLine: window[e], patternId: p.id, index: e };
    break;
  }

  const pick = (limit && outage) ? (limit.index >= outage.index ? limit : outage) : (limit ?? outage);
  if (!pick) return null;
  const { index, ...banner } = pick;
  return banner;
}

export function inferPlatform(terminal, banner = null) {
  const id = terminal?.agentIdentity;
  if (id === 'claude' || id === 'codex') return id;
  if (banner?.patternId === 'claude-api-error') return 'claude';
  if (banner?.patternId === 'codex-api-error') return 'codex';
  return 'unknown';
}

export function newEvent(o, now, newEpisodeId = randomUUID) {
  const kind = o.banner.kind;
  const resetAt = kind === 'outage'
    ? new Date(now.getTime() + SCHEDULE.outage.initialDelayMs)
    : kind === 'limit-open' ? now
    : o.banner.resetAt ? new Date(o.banner.resetAt)
    : (parseResetTime(o.banner.bannerText, now) ?? new Date(now.getTime() + 60 * MIN));
  return {
    handle: o.handle, kind, platform: o.platform ?? 'unknown', bannerText: o.banner.bannerText,
    detectedAt: now.toISOString(), resetAt: resetAt.toISOString(),
    attempts: 0, lastAttemptAt: null, status: kind === 'limit-open' ? 'awaiting-user' : 'waiting',
    alertedAt: null, ...(kind === 'limit-open' ? { episodeId: newEpisodeId() } : {}),
  };
}

const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

// Returns the first violation as a string, or null when the event is valid (spec §3).
export function validateEvent(key, ev) {
  if (!ev || typeof ev !== 'object') return 'event: not an object';
  if (typeof ev.handle !== 'string' || ev.handle === '' || ev.handle !== key) return 'handle: must equal its key';
  if (!KINDS.includes(ev.kind)) return `kind: ${ev.kind}`;
  if (!PLATFORMS.includes(ev.platform)) return `platform: ${ev.platform}`;
  if (ev.kind === 'outage' && ev.platform === 'unknown') return 'platform: outage requires a known platform';
  if (!STATUSES.includes(ev.status)) return `status: ${ev.status}`;
  if (['awaiting-user', 'dismissed'].includes(ev.status) && ev.kind !== 'limit-open') return 'status: requires limit-open';
  if (ev.kind === 'limit-open') {
    if (ev.platform !== 'codex') return 'platform: limit-open requires codex';
    if (typeof ev.episodeId !== 'string' || !ev.episodeId.trim()) return 'episodeId: required';
    if (ev.status === 'awaiting-user' && ev.attempts !== 0) return 'attempts: awaiting-user requires zero';
  } else if (ev.episodeId !== undefined) return 'episodeId: only legal for limit-open';
  if (ev.alertedAt !== null && !isIso(ev.alertedAt)) return 'alertedAt: not null or a timestamp';
  if (typeof ev.bannerText !== 'string') return 'bannerText: not a string';
  if (!isIso(ev.detectedAt)) return 'detectedAt: not a timestamp';
  if (!isIso(ev.resetAt)) return 'resetAt: not a timestamp';
  const max = SCHEDULE[ev.kind].maxSends;
  if (!Number.isInteger(ev.attempts) || ev.attempts < 0 || ev.attempts > max) return `attempts: ${ev.attempts} (0..${max})`;
  if (ev.lastAttemptAt !== null && !isIso(ev.lastAttemptAt)) return 'lastAttemptAt: not null or a timestamp';
  const unsentStatus = ['waiting', 'awaiting-user', 'dismissed'].includes(ev.status)
    || (ev.status === 'gave_up' && SCHEDULE[ev.kind].deadlineMs !== null);
  if (ev.lastAttemptAt === null && (!unsentStatus || ev.attempts > 0)) return 'lastAttemptAt: required once an attempt was made';
  if (ev.clearedAt !== undefined && !isIso(ev.clearedAt)) return 'clearedAt: not a timestamp';
  return null;
}

// Parses state.json text. v1 is upgraded in memory (kind limit, platform
// unknown) then validated as v2. Returns null for anything invalid.
export function parseStateFile(text) {
  let s;
  try { s = JSON.parse(text); } catch { return null; }
  return validateParsedState(s);
}

// Validates an already-parsed state object (so callers that have parsed the JSON —
// e.g. doctor, which also needs the raw value for diagnostics — need not parse
// twice). Returns the upgraded/validated events map, or null for anything invalid.
export function validateParsedState(s) {
  if (!s || typeof s !== 'object' || !s.events || typeof s.events !== 'object') return null;
  if (s.version !== 1 && s.version !== 2) return null;
  const events = {};
  for (const [key, raw] of Object.entries(s.events)) {
    const ev = { alertedAt: null, ...raw, ...(s.version === 1 ? { kind: 'limit', platform: 'unknown' } : {}) };
    if (validateEvent(key, ev) !== null) return null;
    events[key] = ev;
  }
  return events;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/i;

// Reads a clock time ("3pm", "3:30 p.m.", "14:00") out of text. Returns
// { h, m } or null.
function parseClock(text) {
  const t12 = text.match(/\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?\b/i);
  if (t12) return { h: Number(t12[1]) % 12 + (t12[3].toLowerCase() === 'p' ? 12 : 0), m: Number(t12[2] || 0) };
  const t24 = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (t24) return { h: Number(t24[1]), m: Number(t24[2]) };
  return null;
}

// An unbounded digit run in a relative reset can overflow the Date range and
// yield an Invalid Date (getTime() === NaN). Return null for any non-finite
// instant so callers' `?? fallback` / `?.toISOString()` engage instead of a
// RangeError propagating up and aborting the whole tick (DOG-24).
const validDate = (d) => Number.isFinite(d.getTime()) ? d : null;

export function parseResetTime(text, now) {
  // "in 3 days" (weekly limits) — a day count, never a clock time.
  const relD = text.match(/\bin\s+(\d+)\s+days?\b/i);
  if (relD) return validDate(new Date(now.getTime() + Number(relD[1]) * 24 * 60 * MIN));

  // "in 2 hours 15 minutes", "in 2h 30m", "in 3h", "in 1hr 5m"
  const relHM = text.match(/\bin\s+(\d+)\s*h(?:(?:ou)?rs?)?\b(?:\s*(?:and\s+)?(\d+)\s*m(?:in(?:ute)?s?)?)?/i);
  if (relHM) {
    const mins = Number(relHM[1]) * 60 + Number(relHM[2] || 0);
    return validDate(new Date(now.getTime() + mins * MIN));
  }
  const relM = text.match(/\bin\s+(\d+)\s*m(?:in(?:ute)?s?)?\b/i);
  if (relM) return validDate(new Date(now.getTime() + Number(relM[1]) * MIN));

  const clock = parseClock(text);

  // "Sep 12 at 3pm", "September 12, 09:30", "on Sep 12" (midnight when no time)
  const md = text.match(MONTH_DAY_RE);
  if (md) {
    const month = MONTHS.indexOf(md[1].slice(0, 3).toLowerCase());
    const candidate = new Date(now);
    if (md[3]) candidate.setFullYear(Number(md[3]), month, Number(md[2]));
    else candidate.setMonth(month, Number(md[2]));
    candidate.setHours(clock?.h ?? 0, clock?.m ?? 0, 0, 0);
    if (!md[3] && candidate <= now && now - candidate > GRACE_PAST_MS) candidate.setFullYear(candidate.getFullYear() + 1);
    return candidate;
  }

  if (!clock) return null;
  const candidate = new Date(now);
  candidate.setHours(clock.h, clock.m, 0, 0);
  if (candidate <= now && now - candidate > GRACE_PAST_MS) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

// One event per terminal: a terminal can only be limited by one limit at a
// time, and keying by handle alone means banner-text mutations (our own
// echoed resume text, countdown digits) can never spawn duplicate events.
export const eventKey = (handle) => handle;

// observations: [{ handle, banner: { kind, bannerText, … } | null, platform }]
// Applies spec §5's transition order per stored event; first matching rule wins.
export function reconcile(state, observations, now, liveHandles = null, newEpisodeId = randomUUID) {
  const events = structuredClone(state);
  const sendCandidates = [];
  const byHandle = new Map(observations.map((o) => [o.handle, { ...o, platform: o.platform ?? 'unknown' }]));
  // Terminals that still EXIST this tick (from `terminal list`) — a superset of
  // the ones we managed to READ: a read can fail on transient orca socket churn
  // or be skipped by the read budget. Old callers/tests omit it.
  const live = liveHandles ? new Set(liveHandles) : new Set(byHandle.keys());

  for (const [key, ev] of Object.entries(events)) {
    if (!live.has(ev.handle)) { delete events[key]; continue; }             // 1. vanished
    const o = byHandle.get(ev.handle);
    if (!o) continue;                                                        // 2. live but unread: freeze
    if (!o.banner) {                                                         // 3. banner cleared
      // One absent read is not proof: the agent scrolls, orca returns a short
      // tail, a redraw lands mid-read. Deleting on the first miss resets
      // attempts to 0 and lets a flickering banner be sent to without bound.
      if (ev.clearedAt) { delete events[key]; continue; }                    //    3a. second consecutive miss
      ev.clearedAt = now.toISOString(); continue;                            //    3b. first miss: hold
    }
    delete ev.clearedAt;                                                     //    banner present again
    if (ev.status !== 'dismissed' && (o.banner.kind !== ev.kind || (o.platform !== 'unknown' && o.platform !== ev.platform))) {
      events[key] = newEvent(o, now, newEpisodeId); continue;                 // 4. replace (never a candidate this tick)
    }
    const sch = SCHEDULE[ev.kind];                                           // 5. same kind & platform
    if (ev.status === 'awaiting-user' || ev.status === 'dismissed') continue;
    if (ev.status !== 'gave_up' && sch.deadlineMs !== null && now - new Date(ev.detectedAt) >= sch.deadlineMs) {
      ev.status = 'gave_up'; continue;                                       // 5a
    }
    if (ev.status === 'resumed' && now - new Date(ev.lastAttemptAt) >= sch.rearmMs) {
      ev.status = ev.attempts >= sch.maxSends ? 'gave_up' : 'waiting';       // 5b
    }
    if (ev.status === 'waiting'
      && now - new Date(ev.resetAt) >= sch.bufferMs
      && ev.attempts < sch.maxSends
      && (!ev.lastAttemptAt || now - new Date(ev.lastAttemptAt) >= sch.retrySpacingMs)) {
      sendCandidates.push(key);                                              // 5c
    }
  }
  for (const o of byHandle.values()) {
    if (o.banner && !events[eventKey(o.handle)]) events[eventKey(o.handle)] = newEvent(o, now, newEpisodeId);
  }
  return { events, sendCandidates };
}

const SHELL_PROMPT_RE = /[$%#❯➜λ❱>]$/;
// True when the last non-empty line of a tail is a shell prompt, i.e. the agent
// has exited and a send would land in the shell (spec §6.4). A bare ">" is
// Claude Code's empty input box only with independent evidence (agentIdentity).
export function isShellPrompt(tail, agentIdentity) {
  const last = tail.map((l) => stripAnsi(l).trim()).filter(Boolean).at(-1);
  if (last === undefined) return false;
  if (last === '>') return agentIdentity !== 'claude';
  return SHELL_PROMPT_RE.test(last);
}

// True when the input area already holds unsubmitted text — an agent input box
// draft, or a shell prompt carrying a typed command. A send would be appended to
// it and --enter would submit both, so the tick skips and the event stays as it
// is (spec §6.4 spirit).
const INPUT_DRAFT_RE = /^[>›]\s+(?!Ask Codex to do anything\s*$)\S/;
// A shell prompt glyph (deliberately excluding ">", which is the agent box and a
// shell redirect) preceded by start/space and FOLLOWED by whitespace + a command.
// The empty prompt ("~ %") has nothing after the glyph, so it does not match and
// is left to isShellPrompt's exited-to-shell drop (DOG-24).
const SHELL_CMD_RE = /(?:^|\s)[$%#❯➜λ❱]\s+\S/;
export function isInputOccupied(tail) {
  // .trim() (both ends) mirrors detection, so an indented draft ("  > text") is
  // not missed. Strictly safer: it can only add skips, never a send (DOG-24).
  const lines = tail.map((l) => stripAnsi(l).trim());
  if (lines.some((l) => INPUT_DRAFT_RE.test(l))) return true;
  const last = lines.filter(Boolean).at(-1);
  return last !== undefined && SHELL_CMD_RE.test(last);
}

const STATUS_URLS = Object.freeze({
  claude: 'https://status.claude.com/api/v2/status.json',
  codex: 'https://status.openai.com/api/v2/status.json',
});
export const CONNECTIVITY_URL = 'https://captive.apple.com/hotspot-detect.html';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

// Resolve the status page for a platform. The env override exists for the E2E
// stub only and is honoured solely for http(s) loopback URLs (spec safety §5).
export function statusUrlFor(platform, env = process.env) {
  const url = STATUS_URLS[platform];
  const override = env[`WATCHDOG_STATUS_URL_${platform.toUpperCase()}`];
  if (!override) return { url, warn: null };
  try {
    const u = new URL(override);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname)) return { url: override, warn: null };
  } catch { /* fall through */ }
  return { url, warn: `ignoring non-loopback status URL override for ${platform}` };
}

// Resolve the connectivity probe URL. An override is accepted only for a
// loopback host (as statusUrlFor does), so the e2e loopback stub can drive it;
// anything else is ignored with a warning and the default used.
export function connectivityUrl(env = process.env) {
  const override = env.WATCHDOG_CONNECTIVITY_URL;
  if (!override) return { url: CONNECTIVITY_URL, warn: null };
  try {
    const u = new URL(override);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname)) {
      return { url: override, warn: null };
    }
  } catch { /* fall through */ }
  return { url: CONNECTIVITY_URL, warn: 'ignoring non-loopback connectivity URL override' };
}

// True when a reachability probe succeeds. Fail-closed: any error, timeout,
// non-ok status, or redirect ⇒ false. Reachability, not API-correctness — a
// captive portal that redirects or fails TLS reads as offline (the safe answer).
export async function hasConnectivity(fetchImpl = globalThis.fetch, url = CONNECTIVITY_URL) {
  try {
    const r = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    return r.ok === true;
  } catch { return false; }
}

// Fetch a Statuspage indicator. Never throws: any failure is null (fail open).
export async function fetchIndicator(url, fetchImpl = globalThis.fetch) {
  try {
    const r = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const j = await r.json();
    const ind = j?.status?.indicator;
    return typeof ind === 'string' ? ind : null;
  } catch { return null; }
}

export const suppressedByStatus = (indicator) => indicator === 'major' || indicator === 'critical';

// --- imperative shell ---

const pExecFile = promisify(execFile);

const CHOICES = ['Continue', 'Wait 1h', 'Stop'];
const PATH_COMPONENT_RE = /^[A-Za-z0-9_-]+$/;
function choicePath(handle, episodeId, stateDir = STATE_DIR) {
  if (!PATH_COMPONENT_RE.test(handle) || !PATH_COMPONENT_RE.test(episodeId)
    || typeof handle !== 'string' || typeof episodeId !== 'string') throw new Error('invalid handle/episode path component');
  return path.join(stateDir, 'choices', `${handle}.${episodeId}.json`);
}

// The child outlives the tick. All untrusted display text travels as env/argv
// data; no shell and no banner interpolation into AppleScript source.
export function spawnAlert(ev, { spawnImpl = spawn, stateDir = STATE_DIR, env = process.env } = {}) {
  const child = spawnImpl(process.execPath, [fileURLToPath(import.meta.url), '--alert'], {
    detached: true, stdio: 'ignore', env: { ...env,
      WATCHDOG_ALERT_MESSAGE: `${ev.handle} — ${sanitize(ev.bannerText)}`,
      WATCHDOG_ALERT_EPISODE: ev.episodeId,
      WATCHDOG_ALERT_CHOICE_FILE: choicePath(ev.handle, ev.episodeId, stateDir) },
  });
  child.unref();
  return child; // tick attaches an async error listener before yielding
}

export async function readChoice(handle, episodeId, stateDir = STATE_DIR, logImpl = log) {
  try { return JSON.parse(fs.readFileSync(choicePath(handle, episodeId, stateDir), 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') logImpl('warn', `choice read failed for ${handle}: ${sanitize(e.message)}`);
    return null;
  }
}

export async function clearChoice(handle, episodeId, stateDir = STATE_DIR, logImpl = log) {
  try { fs.unlinkSync(choicePath(handle, episodeId, stateDir)); }
  catch (e) { if (e.code !== 'ENOENT') logImpl('warn', `choice delete failed for ${handle}: ${sanitize(e.message)}`); }
}

export function reapChoices(liveNames, stateDir = STATE_DIR, logImpl = log) {
  const dir = path.join(stateDir, 'choices');
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) {
    if (e.code !== 'ENOENT') logImpl('debug', `choice reaper read failed: ${sanitize(e.message)}`);
    return 0;
  }
  let reaped = 0;
  for (const name of names) {
    if (!name.endsWith('.json') || liveNames.has(name)) continue;
    try { fs.unlinkSync(path.join(dir, name)); reaped++; }
    catch { /* raced unlink or otherwise unavailable; retry next tick */ }
  }
  return reaped;
}

// Separate from the daemon logger: --alert must not touch state/lock/log files.
const alertLog = (level, msg) => console.error(`${level}: ${msg}`);
export async function runAlert(env, { execFileImpl = pExecFile, logImpl = alertLog } = {}) {
  let tmp;
  try {
    const message = env.WATCHDOG_ALERT_MESSAGE;
    const episodeId = env.WATCHDOG_ALERT_EPISODE;
    const file = env.WATCHDOG_ALERT_CHOICE_FILE;
    if (typeof message !== 'string' || !message.trim() || message.includes('\0')
      || typeof episodeId !== 'string' || !PATH_COMPONENT_RE.test(episodeId)
      || typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file
      || path.basename(path.dirname(file)) !== 'choices') throw new Error('invalid alert environment');
    const suffix = `.${episodeId}.json`;
    const name = path.basename(file);
    if (!name.endsWith(suffix) || !PATH_COMPONENT_RE.test(name.slice(0, -suffix.length))) throw new Error('invalid alert choice path');
    const { stdout } = await execFileImpl('/usr/bin/osascript', ['-e', 'on run argv', '-e',
      'return button returned of (display alert "orca-watchdog" message (item 1 of argv) buttons {"Stop","Wait 1h","Continue"} default button "Continue")',
      '-e', 'end run', '--', message]);
    const choice = stdout?.trim();
    if (!CHOICES.includes(choice)) { logImpl('warn', 'alert returned no valid choice'); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    tmp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ choice, episodeId, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
    tmp = undefined;
  } catch (e) {
    logImpl('warn', `alert failed: ${sanitize(e.message)}`);
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
  }
}

function log(level, msg) {
  if (!shouldLog(level)) return;
  try { appendActivity(STATE_DIR, `${new Date().toISOString()} ${level} ${msg}\n`); }
  catch { /* diagnostic IO must not affect sends */ }
}

export async function orca(args, execImpl = pExecFile) {
  let stdout;
  try {
    ({ stdout } = await execImpl(ORCA, [...args, '--json'], { timeout: 15_000 }));
  } catch (e) {
    // orca exits non-zero for structured errors but still prints JSON to stdout
    if (!e.stdout) throw e;
    stdout = e.stdout;
  }
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch {
    // Malformed stdout (orca socket churn / a partial write during an update) is
    // "nothing to observe this tick", not a watchdog fault: classify as unavailable
    // so callers handle it gracefully instead of an unhandled SyntaxError aborting
    // the whole tick (DOG-24).
    const e = new Error('orca returned malformed JSON'); e.code = 'runtime_unavailable'; throw e;
  }
  if (!parsed.ok) { const e = new Error(parsed.error?.message || 'orca error'); e.code = parsed.error?.code; throw e; }
  return parsed.result;
}

function loadState() {
  let text;
  try { text = readRegularSync(STATE_FILE); } catch (e) {
    if (e.code === 'ENOENT') return {};
    log('warn', `state file unreadable (${e.message}); reset`);
    return {};
  }
  const events = parseStateFile(text);
  if (events) return events;
  // Name the first violation so a bad file is diagnosable from the log.
  let why = 'invalid state file';
  try {
    const s = JSON.parse(text);
    if (s?.version !== 1 && s?.version !== 2) why = `unsupported version ${s?.version}`;
    else for (const [k, raw] of Object.entries(s.events ?? {})) {
      const v = validateEvent(k, { alertedAt: null, ...raw, ...(s.version === 1 ? { kind: 'limit', platform: 'unknown' } : {}) });
      if (v) { why = `${k}: ${v}`; break; }
    }
  } catch (e) { why = e.message; }
  try { fs.renameSync(STATE_FILE, `${STATE_FILE}.bad-${Date.now()}`); } catch { /* gone */ }
  log('warn', `state file rejected (${why}); backed up and reset`);
  return {};
}

export function saveState(events, stateDir = STATE_DIR) {
  // Daemon state can name terminals and carry sanitized banner text, so it is kept
  // owner-only. This send-critical write must never THROW on a tampered-but-valid
  // state (that would skip the resume send persisted just before it in tick()), so it
  // calls atomicWriteFile with BOTH destination and directory guards OFF:
  //   checkTarget:false — the rename replaces the state.json entry atomically without
  //     following a symlink or writing through a hardlink;
  //   hardenDir:false  — pre-DOG-29 dir semantics (mkdir -p 0700 + best-effort chmod),
  //     NO symlink/owner rejection. Do NOT "restore" a dir guard here: it would be a
  //     silent send-blocking throw path and protects nothing (loadState reads through
  //     the same dir unchecked).
  // The unpredictable 'wx' temp + atomic rename still defeat a pre-planted temp
  // symlink. See atomicWriteFile (DOG-29 #12 + N1).
  atomicWriteFile(stateDir, 'state.json', JSON.stringify({ version: 2, events }, null, 2), { checkTarget: false, hardenDir: false });
}

export function acquireLock(lockFile = LOCK_FILE) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  // The exclusive create (wx) is the sole arbiter: in the common no-lock case it
  // wins in one syscall; when it loses, only a *stale* lock is reclaimed and the
  // reclaim is arbitrated by an atomic rename so two racing ticks can never both
  // win (the old rm-then-create could) — a lost race simply skips (DOG-24).
  const create = () => { try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); return true; } catch { return false; } };
  if (create()) return true;
  let age;
  try { age = Date.now() - fs.statSync(lockFile).mtimeMs; }
  catch { return create(); }                 // vanished between create and stat
  if (age < 10 * MIN) return false;          // a live tick holds a fresh lock
  const stolen = `${lockFile}.stale-${process.pid}-${Date.now()}`;
  try { fs.renameSync(lockFile, stolen); }   // only one racer can rename it away
  catch { return false; }                    // lost the reclaim race → skip this tick
  try { fs.rmSync(stolen, { force: true }); } catch { /* best effort */ }
  return create();                           // may still lose to a fresh create in the gap
}

async function readTail(handle, orcaFn = orca) {
  const r = await orcaFn(['terminal', 'read', '--terminal', handle]);
  return r.terminal?.tail ?? [];
}

const DEFAULT_DEPS = () => ({ orca, fetchImpl: globalThis.fetch, env: process.env, now: () => new Date(), loadState, saveState, log,
  newEpisodeId: randomUUID, spawn: spawnAlert, readChoice, clearChoice, reapChoices,
  isDisabled: () => fs.existsSync(DISABLED_FILE) });

export async function tick({ dryRun }, depsIn = {}) {
  const deps = { ...DEFAULT_DEPS(), ...depsIn };
  const observe = (...args) => { try { deps.observe?.(...args); } catch { /* diagnostics cannot change eligibility */ } };
  const waiting = (handle, reason) => observe('waiting', handle, reason);
  const log = deps.log;   // shadows the module logger so tests can silence it
  let terminals;
  try {
    terminals = (await deps.orca(['terminal', 'list'])).terminals ?? [];
  } catch (e) {
    if (isUnavailableError(e)) { observe('unavailable'); log('debug', `orca unavailable: ${e.message.split('\n')[0]}`); return; }
    throw e;
  }
  const byHandle = new Map(terminals.map((t) => [t.handle, t]));

  const observations = [];
  const startedAt = Date.now();
  const queue = terminals.filter((t) => t.connected && t.writable);
  let budgetSpent = false;
  const worker = async () => {
    while (queue.length > 0) {
      if (readBudgetExceeded(startedAt, Date.now())) { budgetSpent = true; return; }
      const t = queue.shift();
      try {
        const tail = await readTail(t.handle, deps.orca);
        const banner = detectBanner(tail, inferPlatform(t), deps.now());
        if (!banner && shouldLog('debug') && hasOutageLine(tail)) {
          log('debug', `outage-pattern line present but not detected (platform gate, retry veto, or final block) on ${t.handle}: ${sanitize(tail.slice(-TAIL_LINES).join(' | '), 600)}`);
        }
        observations.push({ handle: t.handle, banner, platform: inferPlatform(t, banner), window: tail.slice(-TAIL_LINES).join(' | ') });
      } catch (e) {
        waiting(t.handle, 'failed read');
        log('warn', `read failed for ${t.handle}: ${sanitize(e.message)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, worker));
  if (budgetSpent) log('warn', `read budget (${READ_BUDGET_MS / MIN} min) spent; skipped ${queue.length} terminal(s) this tick`);

  const now = deps.now();
  const state = deps.loadState();
  // Pass every terminal that still exists so reconcile can tell a vanished
  // terminal (delete) from one merely unread this tick (freeze).
  const liveHandles = terminals.map((t) => t.handle);
  const { events, sendCandidates } = reconcile(state, observations, now, liveHandles, deps.newEpisodeId);
  for (const ev of Object.values(events)) {
    if (observations.some(o => o.handle === ev.handle)) waiting(ev.handle,
      ev.status === 'gave_up' ? 'exhausted retries' : ev.status === 'awaiting-user' ? 'user choice'
      : ev.status === 'dismissed' ? 'user dismissed' : ev.clearedAt ? 'banner clearance confirmation'
      : ev.status === 'resumed' ? 'resume confirmation' : 'reset time or retry delay');
  }

  for (const key of Object.keys(events)) {
    const ev = events[key];
    if (state[key]?.detectedAt === ev.detectedAt) continue;   // not new (also skips untouched events)
    const o = observations.find((x) => x.handle === ev.handle);
    log('info', `detected ${ev.kind} on ${ev.handle} (${ev.platform}, ${o?.banner?.patternId ?? 'limit'}: ${sanitize(o?.banner?.matchedLine ?? ev.bannerText)}), resetAt ${ev.resetAt}`);
    if (ev.kind === 'outage' && shouldLog('debug')) log('debug', `outage window on ${ev.handle}: ${sanitize(o?.window ?? '', 600)}`);
  }

  // Reconcile has already selected sends. Consent becomes eligible next tick,
  // preserving unread/first-miss freezes and never bypassing the send guards.
  for (const ev of Object.values(events)) {
    if (ev.kind !== 'limit-open' || ev.status !== 'awaiting-user') continue;
    if (!observations.some((o) => o.handle === ev.handle && o.banner) || ev.clearedAt) continue;
    // The handle comes straight from `orca terminal list`; a value that is not a
    // safe path component would make choicePath throw and churn the alert every
    // tick. Skip it gracefully (DOG-24) instead of claiming and spawning.
    if (!PATH_COMPONENT_RE.test(ev.handle) || !PATH_COMPONENT_RE.test(ev.episodeId ?? '')) {
      log('warn', `skip alert for ${sanitize(ev.handle)}: handle/episode is not a safe path component`); continue;
    }
    if (dryRun) { log('info', `[dry-run] would await alert choice for ${ev.handle}`); continue; }
    try {
      if (ev.alertedAt === null) {
        ev.alertedAt = now.toISOString();
        deps.saveState(events); // claim before spawn: a crash cannot duplicate the dialog
        // A spawn failure (sync throw or async 'error') means no dialog was shown,
        // so release the claim to re-arm next tick rather than wedge the episode
        // forever on a choice file that will never appear (DOG-24). A real crash
        // dies before this runs, so the claim persists and cannot double-alert.
        const rearm = (e) => { log('warn', `alert spawn failed for ${ev.handle}: ${sanitize(e.message)}`); ev.alertedAt = null; deps.saveState(events); };
        try {
          const child = deps.spawn(ev);
          child?.on('error', rearm);
        } catch (e) { rearm(e); }
        continue;
      }
      const result = await deps.readChoice(ev.handle, ev.episodeId);
      if (result === null) continue;
      if (result?.episodeId === ev.episodeId && isIso(result.at)
        && CHOICES.includes(result.choice)) {
        if (result.choice === 'Stop') ev.status = 'dismissed';
        else {
          ev.status = 'waiting';
          ev.detectedAt = now.toISOString();
          ev.resetAt = new Date(now.getTime() + (result.choice === 'Wait 1h' ? 60 * MIN : 0)).toISOString();
        }
        deps.saveState(events); // durable choice before deleting the child's result
      } else log('warn', `ignored invalid or stale alert choice for ${ev.handle}`);
      await deps.clearChoice(ev.handle, ev.episodeId);
    } catch (e) {
      log('warn', `alert failed for ${ev.handle}: ${sanitize(e.message)}`);
    }
  }

  if (!dryRun) {
    const liveChoiceNames = new Set(Object.values(events)
      .filter((e) => e.kind === 'limit-open' && e.status === 'awaiting-user' && e.episodeId)
      .map((e) => `${e.handle}.${e.episodeId}.json`));
    try { await deps.reapChoices(liveChoiceNames); }
    catch (e) { log('debug', `choice reaper failed: ${sanitize(e.message)}`); }
  }

  const indicators = new Map();   // platform → indicator, fetched at most once per tick
  let online = null;              // connectivity, probed lazily once per real (non-dry-run) tick
  for (const key of sendCandidates) {
    const ev = events[key];
    const sch = SCHEDULE[ev.kind];
    if (dryRun) {
      log('info', `[dry-run] would resume ${ev.handle} (${ev.kind}/${ev.platform}, attempt ${ev.attempts + 1})`);
      console.log(`would resume ${ev.handle} (${ev.kind}/${ev.platform}, attempt ${ev.attempts + 1})`);
      continue;
    }
    // Re-check the kill switch before every real send: a `pause` that lands mid-
    // tick must stop the remaining candidates, not only future ticks (DOG-24).
    if (deps.isDisabled()) { log('info', `paused mid-tick; halting remaining sends`); break; }
    try {   // fault-isolate per-candidate work: a throw on one must not abort the rest (DOG-24)
    if (online === null) {   // 0. connectivity gate: never resume while offline; probe once per real tick
      const { url, warn } = connectivityUrl(deps.env);
      if (warn) log('warn', warn);
      online = await hasConnectivity(deps.fetchImpl, url);
    }
    if (!online) { waiting(ev.handle, 'offline'); log('debug', `held ${ev.handle}: offline`); continue; }
    if (ev.kind === 'outage') {   // 1. status gate (validateEvent guarantees a known platform)
      if (!indicators.has(ev.platform)) {
        const { url, warn } = statusUrlFor(ev.platform, deps.env);
        if (warn) log('warn', warn);
        indicators.set(ev.platform, await fetchIndicator(url, deps.fetchImpl));
      }
      const indicator = indicators.get(ev.platform);
      // Fail closed: an unverifiable status (fetch failed/timed out/redirected/
      // bad JSON ⇒ null) must not authorize a resume during a possibly-continuing
      // outage. Only a confirmed-healthy indicator allows the send (DOG-24).
      if (indicator === null) { waiting(ev.handle, 'provider health unknown'); log('warn', 'hold: provider health unverifiable'); continue; }
      if (suppressedByStatus(indicator)) {
        waiting(ev.handle, 'provider health ' + indicator);
        log('debug', `skip ${ev.handle}: ${ev.platform} status is ${indicator}`); continue;
      }
    }
    try {                                                                            // 2. idle check
      await deps.orca(['terminal', 'wait', '--terminal', ev.handle, '--for', 'tui-idle', '--timeout-ms', '5000']);
    } catch (e) {
      waiting(ev.handle, 'busy terminal');
      log('info', `skip ${ev.handle}: not idle (${sanitize(e.message)})`); continue;
    }
    let tail;                                                                        // 3. fresh re-read
    try { tail = await readTail(ev.handle, deps.orca); } catch (e) {
      waiting(ev.handle, 'failed read');
      log('warn', `skip ${ev.handle}: re-read failed (${sanitize(e.message)}); event untouched`); continue;
    }
    const term = byHandle.get(ev.handle);
    const fresh = detectBanner(tail, inferPlatform(term), now);
    if (!fresh) {   // same hold as reconcile rule 3b: one miss is not proof
      log('info', `skip ${ev.handle}: banner cleared before send; holding`);
      ev.clearedAt = now.toISOString(); deps.saveState(events); continue;
    }
    const platform = inferPlatform(term, fresh);
    if (fresh.kind !== ev.kind || (platform !== 'unknown' && platform !== ev.platform)) {
      log('info', `skip ${ev.handle}: banner changed to ${fresh.kind}/${platform} before send; fresh event`);
      events[key] = newEvent({ handle: ev.handle, banner: fresh, platform }, now, deps.newEpisodeId); deps.saveState(events); continue;
    }
    if (ev.kind === 'limit') {                                                       // 3b. reset moved later
      const freshReset = fresh.resetAt ? new Date(fresh.resetAt) : parseResetTime(fresh.bannerText, now);
      if (freshReset && freshReset.getTime() - new Date(ev.resetAt).getTime() >= RESET_REFRESH_MIN_MS) {
        ev.resetAt = freshReset.toISOString();
        if (now - new Date(ev.resetAt) < SCHEDULE.limit.bufferMs) {
          log('info', `skip ${ev.handle}: reset moved later to ${ev.resetAt}; holding`);
          deps.saveState(events); continue;
        }
      }
    }
    if (isShellPrompt(tail, term?.agentIdentity)) {                                  // 4. prompt guard
      log('warn', `skip ${ev.handle}: shell prompt on last line, agent has exited; event dropped`);
      observe('resolved', ev.handle);   // the event is gone: don't leave a stale waiting reason in status
      delete events[key]; deps.saveState(events); continue;
    }
    if (isInputOccupied(tail)) {                                                     // 4b. draft guard
      waiting(ev.handle, 'draft input');
      log('info', `skip ${ev.handle}: input box holds a draft; event untouched`); continue;
    }
    ev.attempts += 1;                                                                // 5. persist, then send
    ev.lastAttemptAt = now.toISOString();
    ev.status = 'resumed';
    deps.saveState(events);
    try {
      await deps.orca(['terminal', 'send', '--terminal', ev.handle, '--text', sch.resumeText, '--enter']);
      observe('resumed', ev.handle);
      log('info', `resumed ${ev.handle} (${ev.kind}, attempt ${ev.attempts})`);
    } catch (e) {
      // The attempt is already persisted (no double-send on retry); the other
      // candidates and the GAVE UP pass must still run this tick.
      waiting(ev.handle, 'failed send');
      log('warn', `send failed for ${ev.handle} (attempt ${ev.attempts}): ${sanitize(e.message)}`);
    }
    } catch (e) {   // untrusted-content or unexpected throw processing this candidate
      waiting(ev.handle, 'failed send processing');
      log('warn', `skip ${ev.handle}: send processing failed (${sanitize(e.message)}); event untouched`);
    }
  }

  for (const [key, ev] of Object.entries(events)) {
    if (ev.status === 'gave_up' && state[key]?.status !== 'gave_up') {
      log('error', `GAVE UP on ${ev.handle} (${ev.kind}) after ${ev.attempts} attempts — banner never cleared`);
    }
  }

  if (!dryRun) deps.saveState(events);
  if (dryRun) console.log(`${Object.keys(events).length} active event(s), ${sendCandidates.length} send candidate(s)`);
}

export const USAGE = `Usage: watchdog.mjs [--dry-run | --status | --once | --help]
  (no args)   run one daemon tick (launchd invokes it this way)
  --dry-run   observe only; print intended actions, send nothing
  --status    print active events and exit
  --once      alias for a normal one-tick run
  --help, -h  show this help
`;

// Classify the daemon invocation. Unknown tokens fail closed (never a live tick):
// launchd calls with no args, which MUST still tick (DOG-24). `--alert` is handled
// at the entry before main and is not a valid main() token.
const KNOWN_ARGS = new Set(['--once', '--dry-run', '--status', '--help', '-h']);
export function parseArgv(argv) {
  const unknown = argv.filter((a) => !KNOWN_ARGS.has(a));
  if (unknown.length > 0) return { action: 'error', unknown };
  if (argv.includes('--help') || argv.includes('-h')) return { action: 'help' };
  if (argv.includes('--status')) return { action: 'status' };
  return { action: 'tick', dryRun: argv.includes('--dry-run') };
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed.action === 'error') {
    process.stderr.write(`unknown argument: ${parsed.unknown.join(' ')}\n${USAGE}`);
    process.exitCode = 2; return;
  }
  if (parsed.action === 'help') { process.stdout.write(USAGE); return; }
  if (parsed.action === 'status') {
    let events;
    try { events = parseStateFile(readRegularSync(STATE_FILE)); }
    catch (e) {
      if (e.code === 'ENOENT') events = {};
      else { console.log('event state: unknown (unreadable; run orca-watchdog doctor)'); return; }
    }
    if (!events) { console.log('event state: unknown (malformed; run orca-watchdog doctor)'); return; }
    console.log(Object.keys(events).length === 0 ? 'no active events'
      : JSON.stringify({ version: 2, events }, null, 2));
    return;
  }
  if (fs.existsSync(DISABLED_FILE)) return;
  const dryRun = parsed.dryRun;
  if (!dryRun && !acquireLock()) return;
  const tickLog = dryRun ? (level, msg) => { if (shouldLog(level)) console.log(`${level} ${msg}`); } : log;
  if (!dryRun) { try { maintainLogs(STATE_DIR); } catch (e) { console.error(`log maintenance: ${e.message}`); } }
  // Release the lock on ANY exit, including the deadline's process.exit(1),
  // which bypasses the finally below. Without this, a hard-killed tick leaves a
  // stale lock that makes the next 1-2 scheduled ticks skip (age < 10-min TTL),
  // blinding the watchdog for ~5-15 min exactly when ticks are running slow.
  if (!dryRun) process.once('exit', () => { try { fs.rmSync(LOCK_FILE, { force: true }); } catch { /* best effort */ } });
  const deadline = setTimeout(() => { tickLog('error', 'tick deadline (4 min) exceeded'); process.exit(1); }, 4 * MIN);
  try {
    await runObservedCheck({ stateDir: STATE_DIR, dryRun, tick, deps: { log: tickLog,
      ...(dryRun ? { loadState: () => { try { return parseStateFile(readRegularSync(STATE_FILE)) ?? {}; } catch { return {}; } } } : {}) } });
  } catch (e) {
    tickLog('error', `tick failed: ${sanitize(e.message)}`);
  } finally {
    clearTimeout(deadline);
    // Only the activity log grew during the tick; the launchd stdout/stderr logs are
    // bounded by the start pass above and by the next tick's start pass.
    if (!dryRun) { try { maintainLogs(STATE_DIR, 'activity'); } catch { /* best effort */ } }
    if (!dryRun) fs.rmSync(LOCK_FILE, { force: true });
  }
}

// import.meta.url is the real path; argv[1] may be a symlink. Compare real to real,
// through pathToFileURL so spaces and unicode are percent-encoded on both sides.
const entryIsThisFile = (() => {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (entryIsThisFile) {
  if (process.argv.slice(2).includes('--alert')) {
    if (process.argv.length !== 3) alertLog('warn', 'invalid mixed --alert invocation');
    else await runAlert(process.env);
  } else await main();
}
