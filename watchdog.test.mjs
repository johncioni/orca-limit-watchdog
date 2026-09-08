import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBanner, parseResetTime, reconcile, eventKey, stripAnsi, sanitize, hasOutageLine, inferPlatform,
  SCHEDULE, OUTAGE_RESUME_TEXT, newEvent, validateEvent, parseStateFile } from './watchdog.mjs';
import { isShellPrompt, isInputOccupied } from './watchdog.mjs';
import { statusUrlFor, fetchIndicator, suppressedByStatus } from './watchdog.mjs';
import { tick, RESUME_TEXT } from './watchdog.mjs';

const CLAUDE_BANNER = [
  '─'.repeat(40),
  'Claude usage limit reached. Your limit will reset at 3am (America/New_York).',
  '> ',
];
const CODEX_BANNER = [
  "You've hit your usage limit. Try again at Sep 8th, 2026 2:00 PM.",
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

test('limit bannerText is sanitized before storage', () => {
  const b = detectBanner([
    'Claude usage limit reached.',
    'Your limit will reset at 3am. Authorization: Bearer abc123token',
  ]);
  assert.match(b.bannerText, /usage limit reached/i);
  assert.match(b.bannerText, /\[redacted\]/);
  assert.doesNotMatch(b.bannerText, /Bearer/i);
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

const FOOTER = 'Context ██░░░░░░░░ 19% │ Usage ████░░░░░░ 41% (resets in 3h 8m)';

test('usage footer does not turn a prose rate-limit line into a limit event (DOG-3)', () => {
  assert.equal(detectBanner(['error: rate limit exceeded (HTTP 429)', FOOTER, '> ', '? for shortcuts'], 'claude'), null);
  assert.equal(detectBanner(['Working around the rate limit we hit yesterday.', FOOTER, '> ', '? for shortcuts'], 'claude'), null);
});

test('limit phrase and reached word must share a line', () => {
  assert.equal(detectBanner(['usage limit', 'reached', 'resets at 3pm']), null);
});

test('a real banner is still detected next to the footer, and the footer never enters bannerText', () => {
  const b = detectBanner([...CLAUDE_BANNER, FOOTER, '? for shortcuts'], 'claude');
  assert.ok(b);
  assert.equal(b.kind, 'limit');
  assert.match(b.bannerText, /reset at 3am/i);
  assert.doesNotMatch(b.bannerText, /3h 8m/);
});

test('only scans the last 15 lines', () => {
  const lines = [...CLAUDE_BANNER, ...Array(20).fill('normal output')];
  assert.equal(detectBanner(lines), null);
});

// --- outage detection ---

const CHROME_TAIL = ['', '─'.repeat(40), '> ', '? for shortcuts'];
const CLAUDE_529 = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CTx"}';
const outageTail = (line) => ['some earlier output', line, ...CHROME_TAIL];

test('existing limit banners now carry kind "limit"', () => {
  assert.equal(detectBanner(CLAUDE_BANNER).kind, 'limit');
  assert.equal(detectBanner(CODEX_BANNER).kind, 'limit');
});

test('detects Claude API outage banners (529, 503, Connection error, ⎿ prefix) on claude and unknown', () => {
  for (const platform of ['claude', 'unknown']) {
    for (const line of [CLAUDE_529, '⎿  ' + CLAUDE_529, 'API Error: 503 Service Unavailable', 'API Error: Connection error']) {
      const b = detectBanner(outageTail(line), platform);
      assert.ok(b, `${platform}: ${line}`);
      assert.equal(b.kind, 'outage');
      assert.equal(b.patternId, 'claude-api-error');
      assert.match(b.bannerText, /^(?:⎿\s*)?API Error/);
    }
  }
});

test('outage bannerText is sanitized and capped at 200 chars', () => {
  const b = detectBanner(outageTail('API Error: 529 ' + 'x '.repeat(300)), 'claude');
  assert.ok(b.bannerText.length <= 201);
  assert.match(b.bannerText, /…$/);
});

test('non-outage API errors do not match', () => {
  for (const code of [400, 401, 403, 429]) {
    assert.equal(detectBanner(outageTail(`API Error: ${code} {"type":"error"}`), 'claude'), null, String(code));
  }
});

test('the Claude pattern is not applied to codex terminals', () => {
  assert.equal(detectBanner(outageTail(CLAUDE_529), 'codex'), null);
});

test('prose, code and logs mentioning errors do not match', () => {
  const lines = [
    'I saw "API Error: 529" in the logs yesterday.',
    'const status = 500; // or 529',
    'connection reset by peer; stream error; ECONNRESET; fetch failed; overloaded',
    '> ',
  ];
  assert.equal(detectBanner(lines, 'claude'), null);
});

test('ordinary agent output ending at the input box does not match', () => {
  assert.equal(detectBanner(['Done. All tests pass.', '', '> ', '? for shortcuts'], 'claude'), null);
});

test('a stale error the agent worked past fails the final-block requirement', () => {
  assert.equal(detectBanner([CLAUDE_529, 'Retrying succeeded, continuing with the task.', 'Edited foo.js', '> '], 'claude'), null);
  assert.equal(detectBanner([CLAUDE_529, 'john@mac ~ %'], 'claude'), null);
});

test('retry markers at or after the error veto; before the error do not', () => {
  assert.equal(detectBanner([CLAUDE_529, 'Retrying in 5s… (attempt 2/10)', '> '], 'claude'), null);
  assert.equal(detectBanner(['API Error: 529 overloaded_error · Retrying in 4s', '> '], 'claude'), null);
  assert.ok(detectBanner(['Retrying in 5s…', CLAUDE_529, '> '], 'claude'));
  assert.ok(detectBanner([CLAUDE_529, 'Retrying in 5s…', CLAUDE_529, '> '], 'claude'));
});

test('"reconnecting…" alone is neither a match nor a veto', () => {
  assert.equal(detectBanner(['reconnecting…', '> '], 'claude'), null);
});

test('ANSI-wrapped banner and chrome still match; ANSI-wrapped prose still does not', () => {
  assert.ok(detectBanner(['\x1b[31m' + CLAUDE_529 + '\x1b[0m', '\x1b[2m> \x1b[0m'], 'claude'));
  assert.equal(detectBanner(['\x1b[31mI saw "API Error: 529" once\x1b[0m', '> '], 'claude'), null);
});

test('class precedence is chronological by last contributing line', () => {
  const limitLine = 'Claude usage limit reached.';
  const resetLine = 'Your limit will reset at 3am.';
  assert.equal(detectBanner([limitLine, resetLine, CLAUDE_529, '> '], 'claude').kind, 'outage');
  assert.equal(detectBanner([CLAUDE_529, limitLine, resetLine, '> '], 'claude').kind, 'limit');
  assert.equal(detectBanner([limitLine, CLAUDE_529, resetLine, '> '], 'claude').kind, 'limit');
  assert.equal(detectBanner(['Session limit reached: API Error: 529 overloaded_error, try again later', '> '], 'claude').kind, 'limit');
});

test('hasOutageLine reports a pattern line regardless of platform or trailing prose', () => {
  assert.equal(hasOutageLine([CLAUDE_529, 'moved on', 'john@mac ~ %']), true);
  assert.equal(hasOutageLine(['all good', '> ']), false);
});

// --- inferPlatform ---

test('agentIdentity is authoritative; banner is the fallback; else unknown', () => {
  const claudeBanner = { patternId: 'claude-api-error' };
  assert.equal(inferPlatform({ agentIdentity: 'codex' }, claudeBanner), 'codex');
  assert.equal(inferPlatform({ agentIdentity: 'claude' }, null), 'claude');
  assert.equal(inferPlatform({}, claudeBanner), 'claude');
  assert.equal(inferPlatform(undefined, claudeBanner), 'claude');
  assert.equal(inferPlatform({ agentIdentity: 'gpt' }, null), 'unknown');
  assert.equal(inferPlatform({}, { patternId: 'limit' }), 'unknown');
  assert.equal(inferPlatform({ agentIdentity: 'gpt' }), 'unknown');
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

test('parses compact relative resets "in 3h 8m", "in 2h", "in 1hr 5m" (DOG-4)', () => {
  const now = new Date('2026-09-07T10:00:00');
  assert.equal(parseResetTime('Usage 41% (resets in 3h 8m)', now).getTime(), now.getTime() + 188 * 60_000);
  assert.equal(parseResetTime('resets in 2h', now).getTime(), now.getTime() + 120 * 60_000);
  assert.equal(parseResetTime('try again in 1hr 5m', now).getTime(), now.getTime() + 65 * 60_000);
  assert.equal(parseResetTime('resets in 45m', now).getTime(), now.getTime() + 45 * 60_000);
});

test('parses multi-day and month-day resets instead of defaulting to today (DOG-5)', () => {
  const now = new Date('2026-09-07T10:00:00');
  assert.equal(parseResetTime('Weekly limit reached. Resets in 3 days.', now).getTime(), now.getTime() + 3 * 24 * 60 * 60_000);
  assert.equal(parseResetTime('resets Sep 12 at 3pm', now).getTime(), new Date('2026-09-12T15:00:00').getTime());
  assert.equal(parseResetTime('resets September 12, 09:30', now).getTime(), new Date('2026-09-12T09:30:00').getTime());
  // no time given: start of that day is the earliest safe assumption
  assert.equal(parseResetTime('resets on Sep 12', now).getTime(), new Date('2026-09-12T00:00:00').getTime());
  // a month-day already more than 2 minutes in the past means next year
  assert.equal(parseResetTime('resets Jan 3 at 3pm', now).getTime(), new Date('2027-01-03T15:00:00').getTime());
});

test('parses month-day resets with an ordinal suffix and a year, as Codex prints them (DOG-16)', () => {
  const now = new Date('2026-09-07T10:00:00');
  assert.equal(parseResetTime("You've hit your usage limit. Try again at Sep 12th, 2026 9:30 AM.", now).getTime(), new Date('2026-09-12T09:30:00').getTime());
  assert.equal(parseResetTime('Try again at Sep 8th, 2026 2:00 PM.', now).getTime(), new Date('2026-09-08T14:00:00').getTime());
  assert.equal(parseResetTime('resets Oct 1st at 3pm', now).getTime(), new Date('2026-10-01T15:00:00').getTime());
  assert.equal(parseResetTime('resets Jan 2nd, 2027 8:00 AM', now).getTime(), new Date('2027-01-02T08:00:00').getTime());
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
const obs = (banner, extra = {}) => [{ handle: H, platform: 'unknown', ...extra,
  banner: banner ? (typeof banner === 'string' ? { kind: 'limit', bannerText: banner } : banner) : null }];
const LIMIT_EV = { handle: H, kind: 'limit', platform: 'unknown' };
const BANNER = 'Claude usage limit reached. | Your limit will reset at 3am.';

// --- schema v2 ---

const V1 = { handle: H, bannerText: BANNER, detectedAt: NOW.toISOString(), resetAt: NOW.toISOString(),
  attempts: 1, lastAttemptAt: NOW.toISOString(), status: 'resumed' };
const V2 = { ...V1, kind: 'limit', platform: 'unknown' };

test('schedule table matches the spec', () => {
  assert.deepEqual(SCHEDULE.limit, { bufferMs: min(2), retrySpacingMs: min(30), rearmMs: min(10), maxSends: 3, deadlineMs: null,
    resumeText: 'Session rate limit has reset. Resume where you left off.' });
  assert.deepEqual(SCHEDULE.outage, { bufferMs: 0, retrySpacingMs: min(30), rearmMs: min(10), maxSends: 6, deadlineMs: min(24 * 60),
    initialDelayMs: min(10), resumeText: OUTAGE_RESUME_TEXT });
  assert.equal(OUTAGE_RESUME_TEXT, 'The API outage appears to be over. Resume where you left off.');
});

test('newEvent: outage resetAt is detectedAt + 10 min; limit parses the banner', () => {
  const o = newEvent({ handle: H, platform: 'claude', banner: { kind: 'outage', bannerText: 'API Error: 529', patternId: 'claude-api-error' } }, NOW);
  assert.deepEqual(o, { handle: H, kind: 'outage', platform: 'claude', bannerText: 'API Error: 529', detectedAt: NOW.toISOString(),
    resetAt: new Date(NOW.getTime() + min(10)).toISOString(), attempts: 0, lastAttemptAt: null, status: 'waiting' });
  const l = newEvent({ handle: H, platform: 'unknown', banner: { kind: 'limit', bannerText: 'session limit reached, resets in 2 hours' } }, NOW);
  assert.equal(l.kind, 'limit');
  assert.equal(new Date(l.resetAt).getTime(), NOW.getTime() + min(120));
});

test('validateEvent accepts a valid v2 event and names the first violation otherwise', () => {
  assert.equal(validateEvent(H, V2), null);
  assert.equal(validateEvent(H, { ...V2, attempts: 0, lastAttemptAt: null, status: 'waiting' }), null);
  const bad = [
    ['handle', { ...V2, handle: 'other' }],
    ['kind', { ...V2, kind: 'oops' }],
    ['kind', (() => { const { kind, ...rest } = V2; return rest; })()],
    ['platform', { ...V2, platform: 'gpt' }],
    ['platform', { ...V2, kind: 'outage', platform: 'unknown' }],
    ['status', { ...V2, status: 'done' }],
    ['bannerText', { ...V2, bannerText: 5 }],
    ['detectedAt', { ...V2, detectedAt: 'yesterday' }],
    ['resetAt', { ...V2, resetAt: 12 }],
    ['attempts', { ...V2, attempts: -1 }],
    ['attempts', { ...V2, attempts: 7 }],
    ['attempts', { ...V2, kind: 'outage', platform: 'claude', attempts: 7 }],
    ['attempts', { ...V2, attempts: 1.5 }],
    ['lastAttemptAt', { ...V2, lastAttemptAt: null }],            // resumed needs a timestamp
    ['lastAttemptAt', { ...V2, status: 'waiting', lastAttemptAt: null }], // attempts > 0 needs one
    ['lastAttemptAt', { ...V2, lastAttemptAt: 'nope' }],
  ];
  for (const [field, ev] of bad) assert.match(validateEvent(H, ev) ?? 'VALID', new RegExp(field), JSON.stringify(ev));
  assert.equal(validateEvent(H, { ...V2, kind: 'outage', platform: 'claude', attempts: 6 }), null);
});

test('parseStateFile upgrades v1 in memory, round-trips v2, rejects everything else', () => {
  const v1 = parseStateFile(JSON.stringify({ version: 1, events: { [H]: V1 } }));
  assert.deepEqual(v1[H], V2);
  const v2 = parseStateFile(JSON.stringify({ version: 2, events: { [H]: V2 } }));
  assert.deepEqual(v2[H], V2);
  assert.equal(parseStateFile(JSON.stringify({ version: 3, events: {} })), null);
  assert.equal(parseStateFile(JSON.stringify({ version: 2, events: { [H]: V1 } })), null); // missing kind
  assert.equal(parseStateFile(JSON.stringify({ version: 2, events: { [H]: { ...V2, attempts: -1 } } })), null);
  assert.equal(parseStateFile('not json'), null);
  assert.deepEqual(parseStateFile(JSON.stringify({ version: 2, events: {} })), {});
});

test('event key is the terminal handle alone', () => {
  assert.equal(eventKey(H), H);
});

test('echoed resume text changing the banner does not create a new event or resend', () => {
  const state = { [H]: { ...LIMIT_EV, bannerText: BANNER, detectedAt: NOW.toISOString(),
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
  const state = { [key]: { ...LIMIT_EV, bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 1, lastAttemptAt: NOW.toISOString(), status: 'resumed' } };
  const r = reconcile(state, obs(BANNER), new Date(NOW.getTime() + min(5)));
  assert.deepEqual(r.sendCandidates, []);
  assert.equal(r.events[key].status, 'resumed');
});

test('banner persisting ≥10min after send re-arms, retry gated to ≥30min spacing', () => {
  const key = eventKey(H);
  const state = { [key]: { ...LIMIT_EV, bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 1, lastAttemptAt: NOW.toISOString(), status: 'resumed' } };
  const at15 = reconcile(state, obs(BANNER), new Date(NOW.getTime() + min(15)));
  assert.equal(at15.events[key].status, 'waiting');
  assert.deepEqual(at15.sendCandidates, []); // 30min spacing not yet met
  const at35 = reconcile(at15.events, obs(BANNER), new Date(NOW.getTime() + min(35)));
  assert.deepEqual(at35.sendCandidates, [key]);
});

test('gives up after 3 attempts', () => {
  const key = eventKey(H);
  const state = { [key]: { ...LIMIT_EV, bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 3, lastAttemptAt: NOW.toISOString(), status: 'resumed' } };
  const r = reconcile(state, obs(BANNER), new Date(NOW.getTime() + min(15)));
  assert.equal(r.events[key].status, 'gave_up');
  const r2 = reconcile(r.events, obs(BANNER), new Date(NOW.getTime() + min(90)));
  assert.deepEqual(r2.sendCandidates, []);
});

test('banner gone deletes the event (success)', () => {
  const key = eventKey(H);
  const state = { [key]: { ...LIMIT_EV, bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 1, lastAttemptAt: NOW.toISOString(), status: 'resumed' } };
  const held = reconcile(state, obs(null), new Date(NOW.getTime() + min(5)));       // first miss: held (DOG-11)
  assert.ok(held.events[key], 'kept after one absent tick');
  const r = reconcile(held.events, obs(null), new Date(NOW.getTime() + min(10)));   // second miss: deleted
  assert.deepEqual(r.events, {});
});

test('terminal gone deletes the event', () => {
  const key = eventKey(H);
  const state = { [key]: { ...LIMIT_EV, bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 0, lastAttemptAt: null, status: 'waiting' } };
  const r = reconcile(state, [], NOW);
  assert.deepEqual(r.events, {});
});

test('same banner reappearing after absence is a fresh event', () => {
  const key = eventKey(H);
  const state = { [key]: { ...LIMIT_EV, bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 3, lastAttemptAt: NOW.toISOString(), status: 'gave_up' } };
  const held = reconcile(state, obs(null), new Date(NOW.getTime() + min(5)));       // first miss: held (DOG-11)
  const gone = reconcile(held.events, obs(null), new Date(NOW.getTime() + min(10))); // second miss: deleted
  assert.deepEqual(gone.events, {});
  const back = reconcile(gone.events, obs(BANNER), new Date(NOW.getTime() + min(15)));
  assert.equal(Object.values(back.events)[0].attempts, 0);
});

test('countdown digit changes do not spawn new events', () => {
  const a = reconcile({}, obs('usage limit reached, resets in 2 hours'), NOW);
  const b = reconcile(a.events, obs('usage limit reached, resets in 1 hours'), new Date(NOW.getTime() + min(60)));
  assert.equal(Object.keys(b.events).length, 1);
  assert.equal(Object.values(b.events)[0].detectedAt, NOW.toISOString());
});

test('reconcile: a banner missing for ONE tick marks clearedAt and keeps attempts; TWO ticks deletes (DOG-11)', () => {
  const now = at(10);
  const ev = { handle: H, kind: 'limit', platform: 'claude', bannerText: BANNER, detectedAt: at(0).toISOString(), resetAt: at(0).toISOString(),
    attempts: 2, lastAttemptAt: at(5).toISOString(), status: 'waiting' };
  const gone = { handle: H, banner: null, platform: 'claude' };
  const r1 = reconcile({ [H]: ev }, [gone], now, [H]);
  assert.ok(r1.events[H], 'kept after one absent tick');
  assert.equal(r1.events[H].attempts, 2);
  assert.equal(r1.events[H].clearedAt, now.toISOString());
  assert.deepEqual(r1.sendCandidates, []);
  const r2 = reconcile(r1.events, [gone], at(15), [H]);
  assert.equal(r2.events[H], undefined, 'deleted after two consecutive absent ticks');
});

test('reconcile: the banner coming back clears clearedAt and keeps the attempt count', () => {
  const ev = { handle: H, kind: 'limit', platform: 'claude', bannerText: BANNER, detectedAt: at(0).toISOString(), resetAt: at(0).toISOString(),
    attempts: 2, lastAttemptAt: at(5).toISOString(), status: 'waiting', clearedAt: at(10).toISOString() };
  const back = { handle: H, banner: { kind: 'limit', bannerText: BANNER, patternId: 'limit' }, platform: 'claude' };
  const r = reconcile({ [H]: ev }, [back], at(40), [H]);
  assert.equal(r.events[H].attempts, 2);
  assert.equal(r.events[H].clearedAt, undefined);
  assert.deepEqual(r.sendCandidates, [H]);
});

test('validateEvent accepts clearedAt absent or ISO, rejects garbage', () => {
  const base = { handle: H, kind: 'limit', platform: 'claude', bannerText: BANNER, detectedAt: at(0).toISOString(), resetAt: at(0).toISOString(),
    attempts: 0, lastAttemptAt: null, status: 'waiting' };
  assert.equal(validateEvent(H, base), null);
  assert.equal(validateEvent(H, { ...base, clearedAt: at(1).toISOString() }), null);
  assert.match(validateEvent(H, { ...base, clearedAt: 'soon' }), /clearedAt/);
});

// --- outage lifecycle ---

const OUTAGE_BANNER = { kind: 'outage', bannerText: 'API Error: 529 overloaded_error', patternId: 'claude-api-error' };
const oobs = (banner = OUTAGE_BANNER, platform = 'claude') => obs(banner, { platform });
const at = (m) => new Date(NOW.getTime() + min(m));
const seed = (over = {}) => ({ [H]: { handle: H, kind: 'outage', platform: 'claude', bannerText: OUTAGE_BANNER.bannerText,
  detectedAt: NOW.toISOString(), resetAt: at(10).toISOString(), attempts: 0, lastAttemptAt: null, status: 'waiting', ...over } });

test('outage: waiting event, candidate at exactly +10 min and not before', () => {
  const { events } = reconcile({}, oobs(), NOW);
  assert.equal(events[H].kind, 'outage');
  assert.equal(events[H].platform, 'claude');
  assert.equal(events[H].resetAt, at(10).toISOString());
  assert.deepEqual(reconcile(events, oobs(), at(9)).sendCandidates, []);
  assert.deepEqual(reconcile(events, oobs(), at(10)).sendCandidates, [H]);
});

test('outage: retry only after the 10-min verify and ≥30 min spacing', () => {
  const sent = seed({ attempts: 1, lastAttemptAt: at(10).toISOString(), status: 'resumed' });
  assert.equal(reconcile(sent, oobs(), at(19)).events[H].status, 'resumed');
  const r = reconcile(sent, oobs(), at(20));
  assert.equal(r.events[H].status, 'waiting');
  assert.deepEqual(r.sendCandidates, []);                       // 30-min spacing not yet met
  assert.deepEqual(reconcile(sent, oobs(), at(40)).sendCandidates, [H]);
});

test('outage: sixth send stays resumed through verify, then gave_up', () => {
  const sixth = seed({ attempts: 6, lastAttemptAt: at(200).toISOString(), status: 'resumed' });
  assert.equal(reconcile(sixth, oobs(), at(205)).events[H].status, 'resumed');
  const r = reconcile(sixth, oobs(), at(210));
  assert.equal(r.events[H].status, 'gave_up');
  assert.deepEqual(r.sendCandidates, []);
});

test('outage: deadline at exactly +24h gives up even with attempts left', () => {
  const r = reconcile(seed({ attempts: 2, lastAttemptAt: at(60).toISOString() }), oobs(), at(24 * 60));
  assert.equal(r.events[H].status, 'gave_up');
  assert.deepEqual(r.sendCandidates, []);
  assert.equal(reconcile(seed(), oobs(), at(24 * 60 - 1)).events[H].status, 'waiting');
  const alreadyGaveUp = reconcile(
    seed({ attempts: 2, lastAttemptAt: at(60).toISOString(), status: 'gave_up' }),
    oobs(),
    at(24 * 60 + 1),
  );
  assert.equal(alreadyGaveUp.events[H].status, 'gave_up');
  assert.deepEqual(alreadyGaveUp.sendCandidates, []);
});

test('outage: limit events have no deadline', () => {
  const st = { [H]: { ...LIMIT_EV, bannerText: BANNER, detectedAt: NOW.toISOString(), resetAt: at(48 * 60).toISOString(),
    attempts: 0, lastAttemptAt: null, status: 'waiting' } };
  assert.equal(reconcile(st, obs(BANNER), at(30 * 60)).events[H].status, 'waiting');
});

test('gave_up event whose banner clears is deleted', () => {
  const held = reconcile(seed({ attempts: 6, lastAttemptAt: at(1).toISOString(), status: 'gave_up' }), obs(null), at(300));
  assert.ok(held.events[H], 'held after one absent tick (DOG-11)');
  const r = reconcile(held.events, obs(null), at(330));
  assert.deepEqual(r.events, {});
});

test('unread live event is frozen: no candidate, no deadline, no re-arm', () => {
  const st = seed({ attempts: 1, lastAttemptAt: at(10).toISOString(), status: 'resumed' });
  const r = reconcile(st, [], at(48 * 60), [H]);
  assert.deepEqual(r.events, st);
  assert.deepEqual(r.sendCandidates, []);
});

test('replace: kind change from every status yields a fresh event with attempts 0', () => {
  for (const status of ['waiting', 'resumed', 'gave_up']) {
    const st = seed({ attempts: 3, lastAttemptAt: at(5).toISOString(), status });
    const r = reconcile(st, obs(BANNER, { platform: 'claude' }), at(100));
    assert.equal(r.events[H].kind, 'limit', status);
    assert.equal(r.events[H].attempts, 0);
    assert.equal(r.events[H].status, 'waiting');
    assert.equal(r.events[H].detectedAt, at(100).toISOString());
    assert.deepEqual(r.sendCandidates, []);                     // never a candidate on the replacing tick
    const lim = { [H]: { ...LIMIT_EV, platform: 'claude', bannerText: BANNER, detectedAt: NOW.toISOString(), resetAt: NOW.toISOString(),
      attempts: 2, lastAttemptAt: at(5).toISOString(), status } };
    const r2 = reconcile(lim, oobs(), at(100));
    assert.equal(r2.events[H].kind, 'outage', status);
    assert.equal(r2.events[H].attempts, 0);
  }
});

test('replace: a known, different platform replaces; unknown keeps the event', () => {
  const st = seed({ attempts: 2, lastAttemptAt: at(5).toISOString(), status: 'waiting' });
  const changed = reconcile(st, oobs(OUTAGE_BANNER, 'codex'), at(100)).events[H];
  assert.equal(changed.platform, 'codex');
  assert.equal(changed.attempts, 0);
  const kept = reconcile(st, oobs(OUTAGE_BANNER, 'unknown'), at(100)).events[H];
  assert.equal(kept.platform, 'claude');
  assert.equal(kept.attempts, 2);
});

test('limit lifecycle still uses the 2-min buffer and 3-send cap', () => {
  const st = { [H]: { ...LIMIT_EV, bannerText: BANNER, detectedAt: NOW.toISOString(), resetAt: NOW.toISOString(),
    attempts: 0, lastAttemptAt: null, status: 'waiting' } };
  assert.deepEqual(reconcile(st, obs(BANNER), at(1)).sendCandidates, []);
  assert.deepEqual(reconcile(st, obs(BANNER), at(2)).sendCandidates, [H]);
  const third = { [H]: { ...st[H], attempts: 3, lastAttemptAt: at(2).toISOString(), status: 'resumed' } };
  assert.equal(reconcile(third, obs(BANNER), at(12)).events[H].status, 'gave_up');
});

// --- prompt guard ---

test('isShellPrompt recognises shell prompt endings and fails closed on a bare ">"', () => {
  for (const p of ['john@mac ~ $', '~ %', 'root#', '❯', 'repo ➜', 'λ', '❱', 'foo>', 'cmd>  ']) {
    assert.equal(isShellPrompt(['API Error: 529', p, '', '  '], 'claude'), true, p);
  }
  assert.equal(isShellPrompt(['API Error: 529', '\x1b[32m~ %\x1b[0m']), true);
  assert.equal(isShellPrompt(['API Error: 529', '> ']), true);           // no identity ⇒ shell continuation
  assert.equal(isShellPrompt(['API Error: 529', '> '], 'codex'), true);
  assert.equal(isShellPrompt(['API Error: 529', '> '], 'claude'), false);
  assert.equal(isShellPrompt(['API Error: 529', '? for shortcuts']), false);
  assert.equal(isShellPrompt([]), false);
});

// --- status gate ---

const CLAUDE_URL = 'https://status.claude.com/api/v2/status.json';
const CODEX_URL = 'https://status.openai.com/api/v2/status.json';

test('statusUrlFor: defaults, loopback overrides honoured, everything else ignored with a warning', () => {
  assert.deepEqual(statusUrlFor('claude', {}), { url: CLAUDE_URL, warn: null });
  assert.deepEqual(statusUrlFor('codex', {}), { url: CODEX_URL, warn: null });
  for (const ok of ['http://127.0.0.1:8123/s.json', 'http://localhost:8123/s.json', 'https://[::1]:8123/s.json']) {
    assert.deepEqual(statusUrlFor('claude', { WATCHDOG_STATUS_URL_CLAUDE: ok }), { url: ok, warn: null }, ok);
  }
  for (const bad of ['https://evil.example/s.json', 'file:///etc/passwd', 'ftp://127.0.0.1/x', 'http://127.0.0.1.evil.example/', 'not a url']) {
    const r = statusUrlFor('claude', { WATCHDOG_STATUS_URL_CLAUDE: bad });
    assert.equal(r.url, CLAUDE_URL, bad);
    assert.match(r.warn, /ignoring/);
  }
  assert.equal(statusUrlFor('codex', { WATCHDOG_STATUS_URL_CLAUDE: 'http://127.0.0.1:1/' }).url, CODEX_URL);
});

const fakeFetch = (impl) => {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
  f.calls = calls;
  return f;
};
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

test('fetchIndicator reads status.indicator, passes redirect:error and a timeout signal', async () => {
  const f = fakeFetch(() => okJson({ status: { indicator: 'major' } }));
  assert.equal(await fetchIndicator(CLAUDE_URL, f), 'major');
  assert.equal(f.calls[0].opts.redirect, 'error');
  assert.ok(f.calls[0].opts.signal instanceof AbortSignal);
});

test('fetchIndicator returns null on non-200, bad JSON, missing field, or throw', async () => {
  assert.equal(await fetchIndicator(CLAUDE_URL, fakeFetch(() => ({ ok: false, status: 503, json: async () => ({}) }))), null);
  assert.equal(await fetchIndicator(CLAUDE_URL, fakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }))), null);
  assert.equal(await fetchIndicator(CLAUDE_URL, fakeFetch(() => okJson({ page: {} }))), null);
  assert.equal(await fetchIndicator(CLAUDE_URL, fakeFetch(() => { throw new TypeError('redirect'); })), null);
});

test('suppressedByStatus only for major/critical', () => {
  assert.equal(suppressedByStatus('major'), true);
  assert.equal(suppressedByStatus('critical'), true);
  for (const v of ['none', 'minor', 'weird', null, undefined]) assert.equal(suppressedByStatus(v), false, String(v));
});

// --- tick send gate (fake orca, fake fetch, in-memory state) ---

function harness({ tail, terminals, indicator = 'none', state = {}, now = at(10), readThrows = false }) {
  const sent = [];
  const orcaCalls = [];
  let saved = null;
  const orca = async (args) => {
    orcaCalls.push(args);
    const [scope, verb] = args;
    if (scope === 'terminal' && verb === 'list') return { terminals };
    if (scope === 'terminal' && verb === 'read') { if (readThrows) throw new Error('Command failed: read'); return { terminal: { tail } }; }
    if (scope === 'terminal' && verb === 'wait') return {};
    if (scope === 'terminal' && verb === 'send') { sent.push(args[args.indexOf('--text') + 1]); return {}; }
    throw new Error(`unexpected orca call ${args.join(' ')}`);
  };
  const fetchImpl = fakeFetch(() => okJson({ status: { indicator } }));
  const deps = { orca, fetchImpl, env: {}, now: () => now, loadState: () => structuredClone(state), saveState: (e) => { saved = structuredClone(e); }, log: () => {} };
  return { deps, sent, orcaCalls, fetchImpl, saved: () => saved };
}
const T = { handle: H, connected: true, writable: true, agentIdentity: 'claude' };
const OUTAGE_TAIL = [CLAUDE_529, '', '> ', '? for shortcuts'];

test('tick: due outage event, status none ⇒ one outage resume, attempt persisted before send', async () => {
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed() });
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, [OUTAGE_RESUME_TEXT]);
  assert.equal(h.saved()[H].attempts, 1);
  assert.equal(h.saved()[H].status, 'resumed');
  assert.equal(h.fetchImpl.calls.length, 1);
  assert.equal(h.fetchImpl.calls[0].url, CLAUDE_URL);
});

test('tick: status major suppresses without consuming an attempt', async () => {
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed(), indicator: 'major' });
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, []);
  assert.equal(h.saved()[H].attempts, 0);
  assert.equal(h.saved()[H].lastAttemptAt, null);
  assert.equal(h.saved()[H].status, 'waiting');
});

test('tick: limit events use the limit text and never touch the network', async () => {
  const st = { [H]: { ...LIMIT_EV, platform: 'claude', bannerText: BANNER, detectedAt: NOW.toISOString(), resetAt: NOW.toISOString(),
    attempts: 0, lastAttemptAt: null, status: 'waiting' } };
  const h = harness({ tail: [...CLAUDE_BANNER, '? for shortcuts'], terminals: [T], state: st, indicator: 'major' });
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, [RESUME_TEXT]);
  assert.equal(h.fetchImpl.calls.length, 0);
});

test('tick: dry-run makes no sends and no network calls', async () => {
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed() });
  await tick({ dryRun: true }, h.deps);
  assert.deepEqual(h.sent, []);
  assert.equal(h.fetchImpl.calls.length, 0);
  assert.equal(h.saved(), null);
});

test('isInputOccupied: a ">" line with text after it is a user draft', () => {
  assert.equal(isInputOccupied(['API Error: 529', '> my half typed draft', '? for shortcuts']), true);
  assert.equal(isInputOccupied(['API Error: 529', '> ', '? for shortcuts']), false);
  assert.equal(isInputOccupied(['API Error: 529', '>', '? for shortcuts']), false);
  assert.equal(isInputOccupied([]), false);
});

test('tick: an occupied input box skips the send and leaves the event untouched (DOG-7)', async () => {
  const h = harness({ tail: [CLAUDE_529, '', '> my half typed draft', '? for shortcuts'], terminals: [T], state: seed() });
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, []);
  assert.equal(h.saved()[H].attempts, 0);
  assert.equal(h.saved()[H].status, 'waiting');
});

test('tick: a throwing send is logged and the remaining candidates still send (DOG-10)', async () => {
  const H2 = 'term_second';
  const T2 = { ...T, handle: H2 };
  const sent = [];
  const logged = [];
  const orca = async (args) => {
    const [scope, verb] = args;
    if (scope === 'terminal' && verb === 'list') return { terminals: [T, T2] };
    if (scope === 'terminal' && verb === 'read') return { terminal: { tail: OUTAGE_TAIL } };
    if (scope === 'terminal' && verb === 'wait') return {};
    if (scope === 'terminal' && verb === 'send') {
      const handle = args[args.indexOf('--terminal') + 1];
      if (handle === H) throw new Error('Command failed: agent_prompt_stalled');
      sent.push(handle); return {};
    }
    throw new Error(`unexpected orca call ${args.join(' ')}`);
  };
  const state = { ...seed(), [H2]: { ...seed()[H], handle: H2 } };
  let saved = null;
  const deps = { orca, fetchImpl: fakeFetch(() => okJson({ status: { indicator: 'none' } })), env: {}, now: () => at(10),
    loadState: () => structuredClone(state), saveState: (e) => { saved = structuredClone(e); }, log: (lvl, msg) => logged.push(`${lvl} ${msg}`) };
  await tick({ dryRun: false }, deps);
  assert.deepEqual(sent, [H2]);
  assert.equal(saved[H].attempts, 1, 'attempt was persisted before the failed send');
  assert.ok(logged.some((l) => l.startsWith('warn send failed for term_') && l.includes('agent_prompt_stalled')), logged.join('\n'));
});

test('tick: multi-line orca errors are logged on one line (DOG-13)', async () => {
  const logged = [];
  const orca = async (args) => {
    const [scope, verb] = args;
    if (scope === 'terminal' && verb === 'list') return { terminals: [T] };
    if (scope === 'terminal' && verb === 'read') return { terminal: { tail: OUTAGE_TAIL } };
    if (scope === 'terminal' && verb === 'wait') throw new Error('agent_prompt_stalled\n2026-09-07T00:00:00Z error INJECTED');
    throw new Error(`unexpected orca call ${args.join(' ')}`);
  };
  const deps = { orca, fetchImpl: fakeFetch(() => okJson({ status: { indicator: 'none' } })), env: {}, now: () => at(10),
    loadState: () => seed(), saveState: () => {}, log: (lvl, msg) => logged.push(msg) };
  await tick({ dryRun: false }, deps);
  const line = logged.find((m) => m.includes('not idle'));
  assert.ok(line, logged.join('\n'));
  assert.doesNotMatch(line, /\n/);
  assert.match(line, /INJECTED/);
});

test('tick: terminal reads run with bounded concurrency, not one at a time (DOG-9)', async () => {
  const terminals = Array.from({ length: 8 }, (_, i) => ({ ...T, handle: `term_${i}` }));
  let inFlight = 0, peak = 0;
  const orca = async (args) => {
    const [scope, verb] = args;
    if (scope === 'terminal' && verb === 'list') return { terminals };
    if (scope === 'terminal' && verb === 'read') {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      inFlight -= 1;
      return { terminal: { tail: ['> '] } };
    }
    throw new Error(`unexpected orca call ${args.join(' ')}`);
  };
  const deps = { orca, fetchImpl: fakeFetch(() => okJson({})), env: {}, now: () => at(10), loadState: () => ({}), saveState: () => {}, log: () => {} };
  const started = Date.now();
  await tick({ dryRun: false }, deps);
  const elapsed = Date.now() - started;
  assert.ok(peak >= 2 && peak <= 4, `peak in-flight reads ${peak}, expected 2..4`);
  assert.ok(elapsed < 250, `8 reads at 50 ms took ${elapsed} ms; sequential would be >= 400`);
});

test('tick: fresh re-read failure leaves the event untouched and sends nothing', async () => {
  const state = seed();
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state });
  let reads = 0;
  const inner = h.deps.orca;
  h.deps.orca = async (args) => { if (args[1] === 'read' && ++reads === 2) throw new Error('Command failed'); return inner(args); };
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.saved()[H], state[H]);
});

test('tick: banner cleared on fresh re-read holds one tick then deletes; kind change replaces it; neither sends', async () => {
  const flip = (state, second) => {
    const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state });
    let reads = 0; const inner = h.deps.orca;
    h.deps.orca = async (args) => (args[1] === 'read' && ++reads === 2) ? { terminal: { tail: second } } : inner(args);
    return h;
  };
  // gone: the banner clears on the fresh re-read. First tick holds (clearedAt);
  // a second tick with the banner still absent deletes it (DOG-11). Never sends.
  const gone1 = flip(seed(), ['all done', '> ', '? for shortcuts']);
  await tick({ dryRun: false }, gone1.deps);
  assert.deepEqual(gone1.sent, []);
  assert.ok(gone1.saved()[H].clearedAt, 'first miss holds with clearedAt');
  const gone2 = harness({ tail: ['all done', '> ', '? for shortcuts'], terminals: [T], state: gone1.saved() });
  await tick({ dryRun: false }, gone2.deps);
  assert.deepEqual(gone2.sent, []); assert.deepEqual(gone2.saved(), {});
  // kind change on the fresh re-read replaces the event; never sends.
  const changed = flip(seed(), [...CLAUDE_BANNER, '? for shortcuts']);
  await tick({ dryRun: false }, changed.deps);
  assert.deepEqual(changed.sent, []);
  assert.equal(changed.saved()[H].kind, 'limit'); assert.equal(changed.saved()[H].attempts, 0);
});

test('tick: shell prompt on the fresh tail deletes the event and sends nothing', async () => {
  // A limit banner still detects with a trailing shell prompt (no final-block
  // requirement), so the fresh re-read reaches the prompt guard: the agent has
  // exited to a shell, the event is dropped and nothing is sent.
  const st = { [H]: { ...LIMIT_EV, platform: 'claude', bannerText: BANNER, detectedAt: NOW.toISOString(), resetAt: NOW.toISOString(),
    attempts: 0, lastAttemptAt: null, status: 'waiting' } };
  const h = harness({ tail: [...CLAUDE_BANNER, '? for shortcuts'], terminals: [T], state: st });
  let reads = 0; const inner = h.deps.orca;
  h.deps.orca = async (args) => (args[1] === 'read' && ++reads === 2) ? { terminal: { tail: ['Claude usage limit reached. Your limit will reset at 3am.', 'john@mac ~ %'] } } : inner(args);
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, []); assert.deepEqual(h.saved(), {});
});

test('tick: two due Claude outages share one status fetch and both send when status is none', async () => {
  const H2 = 'term_two';
  const T2 = { ...T, handle: H2 };
  const state = { ...seed(), [H2]: { ...seed()[H], handle: H2 } };
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T, T2], state });
  await tick({ dryRun: false }, h.deps);
  assert.equal(h.fetchImpl.calls.filter((c) => c.url === CLAUDE_URL).length, 1);
  assert.deepEqual(h.sent, [OUTAGE_RESUME_TEXT, OUTAGE_RESUME_TEXT]);
});

test('tick: two due Claude outages share one major status fetch and consume no attempts', async () => {
  const H2 = 'term_two';
  const T2 = { ...T, handle: H2 };
  const state = { ...seed(), [H2]: { ...seed()[H], handle: H2 } };
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T, T2], state, indicator: 'major' });
  await tick({ dryRun: false }, h.deps);
  assert.equal(h.fetchImpl.calls.filter((c) => c.url === CLAUDE_URL).length, 1);
  assert.deepEqual(h.sent, []);
  for (const handle of [H, H2]) {
    assert.equal(h.saved()[handle].attempts, 0);
    assert.equal(h.saved()[handle].lastAttemptAt, null);
    assert.equal(h.saved()[handle].status, 'waiting');
  }
});

test('tick: codex terminal with a Claude-shaped tail cannot become a candidate; only Claude is fetched', async () => {
  const H2 = 'term_two';
  const T2 = { ...T, handle: H2, agentIdentity: 'codex' };
  const state = { ...seed(), [H2]: { ...seed()[H], handle: H2, platform: 'codex' } };
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T, T2], state });
  h.deps.fetchImpl = fakeFetch((url) => okJson({ status: { indicator: url === CLAUDE_URL ? 'major' : 'none' } }));
  // True cross-platform isolation is unreachable through the public path while Codex detection is disabled.
  await tick({ dryRun: false }, h.deps);
  assert.equal(h.deps.fetchImpl.calls.filter((c) => c.url === CLAUDE_URL).length, 1);
  assert.deepEqual(h.sent, []);            // claude suppressed; codex terminal's tail cannot match (no codex row) ⇒ never a candidate
  // The codex tail reads as no-banner: the first miss holds it (clearedAt) with
  // attempts still 0 — never a send candidate; a second absent tick deletes it (DOG-11).
  assert.ok(h.saved()[H2].clearedAt);
  assert.equal(h.saved()[H2].attempts, 0);
});

test('tick: v1 state file on disk is saved back as v2', async () => {
  const h = harness({ tail: ['nothing here', '> ', '? for shortcuts'], terminals: [T] });
  h.deps.loadState = () => parseStateFile(JSON.stringify({ version: 1, events: {} }));
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.saved(), {});
});

// --- log hygiene + tick robustness ---
import { shouldLog, isUnavailableError, readBudgetExceeded } from './watchdog.mjs';

test('debug lines are suppressed unless WATCHDOG_DEBUG is set', () => {
  assert.equal(shouldLog('debug', {}), false);
  assert.equal(shouldLog('debug', { WATCHDOG_DEBUG: '1' }), true);
  for (const lvl of ['info', 'warn', 'error']) assert.equal(shouldLog(lvl, {}), true);
});

test('runtime_unavailable and CLI command failure both count as orca unavailable', () => {
  assert.equal(isUnavailableError(Object.assign(new Error('x'), { code: 'runtime_unavailable' })), true);
  assert.equal(isUnavailableError(new Error('Command failed: /usr/local/bin/orca terminal list --json')), true);
  assert.equal(isUnavailableError(new Error('unexpected JSON shape')), false);
});

test('read loop stops once the tick budget is spent', () => {
  const t0 = new Date('2026-08-27T00:00:00Z');
  assert.equal(readBudgetExceeded(t0, new Date(t0.getTime() + min(2))), false);
  assert.equal(readBudgetExceeded(t0, new Date(t0.getTime() + min(3) + 1)), true);
});

// --- sanitize ---

test('stripAnsi removes CSI, OSC and control bytes', () => {
  assert.equal(stripAnsi('\x1b[1;31mred\x1b[0m \x1b]0;title\x07x\x07'), 'red x');
});

test('stripAnsi removes two-byte escapes so a stray ">" cannot fake a shell prompt (DOG-8)', () => {
  assert.equal(stripAnsi('? for shortcuts\x1b>'), '? for shortcuts');
  assert.equal(stripAnsi('\x1b=\x1b(Bhello\x1b7\x1b8'), 'hello');
  assert.equal(isShellPrompt(['API Error: 529', '? for shortcuts\x1b>'], 'claude'), false);
});

test('sanitize redacts credentials and long opaque runs', () => {
  assert.equal(sanitize('key sk-abcdefghijklmnop end'), 'key [redacted] end');
  assert.equal(sanitize('ghp_ABCDEFGHIJKLMNOP'), '[redacted]');
  assert.equal(sanitize('github_pat_11ABCDEFG_xyz'), '[redacted]');
  assert.equal(sanitize('Authorization: Bearer eyJhbGciOi'), 'Authorization: [redacted]');
  assert.equal(sanitize('AKIA' + 'ABCDEFGHIJKLMNOP'), '[redacted]'); // built at runtime so secret scanners don't flag the fixture
  assert.equal(sanitize('a'.repeat(40)), '[redacted]');
});

test('sanitize leaves ordinary text and short hashes alone', () => {
  assert.equal(sanitize('API Error: 529 overloaded_error at b7ea497'), 'API Error: 529 overloaded_error at b7ea497');
});

test('sanitize keeps filesystem paths but still redacts long opaque tokens (DOG-12)', () => {
  const p = '/Users/john/Projects/orca-limit-watchdog/watchdog.mjs';
  assert.equal(sanitize(`see ${p} line 3`), `see ${p} line 3`);
  assert.equal(sanitize('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc'), 'token [redacted]');
});

test('sanitize strips ANSI, collapses whitespace and truncates', () => {
  assert.equal(sanitize('\x1b[2m  a \n\t b  \x1b[0m'), 'a b');
  assert.equal(sanitize('x'.repeat(10), 4), 'xxxx…');
});

// --- e2e status stub ---

test('status-stub serves the scripted indicator sequence and repeats the last', async () => {
  const { startStub } = await import('./e2e/status-stub.mjs');
  const stub = await startStub(0, ['major', 'none']);
  try {
    const get = async () => (await (await fetch(`http://127.0.0.1:${stub.port}/api/v2/status.json`)).json()).status.indicator;
    assert.equal(await get(), 'major');
    assert.equal(await get(), 'none');
    assert.equal(await get(), 'none');
  } finally { await stub.close(); }
});

// --- CLI entry + install.sh rendering (DOG-6, DOG-15) ---
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const pExecFile = promisify(execFile);

test('CLI entry runs when invoked through a symlinked path (DOG-6)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-symlink-'));
  const link = path.join(tmp, 'repo');
  fs.symlinkSync(process.cwd(), link);
  try {
    const { stdout } = await pExecFile(process.execPath, [path.join(link, 'watchdog.mjs'), '--status'], { env: { ...process.env, HOME: tmp } });
    assert.equal(stdout.trim(), 'no active events');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('install.sh renders the plist without sed-delimiter corruption for paths containing | and & (DOG-15)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-plist-'));
  const out = path.join(tmp, 'out.plist');
  const script = `
    set -euo pipefail
    NODE_BIN='/opt/a|b/node'; REPO='/Users/x&y/repo'; STATE='/tmp/state'
    eval "$(sed -n '/^render_plist()/,/^}/p' install.sh)"
    render_plist com.john.orca-limit-watchdog.plist "${out}"
  `;
  try {
    await pExecFile('bash', ['-c', script]);
    const rendered = fs.readFileSync(out, 'utf8');
    assert.match(rendered, /<string>\/opt\/a\|b\/node<\/string>/);
    assert.match(rendered, /\/Users\/x&y\/repo/);
    assert.doesNotMatch(rendered, /__(NODE|REPO|STATE)__/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
