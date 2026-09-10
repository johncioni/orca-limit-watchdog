import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pExecFile = promisify(execFile);
const ROOT = process.cwd();
const CLI = path.join(ROOT, 'bin', 'orca-watchdog.mjs');

async function loadManagement() {
  return import('./lib/management.mjs');
}

function executable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function harness(prefix = 'wd management ') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(base, 'Home with spaces & ü');
  const fakeBin = path.join(base, 'fake bin');
  const launchctlState = path.join(base, 'launchctl.registered');
  const launchctlLog = path.join(base, 'launchctl.log');
  const orcaLog = path.join(base, 'orca.log');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });

  const launchctl = path.join(fakeBin, 'launchctl');
  executable(launchctl, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LAUNCHCTL_LOG"
case "$1" in
  print) test -f "$FAKE_LAUNCHCTL_STATE" ;;
  bootstrap) printf registered > "$FAKE_LAUNCHCTL_STATE" ;;
  bootout) /bin/rm -f "$FAKE_LAUNCHCTL_STATE" ;;
  *) exit 64 ;;
esac
`);
  const orca = path.join(fakeBin, 'orca <&> α');
  executable(orca, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_ORCA_LOG"
case "$*" in
  "terminal list --help"|"terminal read --help"|"terminal wait --help"|"terminal send --help") exit 0 ;;
  *) exit 64 ;;
esac
`);

  const env = {
    ...process.env,
    HOME: home,
    PATH: '/usr/bin:/bin',
    ORCA_CLI: orca,
    ORCA_WATCHDOG_NODE: process.execPath,
    ORCA_WATCHDOG_LAUNCHCTL: launchctl,
    FAKE_LAUNCHCTL_STATE: launchctlState,
    FAKE_LAUNCHCTL_LOG: launchctlLog,
    FAKE_ORCA_LOG: orcaLog,
  };
  return {
    base, home, orca, launchctlState, launchctlLog, orcaLog, env,
    cleanup() { fs.rmSync(base, { recursive: true, force: true }); },
  };
}

function releaseCopy(base, version, mutate) {
  const release = path.join(base, `release-${version}`);
  fs.cpSync(ROOT, release, {
    recursive: true,
    filter(source) {
      const relative = path.relative(ROOT, source);
      return relative !== '.git' && !relative.startsWith(`.git${path.sep}`)
        && relative !== '.superpowers' && !relative.startsWith(`.superpowers${path.sep}`)
        && relative !== 'dist' && relative !== 'HANDOFF.md';
    },
  });
  fs.writeFileSync(path.join(release, 'version.mjs'), `export const VERSION = '${version}';\n`);
  mutate?.(release);
  return release;
}

async function runInstall(release, args, env) {
  return pExecFile('/bin/bash', [path.join(release, 'install.sh'), ...args], { cwd: release, env });
}

async function runCli(args, env) {
  return pExecFile(process.execPath, [CLI, ...args], { cwd: ROOT, env });
}

test('plist rendering XML-escapes executable and data paths', async () => {
  const { renderPlist } = await loadManagement();
  const xml = renderPlist({
    nodePath: '/opt/Node & Sons/node',
    watchdogPath: '/Users/Jöhn/<watchdog>/watchdog.mjs',
    stateDir: '/tmp/state "quoted" & ready',
    orcaPath: '/Applications/Orca <Beta>/orca',
  });
  assert.match(xml, /Node &amp; Sons/);
  assert.match(xml, /Jöhn\/&lt;watchdog&gt;/);
  assert.match(xml, /state &quot;quoted&quot; &amp; ready/);
  assert.match(xml, /Orca &lt;Beta&gt;/);
  assert.doesNotMatch(xml, /__\w+__/);
});

test('executable resolution rejects missing and non-executable paths clearly', async () => {
  const { resolveExecutable } = await loadManagement();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-exec-'));
  const malformed = path.join(tmp, 'orca');
  fs.writeFileSync(malformed, '#!/bin/sh\n');
  try {
    assert.throws(() => resolveExecutable('/definitely/missing/orca', ''), /not found.*ORCA_CLI/i);
    assert.throws(() => resolveExecutable(malformed, ''), /not executable.*ORCA_CLI/i);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('public CLI help/version do not inspect terminals and unknown args fail closed', async () => {
  const h = harness();
  try {
    const noArgs = await runCli([], h.env);
    assert.match(noArgs.stdout, /Usage: orca-watchdog/);
    const help = await runCli(['--help'], h.env);
    assert.match(help.stdout, /doctor.*start.*stop/s);
    const { VERSION } = await loadManagement();
    const version = await runCli(['--version'], h.env);
    assert.equal(version.stdout.trim(), `orca-watchdog ${VERSION}`);
    await assert.rejects(runCli(['--bogus'], h.env), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /unknown command.*--bogus/i);
      return true;
    });
    assert.equal(fs.existsSync(h.orcaLog), false);
    assert.equal(fs.existsSync(h.launchctlLog), false);
  } finally { h.cleanup(); }
});

test('doctor reports prerequisites and never sends terminal input', async () => {
  const h = harness();
  try {
    const { stdout } = await runCli(['doctor'], h.env);
    assert.match(stdout, /macOS:\s+ok/);
    assert.match(stdout, /Node:\s+ok/);
    assert.match(stdout, /Orca CLI:\s+ok/);
    assert.match(stdout, /launchd:\s+stopped/);
    const calls = fs.readFileSync(h.orcaLog, 'utf8');
    assert.doesNotMatch(calls, /^terminal send$/m);
    assert.equal(calls.trim().split('\n').length, 4);
  } finally { h.cleanup(); }
});

test('start resolves absolute paths, validates a real plist, and repeat start does not duplicate registration', async () => {
  const h = harness();
  try {
    const first = await runCli(['start'], h.env);
    assert.match(first.stdout, /started/);
    const plist = path.join(h.home, 'Library', 'LaunchAgents', 'com.john.orca-watchdog.plist');
    await pExecFile('/usr/bin/plutil', ['-lint', plist]);
    const xml = fs.readFileSync(plist, 'utf8');
    assert.match(xml, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(xml, /orca &lt;&amp;&gt; α/);
    assert.match(xml, /<key>ORCA_CLI<\/key>/);
    await assert.rejects(runCli(['start'], h.env), /already running/i);
    const calls = fs.readFileSync(h.launchctlLog, 'utf8').trim().split('\n');
    assert.equal(calls.filter((line) => line.startsWith('bootstrap ')).length, 1);
    assert.doesNotMatch(fs.readFileSync(h.orcaLog, 'utf8'), /^terminal send$/m);
  } finally { h.cleanup(); }
});

test('pause, resume, stop, and status keep service, pause, and events separate', async () => {
  const h = harness();
  try {
    await runCli(['start'], h.env);
    await runCli(['pause'], h.env);
    const paused = await runCli(['status'], h.env);
    assert.match(paused.stdout, /service:\s+registered/);
    assert.match(paused.stdout, /pause:\s+paused/);
    assert.match(paused.stdout, /events:\s+none/);
    await runCli(['resume'], h.env);
    assert.match((await runCli(['status'], h.env)).stdout, /pause:\s+active/);
    await runCli(['stop'], h.env);
    assert.match((await runCli(['status'], h.env)).stdout, /service:\s+stopped/);
  } finally { h.cleanup(); }
});

test('status labels registration, running process and health observations separately', async () => {
  const h = harness();
  try {
    const { statusText, installPaths } = await loadManagement();
    fs.writeFileSync(h.launchctlState, 'registered');
    const paths = installPaths(h.home);
    let output = statusText({ env: h.env });
    assert.match(output, /service: registered.*periodic/);
    assert.match(output, /process: unknown/);
    assert.match(output, /installed version:/);
    assert.match(output, /last completed check: unknown/);
    const { beginCheck } = await import('./lib/operations.mjs');
    beginCheck(paths.stateDir, new Date('2020-01-01T00:00:00Z'));
    output = statusText({ env: h.env });
    assert.match(output, /stale/);
    assert.match(output, /in-progress.*interrupted/);
  } finally { h.cleanup(); }
});

test('doctor inspects saved and loaded paths, stable symlinks, stale versions and malformed metadata read-only', async () => {
  const h = harness();
  try {
    const { doctorText, installPaths, VERSION } = await loadManagement();
    const paths = installPaths(h.home);
    fs.mkdirSync(paths.launchAgentsDir, { recursive: true });
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const stableNode = path.join(h.base, 'stable node'); fs.symlinkSync(process.execPath, stableNode);
    const runtime = path.join(h.base, 'runtime'); fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, 'watchdog.mjs'), '// fixture');
    fs.writeFileSync(path.join(runtime, 'version.mjs'), `export const VERSION = '${VERSION}';`);
    const config = { ProgramArguments: [stableNode, path.join(runtime, 'watchdog.mjs')], EnvironmentVariables: { ORCA_CLI: h.orca } };
    const plutil = path.join(h.base, 'plutil');
    executable(plutil, '#!/bin/sh\n/bin/cat "$FAKE_PLIST_JSON"\n');
    h.env.ORCA_WATCHDOG_PLUTIL = plutil;
    h.env.FAKE_PLIST_JSON = path.join(h.base, 'config.json');
    fs.writeFileSync(h.env.FAKE_PLIST_JSON, JSON.stringify(config));
    fs.writeFileSync(paths.plistPath, 'saved fixture');
    let result = doctorText({ env: h.env });
    assert.equal(result.failed, false, result.text);
    assert.match(result.text, /saved Node: ok/);
    assert.match(result.text, /saved runtime: ok/);
    assert.match(result.text, /stopped/);
    executable(h.env.ORCA_WATCHDOG_LAUNCHCTL, '#!/bin/sh\n/bin/cat "$FAKE_LOADED_JOB"\n');
    h.env.FAKE_LOADED_JOB = path.join(h.base, 'loaded.txt');
    const loaded = `job = {\n state = not running\n arguments = {\n ${stableNode}\n ${config.ProgramArguments[1]}\n }\n environment = {\n ORCA_CLI => ${h.orca}\n }\n}`;
    fs.writeFileSync(h.env.FAKE_LOADED_JOB, loaded);
    result = doctorText({ env: h.env });
    assert.equal(result.failed, false, result.text);
    assert.match(result.text, /saved\/loaded: agree/);
    fs.writeFileSync(path.join(runtime, 'version.mjs'), "export const VERSION = '0.0.0';");
    result = doctorText({ env: h.env });
    assert.equal(result.failed, true); assert.match(result.text, /stale.*0\.0\.0/);
    fs.writeFileSync(h.env.FAKE_LOADED_JOB, loaded.replace(stableNode, '/missing/node'));
    result = doctorText({ env: h.env });
    assert.equal(result.failed, true); assert.match(result.text, /saved\/loaded:.*disagree/);
    assert.match(result.text, /loaded Node: error/);
    assert.match(result.text, /orca-watchdog stop/);
    fs.writeFileSync(paths.stateFile, '{"version":2,"events":{"bad":{}}}');
    fs.writeFileSync(paths.healthFile, '{broken');
    result = doctorText({ env: h.env });
    assert.match(result.text, /event state: error/); assert.match(result.text, /health:.*unknown/);
    assert.equal(fs.readFileSync(paths.healthFile, 'utf8'), '{broken');
    assert.equal(fs.readFileSync(paths.stateFile, 'utf8'), '{"version":2,"events":{"bad":{}}}');
    assert.equal(fs.readFileSync(paths.plistPath, 'utf8'), 'saved fixture');
    assert.doesNotMatch(fs.readFileSync(h.launchctlLog, 'utf8'), /bootstrap|bootout/);
  } finally { h.cleanup(); }
});

test('start works with a restricted PATH and never invokes env lookup under launchd', async () => {
  const h = harness();
  try {
    await runCli(['start'], { ...h.env, PATH: '/empty' });
    const plist = fs.readFileSync(path.join(h.home, 'Library', 'LaunchAgents', 'com.john.orca-watchdog.plist'), 'utf8');
    assert.match(plist, new RegExp(`<string>${process.execPath.replace(/&/g, '&amp;')}</string>`));
    assert.match(plist, /<key>PATH<\/key>\s*<string>\/usr\/bin:\/bin<\/string>/);
  } finally { h.cleanup(); }
});

test('start preserves an explicit stable Node symlink in the plist', async () => {
  const h = harness();
  try {
    const symlinkPath = path.join(path.dirname(h.orca), 'stable-node');
    fs.symlinkSync(process.execPath, symlinkPath);
    await runCli(['start'], { ...h.env, ORCA_WATCHDOG_NODE: symlinkPath });
    const plist = fs.readFileSync(path.join(h.home, 'Library', 'LaunchAgents', 'com.john.orca-watchdog.plist'), 'utf8');
    assert.ok(plist.includes(`<string>${symlinkPath}</string>`));
    assert.ok(!plist.includes(`<string>${fs.realpathSync(symlinkPath)}</string>`));
  } finally { h.cleanup(); }
});

for (const kind of ['missing', 'non-executable']) {
  test(`${kind} Node override is an actionable start error and never registers`, async () => {
    const h = harness();
    try {
      const nodePath = path.join(path.dirname(h.orca), 'invalid-node');
      if (kind === 'non-executable') fs.writeFileSync(nodePath, '#!/bin/sh\n', { mode: 0o644 });
      await assert.rejects(
        runCli(['start'], { ...h.env, ORCA_WATCHDOG_NODE: nodePath }),
        kind === 'missing' ? /Node.*not found.*absolute executable path/i : /Node.*not executable.*absolute executable path/i,
      );
      assert.equal(fs.existsSync(h.launchctlState), false);
      const calls = fs.existsSync(h.launchctlLog) ? fs.readFileSync(h.launchctlLog, 'utf8') : '';
      assert.doesNotMatch(calls, /bootstrap/);
    } finally { h.cleanup(); }
  });
}

test('missing Orca is an actionable start error and never registers', async () => {
  const h = harness();
  try {
    await assert.rejects(runCli(['start'], { ...h.env, ORCA_CLI: '/missing/orca' }), /not found.*ORCA_CLI/i);
    assert.equal(fs.existsSync(h.launchctlState), false);
    const calls = fs.existsSync(h.launchctlLog) ? fs.readFileSync(h.launchctlLog, 'utf8') : '';
    assert.doesNotMatch(calls, /bootstrap/);
  } finally { h.cleanup(); }
});

test('archive install is stopped and repeatable; upgrade requires stop and failed validation rolls back', async () => {
  const h = harness('wd archive ');
  try {
    const v1 = releaseCopy(h.base, '0.1.0');
    const first = await runInstall(v1, [], h.env);
    assert.match(first.stdout, /installed 0\.1\.0.*stopped/s);
    const share = path.join(h.home, '.local', 'share', 'orca-watchdog');
    const current = path.join(share, 'current');
    const command = path.join(h.home, '.local', 'bin', 'orca-watchdog');
    assert.equal(fs.readlinkSync(current), '0.1.0');
    assert.equal(fs.realpathSync(command), fs.realpathSync(path.join(share, '0.1.0', 'bin', 'orca-watchdog')));
    await runInstall(v1, [], h.env);
    assert.equal(fs.readlinkSync(current), '0.1.0');
    const launchCalls = fs.readFileSync(h.launchctlLog, 'utf8');
    assert.doesNotMatch(launchCalls, /bootstrap|bootout/);
    assert.equal(fs.existsSync(h.orcaLog), false);

    const v2 = releaseCopy(h.base, '0.2.0');
    fs.writeFileSync(h.launchctlState, 'registered');
    await assert.rejects(runInstall(v2, [], h.env), /stop.*before.*upgrade/i);
    assert.equal(fs.readlinkSync(current), '0.1.0');
    fs.rmSync(h.launchctlState);
    await runInstall(v2, [], h.env);
    assert.equal(fs.readlinkSync(current), '0.2.0');
    assert.equal(fs.readlinkSync(path.join(share, 'previous')), '0.1.0');
    assert.equal(fs.existsSync(path.join(share, '0.1.0')), true);

    const bad = releaseCopy(h.base, '0.3.0', (release) => fs.rmSync(path.join(release, 'watchdog.mjs')));
    await assert.rejects(runInstall(bad, [], h.env), /release file missing.*watchdog\.mjs/i);
    assert.equal(fs.readlinkSync(current), '0.2.0');

    const rollback = await runInstall(v2, ['--rollback'], h.env);
    assert.match(rollback.stdout, /rolled back.*0\.1\.0/i);
    assert.equal(fs.readlinkSync(current), '0.1.0');
    assert.equal(fs.readlinkSync(path.join(share, 'previous')), '0.2.0');
  } finally { h.cleanup(); }
});

test('status counts v1 state events correctly (empty ⇒ none, not the wrapper keys) (DOG-24)', async () => {
  const h = harness('wd v1count ');
  try {
    const { statusText, installPaths } = await loadManagement();
    const paths = installPaths(h.home);
    fs.mkdirSync(path.dirname(paths.stateFile), { recursive: true });
    fs.writeFileSync(paths.stateFile, JSON.stringify({ version: 1, events: {} }));
    assert.match(statusText({ env: h.env }), /events:\s+none/);
    fs.writeFileSync(paths.stateFile, JSON.stringify({ version: 1, events: { a: {}, b: {} } }));
    assert.match(statusText({ env: h.env }), /events:\s+2/);
  } finally { h.cleanup(); }
});

test('serviceIsRunning throws on a launchctl spawn error rather than reporting "stopped" (DOG-24)', async () => {
  const h = harness('wd svc ');
  try {
    const { serviceIsRunning } = await loadManagement();
    // launchctl resolves as executable but cannot exec (bad interpreter) ⇒ spawnSync
    // returns {error, status:null}. An unknown state must NOT read as "not running".
    executable(h.env.ORCA_WATCHDOG_LAUNCHCTL, '#!/nonexistent-interp-xyz-123\n');
    assert.throws(() => serviceIsRunning(h.env), /launchctl|spawn|ENOENT/i);
  } finally { h.cleanup(); }
});

test('install that throws at the command-link step leaves current unchanged (DOG-24)', async () => {
  const h = harness('wd cmdlink ');
  try {
    const { installRelease } = await loadManagement();
    const v1 = releaseCopy(h.base, '0.1.0');
    installRelease({ sourceRoot: v1, version: '0.1.0', env: h.env });
    const share = path.join(h.home, '.local', 'share', 'orca-watchdog');
    const current = path.join(share, 'current');
    assert.equal(fs.readlinkSync(current), '0.1.0');
    // Put a regular file where the command symlink lives so the command-link step throws.
    const commandLink = path.join(h.home, '.local', 'bin', 'orca-watchdog');
    fs.rmSync(commandLink);
    fs.writeFileSync(commandLink, 'not a symlink');
    const v2 = releaseCopy(h.base, '0.2.0');
    assert.throws(() => installRelease({ sourceRoot: v2, version: '0.2.0', env: h.env }), /non-symlink/);
    assert.equal(fs.readlinkSync(current), '0.1.0', 'current must not switch when the install fails');
  } finally { h.cleanup(); }
});

test('stopped legacy registration migrates on start without duplicate registration', async () => {
  const h = harness('wd migrate ');
  try {
    const oldPlist = path.join(h.home, 'Library', 'LaunchAgents', 'com.john.orca-watchdog.plist');
    fs.mkdirSync(path.dirname(oldPlist), { recursive: true });
    fs.writeFileSync(oldPlist, '<plist><string>/old/disposable/worktree/watchdog.mjs</string></plist>');
    const release = releaseCopy(h.base, '0.1.0');
    await runInstall(release, [], h.env);
    const command = path.join(h.home, '.local', 'bin', 'orca-watchdog');
    await pExecFile(command, ['start'], { env: h.env });
    const migrated = fs.readFileSync(oldPlist, 'utf8');
    assert.doesNotMatch(migrated, /old\/disposable/);
    assert.match(migrated, /\.local\/share\/orca-watchdog\/0\.1\.0\/watchdog\.mjs/);
    const calls = fs.readFileSync(h.launchctlLog, 'utf8').trim().split('\n');
    assert.equal(calls.filter((line) => line.startsWith('bootstrap ')).length, 1);
  } finally { h.cleanup(); }
});

test('uninstall requires a stopped service and retains event state and pause', async () => {
  const h = harness('wd uninstall ');
  try {
    const release = releaseCopy(h.base, '0.1.0');
    await runInstall(release, [], h.env);
    const stateDir = path.join(h.home, '.local', 'state', 'orca-watchdog');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state.json'), '{"version":2,"events":{}}\n');
    fs.writeFileSync(path.join(stateDir, 'disabled'), '');
    fs.writeFileSync(h.launchctlState, 'registered');
    await assert.rejects(
      pExecFile('/bin/bash', [path.join(release, 'uninstall.sh')], { env: h.env }),
      /stop.*before.*uninstall/i,
    );
    assert.equal(fs.existsSync(path.join(h.home, '.local', 'share', 'orca-watchdog')), true);
    fs.rmSync(h.launchctlState);
    const removed = await pExecFile('/bin/bash', [path.join(release, 'uninstall.sh')], { env: h.env });
    assert.match(removed.stdout, /uninstalled.*state retained/i);
    assert.equal(fs.existsSync(path.join(h.home, '.local', 'share', 'orca-watchdog')), false);
    assert.equal(fs.existsSync(path.join(h.home, '.local', 'bin', 'orca-watchdog')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'state.json')), true);
    assert.equal(fs.existsSync(path.join(stateDir, 'disabled')), true);
  } finally { h.cleanup(); }
});

test('installer and uninstaller reject unknown arguments before mutation', async () => {
  const h = harness('wd args ');
  try {
    const release = releaseCopy(h.base, '0.1.0');
    await assert.rejects(runInstall(release, ['--wat'], h.env), /unknown argument.*--wat/i);
    await assert.rejects(
      pExecFile('/bin/bash', [path.join(release, 'uninstall.sh'), '--wat'], { env: h.env }),
      /unknown argument.*--wat/i,
    );
    assert.equal(fs.existsSync(path.join(h.home, '.local', 'share', 'orca-watchdog')), false);
  } finally { h.cleanup(); }
});

test('serviceIsRunning throws on a signal-killed launchctl (fail closed like inspectService)', async () => {
  const { serviceIsRunning } = await loadManagement();
  const h = harness('wd signal ');
  try {
    executable(h.env.ORCA_WATCHDOG_LAUNCHCTL, '#!/bin/sh\nkill -KILL $$\n');
    assert.throws(() => serviceIsRunning(h.env), /could not check service state/);
  } finally { h.cleanup(); }
});

test('logs tolerates a reader that closes the pipe early (no EPIPE crash)', async () => {
  const h = harness('wd epipe ');
  try {
    const dir = path.join(h.home, '.local', 'state', 'orca-watchdog');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'launchd.err.log'), ('x'.repeat(200) + '\n').repeat(20000), { mode: 0o600 });
    const child = spawn(process.execPath, [CLI, 'logs', '--source', 'stderr', '--lines', '20000'], { env: h.env });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const exit = new Promise((res, rej) => { child.once('error', rej); child.once('exit', (code, signal) => res({ code, signal })); });
    await new Promise((res, rej) => { child.stdout.once('data', res); child.once('error', rej); });
    child.stdout.destroy();   // mimic `| head`: reader closes the pipe early
    const { code } = await exit;
    assert.doesNotMatch(stderr, /EPIPE|Unhandled/, stderr);
    assert.equal(code, 0);
  } finally { h.cleanup(); }
});

test('doctor on an incomplete archive (no watchdog.mjs) diagnoses state.json without crashing on validateEvent', async () => {
  const h = harness('wd incomplete ');
  try {
    const { VERSION, installPaths } = await loadManagement();
    const release = releaseCopy(h.base, VERSION, (r) => fs.rmSync(path.join(r, 'watchdog.mjs')));
    const paths = installPaths(h.home);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(paths.stateFile, '{"version":2,"events":{"term_x":{"handle":"term_x"}}}');
    const r = spawnSync(process.execPath, [path.join(release, 'bin', 'orca-watchdog.mjs'), 'doctor'], { env: h.env, encoding: 'utf8' });
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /validateEvent is not a function/, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /event state:.*(runtime missing|cannot validate)/);
  } finally { h.cleanup(); }
});

test('doctor does not fabricate a saved/loaded mismatch when launchctl output is not scrapeable (DOG-29 #8)', async () => {
  const h = harness('wd reword ');
  try {
    const { doctorText, installPaths, VERSION } = await loadManagement();
    const paths = installPaths(h.home);
    fs.mkdirSync(paths.launchAgentsDir, { recursive: true });
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const stableNode = path.join(h.base, 'stable node'); fs.symlinkSync(process.execPath, stableNode);
    const runtime = path.join(h.base, 'runtime'); fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, 'watchdog.mjs'), '// fixture');
    fs.writeFileSync(path.join(runtime, 'version.mjs'), `export const VERSION = '${VERSION}';`);
    const config = { ProgramArguments: [stableNode, path.join(runtime, 'watchdog.mjs')], EnvironmentVariables: { ORCA_CLI: h.orca } };
    const plutil = path.join(h.base, 'plutil');
    executable(plutil, '#!/bin/sh\n/bin/cat "$FAKE_PLIST_JSON"\n');
    h.env.ORCA_WATCHDOG_PLUTIL = plutil;
    h.env.FAKE_PLIST_JSON = path.join(h.base, 'config.json');
    fs.writeFileSync(h.env.FAKE_PLIST_JSON, JSON.stringify(config));
    fs.writeFileSync(paths.plistPath, 'saved fixture');
    // A registered job whose output has NO scrapeable `arguments = { }` block
    // (as a future macOS launchctl reword could produce).
    executable(h.env.ORCA_WATCHDOG_LAUNCHCTL, '#!/bin/sh\n/bin/cat "$FAKE_LOADED_JOB"\n');
    h.env.FAKE_LOADED_JOB = path.join(h.base, 'loaded.txt');
    fs.writeFileSync(h.env.FAKE_LOADED_JOB,
      `com.john.orca-watchdog = {\n state = not running\n inherited environment = {\n ORCA_CLI => ${h.orca}\n }\n}`);
    const result = doctorText({ env: h.env });
    assert.equal(result.failed, false, result.text);
    assert.match(result.text, /saved\/loaded: not compared/);
    assert.doesNotMatch(result.text, /disagree/);
    assert.doesNotMatch(result.text, /loaded Node: error/);
  } finally { h.cleanup(); }
});
