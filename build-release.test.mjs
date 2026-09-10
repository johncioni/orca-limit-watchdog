import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildRelease } from './scripts/build-release.mjs';
import { validateReleaseRoot, VERSION } from './lib/management.mjs';

const pExecFile = promisify(execFile);
const ROOT = process.cwd();
const NAME = 'orca-watchdog';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function extract(tarball) {
  const dir = tmp('wd-extract-');
  await pExecFile('/usr/bin/tar', ['-xzf', tarball, '-C', dir]);
  return path.join(dir, `${NAME}-${VERSION}`);
}

test('buildRelease writes a curated tarball and a matching sha256 to the out dir', async () => {
  const outDir = tmp('wd-dist-');
  try {
    const result = buildRelease({ sourceRoot: ROOT, version: VERSION, outDir });
    assert.equal(path.basename(result.tarball), `${NAME}-${VERSION}.tar.gz`);
    assert.equal(path.basename(result.checksum), `${NAME}-${VERSION}.tar.gz.sha256`);
    assert.equal(fs.existsSync(result.tarball), true);

    const bytes = fs.readFileSync(result.tarball);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(result.sha256, sha);

    const checksumLine = fs.readFileSync(result.checksum, 'utf8').trim();
    const [recordedSha, recordedName] = checksumLine.split(/\s+/);
    assert.equal(recordedSha, sha);
    assert.equal(recordedName, `${NAME}-${VERSION}.tar.gz`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('the extracted archive is exactly the release set and passes validateReleaseRoot', async () => {
  const outDir = tmp('wd-dist-');
  try {
    const { tarball } = buildRelease({ sourceRoot: ROOT, version: VERSION, outDir });
    const releaseRoot = await extract(tarball);

    // Runtime payload is present.
    for (const rel of ['bin/orca-watchdog', 'bin/orca-watchdog.mjs',
      'lib/management.mjs', 'watchdog.mjs', 'version.mjs', 'install.sh', 'uninstall.sh',
      'scripts/install-archive.mjs', 'scripts/uninstall-archive.mjs', 'README.md',
      'LICENSE', 'CHANGELOG.md', 'lib/operations.mjs', 'lib/logs.mjs',
      'completions/orca-watchdog.bash', 'completions/_orca-watchdog',
      'completions/orca-watchdog.fish', 'man/orca-watchdog.1']) {
      assert.equal(fs.existsSync(path.join(releaseRoot, rel)), true, `missing ${rel}`);
    }
    // Development-only material is excluded.
    for (const rel of ['e2e', 'docs', 'CLAUDE.md', 'AGENTS.md', 'orca.yaml', 'renovate.json5',
      '.git', '.superpowers', 'dist', 'watchdog.test.mjs', 'management.test.mjs',
      'build-release.test.mjs', 'scripts/orca-setup.sh', 'scripts/build-release.mjs']) {
      assert.equal(fs.existsSync(path.join(releaseRoot, rel)), false, `should not ship ${rel}`);
    }

    // The archive is a valid install source (node --check + plutil -lint run inside).
    validateReleaseRoot(releaseRoot, VERSION);

    fs.rmSync(path.dirname(releaseRoot), { recursive: true, force: true });
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('formula installs completions and man page into standard directories', async () => {
  const base = tmp('wd-formula-');
  try {
    const { tarball } = buildRelease({ sourceRoot: ROOT, version: VERSION, outDir: base });
    const release = await extract(tarball);
    const prefix = path.join(base, 'prefix');
    const ruby = `require 'pathname'
require 'fileutils'
class Pathname
  def install(*sources)
    FileUtils.mkdir_p(self.to_s)
    sources.flatten.each { |s| FileUtils.cp_r(s.to_s, self.to_s) }
  end
  def write_env_script(*args, **kwargs)
    FileUtils.mkdir_p(dirname.to_s)
    write('fixture wrapper')
  end
end
class Formula
  def self.desc(*); end
  def self.homepage(*); end
  def self.url(*); end
  def self.sha256(*); end
  def self.license(*); end
  def self.depends_on(*); end
  def self.test; end
  def libexec; Pathname.new(ENV.fetch('PREFIX'))/'libexec'; end
  def bin; Pathname.new(ENV.fetch('PREFIX'))/'bin'; end
  def bash_completion; Pathname.new(ENV.fetch('PREFIX'))/'etc/bash_completion.d'; end
  def zsh_completion; Pathname.new(ENV.fetch('PREFIX'))/'share/zsh/site-functions'; end
  def fish_completion; Pathname.new(ENV.fetch('PREFIX'))/'share/fish/vendor_completions.d'; end
  def man1; Pathname.new(ENV.fetch('PREFIX'))/'share/man/man1'; end
  def formula_opt_bin(*); Pathname.new('/fixture/node/bin'); end
end
load ARGV.fetch(0)
OrcaWatchdog.new.install
`;
    await pExecFile('ruby', ['-e', ruby, path.join(ROOT, 'Formula/orca-watchdog.rb')], { cwd: release, env: { ...process.env, PREFIX: prefix } });
    for (const rel of ['etc/bash_completion.d/orca-watchdog.bash', 'share/zsh/site-functions/_orca-watchdog',
      'share/fish/vendor_completions.d/orca-watchdog.fish', 'share/man/man1/orca-watchdog.1']) {
      assert.ok(fs.existsSync(path.join(prefix, rel)), `formula did not install ${rel}`);
    }
    fs.rmSync(path.dirname(release), { recursive: true, force: true });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('archived install scripts keep their executable bit', async () => {
  const outDir = tmp('wd-dist-');
  try {
    const { tarball } = buildRelease({ sourceRoot: ROOT, version: VERSION, outDir });
    const releaseRoot = await extract(tarball);
    for (const rel of ['install.sh', 'uninstall.sh', 'bin/orca-watchdog', 'bin/orca-watchdog.mjs']) {
      const mode = fs.statSync(path.join(releaseRoot, rel)).mode;
      assert.ok(mode & 0o111, `${rel} should be executable (mode ${mode.toString(8)})`);
    }
    fs.rmSync(path.dirname(releaseRoot), { recursive: true, force: true });
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('the build is byte-for-byte deterministic', async () => {
  const a = tmp('wd-dist-a-');
  const b = tmp('wd-dist-b-');
  try {
    const first = buildRelease({ sourceRoot: ROOT, version: VERSION, outDir: a });
    const second = buildRelease({ sourceRoot: ROOT, version: VERSION, outDir: b });
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(fs.readFileSync(first.tarball), fs.readFileSync(second.tarball));
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('a version that disagrees with version.mjs is refused before writing anything', async () => {
  const outDir = tmp('wd-dist-');
  try {
    assert.throws(() => buildRelease({ sourceRoot: ROOT, version: '9.9.9', outDir }),
      /version/i);
    assert.deepEqual(fs.readdirSync(outDir), []);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('the Homebrew formula pins the current version and a well-formed sha256', () => {
  const formula = fs.readFileSync(path.join(ROOT, 'Formula', 'orca-watchdog.rb'), 'utf8');
  const escaped = VERSION.replace(/\./g, '\\.');
  // The URL pins the version (release tag and asset filename) that Homebrew infers.
  assert.match(formula, new RegExp(`download/v${escaped}/${NAME}-${escaped}\\.tar\\.gz`),
    'formula url must point at the versioned release asset');
  // A pinned 64-hex sha256. The exact bytes are the uploaded release asset's,
  // fixed at release time: gzip output is not identical across zlib builds, so
  // CI cannot reproduce and byte-compare it here.
  assert.match(formula, /sha256 "[0-9a-f]{64}"/, 'formula must pin a sha256');
});
