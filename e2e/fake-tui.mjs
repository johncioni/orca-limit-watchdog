#!/usr/bin/env node
// Fake paused agent TUI for E2E testing. Prints a Claude-style limit banner,
// then appends anything it receives on stdin to the given file.
// Usage: node fake-tui.mjs <received-file> <reset-time-text e.g. "9:05am">
import fs from 'node:fs';

const [outFile, resetText] = process.argv.slice(2);
console.log('─'.repeat(60));
console.log(`Claude usage limit reached. Your limit will reset at ${resetText}.`);
console.log('> ');

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => fs.appendFileSync(outFile, d));
