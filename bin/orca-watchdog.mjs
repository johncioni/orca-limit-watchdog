#!/usr/bin/env node
import { runCli } from '../lib/management.mjs';

// A downstream reader that closes the pipe early (e.g. `orca-watchdog logs | head`)
// makes stdout emit EPIPE; treat it as a clean stop instead of crashing with a
// stack trace. Any other stdout error is surfaced rather than silently swallowed.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  console.error(`error: ${error.message}`);
  process.exit(1);
});

try {
  process.exitCode = await runCli();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
}
