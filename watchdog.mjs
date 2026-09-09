#!/usr/bin/env node
// orca-limit-watchdog — detects rate-limited Orca agent terminals and sends a
// resume prompt after the limit resets. Zero dependencies. See README.md.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const RESUME_TEXT = 'Session rate limit has reset. Resume where you left off.';

const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'orca-limit-watchdog');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOG_FILE = path.join(STATE_DIR, 'watchdog.log');
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
const TAIL_LINES = 15;
const READ_BUDGET_MS = 3 * MIN;    // stop reading terminals before the 4-min tick deadline
const READ_CONCURRENCY = 4;        // parallel `terminal read`s per tick; orca serialises beyond a few

// --- pure logic (unit-tested) ---

const LIMIT_RE = /((usage|rate|session|weekly|daily|\d+[- ]hour)\s+limit|quota)/i;
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
export function sanitize(text, limit = 200) {
  let s = stripAnsi(text).replace(/\s+/g, ' ').trim();
  for (const re of SECRET_RES) s = s.replace(re, '[redacted]');
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

export function hasOutageLine(lines) {
  const window = lines.slice(-TAIL_LINES).map((l) => stripAnsi(l).trim());
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
  const window = lines.slice(-TAIL_LINES).map((l) => stripAnsi(l).trim());
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
    limit = { kind: 'limit', bannerText: sanitize(window.filter(isRelevant).join(' | '), 600),
      matchedLine: window[l], patternId: 'limit', index: l };
  }

  if (codexLimit) limit = codexLimit;

  // --- outage rule ---
  let outage = null;
  for (const p of OUTAGE_PATTERNS) {
    if (!p.platforms.includes(platform)) continue;
    const e = lastIndex(window, (l) => p.re.test(l));
    if (e < 0) continue;
    if (lastIndex(window, (l) => RETRY_RE.test(l)) >= e) continue;   // still retrying
    if (!window.slice(e + 1).every(isChrome)) continue;               // stale: agent moved on
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

export function parseResetTime(text, now) {
  // "in 3 days" (weekly limits) — a day count, never a clock time.
  const relD = text.match(/\bin\s+(\d+)\s+days?\b/i);
  if (relD) return new Date(now.getTime() + Number(relD[1]) * 24 * 60 * MIN);

  // "in 2 hours 15 minutes", "in 2h 30m", "in 3h", "in 1hr 5m"
  const relHM = text.match(/\bin\s+(\d+)\s*h(?:(?:ou)?rs?)?\b(?:\s*(?:and\s+)?(\d+)\s*m(?:in(?:ute)?s?)?)?/i);
  if (relHM) {
    const mins = Number(relHM[1]) * 60 + Number(relHM[2] || 0);
    return new Date(now.getTime() + mins * MIN);
  }
  const relM = text.match(/\bin\s+(\d+)\s*m(?:in(?:ute)?s?)?\b/i);
  if (relM) return new Date(now.getTime() + Number(relM[1]) * MIN);

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

// True when an agent input box already holds text. A send would be appended to
// that draft and --enter would submit both, so the tick skips and the event
// stays as it is (spec §6.4 spirit).
const INPUT_DRAFT_RE = /^[>›]\s+(?!Ask Codex to do anything\s*$)\S/;
export function isInputOccupied(tail) {
  return tail.map((l) => stripAnsi(l).trimEnd()).some((l) => INPUT_DRAFT_RE.test(l));
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
      'return button returned of (display alert "orca-limit-watchdog" message (item 1 of argv) buttons {"Stop","Wait 1h","Continue"} default button "Continue")',
      '-e', 'end run', '--', message]);
    const choice = stdout?.trim();
    if (!CHOICES.includes(choice)) { logImpl('warn', 'alert returned no valid choice'); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ choice, episodeId, at: new Date().toISOString() }), { flag: 'wx' });
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
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${level} ${msg}\n`);
  try {
    if (fs.statSync(LOG_FILE).size > 1_000_000) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
      fs.writeFileSync(LOG_FILE, lines.slice(-500).join('\n'));
    }
  } catch { /* best effort */ }
}

async function orca(args) {
  let stdout;
  try {
    ({ stdout } = await pExecFile(ORCA, [...args, '--json'], { timeout: 15_000 }));
  } catch (e) {
    // orca exits non-zero for structured errors but still prints JSON to stdout
    if (!e.stdout) throw e;
    stdout = e.stdout;
  }
  const parsed = JSON.parse(stdout);
  if (!parsed.ok) { const e = new Error(parsed.error?.message || 'orca error'); e.code = parsed.error?.code; throw e; }
  return parsed.result;
}

function loadState() {
  let text;
  try { text = fs.readFileSync(STATE_FILE, 'utf8'); } catch (e) {
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
      const v = validateEvent(k, s.version === 1 ? { ...raw, kind: 'limit', platform: 'unknown' } : raw);
      if (v) { why = `${k}: ${v}`; break; }
    }
  } catch (e) { why = e.message; }
  try { fs.renameSync(STATE_FILE, `${STATE_FILE}.bad-${Date.now()}`); } catch { /* gone */ }
  log('warn', `state file rejected (${why}); backed up and reset`);
  return {};
}

function saveState(events) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 2, events }, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (age >= 10 * MIN) fs.rmSync(LOCK_FILE, { force: true });
  } catch { /* no lock */ }
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch { return false; }
}

async function readTail(handle, orcaFn = orca) {
  const r = await orcaFn(['terminal', 'read', '--terminal', handle]);
  return r.terminal?.tail ?? [];
}

const DEFAULT_DEPS = () => ({ orca, fetchImpl: globalThis.fetch, env: process.env, now: () => new Date(), loadState, saveState, log,
  newEpisodeId: randomUUID, spawn: spawnAlert, readChoice, clearChoice, reapChoices });

export async function tick({ dryRun }, depsIn = {}) {
  const deps = { ...DEFAULT_DEPS(), ...depsIn };
  const log = deps.log;   // shadows the module logger so tests can silence it
  let terminals;
  try {
    terminals = (await deps.orca(['terminal', 'list'])).terminals ?? [];
  } catch (e) {
    if (isUnavailableError(e)) { log('debug', `orca unavailable: ${e.message.split('\n')[0]}`); return; }
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
    if (dryRun) { log('info', `[dry-run] would await alert choice for ${ev.handle}`); continue; }
    try {
      if (ev.alertedAt === null) {
        ev.alertedAt = now.toISOString();
        deps.saveState(events); // claim before spawn: a crash cannot duplicate the dialog
        const child = deps.spawn(ev);
        child?.on('error', (e) => log('warn', `alert spawn failed for ${ev.handle}: ${sanitize(e.message)}`));
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
    if (online === null) {   // 0. connectivity gate: never resume while offline; probe once per real tick
      const { url, warn } = connectivityUrl(deps.env);
      if (warn) log('warn', warn);
      online = await hasConnectivity(deps.fetchImpl, url);
    }
    if (!online) { log('debug', `held ${ev.handle}: offline`); continue; }
    if (ev.kind === 'outage') {   // 1. status gate (validateEvent guarantees a known platform)
      if (!indicators.has(ev.platform)) {
        const { url, warn } = statusUrlFor(ev.platform, deps.env);
        if (warn) log('warn', warn);
        indicators.set(ev.platform, await fetchIndicator(url, deps.fetchImpl));
      }
      if (suppressedByStatus(indicators.get(ev.platform))) {
        log('debug', `skip ${ev.handle}: ${ev.platform} status is ${indicators.get(ev.platform)}`); continue;
      }
    }
    try {                                                                            // 2. idle check
      await deps.orca(['terminal', 'wait', '--terminal', ev.handle, '--for', 'tui-idle', '--timeout-ms', '5000']);
    } catch (e) {
      log('info', `skip ${ev.handle}: not idle (${sanitize(e.message)})`); continue;
    }
    let tail;                                                                        // 3. fresh re-read
    try { tail = await readTail(ev.handle, deps.orca); } catch (e) {
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
    if (isShellPrompt(tail, term?.agentIdentity)) {                                  // 4. prompt guard
      log('warn', `skip ${ev.handle}: shell prompt on last line, agent has exited; event dropped`);
      delete events[key]; deps.saveState(events); continue;
    }
    if (isInputOccupied(tail)) {                                                     // 4b. draft guard
      log('info', `skip ${ev.handle}: input box holds a draft; event untouched`); continue;
    }
    ev.attempts += 1;                                                                // 5. persist, then send
    ev.lastAttemptAt = now.toISOString();
    ev.status = 'resumed';
    deps.saveState(events);
    try {
      await deps.orca(['terminal', 'send', '--terminal', ev.handle, '--text', sch.resumeText, '--enter']);
      log('info', `resumed ${ev.handle} (${ev.kind}, attempt ${ev.attempts})`);
    } catch (e) {
      // The attempt is already persisted (no double-send on retry); the other
      // candidates and the GAVE UP pass must still run this tick.
      log('warn', `send failed for ${ev.handle} (attempt ${ev.attempts}): ${sanitize(e.message)}`);
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

async function main() {
  const args = new Set(process.argv.slice(2));
  // `--once` is a readability alias for the normal one-tick invocation.
  args.delete('--once');
  if (args.has('--status')) {
    const events = loadState();
    console.log(Object.keys(events).length === 0 ? 'no active events'
      : JSON.stringify({ version: 2, events }, null, 2));
    return;
  }
  if (fs.existsSync(DISABLED_FILE)) return;
  const dryRun = args.has('--dry-run');
  if (!dryRun && !acquireLock()) { log('debug', 'another tick holds the lock'); return; }
  // Release the lock on ANY exit, including the deadline's process.exit(1),
  // which bypasses the finally below. Without this, a hard-killed tick leaves a
  // stale lock that makes the next 1-2 scheduled ticks skip (age < 10-min TTL),
  // blinding the watchdog for ~5-15 min exactly when ticks are running slow.
  if (!dryRun) process.once('exit', () => { try { fs.rmSync(LOCK_FILE, { force: true }); } catch { /* best effort */ } });
  const deadline = setTimeout(() => { log('error', 'tick deadline (4 min) exceeded'); process.exit(1); }, 4 * MIN);
  try {
    await tick({ dryRun });
  } catch (e) {
    log('error', `tick failed: ${sanitize(e.message)}`);
  } finally {
    clearTimeout(deadline);
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
