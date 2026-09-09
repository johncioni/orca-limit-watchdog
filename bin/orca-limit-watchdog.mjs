#!/usr/bin/env node
import { runCli } from '../lib/management.mjs';

try {
  process.exitCode = await runCli();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
}
