import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBanner, parseResetTime, reconcile, eventKey } from './watchdog.mjs';

const CLAUDE_BANNER = [
  '─'.repeat(40),
  'Claude usage limit reached. Your limit will reset at 3am (America/New_York).',
  '> ',
];
const CODEX_BANNER = [
  "You've hit your usage limit. Try again at 14:00.",
];
const GEMINI_BANNER = [
  'Quota exceeded: daily limit reached for gemini-3-pro. Resets in 2 hours 15 minutes.',
];

// --- detectBanner ---

test('detects Claude limit banner', () => {
  const b = detectBanner(CLAUDE_BANNER);
  assert.ok(b);
  assert.match(b.bannerText, /usage limit reached/i);
});

test('detects Codex limit banner', () => {
  assert.ok(detectBanner(CODEX_BANNER));
});

test('detects Gemini quota banner', () => {
  assert.ok(detectBanner(GEMINI_BANNER));
});

test('vetoes "approaching" warning banners', () => {
  assert.equal(
    detectBanner(['Approaching weekly limit · resets at 5pm', '> working...']),
    null
  );
});

test('no match without a reset phrase', () => {
  assert.equal(detectBanner(['error: rate limit exceeded (HTTP 429)']), null);
});

test('no match on ordinary code/log output mentioning limits', () => {
  assert.equal(detectBanner(['const usageLimit = 5; // reached?']), null);
});

test('only scans the last 15 lines', () => {
  const lines = [...CLAUDE_BANNER, ...Array(20).fill('normal output')];
  assert.equal(detectBanner(lines), null);
});

// --- parseResetTime ---

const NOW = new Date('2026-07-23T23:00:00'); // 11pm local

test('parses 12h times, rolling forward past midnight', () => {
  const t = parseResetTime('resets at 3am', NOW);
  assert.equal(t.getHours(), 3);
  assert.equal(t.getDate(), 24); // tomorrow
});

test('parses 12h time with minutes', () => {
  const t = parseResetTime('resets 11:30pm', NOW);
  assert.equal(t.getHours(), 23);
  assert.equal(t.getMinutes(), 30);
  assert.equal(t.getDate(), 23); // still today (in 30 min)
});

test('parses 24h times', () => {
  const t = parseResetTime('try again at 23:45', NOW);
  assert.equal(t.getHours(), 23);
  assert.equal(t.getMinutes(), 45);
});

test('parses relative times', () => {
  const t = parseResetTime('resets in 2 hours 15 minutes', NOW);
  assert.equal(t.getTime(), NOW.getTime() + (2 * 60 + 15) * 60_000);
});

test('parses bare relative minutes', () => {
  const t = parseResetTime('try again in 45 minutes', NOW);
  assert.equal(t.getTime(), NOW.getTime() + 45 * 60_000);
});

test('recent past time (≤2h grace) means already reset — acts now, not tomorrow', () => {
  const t = parseResetTime('resets at 10pm', NOW); // 1h ago
  assert.equal(t.getDate(), 23);
  assert.equal(t.getHours(), 22);
});

test('older past time rolls to tomorrow', () => {
  const t = parseResetTime('resets at 4pm', NOW); // 7h ago
  assert.equal(t.getDate(), 24);
});

test('unparsable returns null', () => {
  assert.equal(parseResetTime('resets eventually', NOW), null);
});

// --- reconcile lifecycle ---

const H = 'term_abc';
const min = (n) => n * 60_000;
const obs = (banner) => [{ handle: H, banner: banner ? { bannerText: banner } : null }];
const BANNER = 'Claude usage limit reached. | Your limit will reset at 3am.';

test('event key is the terminal handle alone', () => {
  assert.equal(eventKey(H), H);
});

test('echoed resume text changing the banner does not create a new event or resend', () => {
  const state = { [H]: { handle: H, bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 1, lastAttemptAt: NOW.toISOString(), status: 'resumed' } };
  const mutated = BANNER + ' | Session rate limit has reset. Resume where you left off.';
  const r = reconcile(state, obs(mutated), new Date(NOW.getTime() + min(2)));
  assert.equal(Object.keys(r.events).length, 1);
  assert.deepEqual(r.sendCandidates, []);
  assert.equal(r.events[H].status, 'resumed');
  assert.equal(r.events[H].attempts, 1);
});

test('creates a waiting event on detection', () => {
  const { events, sendCandidates } = reconcile({}, obs(BANNER), NOW);
  const [key] = Object.keys(events);
  assert.equal(events[key].status, 'waiting');
  assert.equal(events[key].attempts, 0);
  assert.deepEqual(sendCandidates, []); // 3am is hours away
});

test('unparsable reset time waits 1h from detection', () => {
  const { events } = reconcile({}, obs('session limit reached, try again later'), NOW);
  const ev = Object.values(events)[0];
  assert.equal(new Date(ev.resetAt).getTime(), NOW.getTime() + min(60));
});

test('becomes a send candidate after resetAt + 2min buffer', () => {
  let { events } = reconcile({}, obs(BANNER), NOW);
  const later = new Date(new Date(Object.values(events)[0].resetAt).getTime() + min(3));
  const r = reconcile(events, obs(BANNER), later);
  assert.equal(r.sendCandidates.length, 1);
});

test('resumed event does not resend within 10 minutes', () => {
  const key = eventKey(H);
  const state = { [key]: { handle: H, bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 1, lastAttemptAt: NOW.toISOString(), status: 'resumed' } };
  const r = reconcile(state, obs(BANNER), new Date(NOW.getTime() + min(5)));
  assert.deepEqual(r.sendCandidates, []);
  assert.equal(r.events[key].status, 'resumed');
});

test('banner persisting ≥10min after send re-arms, retry gated to ≥30min spacing', () => {
  const key = eventKey(H);
  const state = { [key]: { handle: H, bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 1, lastAttemptAt: NOW.toISOString(), status: 'resumed' } };
  const at15 = reconcile(state, obs(BANNER), new Date(NOW.getTime() + min(15)));
  assert.equal(at15.events[key].status, 'waiting');
  assert.deepEqual(at15.sendCandidates, []); // 30min spacing not yet met
  const at35 = reconcile(at15.events, obs(BANNER), new Date(NOW.getTime() + min(35)));
  assert.deepEqual(at35.sendCandidates, [key]);
});

test('gives up after 3 attempts', () => {
  const key = eventKey(H);
  const state = { [key]: { handle: H, bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 3, lastAttemptAt: NOW.toISOString(), status: 'resumed' } };
  const r = reconcile(state, obs(BANNER), new Date(NOW.getTime() + min(15)));
  assert.equal(r.events[key].status, 'gave_up');
  const r2 = reconcile(r.events, obs(BANNER), new Date(NOW.getTime() + min(90)));
  assert.deepEqual(r2.sendCandidates, []);
});

test('banner gone deletes the event (success)', () => {
  const key = eventKey(H);
  const state = { [key]: { handle: H, bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 1, lastAttemptAt: NOW.toISOString(), status: 'resumed' } };
  const r = reconcile(state, obs(null), new Date(NOW.getTime() + min(5)));
  assert.deepEqual(r.events, {});
});

test('terminal gone deletes the event', () => {
  const key = eventKey(H);
  const state = { [key]: { handle: H, bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 0, lastAttemptAt: null, status: 'waiting' } };
  const r = reconcile(state, [], NOW);
  assert.deepEqual(r.events, {});
});

test('same banner reappearing after absence is a fresh event', () => {
  const key = eventKey(H);
  const state = { [key]: { handle: H, bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 3, lastAttemptAt: NOW.toISOString(), status: 'gave_up' } };
  const gone = reconcile(state, obs(null), new Date(NOW.getTime() + min(5)));
  const back = reconcile(gone.events, obs(BANNER), new Date(NOW.getTime() + min(10)));
  assert.equal(Object.values(back.events)[0].attempts, 0);
});

test('countdown digit changes do not spawn new events', () => {
  const a = reconcile({}, obs('usage limit reached, resets in 2 hours'), NOW);
  const b = reconcile(a.events, obs('usage limit reached, resets in 1 hours'), new Date(NOW.getTime() + min(60)));
  assert.equal(Object.keys(b.events).length, 1);
  assert.equal(Object.values(b.events)[0].detectedAt, NOW.toISOString());
});
