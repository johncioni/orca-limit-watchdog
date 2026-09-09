import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pExecFile = promisify(execFile);
const ROOT = process.cwd();
const CLI = path.join(ROOT, 'bin', 'orca-limit-watchdog.mjs');

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
    assert.match(noArgs.stdout, /Usage: orca-limit-watchdog/);
    const help = await runCli(['--help'], h.env);
    assert.match(help.stdout, /doctor.*start.*stop/s);
    const version = await runCli(['--version'], h.env);
    assert.equal(version.stdout.trim(), 'orca-limit-watchdog 0.1.0');
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
    const plist = path.join(h.home, 'Library', 'LaunchAgents', 'com.john.orca-limit-watchdog.plist');
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
    assert.match(paused.stdout, /service:\s+running/);
    assert.match(paused.stdout, /pause:\s+paused/);
    assert.match(paused.stdout, /events:\s+none/);
    await runCli(['resume'], h.env);
    assert.match((await runCli(['status'], h.env)).stdout, /pause:\s+active/);
    await runCli(['stop'], h.env);
    assert.match((await runCli(['status'], h.env)).stdout, /service:\s+stopped/);
  } finally { h.cleanup(); }
});

test('start works with a restricted PATH and never invokes env lookup under launchd', async () => {
  const h = harness();
  try {
    await runCli(['start'], { ...h.env, PATH: '/empty' });
    const plist = fs.readFileSync(path.join(h.home, 'Library', 'LaunchAgents', 'com.john.orca-limit-watchdog.plist'), 'utf8');
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
    const plist = fs.readFileSync(path.join(h.home, 'Library', 'LaunchAgents', 'com.john.orca-limit-watchdog.plist'), 'utf8');
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
    const share = path.join(h.home, '.local', 'share', 'orca-limit-watchdog');
    const current = path.join(share, 'current');
    const command = path.join(h.home, '.local', 'bin', 'orca-limit-watchdog');
    assert.equal(fs.readlinkSync(current), '0.1.0');
    assert.equal(fs.realpathSync(command), fs.realpathSync(path.join(share, '0.1.0', 'bin', 'orca-limit-watchdog')));
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

test('stopped legacy registration migrates on start without duplicate registration', async () => {
  const h = harness('wd migrate ');
  try {
    const oldPlist = path.join(h.home, 'Library', 'LaunchAgents', 'com.john.orca-limit-watchdog.plist');
    fs.mkdirSync(path.dirname(oldPlist), { recursive: true });
    fs.writeFileSync(oldPlist, '<plist><string>/old/disposable/worktree/watchdog.mjs</string></plist>');
    const release = releaseCopy(h.base, '0.1.0');
    await runInstall(release, [], h.env);
    const command = path.join(h.home, '.local', 'bin', 'orca-limit-watchdog');
    await pExecFile(command, ['start'], { env: h.env });
    const migrated = fs.readFileSync(oldPlist, 'utf8');
    assert.doesNotMatch(migrated, /old\/disposable/);
    assert.match(migrated, /\.local\/share\/orca-limit-watchdog\/0\.1\.0\/watchdog\.mjs/);
    const calls = fs.readFileSync(h.launchctlLog, 'utf8').trim().split('\n');
    assert.equal(calls.filter((line) => line.startsWith('bootstrap ')).length, 1);
  } finally { h.cleanup(); }
});

test('uninstall requires a stopped service and retains event state and pause', async () => {
  const h = harness('wd uninstall ');
  try {
    const release = releaseCopy(h.base, '0.1.0');
    await runInstall(release, [], h.env);
    const stateDir = path.join(h.home, '.local', 'state', 'orca-limit-watchdog');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state.json'), '{"version":2,"events":{}}\n');
    fs.writeFileSync(path.join(stateDir, 'disabled'), '');
    fs.writeFileSync(h.launchctlState, 'registered');
    await assert.rejects(
      pExecFile('/bin/bash', [path.join(release, 'uninstall.sh')], { env: h.env }),
      /stop.*before.*uninstall/i,
    );
    assert.equal(fs.existsSync(path.join(h.home, '.local', 'share', 'orca-limit-watchdog')), true);
    fs.rmSync(h.launchctlState);
    const removed = await pExecFile('/bin/bash', [path.join(release, 'uninstall.sh')], { env: h.env });
    assert.match(removed.stdout, /uninstalled.*state retained/i);
    assert.equal(fs.existsSync(path.join(h.home, '.local', 'share', 'orca-limit-watchdog')), false);
    assert.equal(fs.existsSync(path.join(h.home, '.local', 'bin', 'orca-limit-watchdog')), false);
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
    assert.equal(fs.existsSync(path.join(h.home, '.local', 'share', 'orca-limit-watchdog')), false);
  } finally { h.cleanup(); }
});
