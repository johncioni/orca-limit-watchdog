import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as logs from './lib/logs.mjs';
import { spawnSync, spawn } from 'node:child_process';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-logs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('logs default to newest 100 lines, validate options, and tolerate missing files', t => {
  const dir = fixture(t), file = path.join(dir, 'watchdog.log');
  assert.equal(logs.readLog(file, 100), '');
  fs.writeFileSync(file, Array.from({ length: 120 }, (_, i) => `line ${i}\n`).join(''));
  assert.equal(logs.readLog(file, 100).split('\n')[0], 'line 20');
  assert.equal(logs.readLog(file, 2), 'line 118\nline 119\n');
  assert.deepEqual(logs.parseLogArgs([]), { lines: 100, source: 'activity', follow: false });
  for (const args of [['--lines', '0'], ['--lines', '-2'], ['--lines', '1.5'], ['--source', 'bad'], ['--follow', 'x']]) assert.throws(() => logs.parseLogArgs(args));
});
test('readLog honors --lines N beyond the 500KB retention tail (does not silently cap)', t => {
  const dir = fixture(t), file = path.join(dir, 'launchd.err.log');
  const count = 60000;
  fs.writeFileSync(file, Array.from({ length: count }, (_, i) => `line ${i}`).join('\n') + '\n');
  assert.ok(fs.statSync(file).size > 500_000, 'fixture must exceed the retention cap');
  const all = logs.readLog(file, count).split('\n').filter(Boolean);
  assert.equal(all.length, count);
  assert.equal(all[0], 'line 0');
  assert.equal(all.at(-1), `line ${count - 1}`);
  // Asking for more lines than exist returns them all, not a byte-capped subset.
  assert.equal(logs.readLog(file, count + 500).split('\n').filter(Boolean).length, count);
});
test('retention bounds bytes and lines, handles Unicode and huge lines, preserves inode', t => {
  const dir = fixture(t), file = path.join(dir, 'watchdog.log');
  for (const contents of ['😀'.repeat(300_000), ('a\n').repeat(600_000), 'a'.repeat(1_100_000) + '\nnewest\n']) {
    fs.writeFileSync(file, contents, { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const ino = fs.statSync(file).ino;
    logs.maintainLog(file, 500);
    const value = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(value) <= 500_000);
    assert.ok(value.trimEnd().split('\n').length <= 500);
    assert.ok(!value.includes('\ufffd'));
    assert.equal(fs.statSync(file).ino, ino);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});
test('maintainLogs bounds only the named log; the finally pass spares launchd stdout/stderr until the next start pass (DOG-29 #11)', t => {
  const dir = fixture(t);
  const big = ('x\n').repeat(600_000);   // 1.2MB > THRESHOLD, many lines
  for (const name of Object.values(logs.LOG_FILES)) fs.writeFileSync(path.join(dir, name), big, { mode: 0o600 });
  // The per-tick finally pass targets only the activity log (the sole log a tick appends to).
  logs.maintainLogs(dir, 'activity');
  assert.ok(fs.statSync(path.join(dir, logs.LOG_FILES.activity)).size <= 500_000, 'activity is trimmed');
  assert.equal(fs.statSync(path.join(dir, logs.LOG_FILES.stdout)).size, big.length, 'launchd stdout untouched');
  assert.equal(fs.statSync(path.join(dir, logs.LOG_FILES.stderr)).size, big.length, 'launchd stderr untouched');
  // The unfiltered start pass still bounds all three.
  logs.maintainLogs(dir);
  for (const name of Object.values(logs.LOG_FILES)) assert.ok(fs.statSync(path.join(dir, name)).size <= 500_000);
});
test('appendActivity creates a 0600 log, accumulates appends, and refuses symlink/hardlink targets (DOG-29 #10)', t => {
  const dir = fixture(t), file = path.join(dir, logs.LOG_FILES.activity);
  logs.appendActivity(dir, 'first\n');
  logs.appendActivity(dir, 'second\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'first\nsecond\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // Symlinked activity path: O_NOFOLLOW must refuse it and leave the target untouched.
  const outside = path.join(dir, 'outside');
  fs.writeFileSync(outside, 'untouched');
  fs.rmSync(file);
  fs.symlinkSync(outside, file);
  assert.throws(() => logs.appendActivity(dir, 'evil\n'));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
  // Hardlinked activity path (nlink > 1): must be rejected, target left untouched.
  fs.rmSync(file);
  fs.linkSync(outside, file);
  assert.throws(() => logs.appendActivity(dir, 'evil\n'), /unsafe log|regular|unlinked/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});
test('appendActivity rejects a FIFO activity log fast instead of blocking the tick on open (DOG-29 #10 round-2)', t => {
  if (process.platform === 'win32') return;
  const dir = fixture(t);
  const file = path.join(dir, logs.LOG_FILES.activity);
  const mk = spawnSync('mkfifo', [file]);
  assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`);
  // A plain O_WRONLY open on a reader-less FIFO blocks forever, hanging the tick
  // (the block escapes both the try/catch and the tick deadline). Run in a
  // subprocess with a hard timeout: a hang shows up as a kill signal.
  const logsUrl = new URL('./lib/logs.mjs', import.meta.url).href;
  const script = `import * as logs from ${JSON.stringify(logsUrl)};`
    + `try { logs.appendActivity(${JSON.stringify(dir)}, 'x\\n'); console.log('NO_THROW'); }`
    + `catch { console.log('REJECTED'); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 3000, encoding: 'utf8' });
  assert.equal(r.signal, null, 'appendActivity blocked on the FIFO (killed by timeout)');
  assert.match(r.stdout, /REJECTED/, `expected FIFO rejection, got stdout=${JSON.stringify(r.stdout)}`);
});
test('log symlinks and hard links are rejected for reads and retention', t => {
  const dir = fixture(t), target = path.join(dir, 'target'), link = path.join(dir, 'log');
  fs.writeFileSync(target, 'untouched');
  fs.symlinkSync(target, link);
  assert.throws(() => logs.readLog(link, 100), /symlink|regular/);
  assert.throws(() => logs.maintainLog(link), /symlink|regular/);
  fs.unlinkSync(link); fs.linkSync(target, link);
  assert.throws(() => logs.maintainLog(link), /regular/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
});
test('follow observes creation, append, truncate and replace and aborts cleanly', async t => {
  const dir = fixture(t), file = path.join(dir, 'watchdog.log');
  const abort = new AbortController();
  let output = '';
  const following = logs.followLog(file, { lines: 100, signal: abort.signal, write: text => { output += text; }, interval: 10 });
  const until = async text => {
    for (let i = 0; i < 100 && !output.includes(text); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(output.includes(text), JSON.stringify(output));
  };
  try {
    fs.writeFileSync(file, 'first\n'); await until('first');
    fs.appendFileSync(file, '😀 appended\n'); await until('😀 appended');
    fs.writeFileSync(file, 'short\n'); await until('short');
    fs.renameSync(file, file + '.old'); fs.writeFileSync(file, 'replacement\n'); await until('replacement');
  } finally { abort.abort(); await following; }
});

test('CLI logs is read-only and follow exits cleanly on SIGINT', async t => {
  const home = fixture(t), dir = path.join(home, '.local/state/orca-watchdog');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'launchd.err.log');
  fs.writeFileSync(file, 'one\ntwo\n', { mode: 0o644 });
  const env = { ...process.env, HOME: home };
  const result = spawnSync(process.execPath, ['bin/orca-watchdog.mjs', 'logs', '--source', 'stderr', '--lines', '1'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout, 'two\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  const child = spawn(process.execPath, ['bin/orca-watchdog.mjs', 'logs', '--source', 'stderr', '--follow'], { env });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  child.kill('SIGINT');
  assert.deepEqual(await exit, { code: 0, signal: null });
});

test('dry-run and lock contention do not retain logs or write health; locked ticks retain all logs', t => {
  const home = fixture(t), dir = path.join(home, '.local/state/orca-watchdog');
  fs.mkdirSync(dir, { recursive: true });
  const orca = path.join(home, 'fake-orca');
  fs.writeFileSync(orca, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"result":{"terminals":[]}}\'\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, ORCA_CLI: orca };
  const file = path.join(dir, 'watchdog.log');
  for (const name of Object.values(logs.LOG_FILES)) fs.writeFileSync(path.join(dir, name), 'a'.repeat(1_100_000));
  fs.writeFileSync(path.join(dir, 'state.json'), '{broken');
  const run = arg => { const r = spawnSync(process.execPath, ['watchdog.mjs', arg], { env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  run('--dry-run');
  assert.equal(fs.statSync(file).size, 1_100_000);
  assert.equal(fs.existsSync(path.join(dir, 'health.json')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), '{broken');
  fs.writeFileSync(path.join(dir, 'lock'), 'fixture'); run('--once');
  assert.equal(fs.statSync(file).size, 1_100_000);
  assert.equal(fs.existsSync(path.join(dir, 'health.json')), false);
  fs.unlinkSync(path.join(dir, 'lock'));
  fs.writeFileSync(path.join(dir, 'state.json'), '{"version":2,"events":{}}');
  run('--once');
  for (const name of Object.values(logs.LOG_FILES)) assert.ok(fs.statSync(path.join(dir, name)).size <= 500_000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'health.json'))).check.outcome, 'success');
});
