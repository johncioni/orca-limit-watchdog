#!/usr/bin/env node
// Loopback Statuspage stub for E2E: answers a scripted sequence of indicators
// (last value repeats). Usage: node status-stub.mjs <port> major,none
import http from 'node:http';

export function startStub(port, sequence) {
  let i = 0;
  const server = http.createServer((req, res) => {
    const indicator = sequence[Math.min(i++, sequence.length - 1)];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ page: { name: 'stub' }, status: { indicator, description: indicator } }));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  })));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [port, seq] = process.argv.slice(2);
  const stub = await startStub(Number(port), seq.split(','));
  console.log(`status stub on http://127.0.0.1:${stub.port}/api/v2/status.json serving ${seq}`);
}
