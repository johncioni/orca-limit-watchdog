#!/usr/bin/env node
// orca-limit-watchdog — detects rate-limited Orca agent terminals and sends a
// resume prompt after the limit resets. Zero dependencies. See docs/superpowers/specs/.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const RESUME_TEXT = 'Session rate limit has reset. Resume where you left off.';

const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'orca-limit-watchdog');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOG_FILE = path.join(STATE_DIR, 'watchdog.log');
const LOCK_FILE = path.join(STATE_DIR, 'lock');
const DISABLED_FILE = path.join(STATE_DIR, 'disabled');

const ORCA = process.env.ORCA_CLI
  || (fs.existsSync('/usr/local/bin/orca') ? '/usr/local/bin/orca' : 'orca');

const MIN = 60_000;
const BUFFER_MS = 2 * MIN;        // wait past stated reset before sending
const REARM_MS = 10 * MIN;        // banner still present this long after a send = failed attempt
const RETRY_SPACING_MS = 30 * MIN;
const MAX_ATTEMPTS = 3;
const GRACE_PAST_MS = 2 * 60 * MIN; // absolute time this recently past = already reset
const TAIL_LINES = 15;
const READ_BUDGET_MS = 3 * MIN;    // stop reading terminals before the 4-min tick deadline

// --- pure logic (unit-tested) ---

const LIMIT_RE = /((usage|rate|session|weekly|daily|\d+[- ]hour)\s+limit|quota)/i;
const REACHED_RE = /(reached|hit|exceeded)/i;
const RESET_RE = /(resets?\b|try again|available|come back)/i;
const VETO_RE = /approaching[^\n]*limit/i;

// CSI (ESC [ … final), OSC (ESC ] … BEL|ST), and stray C0/DEL control bytes.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g;
export function stripAnsi(s) { return String(s).replace(ANSI_RE, ''); }

// Credential shapes redacted from every logged terminal fragment. The last
// pattern (32+ opaque chars) also catches raw JWT/API-key material we have no
// prefix for; ordinary words and short git hashes are far below that length.
const SECRET_RES = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bBearer\s+\S+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /[A-Za-z0-9+/=_-]{32,}/g,
];
export function sanitize(text, limit = 200) {
  let s = stripAnsi(text).replace(/\s+/g, ' ').trim();
  for (const re of SECRET_RES) s = s.replace(re, '[redacted]');
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

// Outage banners are platform-owned TUI shapes; there is deliberately no
// generic rule. `platforms` gates which terminal identities a row applies to.
// Codex has no row yet (spec §Non-goals): nothing it prints is unambiguous.
const OUTAGE_PATTERNS = [
  { id: 'claude-api-error', platforms: ['claude', 'unknown'],
    re: /^(⎿\s*)?API Error: (5\d\d\b|Connection error\b|.*\boverloaded_error\b)/i },
];
const RETRY_RE = /retrying in \d|attempt \d+\s*(\/|of)\s*\d+/i;
// Lines allowed AFTER the error for it to count as the final, stalled banner.
const CHROME_RES = [
  /^$/,
  /^[─│╭╮╰╯┃━┌┐└┘├┤⎿\s]+$/,
  /^>(\s.*)?$/,
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

export function detectBanner(lines, platform = 'unknown') {
  const window = lines.slice(-TAIL_LINES).map((l) => stripAnsi(l).trim());

  // --- limit rule (unchanged semantics; now on stripped lines) ---
  // Drop soft "approaching … limit" warning lines first, so such a warning can
  // neither be mistaken for a reached-banner nor veto a genuine reached-banner
  // that happens to share the same 15-line window (per-line veto, not whole-window).
  const kept = window.filter((l) => !VETO_RE.test(l));
  const text = kept.join('\n');
  let limit = null;
  if (LIMIT_RE.test(text) && REACHED_RE.test(text) && RESET_RE.test(text)) {
    const isRelevant = (l) => !VETO_RE.test(l) && (LIMIT_RE.test(l) || RESET_RE.test(l));
    const l = lastIndex(window, isRelevant);
    limit = { kind: 'limit', bannerText: window.filter(isRelevant).join(' | '),
      matchedLine: window[l], patternId: 'limit', index: l };
  }

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

export function parseResetTime(text, now) {
  const relHM = text.match(/\bin\s+(\d+)\s*h(?:ou)?rs?\b(?:\s*(?:and\s+)?(\d+)\s*m(?:in(?:ute)?s?)?)?/i);
  if (relHM) {
    const mins = Number(relHM[1]) * 60 + Number(relHM[2] || 0);
    return new Date(now.getTime() + mins * MIN);
  }
  const relM = text.match(/\bin\s+(\d+)\s*m(?:in(?:ute)?s?)?\b/i);
  if (relM) return new Date(now.getTime() + Number(relM[1]) * MIN);

  let h = null, m = 0;
  const t12 = text.match(/\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?\b/i);
  if (t12) {
    h = Number(t12[1]) % 12 + (t12[3].toLowerCase() === 'p' ? 12 : 0);
    m = Number(t12[2] || 0);
  } else {
    const t24 = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (t24) { h = Number(t24[1]); m = Number(t24[2]); }
  }
  if (h === null) return null;
  const candidate = new Date(now);
  candidate.setHours(h, m, 0, 0);
  if (candidate <= now && now - candidate > GRACE_PAST_MS) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

// One event per terminal: a terminal can only be limited by one limit at a
// time, and keying by handle alone means banner-text mutations (our own
// echoed resume text, countdown digits) can never spawn duplicate events.
export const eventKey = (handle) => handle;

// observations: [{ handle, banner: { bannerText } | null }]
export function reconcile(state, observations, now, liveHandles = null) {
  const events = structuredClone(state);
  const sendCandidates = [];
  const obsHandles = new Set(observations.map((o) => o.handle));
  // Terminals that still EXIST this tick (from `terminal list`) — a superset of
  // the ones we managed to READ (obsHandles): a read can fail on transient orca
  // socket churn or be skipped by the read budget. When the caller doesn't
  // supply it (old callers/tests), fall back to obsHandles, preserving the
  // original delete-if-not-observed behavior.
  const live = liveHandles ? new Set(liveHandles) : obsHandles;
  const currentKeys = new Set();

  for (const o of observations) {
    if (!o.banner) continue;
    const key = eventKey(o.handle);
    currentKeys.add(key);
    if (!events[key]) {
      const resetAt = parseResetTime(o.banner.bannerText, now) ?? new Date(now.getTime() + 60 * MIN);
      events[key] = {
        handle: o.handle, bannerText: o.banner.bannerText,
        detectedAt: now.toISOString(), resetAt: resetAt.toISOString(),
        attempts: 0, lastAttemptAt: null, status: 'waiting',
      };
    }
  }

  for (const [key, ev] of Object.entries(events)) {
    if (!live.has(ev.handle)) { delete events[key]; continue; }   // terminal genuinely gone
    if (!obsHandles.has(ev.handle)) continue;                     // live but unread this tick: freeze state, don't reset attempts
    if (!currentKeys.has(key)) { delete events[key]; continue; }  // read OK, banner cleared: resume worked
    if (ev.status === 'resumed' && now - new Date(ev.lastAttemptAt) >= REARM_MS) {
      ev.status = ev.attempts >= MAX_ATTEMPTS ? 'gave_up' : 'waiting';
    }
    if (ev.status === 'waiting'
      && now - new Date(ev.resetAt) >= BUFFER_MS
      && ev.attempts < MAX_ATTEMPTS
      && (!ev.lastAttemptAt || now - new Date(ev.lastAttemptAt) >= RETRY_SPACING_MS)) {
      sendCandidates.push(key);
    }
  }
  return { events, sendCandidates };
}

// --- imperative shell ---

const pExecFile = promisify(execFile);

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
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.version === 1 && s.events && typeof s.events === 'object') return s.events;
    throw new Error('unexpected schema');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    try { fs.renameSync(STATE_FILE, `${STATE_FILE}.bad-${Date.now()}`); } catch { /* gone */ }
    log('warn', `state file unreadable (${e.message}); reset`);
    return {};
  }
}

function saveState(events) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, events }, null, 2));
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

async function readTail(handle) {
  const r = await orca(['terminal', 'read', '--terminal', handle]);
  return r.terminal?.tail ?? [];
}

async function tick({ dryRun }) {
  let terminals;
  try {
    terminals = (await orca(['terminal', 'list'])).terminals ?? [];
  } catch (e) {
    if (isUnavailableError(e)) { log('debug', `orca unavailable: ${e.message.split('\n')[0]}`); return; }
    throw e;
  }

  const observations = [];
  const startedAt = Date.now();
  for (const t of terminals.filter((t) => t.connected && t.writable)) {
    if (readBudgetExceeded(startedAt, Date.now())) {
      log('warn', `read budget (${READ_BUDGET_MS / MIN} min) spent; skipping remaining terminals this tick`);
      break;
    }
    try {
      observations.push({ handle: t.handle, banner: detectBanner(await readTail(t.handle)) });
    } catch (e) {
      log('warn', `read failed for ${t.handle}: ${e.message}`);
    }
  }

  const now = new Date();
  const state = loadState();
  // Pass the full set of terminals that still exist so reconcile can tell a
  // vanished terminal (delete its event) from one merely unread this tick
  // (keep its event) — a transient read failure or budget skip must not reset
  // attempt/backoff accounting and defeat RETRY_SPACING/MAX_ATTEMPTS.
  const liveHandles = terminals.map((t) => t.handle);
  const { events, sendCandidates } = reconcile(state, observations, now, liveHandles);

  for (const key of Object.keys(events)) {
    if (!state[key]) log('info', `detected limit on ${events[key].handle}, resetAt ${events[key].resetAt}`);
  }

  for (const key of sendCandidates) {
    const ev = events[key];
    if (dryRun) { log('info', `[dry-run] would resume ${ev.handle} (attempt ${ev.attempts + 1})`); console.log(`would resume ${ev.handle} (attempt ${ev.attempts + 1})`); continue; }
    try {
      await orca(['terminal', 'wait', '--terminal', ev.handle, '--for', 'tui-idle', '--timeout-ms', '5000']);
    } catch (e) {
      log('info', `skip ${ev.handle}: not idle (${e.message})`); continue;
    }
    // re-read immediately before sending: a limit banner must still be present
    let stillThere = false;
    try {
      stillThere = detectBanner(await readTail(ev.handle)) !== null;
    } catch { /* treated as gone */ }
    if (!stillThere) { log('info', `skip ${ev.handle}: banner cleared before send`); continue; }
    // persist the attempt BEFORE sending (at-most-once per attempt)
    ev.attempts += 1;
    ev.lastAttemptAt = now.toISOString();
    ev.status = 'resumed';
    saveState(events);
    await orca(['terminal', 'send', '--terminal', ev.handle, '--text', RESUME_TEXT, '--enter']);
    log('info', `resumed ${ev.handle} (attempt ${ev.attempts})`);
  }

  for (const [key, ev] of Object.entries(events)) {
    if (ev.status === 'gave_up' && state[key]?.status !== 'gave_up') {
      log('error', `GAVE UP on ${ev.handle} after ${ev.attempts} attempts — banner never cleared`);
    }
  }

  if (!dryRun) saveState(events);
  if (dryRun) console.log(`${Object.keys(events).length} active event(s), ${sendCandidates.length} send candidate(s)`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--status')) {
    const events = loadState();
    console.log(Object.keys(events).length === 0 ? 'no active events'
      : JSON.stringify({ version: 1, events }, null, 2));
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
    log('error', `tick failed: ${e.message}`);
  } finally {
    clearTimeout(deadline);
    if (!dryRun) fs.rmSync(LOCK_FILE, { force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
