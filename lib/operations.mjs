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

export function writeHealth(dir, value) {
  privateDirectory(dir);
  const file = path.join(dir, 'health.json');
  assertRegular(file);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
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
  const persist = () => { if (health) { try { writeHealth(stateDir, health); } catch { /* best effort */ } } };
  let outcome = 'success';
  const observe = (kind, handle, reason) => {
    if (!health) return;
    const at = now().toISOString();
    if (kind === 'unavailable') outcome = 'unavailable';
    if (kind === 'waiting') health.waiting[handle] = { at, reason };
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
