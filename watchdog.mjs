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

// --- pure logic (unit-tested) ---

const LIMIT_RE = /((usage|rate|session|weekly|daily|\d+[- ]hour)\s+limit|quota)/i;
const REACHED_RE = /(reached|hit|exceeded)/i;
const RESET_RE = /(resets?\b|try again|available|come back)/i;
const VETO_RE = /approaching[^\n]*limit/i;

export function detectBanner(lines) {
  const window = lines.slice(-TAIL_LINES);
  const text = window.join('\n');
  if (VETO_RE.test(text)) return null;
  if (!(LIMIT_RE.test(text) && REACHED_RE.test(text) && RESET_RE.test(text))) return null;
  const relevant = window.filter((l) => LIMIT_RE.test(l) || RESET_RE.test(l));
  return { bannerText: relevant.map((l) => l.trim()).join(' | ') };
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
export function reconcile(state, observations, now) {
  const events = structuredClone(state);
  const sendCandidates = [];
  const obsHandles = new Set(observations.map((o) => o.handle));
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
    if (!obsHandles.has(ev.handle) || !currentKeys.has(key)) { delete events[key]; continue; }
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
    if (age > 10 * MIN) fs.rmSync(LOCK_FILE, { force: true });
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
    if (e.code === 'runtime_unavailable') { log('debug', 'orca not running'); return; }
    throw e;
  }

  const observations = [];
  for (const t of terminals.filter((t) => t.connected && t.writable)) {
    try {
      observations.push({ handle: t.handle, banner: detectBanner(await readTail(t.handle)) });
    } catch (e) {
      log('warn', `read failed for ${t.handle}: ${e.message}`);
    }
  }

  const now = new Date();
  const state = loadState();
  const { events, sendCandidates } = reconcile(state, observations, now);

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
