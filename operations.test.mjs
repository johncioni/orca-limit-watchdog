import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as operations from './lib/operations.mjs';
import { tick } from './watchdog.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-operations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('health is versioned, atomic, private and independent of event state', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'state.json'), 'untouched');
  const health = operations.beginCheck(dir, new Date('2026-09-10T10:00:00Z'));
  assert.equal(health.version, 1);
  assert.equal(operations.readHealth(dir).value.check.outcome, 'in-progress');
  assert.equal(fs.statSync(path.join(dir, 'health.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), 'untouched');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['health.json', 'state.json']);
});

test('missing, corrupt and unsupported health are unknown without writes', t => {
  const dir = fixture(t);
  assert.equal(operations.readHealth(dir).value, null);
  for (const text of ['{', '{"version":99}', '{"version":1,"check":{}}']) {
    fs.writeFileSync(path.join(dir, 'health.json'), text);
    assert.equal(operations.readHealth(dir).value, null);
    assert.equal(fs.readFileSync(path.join(dir, 'health.json'), 'utf8'), text);
  }
});

test('health rejects symlinks without changing their targets', t => {
  const dir = fixture(t), outside = path.join(dir, 'outside');
  fs.writeFileSync(outside, 'private');
  fs.symlinkSync(outside, path.join(dir, 'health.json'));
  assert.throws(() => operations.beginCheck(dir, new Date()), /symlink|regular/i);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'private');
});

for (const outcome of ['success', 'unavailable', 'failed']) {
  test(`check records ${outcome} with completed observation timestamp`, async t => {
    const dir = fixture(t);
    const deps = { orca: async () => {
      if (outcome !== 'success') throw Object.assign(new Error('fixture'), { code: outcome === 'unavailable' ? 'runtime_unavailable' : 'failure' });
      return { terminals: [] };
    }, loadState: () => ({}), saveState() {}, reapChoices() {}, log() {} };
    const run = operations.runObservedCheck({ stateDir: dir, dryRun: false, tick, deps });
    if (outcome === 'failed') await assert.rejects(run, /fixture/); else await run;
    const health = operations.readHealth(dir).value;
    assert.equal(health.check.outcome, outcome);
    assert.ok(health.lastCompletedCheck.at);
    assert.equal(health.lastSuccessfulResume, null);
  });
}

test('unfinished check stays in-progress and dry run does not create metadata', async t => {
  const dir = fixture(t);
  await operations.runObservedCheck({ stateDir: dir, dryRun: true, tick: async () => {} });
  assert.deepEqual(fs.readdirSync(dir), []);
  operations.beginCheck(dir, new Date('2020-01-01T00:00:00Z'));
  assert.equal(operations.readHealth(dir).value.check.outcome, 'in-progress');
});

test('observe(resolved) clears a waiting entry so a dropped event is not reported as waiting', async t => {
  const dir = fixture(t);
  await operations.runObservedCheck({
    stateDir: dir, dryRun: false, deps: { now: () => new Date('2020-01-01T00:00:00Z') },
    tick: async (_ctx, deps) => { deps.observe('waiting', 'term_x', 'reset time or retry delay'); deps.observe('resolved', 'term_x'); },
  });
  assert.deepEqual(operations.readHealth(dir).value.waiting, {});
});
