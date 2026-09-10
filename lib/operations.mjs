import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VERSION } from '../version.mjs';

// Operational files are never inputs to the resume state machine.
export function assertRegular(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`expected regular, unlinked file (no symlink): ${file}`);
    if (stat.uid !== process.getuid()) throw new Error(`not owned by current user: ${file}`);
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error(`unsafe directory: ${dir}`);
  fs.chmodSync(dir, 0o700);
}

const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const outcomes = ['in-progress', 'success', 'unavailable', 'failed'];
export function readHealth(dir) {
  try {
    const file = path.join(dir, 'health.json');
    if (!assertRegular(file)) return { value: null, diagnostic: 'missing' };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.version !== 1 || typeof value.runtimeVersion !== 'string'
      || !iso(value.check?.startedAt) || !outcomes.includes(value.check.outcome)
      || (value.lastCompletedCheck !== null && (!iso(value.lastCompletedCheck?.at) || !outcomes.slice(1).includes(value.lastCompletedCheck?.outcome)))
      || (value.lastSuccessfulResume !== null && (!iso(value.lastSuccessfulResume?.at) || typeof value.lastSuccessfulResume?.handle !== 'string'))
      || !value.waiting || Array.isArray(value.waiting) || typeof value.waiting !== 'object'
      || Object.values(value.waiting).some(x => !iso(x?.at) || typeof x?.reason !== 'string')) throw new Error('invalid health schema');
    return { value, diagnostic: null };
  } catch (error) { return { value: null, diagnostic: error.message }; }
}

// Atomic, owner-only write shared by every operational file (health.json, the
// send-critical state.json): a private (0700, symlink/owner-guarded) dir, then an
// unpredictable temp created exclusively (flag 'wx' — never follows or reuses a
// pre-planted temp) and atomically renamed into place, with the temp always cleaned
// up. Concurrent readers see whole-old or whole-new content, never a torn write.
//
// checkTarget (default true) rejects a symlinked/hardlinked/foreign-owned DESTINATION
// before writing — the right policy for diagnostic files (health.json), whose reads
// also reject a tampered file. It is OFF for state.json: the rename already replaces
// the destination entry atomically WITHOUT following it (a symlink target is never
// written; other hardlinks keep the old inode), and refusing to write would let a
// tampered-but-valid state file block a legitimate resume send (DOG-29 #12).
export function atomicWriteFile(dir, name, contents, { checkTarget = true } = {}) {
  privateDirectory(dir);
  const file = path.join(dir, name);
  if (checkTarget) assertRegular(file);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
  return file;
}

export function writeHealth(dir, value) {
  atomicWriteFile(dir, 'health.json', JSON.stringify(value, null, 2) + '\n');
}

export function beginCheck(dir, now) {
  const previous = readHealth(dir).value;
  const health = { version: 1, runtimeVersion: VERSION,
    check: { startedAt: now.toISOString(), outcome: 'in-progress' },
    lastCompletedCheck: previous?.lastCompletedCheck ?? null,
    lastSuccessfulResume: previous?.lastSuccessfulResume ?? null, waiting: {} };
  writeHealth(dir, health);
  return health;
}

export async function runObservedCheck({ stateDir, dryRun, tick, deps = {} }) {
  if (dryRun) return tick({ dryRun }, deps);
  const now = deps.now ?? (() => new Date());
  let health;
  // Diagnostics must not prevent or authorize a tick, including permission and IO failures.
  try { health = beginCheck(stateDir, now()); } catch { /* metadata unavailable */ }
  // Both call sites are already health-guarded (observe returns early when !health;
  // the finally wraps this in `if (health)`), so persist need not re-check.
  const persist = () => { try { writeHealth(stateDir, health); } catch { /* best effort */ } };
  let outcome = 'success';
  const observe = (kind, handle, reason) => {
    if (!health) return;
    const at = now().toISOString();
    if (kind === 'unavailable') outcome = 'unavailable';
    if (kind === 'waiting') health.waiting[handle] = { at, reason };
    if (kind === 'resolved') delete health.waiting[handle];
    if (kind === 'resumed') { health.lastSuccessfulResume = { at, handle }; delete health.waiting[handle]; persist(); }
  };
  try { return await tick({ dryRun }, { ...deps, observe }); }
  catch (error) { outcome = 'failed'; throw error; }
  finally {
    if (health) {
      health.check.outcome = outcome;
      health.lastCompletedCheck = { at: now().toISOString(), outcome };
      persist();
    }
  }
}
