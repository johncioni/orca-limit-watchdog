import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { assertRegular, privateDirectory } from './operations.mjs';

export const LOG_FILES = Object.freeze({ activity: 'watchdog.log', stdout: 'launchd.out.log', stderr: 'launchd.err.log' });
const KEEP_BYTES = 500_000;
const THRESHOLD = 1_000_000;

function openRegular(file, flags) {
  if (!assertRegular(file)) return null;
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) {
    fs.closeSync(fd); throw new Error(`unsafe log: ${file}`);
  }
  return fd;
}

function tailBytes(fd, size, max = KEEP_BYTES) {
  const start = Math.max(0, size - max);
  const bytes = Buffer.alloc(Math.min(size, max));
  const n = fs.readSync(fd, bytes, 0, bytes.length, start);
  let offset = 0;
  // A bounded read may begin inside a UTF-8 code point.
  while (offset < n && (bytes[offset] & 0xc0) === 0x80) offset++;
  return bytes.subarray(offset, n);
}

function lastLines(text, lines) {
  const end = text.endsWith('\n') ? text.length - 1 : text.length;
  let offset = end;
  for (let n = 0; n < lines; n++) {
    offset = text.lastIndexOf('\n', offset - 1);
    if (offset < 0) return text;
  }
  return text.slice(offset + 1);
}

export function readLog(file, lines = 100) {
  const fd = openRegular(file, fs.constants.O_RDONLY);
  if (fd === null) return '';
  try {
    const size = fs.fstatSync(fd).size;
    // Grow the tail window until it holds more than `lines` complete lines or the
    // whole file, so `--lines N` is honored on logs past the retention cap without
    // loading a huge file when a small N is requested.
    for (let window = Math.min(size, KEEP_BYTES); ; window = Math.min(size, window * 2)) {
      const text = tailBytes(fd, size, window).toString('utf8');
      if (window >= size) return lastLines(text, lines);
      const complete = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      if (complete > lines) return lastLines(text, lines);
    }
  } finally { fs.closeSync(fd); }
}

export function maintainLog(file, lines = Infinity) {
  const fd = openRegular(file, fs.constants.O_RDWR);
  if (fd === null) return;
  try {
    fs.fchmodSync(fd, 0o600);
    const size = fs.fstatSync(fd).size;
    if (size <= THRESHOLD) return;
    const bytes = Buffer.from(lastLines(tailBytes(fd, size).toString('utf8'), lines));
    // Keep launchd's open inode. Never rotate/rename stdout or stderr.
    fs.ftruncateSync(fd, 0);
    // Loop until every byte lands: a single writeSync may short-write (e.g. ENOSPC),
    // which would otherwise silently drop the newest retained lines.
    for (let off = 0; off < bytes.length; ) off += fs.writeSync(fd, bytes, off, bytes.length - off, off);
  } finally { fs.closeSync(fd); }
}

// `only` (a LOG_FILES key) restricts maintenance to one log. The per-tick finally
// pass passes 'activity' — the only log a tick appends to — so it does not re-scan
// the launchd stdout/stderr files, which nothing touches between the start pass and
// the finally and which the next tick's start pass bounds anyway.
export function maintainLogs(dir, only) {
  privateDirectory(dir);
  for (const [source, name] of Object.entries(LOG_FILES)) {
    if (only && source !== only) continue;
    maintainLog(path.join(dir, name), source === 'activity' ? 500 : Infinity);
  }
}

export function appendActivity(dir, text) {
  privateDirectory(dir);
  const file = path.join(dir, LOG_FILES.activity);
  // Reject a non-regular target (FIFO/device/symlink/hardlink/foreign-owner) BEFORE
  // opening: a plain O_WRONLY open on a FIFO with no reader blocks forever, hanging
  // the tick — and a blocked synchronous open escapes both the try/catch below and
  // the tick deadline, so it would stall sends (a send-safety-invariant violation).
  assertRegular(file);
  // O_NONBLOCK is a no-op for a regular file but makes the open fail fast (ENXIO)
  // rather than block if a FIFO is swapped in between the check and the open;
  // O_NOFOLLOW rejects a symlink; the post-open fstat re-checks the descriptor.
  const fd = fs.openSync(file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.nlink !== 1 || stat.uid !== process.getuid() || !stat.isFile()) throw new Error(`unsafe log: ${file}`);
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, text);
  } finally { fs.closeSync(fd); }
}

export function parseLogArgs(args) {
  const options = { lines: 100, source: 'activity', follow: false };
  const bad = () => { throw Object.assign(new Error('usage: logs [--follow] [--lines N] [--source activity|stdout|stderr]'), { exitCode: 2 }); };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--follow') options.follow = true;
    else if (args[i] === '--lines') {
      const value = args[++i];
      if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) bad();
      options.lines = Number(value);
    } else if (args[i] === '--source') {
      const value = args[++i];
      if (!Object.hasOwn(LOG_FILES, value)) bad();
      options.source = value;
    } else bad();
  }
  return options;
}

export async function followLog(file, { lines = 100, write, signal, interval = 200 }) {
  let identity = null, offset = 0, anchor = Buffer.alloc(0);
  let decoder = new StringDecoder('utf8');
  while (!signal?.aborted) {
    const fd = openRegular(file, fs.constants.O_RDONLY);
    if (fd !== null) {
      try {
        const stat = fs.fstatSync(fd), id = `${stat.dev}:${stat.ino}`;
        const check = Buffer.alloc(anchor.length);
        if (offset >= anchor.length) fs.readSync(fd, check, 0, check.length, offset - anchor.length);
        const reset = id !== identity || stat.size < offset || !check.equals(anchor);
        if (reset) {
          decoder = new StringDecoder('utf8');
          write(lastLines(decoder.write(tailBytes(fd, stat.size)), lines));
          offset = stat.size; identity = id;
        } else {
          while (offset < stat.size) {
            const bytes = Buffer.alloc(Math.min(64 * 1024, stat.size - offset));
            const n = fs.readSync(fd, bytes, 0, bytes.length, offset);
            if (!n) break;
            write(decoder.write(bytes.subarray(0, n))); offset += n;
          }
        }
        anchor = Buffer.alloc(Math.min(offset, 64));
        fs.readSync(fd, anchor, 0, anchor.length, offset - anchor.length);
      } finally { fs.closeSync(fd); }
    } else { identity = null; offset = 0; anchor = Buffer.alloc(0); }
    try { await delay(interval, undefined, { signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
}
