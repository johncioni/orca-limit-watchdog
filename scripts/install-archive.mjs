#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRelease, rollbackRelease, VERSION } from '../lib/management.mjs';

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const action = process.argv[2] ?? 'install';

try {
  const message = action === 'rollback'
    ? rollbackRelease({ env: process.env })
    : installRelease({ sourceRoot, version: VERSION, env: process.env });
  console.log(message);
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
