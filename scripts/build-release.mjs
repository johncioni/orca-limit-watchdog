#!/usr/bin/env node
// Build a curated, deterministic release archive (tar.gz) plus its SHA-256.
// Pure Node, no dependencies: the same file set the installer expects, packed
// so an identical tree always produces identical bytes (a stable Homebrew SHA).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { RELEASE_FILES, RUNTIME_ROOT, VERSION, validateReleaseRoot } from '../lib/management.mjs';

export const NAME = 'orca-limit-watchdog';
// Fixed so the archive bytes depend only on file contents, not build time.
const RELEASE_MTIME = 1577836800; // 2020-01-01T00:00:00Z
const BLOCK = 512;

function collectFiles(sourceRoot) {
  const files = [];
  const walk = (relative) => {
    const stat = fs.lstatSync(path.join(sourceRoot, relative));
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(path.join(sourceRoot, relative)).sort()) {
        walk(path.posix.join(relative, name));
      }
    } else if (stat.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`unsupported release entry (not a regular file): ${relative}`);
    }
  };
  for (const entry of RELEASE_FILES) walk(entry);
  return files.sort();
}

function collectEntries(sourceRoot, topDir) {
  const files = collectFiles(sourceRoot);
  const dirs = new Set([`${topDir}/`]);
  const entries = [];
  for (const relative of files) {
    const segments = relative.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      dirs.add(`${topDir}/${segments.slice(0, i).join('/')}/`);
    }
    const mode = fs.statSync(path.join(sourceRoot, relative)).mode & 0o111 ? 0o755 : 0o644;
    entries.push({ name: `${topDir}/${relative}`, type: '0', mode, source: path.join(sourceRoot, relative) });
  }
  for (const name of dirs) entries.push({ name, type: '5', mode: 0o755 });
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function octal(buffer, value, offset, length) {
  buffer.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, 'ascii');
}

function tarHeader({ name, type, mode }, size) {
  if (Buffer.byteLength(name) > 100) throw new Error(`release path too long for ustar: ${name}`);
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, 100, 'utf8');
  octal(header, mode & 0o7777, 100, 8);
  octal(header, 0, 108, 8); // uid
  octal(header, 0, 116, 8); // gid
  octal(header, size, 124, 12);
  octal(header, RELEASE_MTIME, 136, 12);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'binary');
  header.write('00', 263, 2, 'ascii');
  header.fill(0x20, 148, 156); // checksum field spaces during computation
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

export function buildTar(sourceRoot, topDir) {
  const chunks = [];
  for (const entry of collectEntries(sourceRoot, topDir)) {
    if (entry.type === '5') {
      chunks.push(tarHeader(entry, 0));
      continue;
    }
    const content = fs.readFileSync(entry.source);
    chunks.push(tarHeader(entry, content.length), content);
    const remainder = content.length % BLOCK;
    if (remainder) chunks.push(Buffer.alloc(BLOCK - remainder, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive marker
  return Buffer.concat(chunks);
}

export function buildRelease({ sourceRoot = RUNTIME_ROOT, version = VERSION, outDir } = {}) {
  if (!outDir) throw new Error('buildRelease requires an outDir');
  validateReleaseRoot(sourceRoot, version); // version match + syntax + plist lint, before any write
  const topDir = `${NAME}-${version}`;
  const gz = zlib.gzipSync(buildTar(sourceRoot, topDir), { level: 9 });
  const sha256 = crypto.createHash('sha256').update(gz).digest('hex');
  fs.mkdirSync(outDir, { recursive: true });
  const tarball = path.join(outDir, `${topDir}.tar.gz`);
  const checksum = `${tarball}.sha256`;
  fs.writeFileSync(tarball, gz);
  fs.writeFileSync(checksum, `${sha256}  ${topDir}.tar.gz\n`);
  return { name: NAME, version, tarball, checksum, sha256, size: gz.length };
}

function isMain() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try { return fileURLToPath(import.meta.url) === fs.realpathSync(invoked); }
  catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2);
  let outDir = path.join(RUNTIME_ROOT, 'dist');
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') { outDir = path.resolve(args[++i] ?? ''); }
    else { console.error(`error: unknown argument: ${args[i]}`); process.exit(2); }
  }
  try {
    const result = buildRelease({ outDir });
    console.log(`built ${path.basename(result.tarball)} (${result.size} bytes)`);
    console.log(`sha256 ${result.sha256}`);
    console.log(`wrote ${result.tarball}`);
    console.log(`wrote ${result.checksum}`);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
