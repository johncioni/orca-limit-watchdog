#!/usr/bin/env node
import { uninstallRelease } from '../lib/management.mjs';

try {
  console.log(uninstallRelease({ env: process.env }));
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
