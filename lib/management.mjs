import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.mjs';
import { readHealth } from './operations.mjs';
import { LOG_FILES, parseLogArgs, readLog, followLog } from './logs.mjs';

// An incomplete archive must still load management so validation can explain
// the missing runtime. Never execute a saved/loaded job's script to inspect it.
const { parseStateFile, validateEvent } = fs.existsSync(new URL('../watchdog.mjs', import.meta.url))
  ? await import('../watchdog.mjs') : {};

export { VERSION };

export const LABEL = 'com.john.orca-watchdog';
export const MIN_NODE_MAJOR = 22;
export const RUNTIME_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const REQUIRED_ORCA_CAPABILITIES = [
  ['terminal', 'list', '--help'],
  ['terminal', 'read', '--help'],
  ['terminal', 'wait', '--help'],
  ['terminal', 'send', '--help'],
];

export function installPaths(home = os.homedir()) {
  const stateDir = path.join(home, '.local', 'state', 'orca-watchdog');
  return {
    home,
    stateDir,
    stateFile: path.join(stateDir, 'state.json'),
    healthFile: path.join(stateDir, 'health.json'),
    disabledFile: path.join(stateDir, 'disabled'),
    launchAgentsDir: path.join(home, 'Library', 'LaunchAgents'),
    plistPath: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    shareRoot: path.join(home, '.local', 'share', 'orca-watchdog'),
    currentLink: path.join(home, '.local', 'share', 'orca-watchdog', 'current'),
    previousLink: path.join(home, '.local', 'share', 'orca-watchdog', 'previous'),
    commandLink: path.join(home, '.local', 'bin', 'orca-watchdog'),
  };
}

export const RELEASE_FILES = Object.freeze([
  'bin',
  'lib',
  'scripts/install-archive.mjs',
  'scripts/uninstall-archive.mjs',
  'watchdog.mjs',
  'version.mjs',
  'install.sh',
  'uninstall.sh',
  'completions',
  'man',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
]);

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid release version: ${version}`);
}

function existingLinkTarget(link) {
  try {
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink()) throw new Error(`refusing to replace non-symlink path: ${link}`);
    return fs.readlinkSync(link);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function atomicSymlink(target, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmp = `${destination}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.symlinkSync(target, tmp);
  try { fs.renameSync(tmp, destination); }
  finally { fs.rmSync(tmp, { force: true }); }
}

export function validateReleaseRoot(sourceRoot, version, { env = process.env } = {}) {
  assertVersion(version);
  for (const relative of RELEASE_FILES) {
    if (!fs.existsSync(path.join(sourceRoot, relative))) throw new Error(`release file missing: ${relative}`);
  }
  const versionSource = fs.readFileSync(path.join(sourceRoot, 'version.mjs'), 'utf8');
  const escaped = version.replaceAll('.', '\\.');
  if (!new RegExp(`VERSION\\s*=\\s*['\"]${escaped}['\"]`).test(versionSource)) {
    throw new Error(`release version source does not match ${version}`);
  }
  for (const relative of ['watchdog.mjs', 'version.mjs', 'lib/management.mjs', 'bin/orca-watchdog.mjs']) {
    runChecked(process.execPath, ['--check', path.join(sourceRoot, relative)], { env });
  }
}

function requireStopped(action, env) {
  if (serviceIsRunning(env)) {
    throw new Error(`run 'orca-watchdog stop' before ${action}; the registered service was not changed`);
  }
}

export function installRelease({ sourceRoot, version, env = process.env }) {
  ensureSupportedHost();
  validateReleaseRoot(sourceRoot, version, { env });
  requireStopped('install or upgrade', env);
  const paths = installPaths(env.HOME || os.homedir());
  const destination = path.join(paths.shareRoot, version);
  const current = existingLinkTarget(paths.currentLink);
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(paths.shareRoot, { recursive: true });
    const staging = path.join(paths.shareRoot, `.staging-${version}-${process.pid}`);
    try {
      fs.mkdirSync(staging, { mode: 0o755 });
      for (const relative of RELEASE_FILES) {
        fs.cpSync(path.join(sourceRoot, relative), path.join(staging, relative), { recursive: true });
      }
      validateReleaseRoot(staging, version, { env });
      fs.chmodSync(path.join(staging, 'bin', 'orca-watchdog'), 0o755);
      fs.chmodSync(path.join(staging, 'bin', 'orca-watchdog.mjs'), 0o755);
      fs.chmodSync(path.join(staging, 'install.sh'), 0o755);
      fs.chmodSync(path.join(staging, 'uninstall.sh'), 0o755);
      fs.renameSync(staging, destination);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  } else {
    validateReleaseRoot(destination, version, { env });
  }
  // Resolve the command-link state BEFORE flipping current: existingLinkTarget
  // throws if a non-symlink sits at the command path, and that throw must not
  // leave the active version half-switched (DOG-24).
  const commandTarget = path.join('..', 'share', 'orca-watchdog', 'current', 'bin', 'orca-watchdog');
  const existingCommand = existingLinkTarget(paths.commandLink);
  if (current !== version) {
    if (current) atomicSymlink(current, paths.previousLink);
    atomicSymlink(version, paths.currentLink);
  }
  if (existingCommand !== commandTarget) atomicSymlink(commandTarget, paths.commandLink);
  return `installed ${version}; service is stopped (run 'orca-watchdog start' when ready)`;
}

export function rollbackRelease({ env = process.env }) {
  ensureSupportedHost();
  requireStopped('rollback', env);
  const paths = installPaths(env.HOME || os.homedir());
  const current = existingLinkTarget(paths.currentLink);
  const previous = existingLinkTarget(paths.previousLink);
  if (!current || !previous) throw new Error('no previous installed version is available for rollback');
  assertVersion(previous);
  validateReleaseRoot(path.join(paths.shareRoot, previous), previous, { env });
  atomicSymlink(previous, paths.currentLink);
  atomicSymlink(current, paths.previousLink);
  return `rolled back to ${previous}; service is stopped`;
}

export function uninstallRelease({ env = process.env }) {
  ensureSupportedHost();
  requireStopped('uninstall', env);
  const paths = installPaths(env.HOME || os.homedir());
  const command = existingLinkTarget(paths.commandLink);
  if (command) {
    const expected = path.join('..', 'share', 'orca-watchdog', 'current', 'bin', 'orca-watchdog');
    if (command !== expected) throw new Error(`refusing to remove command symlink with unexpected target: ${command}`);
    fs.rmSync(paths.commandLink);
  }
  try {
    const shareStat = fs.lstatSync(paths.shareRoot);
    if (shareStat.isSymbolicLink()) throw new Error(`refusing to remove symlinked install root: ${paths.shareRoot}`);
    fs.rmSync(paths.shareRoot, { recursive: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.rmSync(paths.plistPath, { force: true });
  return `uninstalled ${LABEL}; state retained at ${paths.stateDir}`;
}

export function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderPlist({ nodePath, watchdogPath, stateDir, orcaPath }) {
  const value = (input) => xmlEscape(input);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${value(nodePath)}</string>
    <string>${value(watchdogPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ORCA_CLI</key>
    <string>${value(orcaPath)}</string>
    <key>PATH</key>
    <string>/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${value(path.join(stateDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${value(path.join(stateDir, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
}

function executableError(candidate, label, kind) {
  return new Error(`${label} ${kind}: ${candidate}. Set ${label} to an absolute executable path.`);
}

export function resolveExecutable(candidate, pathEnv = process.env.PATH ?? '', label = 'ORCA_CLI', { resolveSymlinks = true } = {}) {
  if (!candidate) throw executableError('(empty)', label, 'not found');
  const candidates = candidate.includes('/')
    ? [path.resolve(candidate)]
    : pathEnv.split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir, candidate));
  const found = candidates.find((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
  if (!found) throw executableError(candidate, label, 'not found');
  try { fs.accessSync(found, fs.constants.X_OK); } catch { throw executableError(found, label, 'not executable'); }
  return resolveSymlinks ? fs.realpathSync(found) : path.resolve(found);
}

function ensureSupportedHost() {
  if (process.platform !== 'darwin') {
    throw new Error(`macOS is required (found ${process.platform})`);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    throw new Error(`Node ${MIN_NODE_MAJOR} or newer is required (found ${process.version})`);
  }
}

function launchctlPath(env = process.env) {
  return resolveExecutable(env.ORCA_WATCHDOG_LAUNCHCTL || '/bin/launchctl', env.PATH, 'launchctl');
}

function plutilPath(env = process.env) {
  return resolveExecutable(env.ORCA_WATCHDOG_PLUTIL || '/usr/bin/plutil', env.PATH, 'plutil');
}

function serviceTarget() {
  return `gui/${process.getuid()}/${LABEL}`;
}

export function serviceIsRunning(env = process.env) {
  const result = spawnSync(launchctlPath(env), ['print', serviceTarget()], { env, stdio: 'ignore' });
  // A spawn/exec error or a signal-termination (status null) means the registration
  // state is UNKNOWN, not "absent". Collapsing it to "not running" would fail the
  // requireStopped gate open. Throw so the gate fails closed (matching inspectService);
  // a clean nonzero exit is still absent by design (DOG-24).
  if (result.error || result.signal) {
    throw new Error(`launchctl could not check service state: ${result.error?.message ?? `terminated by ${result.signal}`}`);
  }
  return result.status === 0;
}

export function inspectService(env = process.env) {
  const result = spawnSync(launchctlPath(env), ['print', serviceTarget()], { env, encoding: 'utf8' });
  if (result.error || result.signal) throw new Error(`launchctl check failed: ${result.error?.message ?? result.signal}`);
  const output = result.stdout ?? '';
  return { registered: result.status === 0, output,
    process: result.status !== 0 ? 'not running' : /^\s*pid = \d+/m.test(output) ? 'running'
      : /^\s*state = (?:not running|waiting|exited)/m.test(output) ? 'not running' : 'unknown' };
}

function runChecked(file, args, { env = process.env, stdio = 'pipe' } = {}) {
  const result = spawnSync(file, args, { env, encoding: 'utf8', stdio });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${path.basename(file)} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

export function resolveOrca(env = process.env) {
  return resolveExecutable(env.ORCA_CLI || 'orca', env.PATH, 'ORCA_CLI');
}

export function checkOrcaCapabilities(orcaPath, env = process.env) {
  for (const args of REQUIRED_ORCA_CAPABILITIES) {
    try { runChecked(orcaPath, args, { env }); }
    catch { throw new Error(`Orca CLI lacks required capability: orca ${args.join(' ')}`); }
  }
}

function currentRuntimeRoot() {
  return fs.realpathSync(RUNTIME_ROOT);
}

export function startService({ env = process.env } = {}) {
  ensureSupportedHost();
  const paths = installPaths(env.HOME || os.homedir());
  if (serviceIsRunning(env)) {
    const error = new Error(`${LABEL} is already running; run 'orca-watchdog stop' before changing installations`);
    error.exitCode = 1;
    throw error;
  }
  const nodePath = env.ORCA_WATCHDOG_NODE
    ? resolveExecutable(env.ORCA_WATCHDOG_NODE, env.PATH, 'Node', { resolveSymlinks: false })
    : resolveExecutable(process.execPath, env.PATH, 'Node');
  const orcaPath = resolveOrca(env);
  checkOrcaCapabilities(orcaPath, env);
  const watchdogPath = path.join(currentRuntimeRoot(), 'watchdog.mjs');
  if (!fs.existsSync(watchdogPath)) throw new Error(`watchdog runtime not found: ${watchdogPath}`);
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.launchAgentsDir, { recursive: true });
  const tmp = `${paths.plistPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, renderPlist({ nodePath, watchdogPath, stateDir: paths.stateDir, orcaPath }), { mode: 0o600 });
  try {
    runChecked(plutilPath(env), ['-lint', tmp], { env });
    fs.renameSync(tmp, paths.plistPath);
    runChecked(launchctlPath(env), ['bootstrap', `gui/${process.getuid()}`, paths.plistPath], { env });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return `started: ${LABEL}`;
}

export function stopService({ env = process.env } = {}) {
  ensureSupportedHost();
  const paths = installPaths(env.HOME || os.homedir());
  if (!serviceIsRunning(env)) return `already stopped: ${LABEL}`;
  runChecked(launchctlPath(env), ['bootout', `gui/${process.getuid()}`, paths.plistPath], { env });
  return `stopped: ${LABEL}`;
}

export function setPaused(paused, { env = process.env } = {}) {
  const paths = installPaths(env.HOME || os.homedir());
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  if (paused) fs.closeSync(fs.openSync(paths.disabledFile, 'a', 0o600));
  else fs.rmSync(paths.disabledFile, { force: true });
  return paused ? 'paused' : 'resumed';
}

function eventSummary(stateFile) {
  if (!fs.existsSync(stateFile)) return 'none';
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // Both v1 and v2 wrap events under `.events`; only a legacy pre-versioned
    // bare map is the events object itself. Unwrap for v1 too, or the wrapper
    // keys ({version, events}) are miscounted as events (DOG-24).
    const events = (state?.version === 1 || state?.version === 2) ? state.events : state;
    const count = events && typeof events === 'object' ? Object.keys(events).length : 0;
    return count === 0 ? 'none' : String(count);
  } catch { return 'unreadable (run doctor)'; }
}

export function statusText({ env = process.env } = {}) {
  ensureSupportedHost();
  const paths = installPaths(env.HOME || os.homedir());
  let service, processState = 'unknown';
  try { const job = inspectService(env); service = job.registered ? 'registered (periodic, every 300s)' : 'stopped'; processState = job.process; }
  catch (error) { service = `unknown (${error.message})`; }   // don't crash status on an unverifiable state
  const { value: health, diagnostic } = readHealth(paths.stateDir);
  const observation = health?.lastCompletedCheck;
  const stale = observation && Date.now() - Date.parse(observation.at) > 15 * 60_000;
  const waiting = health ? Object.entries(health.waiting).map(([handle, entry]) => `  ${handle}: ${entry.reason} (observed ${entry.at})`) : [];
  return [
    `service: ${service}`,
    `process: ${processState}`,
    `installed version: ${VERSION}`,
    `pause: ${fs.existsSync(paths.disabledFile) ? 'paused' : 'active'}`,
    `events: ${eventSummary(paths.stateFile)}`,
    `last completed check: ${observation ? `${observation.at} (${observation.outcome}; observed${stale ? ', stale' : ''})` : 'unknown'}`,
    `last successful resume: ${health?.lastSuccessfulResume ? `${health.lastSuccessfulResume.at} (${health.lastSuccessfulResume.handle}; observed)` : 'unknown'}`,
    `latest check: ${health ? `${health.check.outcome} (observed start ${health.check.startedAt}${health.check.outcome === 'in-progress' ? '; may be interrupted, stale if process no longer running' : ''})` : `unknown (${diagnostic})`}`,
    `waiting reasons (latest observations):${waiting.length ? '\n' + waiting.join('\n') : ' unknown or none'}`,
  ].join('\n');
}

export function doctorText({ env = process.env } = {}) {
  const lines = [];
  let failed = false;
  if (process.platform === 'darwin') lines.push('macOS: ok');
  else { lines.push(`macOS: error (${process.platform}; macOS required)`); failed = true; }
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) lines.push(`Node: ok (${process.version})`);
  else { lines.push(`Node: error (${process.version}; Node ${MIN_NODE_MAJOR}+ required)`); failed = true; }
  try {
    const orca = resolveOrca(env);
    checkOrcaCapabilities(orca, env);
    lines.push(`Orca CLI: ok (${orca})`);
  } catch (error) { lines.push(`Orca CLI: error (${error.message})`); failed = true; }
  let job;
  try { job = inspectService(env); lines.push(`launchd: ${job.registered ? 'registered (periodic)' : 'stopped (valid; start only when ready)'}`); lines.push(`process: ${job.process}`); }
  catch (error) { lines.push(`launchd: error (${error.message})`); failed = true; }
  const paths = installPaths(env.HOME || os.homedir());
  const fail = (message) => { lines.push(message); failed = true; };
  const inspect = (label, config) => {
    for (const [name, candidate] of [['Node', config.node], ['runtime', config.runtime], ['Orca', config.orca]]) {
      try {
        if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error('missing absolute path');
        if (name === 'runtime') {
          if (!fs.statSync(candidate).isFile()) throw new Error(`missing runtime: ${candidate}`);
          const source = fs.readFileSync(path.join(path.dirname(fs.realpathSync(candidate)), 'version.mjs'), 'utf8');
          const version = source.match(/\bVERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/)?.[1];
          if (version !== VERSION) throw new Error(`stale runtime version ${version ?? 'unknown'}; installed ${VERSION}`);
          lines.push(`${label} runtime: ok (${candidate}; ${version})`);
        } else {
          resolveExecutable(candidate, '', name, { resolveSymlinks: false });
          if (name === 'Node') {
            const version = runChecked(candidate, ['--version'], { env }).stdout.trim();
            if (!/^v\d+\./.test(version) || Number(version.match(/^v(\d+)/)[1]) < MIN_NODE_MAJOR) throw new Error(`Node ${MIN_NODE_MAJOR}+ required; found ${version}`);
          }
          lines.push(`${label} ${name}: ok (${candidate})`);
        }
      } catch (error) { fail(`${label} ${name}: error (${error.message})`); }
    }
  };
  let saved, loaded;
  if (fs.existsSync(paths.plistPath)) {
    try {
      const plist = JSON.parse(runChecked(plutilPath(env), ['-convert', 'json', '-o', '-', paths.plistPath], { env }).stdout);
      saved = { node: plist.ProgramArguments?.[0], runtime: plist.ProgramArguments?.[1], orca: plist.EnvironmentVariables?.ORCA_CLI };
      inspect('saved', saved);
    } catch (error) { fail(`saved plist: error (${error.message})`); }
  } else lines.push('saved plist: missing (normal before first start)');
  if (job?.registered) {
    const argsBlock = job.output.match(/^\s*arguments = \{\s*\n([\s\S]*?)^\s*\}/m)?.[1];
    const args = argsBlock?.split('\n').map(x => x.trim().replace(/^\d+\s*=\s*/, '')).filter(Boolean);
    const unquote = x => x?.replace(/^"(.*)"$/, '$1');
    const orcaLoaded = unquote(job.output.match(/^\s*ORCA_CLI\s*(?:=>|=)\s*(.+)$/m)?.[1]?.trim());
    if (!args || args.length < 2 || orcaLoaded === undefined) {
      // We could not scrape the loaded job (a macOS launchctl reword or an unusual
      // path rendering). Do NOT fabricate a path error or a "disagree" that steers
      // the user into an unnecessary reinstall — the saved plist and the installed
      // runtime are already validated above.
      lines.push('saved/loaded: not compared (launchctl output not machine-readable; saved plist and runtime checked above)');
    } else {
      loaded = { node: unquote(args[0]), runtime: unquote(args[1]), orca: orcaLoaded };
      inspect('loaded', loaded);
      if (!saved || ['node', 'runtime', 'orca'].some(k => saved[k] !== loaded[k])) fail('saved/loaded: disagree (registration may point at a previous installation)');
      else lines.push('saved/loaded: agree');
    }
  }
  let eventsLine = 'none';   // reused for the `events:` line below (state.json is read once)
  try {
    if (!fs.existsSync(paths.stateFile)) lines.push('event state: missing (normal before first check)');
    else {
      const text = fs.readFileSync(paths.stateFile, 'utf8');
      let parsed, parsedOk = false;
      try { parsed = JSON.parse(text); parsedOk = true; } catch { /* counted as unreadable below */ }
      if (parsedOk) {
        const evs = (parsed?.version === 1 || parsed?.version === 2) ? parsed.events : parsed;
        const n = evs && typeof evs === 'object' ? Object.keys(evs).length : 0;
        eventsLine = n === 0 ? 'none' : String(n);
      } else eventsLine = 'unreadable (run doctor)';
      if (!parseStateFile) fail(`event state: unknown (watchdog runtime missing; cannot validate — reinstall the package); preserved at ${paths.stateFile}`);
      else if (!parseStateFile(text)) {
        let why = 'invalid schema';
        try {
          if (!parsedOk) throw new Error('invalid JSON');
          if (![1, 2].includes(parsed?.version)) why = `unsupported version ${parsed?.version}`;
          else for (const [key, raw] of Object.entries(parsed.events ?? {})) {
            const error = validateEvent(key, { alertedAt: null, ...raw, ...(parsed.version === 1 ? { kind: 'limit', platform: 'unknown' } : {}) });
            if (error) { why = `${key}: ${error}`; break; }
          }
        } catch (error) { why = error.message; }
        fail(`event state: error (${why}); preserved at ${paths.stateFile}`);
      } else lines.push('event state: ok');
    }
  } catch (error) { fail(`event state: error (${error.message})`); eventsLine = 'unreadable (run doctor)'; }
  const health = readHealth(paths.stateDir);
  lines.push(`health: ${health.value ? `ok (observed ${health.value.check.startedAt}; ${health.value.check.outcome})` : `unknown (${health.diagnostic}; event state unaffected)`}`);
  if (!health.value && health.diagnostic !== 'missing') failed = true;
  lines.push(`pause: ${fs.existsSync(paths.disabledFile) ? 'paused' : 'active'}`);
  lines.push(`events: ${eventsLine}`);
  if (failed) lines.push('Recovery: inspect orca-watchdog logs --source stderr; correct ORCA_CLI / ORCA_WATCHDOG_NODE paths, then run orca-watchdog stop; orca-watchdog doctor; orca-watchdog start when ready. Reinstall the current package if runtime files are missing. Preserve malformed metadata for diagnosis; doctor never repairs it.');
  return { text: lines.join('\n'), failed };
}

function dryRun({ env = process.env } = {}) {
  ensureSupportedHost();
  const orcaPath = resolveOrca(env);
  checkOrcaCapabilities(orcaPath, env);
  const watchdogPath = path.join(currentRuntimeRoot(), 'watchdog.mjs');
  const result = spawnSync(process.execPath, [watchdogPath, '--dry-run'], {
    env: { ...env, ORCA_CLI: orcaPath }, encoding: 'utf8', stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`watchdog dry-run failed with exit ${result.status}`);
}

export const HELP = `Usage: orca-watchdog <command>

Commands:
  --help       Show this help
  --version    Show the installed version
  doctor       Check macOS, Node, Orca, launchd, pause, and event state
  start        Validate and register the LaunchAgent
  stop         Unregister the LaunchAgent
  pause        Disable all watchdog activity without deleting state
  resume       Re-enable watchdog activity
  status       Show service health, pause state, and active events
  logs         Latest 100 activity lines; --follow, --lines N,
               --source activity|stdout|stderr (read-only)
  --dry-run    Run one observation-only tick; never sends terminal input
`;

export async function runCli(args = process.argv.slice(2), { env = process.env, stdout = process.stdout } = {}) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) { stdout.write(HELP); return 0; }
  if (args[0] === 'logs') {
    const options = parseLogArgs(args.slice(1));
    const file = path.join(installPaths(env.HOME || os.homedir()).stateDir, LOG_FILES[options.source]);
    if (!options.follow) stdout.write(readLog(file, options.lines));
    else {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try { await followLog(file, { ...options, signal: controller.signal, write: text => stdout.write(text) }); }
      finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    }
    return 0;
  }
  if (args.length !== 1) throw Object.assign(new Error(`unknown command: ${args.join(' ')}`), { exitCode: 2 });
  switch (args[0]) {
    case '--version': stdout.write(`orca-watchdog ${VERSION}\n`); return 0;
    case 'doctor': {
      const result = doctorText({ env }); stdout.write(`${result.text}\n`); return result.failed ? 1 : 0;
    }
    case 'start': stdout.write(`${startService({ env })}\n`); return 0;
    case 'stop': stdout.write(`${stopService({ env })}\n`); return 0;
    case 'pause': stdout.write(`${setPaused(true, { env })}\n`); return 0;
    case 'resume': stdout.write(`${setPaused(false, { env })}\n`); return 0;
    case 'status': stdout.write(`${statusText({ env })}\n`); return 0;
    case '--dry-run': dryRun({ env }); return 0;
    default: throw Object.assign(new Error(`unknown command: ${args[0]}`), { exitCode: 2 });
  }
}
