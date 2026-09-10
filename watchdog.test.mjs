import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as watchdog from './watchdog.mjs';
import { fileURLToPath } from 'node:url';
import { detectBanner, parseResetTime, reconcile, eventKey, stripAnsi, sanitize, hasOutageLine, inferPlatform,
  SCHEDULE, OUTAGE_RESUME_TEXT, newEvent, validateEvent, parseStateFile } from './watchdog.mjs';
import { isShellPrompt, isInputOccupied } from './watchdog.mjs';
import { statusUrlFor, fetchIndicator, suppressedByStatus } from './watchdog.mjs';
import { CONNECTIVITY_URL, connectivityUrl, hasConnectivity } from './watchdog.mjs';
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

test('generic limit rule requires the banner to be the final on-screen block (DOG-24)', () => {
  const banner = 'Claude usage limit reached. Your limit will reset at 3am.';
  // Genuinely stalled: banner followed only by chrome (borders, empty box, footer) still detects.
  assert.ok(detectBanner([banner, '─'.repeat(20), '> ', FOOTER, '? for shortcuts'], 'claude'), 'stalled banner still detects');
  // Agent already resumed past the banner and went idle at an empty box: ordinary
  // output sits between the banner and the box, so it is stale — no detection.
  assert.equal(detectBanner([banner, 'Edited foo.js', 'All tests pass.', '> ', FOOTER], 'claude'), null, 'worked-past banner is stale');
});

test('a pathological long-digit line is handled fast and is not a false limit (DOG-24)', () => {
  const evil = `${'9'.repeat(50_000)}-hour`;   // unbounded \d+[- ]hour backtracks super-linearly
  const start = performance.now();
  assert.equal(detectBanner([evil, '> '], 'claude'), null);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 100, `pathological line took ${elapsed.toFixed(1)}ms`);
  // Legitimate hour/word banners still match.
  assert.ok(detectBanner(['5-hour limit reached. Try again at 3pm.', '> '], 'claude'));
  assert.ok(detectBanner(['weekly limit reached, resets in 3 days', '> '], 'claude'));
  assert.ok(detectBanner(['usage limit reached. resets at 3pm', '> '], 'claude'));
});

test('only scans the last 15 lines', () => {
  const lines = [...CLAUDE_BANNER, ...Array(20).fill('normal output')];
  assert.equal(detectBanner(lines), null);
});

// --- outage detection ---

const CHROME_TAIL = ['', '─'.repeat(40), '> ', '? for shortcuts'];
const CLAUDE_529 = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CTx"}';
const CODEX_ERR = "■ We're currently experiencing high demand, which may cause temporary errors.";
const CODEX_FOOTER = 'Context 16% used · 5h 36% left · weekly 90% left · gpt-5.6-sol medium · main · Ready · Custom permissions';
const CODEX_TAIL = ['─ Worked for 2m 51s ───────────', CODEX_ERR, '', '› Ask Codex to do anything', CODEX_FOOTER];
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

test('detects Codex outage errors only on a codex-identified terminal (DOG-17)', () => {
  const b = detectBanner(CODEX_TAIL, 'codex');
  assert.ok(b); assert.equal(b.kind, 'outage'); assert.equal(b.patternId, 'codex-api-error');
  assert.equal(detectBanner(CODEX_TAIL, 'claude'), null);
  assert.equal(detectBanner(CODEX_TAIL, 'unknown'), null);
  for (const line of [
    '■ stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
    '■ Selected model is at capacity. Please try a different model.',
    '■ exceeded retry limit, last status: 503 Service Unavailable, request id: 5036c677',
    '■ request timed out',
  ]) assert.equal(detectBanner([line, '›'], 'codex').kind, 'outage', line);
});

test('Codex 429 retry-limit and usage-limit lines are not outages', () => {
  assert.equal(detectBanner(['■ exceeded retry limit, last status: 429 Too Many Requests', '›'], 'codex').kind, 'limit-open');
  const b = detectBanner(["■ You've hit your usage limit. Try again at Sep 8th, 2026 2:00 PM.", '›'], 'codex');
  assert.ok(b); assert.equal(b.kind, 'limit');
});

test('Reconnecting and esc-to-interrupt after the error veto the outage (still working)', () => {
  assert.equal(detectBanner([CODEX_ERR, 'Reconnecting... 3/5 (13s • esc to interrupt)', '  └ Stream disconnected before completion: websocket closed'], 'codex'), null);
  assert.equal(detectBanner([CODEX_ERR, 'Working (12s • esc to interrupt)'], 'codex'), null);
  assert.equal(detectBanner([CODEX_ERR, 'Reconnecting... waiting for network'], 'codex'), null);
});

test('Codex chrome after the error keeps it final; real output after it does not', () => {
  assert.ok(detectBanner([CODEX_ERR, '', '› Ask Codex to do anything', '42% context left'], 'codex'));
  assert.equal(detectBanner([CODEX_ERR, 'I retried and the request succeeded; continuing with the refactor.', '›'], 'codex'), null);
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

test('the Claude usage footer below the outage banner does not hide it (DOG-24)', () => {
  // Every real Claude terminal shows the FOOTER as its bottom line, after the
  // input box. The footer is chrome, not the agent moving on, so a 529 above it
  // must still detect as a final, stalled outage.
  const b = detectBanner([CLAUDE_529, '', '> ', FOOTER, '? for shortcuts'], 'claude');
  assert.ok(b, 'outage detected with the footer as the trailing line');
  assert.equal(b.kind, 'outage');
  assert.equal(b.patternId, 'claude-api-error');
  // The Codex outage-with-footer path stays detected too.
  assert.equal(detectBanner(CODEX_TAIL, 'codex').kind, 'outage');
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

const OPEN_TAIL = ['■ exceeded retry limit, last status: 429', '› Ask Codex to do anything'];
const USAGE_WRAP = ["■ You've hit your usage limit. Upgrade to Pro (https://x), visit https://y to",
  'purchase more credits.'];

test('detectBanner: Codex reset-less usage limit ⇒ limit-open (DOG-20)', () => {
  assert.equal(detectBanner([...USAGE_WRAP, '›'], 'codex').kind, 'limit-open');
});
test('detectBanner: Codex usage limit WITH reset ⇒ limit (DOG-20)', () => {
  const b = detectBanner([USAGE_WRAP[0], 'purchase more credits or try again at 10:12 PM.', '›'], 'codex', NOW);
  assert.equal(b.kind, 'limit'); assert.ok(b.resetAt);
});
test('detectBanner: bare 429 ⇒ limit-open; reset continuation ⇒ limit (DOG-20)', () => {
  assert.equal(detectBanner(OPEN_TAIL, 'codex').kind, 'limit-open');
  assert.equal(detectBanner([OPEN_TAIL[0], 'Try again at 10:12 PM.', '›'], 'codex').kind, 'limit');
});
test('detectBanner: 5xx stays outage, other status ⇒ null (DOG-20)', () => {
  assert.equal(detectBanner(['■ exceeded retry limit, last status: 503', '›'], 'codex').kind, 'outage');
  assert.equal(detectBanner(['■ exceeded retry limit, last status: 418', '›'], 'codex'), null);
});
test('detectBanner: usage limit reached, try again later ⇒ limit-open (DOG-20)', () => {
  assert.equal(detectBanner(['■ usage limit reached, try again later', '›'], 'codex').kind, 'limit-open');
});
test('detectBanner: limit-open requires Codex and marker (DOG-20)', () => {
  assert.equal(detectBanner(OPEN_TAIL, 'unknown'), null);
  assert.equal(detectBanner([OPEN_TAIL[0].slice(2), '›'], 'codex'), null);
  assert.equal(detectBanner(['error: rate limit exceeded (HTTP 429)', FOOTER, '> ', '? for shortcuts'], 'claude'), null);
});
test('detectBanner: stale, retry, draft, shell and near-miss continuations rejected (DOG-20)', () => {
  for (const trailing of ['• Reconnecting... 2/5', 'Reconnecting... waiting for network', 'esc to interrupt',
    'Retrying in 5s', 'attempt 2 of 5', '› my half-typed reply', 'john@mac ~ %',
    'Continuing the task at 10:12 PM.', 'Try again at 10:12 PM. Now editing files.']) {
    assert.equal(detectBanner([OPEN_TAIL[0], trailing, '›'], 'codex'), null, trailing);
    assert.equal(detectBanner([...USAGE_WRAP, trailing, '›'], 'codex'), null, trailing);
  }
  assert.equal(detectBanner([USAGE_WRAP[0], 'purchase more credits. Working now.', '›'], 'codex'), null);
  assert.equal(detectBanner(["■ You've hit your usage limit. Try again at 10:12 PM.", 'Working now.', '›'], 'codex'), null);
});
test('detectBanner: ANSI positive and ANSI-only negative (DOG-20)', () => {
  assert.equal(detectBanner(['\x1b[31m' + OPEN_TAIL[0] + '\x1b[0m', '›'], 'codex').kind, 'limit-open');
  assert.equal(detectBanner(['\x1b[31m\x1b[0m'], 'codex'), null);
});
test('detectBanner: selected evidence excludes historical clocks and chrome (DOG-20)', () => {
  const b = detectBanner(["■ You've hit your usage limit. Try again at 10:12 PM.", ...OPEN_TAIL, CODEX_FOOTER], 'codex');
  assert.equal(b.kind, 'limit-open'); assert.equal(b.resetAt, null);
  assert.equal(b.bannerText, OPEN_TAIL[0]);
  assert.equal(detectBanner([...OPEN_TAIL, CODEX_ERR, '›'], 'codex').kind, 'outage');
  assert.equal(detectBanner([CODEX_ERR, ...OPEN_TAIL], 'codex').kind, 'limit-open');
});
test('detectBanner: bounded three-line wrap carries reset beyond storage cap (DOG-20)', () => {
  const b = detectBanner(["■ You've hit your usage limit. Upgrade to Pro (https://x/" + 'long/'.repeat(140) + '),',
    'visit https://y to purchase more credits', 'or try again at 10:12 PM.', '›'], 'codex', NOW);
  assert.equal(b.kind, 'limit'); assert.ok(b.resetAt); assert.ok(b.bannerText.length <= 601);
  assert.equal(detectBanner(["■ You've hit your usage limit.", 'Upgrade to Pro (https://x),',
    'visit https://y to purchase more credits', 'or try again at 10:12 PM.', '›'], 'codex'), null);
});

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

test('inferPlatform maps the codex pattern to codex', () => {
  assert.equal(inferPlatform({ agentIdentity: undefined }, { patternId: 'codex-api-error' }), 'codex');
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

test('out-of-range relative reset returns null, not an Invalid Date that throws (DOG-24)', () => {
  // An unbounded digit run overflows the Date range → an Invalid Date object.
  // It must come back as null so the `?? fallback` (and `?.toISOString()`) engage
  // instead of a RangeError aborting the whole tick.
  for (const text of ['resets in 9999999999 days', 'try again in 999999999999 hours',
    'resets in 99999999999999 minutes', 'resets in 9999999999h 30m']) {
    assert.equal(parseResetTime(text, NOW), null, text);
  }
  // A sane relative reset still parses.
  assert.equal(parseResetTime('resets in 3 days', NOW).getTime(), NOW.getTime() + 3 * 24 * 60 * 60_000);
});

test('parseResetTime is DST-safe across a spring-forward boundary and year rollover (DOG-24, regression)', async () => {
  // Runs under a fixed DST timezone in a child so the assertion is deterministic
  // regardless of the host zone. Locks the wall-clock-preserving behavior of the
  // local-setter math: finding 1.6's described "hour off / past time" defect was
  // not reproducible (JS setHours/setDate/setMonth/setFullYear keep wall-clock).
  const wdUrl = new URL('./watchdog.mjs', import.meta.url).href;
  const script = `
    const { parseResetTime } = await import(${JSON.stringify(wdUrl)});
    const sf = parseResetTime('try again at 3:00', new Date(2026, 2, 7, 23, 0, 0)); // Mar 7 eve, NY spring-forward is Mar 8
    const my = parseResetTime('resets Jan 3 at 3pm', new Date(2026, 8, 7, 10, 0, 0)); // Sep 7 -> Jan 3 next year
    process.stdout.write(JSON.stringify({
      springForward: { h: sf.getHours(), m: sf.getMinutes(), day: sf.getDate(), month: sf.getMonth() },
      monthDay: { h: my.getHours(), year: my.getFullYear(), month: my.getMonth(), day: my.getDate() },
    }));
  `;
  const { stdout } = await pExecFile(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, TZ: 'America/New_York' } });
  const out = JSON.parse(stdout);
  assert.deepEqual(out.springForward, { h: 3, m: 0, day: 8, month: 2 });   // next 3:00 wall-clock on the SF day, not an hour off
  assert.deepEqual(out.monthDay, { h: 15, year: 2027, month: 0, day: 3 }); // just-past month-day rolls to next year at 3pm
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
const V2 = { ...V1, kind: 'limit', platform: 'unknown', alertedAt: null };

const LO = (over = {}) => ({ handle: H, kind: 'limit-open', platform: 'codex', bannerText: 'x',
  detectedAt: NOW.toISOString(), resetAt: NOW.toISOString(), attempts: 0, lastAttemptAt: null,
  status: 'awaiting-user', alertedAt: null, episodeId: 'ep-1', ...over });

test('validateEvent: well-formed limit-open accepted (DOG-20)', () => {
  for (const status of ['awaiting-user', 'dismissed', 'waiting']) {
    assert.equal(validateEvent(H, LO({ status })), null);
  }
  assert.equal(validateEvent(H, LO({ status: 'waiting', alertedAt: NOW.toISOString() })), null);
});

test('validateEvent: limit-open rejections (DOG-20)', () => {
  for (const [field, over] of [['platform', { platform: 'claude' }], ['episodeId', { episodeId: '' }],
    ['episodeId', { episodeId: undefined }], ['alertedAt', { alertedAt: 'nope' }],
    ['attempts|lastAttemptAt', { attempts: 1 }], ['attempts', { attempts: 1, lastAttemptAt: NOW.toISOString() }]]) {
    assert.match(validateEvent(H, LO(over)), new RegExp(field));
  }
});

test('validateEvent: awaiting-user/dismissed and episodeId illegal for limit/outage (DOG-20)', () => {
  for (const kind of ['limit', 'outage']) {
    for (const status of ['awaiting-user', 'dismissed']) {
      assert.match(validateEvent(H, { ...V2, kind, platform: 'claude', status }), /status/);
    }
    assert.match(validateEvent(H, { ...V2, kind, platform: 'claude', episodeId: 'ep1' }), /episodeId/);
  }
});

test('validateEvent: zero-attempt gave_up accepted for deadline-bearing kinds (DOG-20)', () => {
  assert.equal(validateEvent(H, LO({ kind: 'outage', platform: 'claude', episodeId: undefined, status: 'gave_up' })), null);
  assert.equal(validateEvent(H, LO({ status: 'gave_up' })), null);
  assert.match(validateEvent(H, { ...V2, attempts: 0, lastAttemptAt: null, status: 'gave_up' }), /lastAttemptAt/);
});

test('parseStateFile: legacy events normalise alertedAt and mix with limit-open (DOG-20)', () => {
  const { alertedAt, ...legacy } = V2;
  for (const events of [{ [H]: legacy }, { [H]: legacy, term_new: LO({ handle: 'term_new' }) }]) {
    const parsed = parseStateFile(JSON.stringify({ version: 2, events }));
    assert.ok(parsed);
    assert.equal(parsed[H].alertedAt, null);
    assert.deepEqual(parseStateFile(JSON.stringify({ version: 2, events: parsed })), parsed);
  }
});

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
    resetAt: new Date(NOW.getTime() + min(10)).toISOString(), attempts: 0, lastAttemptAt: null, status: 'waiting', alertedAt: null });
  const l = newEvent({ handle: H, platform: 'unknown', banner: { kind: 'limit', bannerText: 'session limit reached, resets in 2 hours' } }, NOW);
  assert.equal(l.kind, 'limit');
  assert.equal(new Date(l.resetAt).getTime(), NOW.getTime() + min(120));
});

test('newEvent: limit-open ⇒ awaiting-user, injectable episodeId, resetAt=now (DOG-20)', () => {
  const o = { handle: H, platform: 'codex', banner: { kind: 'limit-open', bannerText: 'x', resetAt: null } };
  const ev = newEvent(o, NOW, () => 'ep-xyz');
  assert.equal(ev.kind, 'limit-open'); assert.equal(ev.status, 'awaiting-user');
  assert.equal(ev.alertedAt, null); assert.equal(ev.episodeId, 'ep-xyz');
  assert.equal(ev.resetAt, NOW.toISOString()); assert.equal(validateEvent(H, ev), null);
  assert.notEqual(newEvent(o, NOW).episodeId, newEvent(o, NOW).episodeId);
  assert.equal(reconcile({}, [o], NOW, [H], () => 'ep-reconcile').events[H].episodeId, 'ep-reconcile');
});
test('newEvent: limit/outage initialise alertedAt without episodeId; carried reset wins (DOG-20)', () => {
  const resetAt = new Date(NOW.getTime() + min(90)).toISOString();
  const lim = newEvent({ handle: H, platform: 'codex', banner: { kind: 'limit', bannerText: 'x', resetAt } }, NOW);
  assert.equal(lim.resetAt, resetAt);
  for (const ev of [lim, newEvent({ handle: H, platform: 'claude', banner: OUTAGE_BANNER }, NOW)]) {
    assert.equal(ev.alertedAt, null); assert.equal(ev.episodeId, undefined);
    assert.equal(validateEvent(H, ev), null);
  }
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
    attempts: 0, lastAttemptAt: null, status: 'waiting', alertedAt: null };
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

const openObs = (banner = { kind: 'limit-open', bannerText: 'x', resetAt: null }, platform = 'codex') =>
  [{ handle: H, banner, platform }];
const roundTrip = (events) => assert.deepEqual(parseStateFile(JSON.stringify({ version: 2, events })), events);

test('reconcile: dismissed survives kind/platform mutation (DOG-20)', () => {
  const ev = LO({ status: 'dismissed', alertedAt: NOW.toISOString() });
  for (const [banner, platform] of [[{ kind: 'limit', bannerText: 'try again at 5pm', resetAt: at(60).toISOString() }, 'codex'],
    [OUTAGE_BANNER, 'claude']]) {
    const r = reconcile({ [H]: ev }, openObs(banner, platform), at(1));
    assert.equal(r.events[H].status, 'dismissed'); assert.equal(r.events[H].kind, 'limit-open');
    assert.deepEqual(r.sendCandidates, []); roundTrip(r.events);
  }
});
test('reconcile: pre-consent statuses never age into gave_up (DOG-20)', () => {
  for (const status of ['awaiting-user', 'dismissed']) {
    const r = reconcile({ [H]: LO({ status }) }, openObs(), at(25 * 60));
    assert.equal(r.events[H].status, status); assert.deepEqual(r.sendCandidates, []); roundTrip(r.events);
  }
});
test('reconcile: Stop clears only after two misses; new episode gets new id (DOG-20)', () => {
  const first = reconcile({ [H]: LO({ status: 'dismissed' }) }, openObs(null), at(1), [H]);
  assert.equal(first.events[H].status, 'dismissed'); assert.ok(first.events[H].clearedAt);
  const gone = reconcile(first.events, openObs(null), at(2), [H]);
  assert.deepEqual(gone.events, {});
  const fresh = reconcile(gone.events, openObs(), at(2), [H], () => 'ep-fresh');
  assert.equal(fresh.events[H].episodeId, 'ep-fresh'); roundTrip(fresh.events);
});
test('reconcile: unanswered mutation replaces and invalidates episode (DOG-20)', () => {
  const r = reconcile({ [H]: LO() }, openObs({ kind: 'limit', bannerText: 'x', resetAt: at(60).toISOString() }), at(1));
  assert.equal(r.events[H].kind, 'limit'); assert.equal(r.events[H].episodeId, undefined);
  assert.deepEqual(r.sendCandidates, []); roundTrip(r.events);
});
test('reconcile: consent schedule caps six sends, deadline counts from consent (DOG-20)', () => {
  let events = { [H]: LO({ status: 'waiting', resetAt: at(60).toISOString() }) };
  assert.deepEqual(reconcile(events, openObs(), at(59)).sendCandidates, []);
  for (let n = 0; n < 6; n++) {
    const t = 60 + n * 30;
    const r = reconcile(events, openObs(), at(t));
    assert.deepEqual(r.sendCandidates, [H]);
    events = r.events;
    Object.assign(events[H], { attempts: n + 1, lastAttemptAt: at(t).toISOString(), status: 'resumed' });
    roundTrip(events);
    assert.deepEqual(reconcile(events, openObs(), at(t + 29)).sendCandidates, []);
  }
  const capped = reconcile(events, openObs(), at(240));
  assert.equal(capped.events[H].status, 'gave_up'); roundTrip(capped.events);
  for (const kind of ['outage', 'limit-open']) {
    const ev = LO({ kind, status: 'waiting', ...(kind === 'outage' ? { platform: 'claude', episodeId: undefined } : {}) });
    delete ev.episodeId;
    if (kind === 'limit-open') ev.episodeId = 'ep-1';
    const observation = openObs({ kind, bannerText: 'x' }, ev.platform);
    assert.equal(reconcile({ [H]: ev }, observation, at(1439)).events[H].status, 'waiting');
    const expired = reconcile({ [H]: ev }, observation, at(1440));
    assert.equal(expired.events[H].status, 'gave_up'); roundTrip(expired.events);
  }
});

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

test('hasConnectivity: ok ⇒ true; non-ok / thrown / redirect ⇒ false (DOG-19)', async () => {
  assert.equal(await hasConnectivity(fakeFetch(() => ({ ok: true, status: 200 }))), true);
  assert.equal(await hasConnectivity(fakeFetch(() => ({ ok: false, status: 503 }))), false);
  assert.equal(await hasConnectivity(fakeFetch(() => { throw new TypeError('redirect'); })), false);
  assert.equal(await hasConnectivity(fakeFetch(() => { throw new Error('offline'); })), false);
});

test('hasConnectivity: requests the resolved URL with redirect:error (DOG-19)', async () => {
  const f = fakeFetch(() => ({ ok: true, status: 200 }));
  await hasConnectivity(f, CONNECTIVITY_URL);
  assert.equal(f.calls[0].url, CONNECTIVITY_URL);
  assert.equal(f.calls[0].opts.redirect, 'error');
});

test('connectivityUrl: loopback override honoured; non-loopback ignored with warn (DOG-19)', () => {
  assert.equal(connectivityUrl({}).url, CONNECTIVITY_URL);
  assert.equal(connectivityUrl({}).warn, null);
  assert.equal(connectivityUrl({ WATCHDOG_CONNECTIVITY_URL: 'http://127.0.0.1:9/x' }).url, 'http://127.0.0.1:9/x');
  const bad = connectivityUrl({ WATCHDOG_CONNECTIVITY_URL: 'https://evil.example/x' });
  assert.equal(bad.url, CONNECTIVITY_URL);
  assert.match(bad.warn, /non-loopback/);
  const malformed = connectivityUrl({ WATCHDOG_CONNECTIVITY_URL: 'not a url' });
  assert.equal(malformed.url, CONNECTIVITY_URL);
  assert.match(malformed.warn, /non-loopback/);
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
  const deps = { orca, fetchImpl, env: {}, now: () => now, loadState: () => structuredClone(state), saveState: (e) => { saved = structuredClone(e); }, log: () => {}, reapChoices: () => 0, isDisabled: () => false };
  return { deps, sent, orcaCalls, fetchImpl, saved: () => saved };
}
const T = { handle: H, connected: true, writable: true, agentIdentity: 'claude' };
const OUTAGE_TAIL = [CLAUDE_529, '', '> ', '? for shortcuts'];

test('operational observations report guard reasons without changing resume decisions', async () => {
  for (const [scenario, expected] of [['offline', 'offline'], ['provider', 'provider health major'],
    ['busy', 'busy terminal'], ['read', 'failed read'], ['draft', 'draft input'], ['send', 'failed send'], ['success', null]]) {
    const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed(), indicator: scenario === 'provider' ? 'major' : 'none' });
    if (scenario === 'offline') h.deps.fetchImpl = async () => { throw new Error('offline'); };
    const inner = h.deps.orca;
    h.deps.orca = async args => {
      if ((scenario === 'busy' && args[1] === 'wait') || (scenario === 'read' && args[1] === 'read') || (scenario === 'send' && args[1] === 'send')) throw new Error('fixture');
      if (scenario === 'draft' && args[1] === 'read') return { terminal: { tail: [CLAUDE_529, '', '> draft text', '? for shortcuts'] } };
      return inner(args);
    };
    const observations = [];
    h.deps.observe = (...args) => observations.push(args);
    await tick({ dryRun: false }, h.deps);
    if (expected) assert.equal(observations.filter(x => x[0] === 'waiting').at(-1)[2], expected, scenario);
    assert.equal(observations.some(x => x[0] === 'resumed'), scenario === 'success', scenario);
    assert.equal(h.sent.length, scenario === 'success' ? 1 : 0);
  }
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed() });
  h.deps.observe = () => { throw new Error('diagnostics unavailable'); };
  await tick({ dryRun: false }, h.deps);
  assert.equal(h.sent.length, 1);
});

function alertHarness({ ev = LO(), choice = null, ...options } = {}) {
  const h = harness({ tail: OPEN_TAIL, terminals: [{ ...T, agentIdentity: 'codex' }], state: { [H]: ev }, now: NOW, ...options });
  const actions = [];
  const save = h.deps.saveState;
  Object.assign(h.deps, {
    saveState: (events) => { actions.push('save'); save(events); },
    spawn: (event) => { actions.push('spawn'); assert.equal(h.saved()[event.handle].alertedAt, NOW.toISOString()); },
    readChoice: async (handle, episodeId) => { actions.push('read'); assert.equal(handle, H); assert.equal(episodeId, ev.episodeId); return choice; },
    clearChoice: async () => { actions.push('clear'); },
    newEpisodeId: () => 'ep-new',
  });
  return { ...h, actions };
}
const choiceOf = (choice, episodeId = 'ep-1') => ({ choice, episodeId, at: NOW.toISOString() });

test('tick: awaiting-user claims before one spawn and never sends (DOG-20)', async () => {
  const h = alertHarness({ state: {} });
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.actions, ['save', 'spawn', 'save']); assert.deepEqual(h.sent, []);
  assert.equal(h.saved()[H].episodeId, 'ep-new'); roundTrip(h.saved());
  const next = alertHarness({ ev: h.saved()[H] });
  await tick({ dryRun: false }, next.deps);
  assert.deepEqual(next.actions, ['read', 'save']); assert.deepEqual(next.sent, []);
});
for (const choice of ['Continue', 'Wait 1h', 'Stop']) {
  test(`tick: pending ${choice} persists transition before clearing, no same-tick send (DOG-20)`, async () => {
    const h = alertHarness({ ev: LO({ alertedAt: at(-100).toISOString(), detectedAt: at(-100).toISOString() }), choice: choiceOf(choice) });
    h.deps.clearChoice = async () => {
      h.actions.push('clear');
      assert.equal(h.saved()[H].status, choice === 'Stop' ? 'dismissed' : 'waiting');
    };
    await tick({ dryRun: false }, h.deps);
    const ev = h.saved()[H];
    assert.deepEqual(h.actions, ['read', 'save', 'clear', 'save']); assert.deepEqual(h.sent, []);
    assert.equal(ev.resetAt, at(choice === 'Wait 1h' ? 60 : 0).toISOString());
    assert.equal(ev.detectedAt, at(choice === 'Stop' ? -100 : 0).toISOString()); roundTrip(h.saved());
    const next = alertHarness({ ev, now: at(5) });
    await tick({ dryRun: false }, next.deps);
    assert.deepEqual(next.sent, choice === 'Continue' ? [RESUME_TEXT] : []);
    assert.equal(next.fetchImpl.calls.length, choice === 'Continue' ? 1 : 0);
  });
}
test('tick: stale choice ignored and cleared; invalid timestamp/button cannot consent (DOG-20)', async () => {
  for (const choice of [choiceOf('Continue', 'ep-stale'), { ...choiceOf('Continue'), at: 'bad' }, choiceOf('Unknown')]) {
    const h = alertHarness({ ev: LO({ alertedAt: NOW.toISOString() }), choice });
    await tick({ dryRun: false }, h.deps);
    assert.equal(h.saved()[H].status, 'awaiting-user'); assert.deepEqual(h.sent, []);
    assert.ok(h.actions.includes('clear'));
  }
});
test('tick: dry-run never spawns, persists, reads or clears choices (DOG-20)', async () => {
  for (const choice of [null, ...['Continue', 'Wait 1h', 'Stop'].map((c) => choiceOf(c))]) {
    const h = alertHarness({ ev: LO({ alertedAt: choice ? NOW.toISOString() : null }), choice });
    const effects = [];
    for (const dep of ['spawn', 'saveState', 'readChoice', 'clearChoice', 'reapChoices', 'fetchImpl']) h.deps[dep] = () => { effects.push(dep); throw new Error(dep); };
    await tick({ dryRun: true }, h.deps);
    assert.deepEqual(effects, []); assert.deepEqual(h.sent, []); assert.equal(h.saved(), null);
  }
});
test('tick: a failed alert spawn (sync throw or async error) re-arms by clearing alertedAt (DOG-24)', async () => {
  // A spawn failure means no dialog was ever shown, so the claim must be released
  // (alertedAt=null) for the next tick to re-arm the alert — otherwise the reset-
  // less limit is wedged forever waiting on a choice file that never appears.
  for (const asyncError of [false, true]) {
    const h = alertHarness(); const warnings = []; const child = new EventEmitter();
    h.deps.log = (level, message) => { if (level === 'warn') warnings.push(message); };
    h.deps.spawn = () => { if (!asyncError) throw new Error('spawn failed'); return child; };
    await tick({ dryRun: false }, h.deps);
    if (asyncError) child.emit('error', new Error('spawn failed'));
    assert.equal(h.saved()[H].alertedAt, null, `re-armed (asyncError=${asyncError})`);
    assert.equal(h.saved()[H].status, 'awaiting-user');
    assert.deepEqual(h.sent, []); assert.ok(warnings.some((m) => /spawn failed/.test(m)));
  }
});
test('tick: a limit-open event with an unsafe handle is skipped with a warn, never spawned (DOG-24)', async () => {
  // A handle from `orca terminal list` that is not a safe path component (e.g. it
  // contains ".") would make choicePath throw and churn the alert path every tick.
  // It must be skipped gracefully instead: no claim, no spawn.
  const badH = 'term.with.dots';
  const ev = { handle: badH, kind: 'limit-open', platform: 'codex', bannerText: 'x', detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 0, lastAttemptAt: null, status: 'awaiting-user', alertedAt: null, episodeId: 'ep-1' };
  const term = { ...T, handle: badH, agentIdentity: 'codex' };
  const h = harness({ tail: OPEN_TAIL, terminals: [term], state: { [badH]: ev }, now: NOW });
  const logs = [];
  h.deps.log = (lvl, msg) => logs.push(`${lvl} ${msg}`);
  let spawned = false;
  h.deps.spawn = () => { spawned = true; };
  await tick({ dryRun: false }, h.deps);   // must not throw
  assert.equal(spawned, false, 'must not spawn an alert for an unsafe handle');
  assert.equal(h.saved()[badH].alertedAt, null, 'must not claim');
  assert.ok(logs.some((l) => l.startsWith('warn') && /handle/.test(l)), logs.join(' | '));
});

test('tick: choices stay bound to two terminals and read/unlink failures are bounded (DOG-20)', async () => {
  for (const failure of [null, 'read', 'clear']) {
    const ev = LO({ alertedAt: NOW.toISOString() });
    const h = alertHarness({ state: { [H]: ev, term_other: { ...ev, handle: 'term_other', episodeId: 'ep-other' } },
      terminals: [{ ...T, agentIdentity: 'codex' }, { ...T, handle: 'term_other', agentIdentity: 'codex' }] });
    const cleared = [];
    h.deps.readChoice = async (handle, episodeId) => {
      if (handle === H && failure === 'read') throw new Error('read failed');
      return choiceOf(handle === H ? 'Stop' : 'Continue', episodeId);
    };
    h.deps.clearChoice = async (handle) => { if (handle === H && failure === 'clear') throw new Error('unlink failed'); cleared.push(handle); };
    await tick({ dryRun: false }, h.deps);
    assert.equal(h.saved()[H].status, failure === 'read' ? 'awaiting-user' : 'dismissed');
    assert.equal(h.saved().term_other.status, 'waiting'); assert.ok(cleared.includes('term_other')); assert.deepEqual(h.sent, []);
  }
});
test('tick: alert pass preserves unread and first-miss freezes (DOG-20)', async () => {
  for (const options of [{ readThrows: true }, { tail: ['›'] }]) {
    const h = alertHarness({ ...options, choice: choiceOf('Continue') });
    await tick({ dryRun: false }, h.deps);
    assert.deepEqual(h.actions, ['save']); assert.equal(h.saved()[H].alertedAt, null);
  }
});

test('reapChoices: keeps exact live basenames and ignores non-json entries (DOG-21)', (t) => {
  assert.equal(typeof watchdog.reapChoices, 'function');
  const { dir } = alertFiles(t);
  const choices = path.join(dir, 'choices');
  fs.mkdirSync(choices);
  for (const name of ['term_x.ep1.json', 'term_x.ep10.json', 'other.ep1.json', 'partial.tmp']) {
    fs.writeFileSync(path.join(choices, name), '{}');
  }
  assert.equal(watchdog.reapChoices(new Set(['term_x.ep1.json']), dir), 2);
  assert.deepEqual(fs.readdirSync(choices).sort(), ['partial.tmp', 'term_x.ep1.json']);
});

test('reapChoices: missing directory is inert; other read errors log debug (DOG-21)', (t) => {
  assert.equal(typeof watchdog.reapChoices, 'function');
  const { dir } = alertFiles(t); const logs = [];
  const logger = (...args) => logs.push(args);
  assert.equal(watchdog.reapChoices(new Set(), dir, logger), 0);
  assert.deepEqual(logs, []);
  fs.writeFileSync(path.join(dir, 'choices'), 'not a directory');
  assert.equal(watchdog.reapChoices(new Set(), dir, logger), 0);
  assert.equal(logs.length, 1); assert.equal(logs[0][0], 'debug');
});

test('reapChoices: unlink failure does not throw or count as reaped (DOG-21)', (t) => {
  assert.equal(typeof watchdog.reapChoices, 'function');
  const { dir } = alertFiles(t); const choices = path.join(dir, 'choices');
  fs.mkdirSync(path.join(choices, 'blocked.json'), { recursive: true });
  fs.writeFileSync(path.join(choices, 'orphan.json'), '{}');
  assert.equal(watchdog.reapChoices(new Set(), dir), 1);
  assert.deepEqual(fs.readdirSync(choices), ['blocked.json']);
});

test('tick: reaps reconciled orphans while retaining an unread live choice; dry-run is inert (DOG-21)', async (t) => {
  const { dir } = alertFiles(t); const choices = path.join(dir, 'choices');
  fs.mkdirSync(choices);
  const live = `${H}.ep-1.json`; const orphan = 'term_absent.ep-old.json';
  for (const name of [live, orphan]) fs.writeFileSync(path.join(choices, name), JSON.stringify(choiceOf('Continue')));
  for (const dryRun of [true, false]) {
    const ev = LO({ alertedAt: NOW.toISOString() });
    const h = alertHarness({ ev, readThrows: true,
      state: { [H]: ev, term_absent: { ...ev, handle: 'term_absent', episodeId: 'ep-old' } } });
    h.deps.reapChoices = (names) => watchdog.reapChoices(names, dir);
    await tick({ dryRun }, h.deps);
    assert.equal(fs.existsSync(path.join(choices, live)), true);
    assert.equal(fs.existsSync(path.join(choices, orphan)), dryRun);
    assert.deepEqual(h.sent, []);
  }
});

test('tick: reaper runs after consent consumption and errors do not block sends (DOG-21)', async () => {
  const h = alertHarness({ ev: LO({ alertedAt: NOW.toISOString() }), choice: choiceOf('Stop') });
  let reaped = false;
  h.deps.reapChoices = (names) => {
    assert.ok(h.actions.includes('clear'));
    assert.deepEqual([...names], []);
    reaped = true;
  };
  await tick({ dryRun: false }, h.deps);
  assert.equal(reaped, true);
  const due = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed() });
  const logs = [];
  due.deps.log = (level, msg) => logs.push(msg);
  due.deps.reapChoices = async () => { throw new Error('reaper failed'); };
  await tick({ dryRun: false }, due.deps);
  assert.deepEqual(due.sent, [OUTAGE_RESUME_TEXT]);
  assert.ok(logs.some((msg) => msg.includes('reaper failed')));
});

function alertFiles(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-alert-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { WATCHDOG_ALERT_MESSAGE: 'term_x — hit limit', WATCHDOG_ALERT_EPISODE: 'ep9',
    WATCHDOG_ALERT_CHOICE_FILE: path.join(dir, 'choices', 'term_x.ep9.json') } };
}

test('runAlert: allowed buttons write atomic episode-bound choice files, message is argv data (DOG-20)', async (t) => {
  assert.equal(typeof watchdog.runAlert, 'function');
  const { dir, env } = alertFiles(t);
  const message = '- quotes " \\ $(touch nope) `echo nope`\nUnicode ■';
  for (const button of ['Continue', 'Wait 1h', 'Stop']) {
    await watchdog.runAlert({ ...env, WATCHDOG_ALERT_MESSAGE: message }, { execFileImpl: async (file, args) => {
      assert.equal(file, '/usr/bin/osascript');
      assert.deepEqual(args, ['-e', 'on run argv', '-e',
        'return button returned of (display alert "orca-watchdog" message (item 1 of argv) buttons {"Stop","Wait 1h","Continue"} default button "Continue")',
        '-e', 'end run', '--', message]);
      return { stdout: button + '\n' };
    } });
    const j = JSON.parse(fs.readFileSync(env.WATCHDOG_ALERT_CHOICE_FILE, 'utf8'));
    assert.deepEqual(Object.keys(j).sort(), ['at', 'choice', 'episodeId']);
    assert.equal(j.choice, button); assert.equal(j.episodeId, 'ep9'); assert.ok(Number.isFinite(Date.parse(j.at)));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'choices')), ['term_x.ep9.json']);
  }
  assert.deepEqual(fs.readdirSync(dir), ['choices']);
});
test('runAlert: osascript rejection, empty or invalid button writes nothing (DOG-20)', async (t) => {
  assert.equal(typeof watchdog.runAlert, 'function');
  const { dir, env } = alertFiles(t); const warnings = [];
  for (const execFileImpl of [async () => { throw new Error('boom'); },
    ...['', 'Delete everything\n', 'Continue\nStop'].map((stdout) => async () => ({ stdout }))]) {
    await watchdog.runAlert(env, { execFileImpl, logImpl: (level, msg) => warnings.push([level, msg]) });
    assert.equal(fs.existsSync(env.WATCHDOG_ALERT_CHOICE_FILE), false);
  }
  assert.deepEqual(fs.readdirSync(dir), []); assert.ok(warnings.length);
});
test('runAlert: missing/invalid env cannot launch osascript or write state paths (DOG-20)', async (t) => {
  assert.equal(typeof watchdog.runAlert, 'function');
  const { dir, env } = alertFiles(t); let calls = 0;
  for (const bad of [{}, { ...env, WATCHDOG_ALERT_MESSAGE: '' }, { ...env, WATCHDOG_ALERT_EPISODE: '../escape' },
    { ...env, WATCHDOG_ALERT_CHOICE_FILE: path.join(dir, 'state.json') },
    { ...env, WATCHDOG_ALERT_CHOICE_FILE: path.join(dir, 'choices', 'term_x.other.json') }]) {
    await watchdog.runAlert(bad, { execFileImpl: async () => { calls++; return { stdout: 'Continue' }; }, logImpl: () => {} });
  }
  assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(dir), []);
});
test('runAlert: awaits completion and concurrent dialogs never cross choices (DOG-20)', async (t) => {
  assert.equal(typeof watchdog.runAlert, 'function');
  const { dir, env } = alertFiles(t); let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const first = watchdog.runAlert(env, { execFileImpl: () => pending });
  const other = { ...env, WATCHDOG_ALERT_EPISODE: 'ep10', WATCHDOG_ALERT_CHOICE_FILE: path.join(dir, 'choices', 'term_y.ep10.json') };
  await watchdog.runAlert(other, { execFileImpl: async () => ({ stdout: 'Stop' }) });
  assert.equal(fs.existsSync(env.WATCHDOG_ALERT_CHOICE_FILE), false);
  finish({ stdout: 'Continue' }); await first;
  assert.equal(JSON.parse(fs.readFileSync(env.WATCHDOG_ALERT_CHOICE_FILE)).choice, 'Continue');
  assert.equal(JSON.parse(fs.readFileSync(other.WATCHDOG_ALERT_CHOICE_FILE)).choice, 'Stop');
  assert.equal(fs.readdirSync(path.join(dir, 'choices')).length, 2);
});
test('spawnAlert: detached self argv and env keep terminal identity outside truncation (DOG-20)', (t) => {
  assert.equal(typeof watchdog.spawnAlert, 'function');
  const { dir } = alertFiles(t); const calls = []; let unrefs = 0;
  const child = new EventEmitter(); child.unref = () => unrefs++;
  const spawnImpl = (...args) => { calls.push(args); return child; };
  for (const handle of ['term_one', 'term_two']) {
    assert.equal(watchdog.spawnAlert(LO({ handle, bannerText: 'x '.repeat(500) }), { spawnImpl, stateDir: dir, env: {} }), child);
  }
  assert.equal(unrefs, 2);
  for (const [i, [file, args, opts]] of calls.entries()) {
    const handle = i ? 'term_two' : 'term_one';
    assert.equal(file, process.execPath); assert.deepEqual(args, [fileURLToPath(new URL('./watchdog.mjs', import.meta.url)), '--alert']);
    assert.equal(opts.detached, true); assert.equal(opts.stdio, 'ignore'); assert.equal(opts.shell, undefined);
    assert.equal(opts.env.WATCHDOG_ALERT_MESSAGE, handle + ' — ' + 'x '.repeat(100) + '…');
    assert.equal(opts.env.WATCHDOG_ALERT_EPISODE, 'ep-1');
    assert.equal(opts.env.WATCHDOG_ALERT_CHOICE_FILE, path.join(dir, 'choices', `${handle}.ep-1.json`));
  }
  assert.throws(() => watchdog.spawnAlert(LO({ handle: '../unsafe' }), { spawnImpl, stateDir: dir }), /handle|path/);
  assert.throws(() => watchdog.spawnAlert(LO({ episodeId: '../unsafe' }), { spawnImpl, stateDir: dir }), /episode|path/);
  assert.equal(calls.length, 2); assert.deepEqual(fs.readdirSync(dir), []);
});
test('choice deps: real per-episode reads/deletes are bounded and isolated (DOG-20)', async (t) => {
  assert.equal(typeof watchdog.readChoice, 'function'); assert.equal(typeof watchdog.clearChoice, 'function');
  const { dir, env } = alertFiles(t); const warnings = []; const logger = (...args) => warnings.push(args);
  assert.equal(await watchdog.readChoice('term_x', 'ep9', dir, logger), null);
  await watchdog.runAlert(env, { execFileImpl: async () => ({ stdout: 'Continue' }) });
  assert.equal((await watchdog.readChoice('term_x', 'ep9', dir, logger)).choice, 'Continue');
  assert.equal(await watchdog.readChoice('term_x', 'ep10', dir, logger), null);
  await watchdog.clearChoice('term_x', 'ep10', dir, logger);
  assert.equal(fs.existsSync(env.WATCHDOG_ALERT_CHOICE_FILE), true);
  fs.writeFileSync(env.WATCHDOG_ALERT_CHOICE_FILE, '{bad');
  assert.equal(await watchdog.readChoice('term_x', 'ep9', dir, logger), null);
  await watchdog.clearChoice('term_x', 'ep9', dir, logger);
  assert.equal(fs.existsSync(env.WATCHDOG_ALERT_CHOICE_FILE), false);
  fs.mkdirSync(env.WATCHDOG_ALERT_CHOICE_FILE);
  await watchdog.clearChoice('term_x', 'ep9', dir, logger);
  assert.ok(warnings.length >= 2);
});
test('loadState: v2 rejection names the normalized violation when alertedAt is omitted (DOG-21)', async (t) => {
  const { dir } = alertFiles(t);
  const stateDir = path.join(dir, '.local', 'state', 'orca-watchdog');
  fs.mkdirSync(stateDir, { recursive: true });
  const ev = LO({ detectedAt: 'invalid-time' });
  delete ev.alertedAt;
  const text = JSON.stringify({ version: 2, events: { [H]: ev } });
  assert.equal(parseStateFile(text), null);
  fs.writeFileSync(path.join(stateDir, 'state.json'), text);
  const { stdout } = await pExecFile(process.execPath,
    [fileURLToPath(new URL('./watchdog.mjs', import.meta.url)), '--status'],
    { env: { ...process.env, HOME: dir }, timeout: 2000 });
  const logged = fs.readFileSync(path.join(stateDir, 'watchdog.log'), 'utf8');
  assert.ok(logged.includes(`state file rejected (${H}: detectedAt: not a timestamp)`), logged);
  assert.doesNotMatch(logged, /alertedAt:/);
  assert.equal(fs.existsSync(path.join(stateDir, 'state.json')), false);
  const backups = fs.readdirSync(stateDir).filter((name) => name.startsWith('state.json.bad-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(stateDir, backups[0]), 'utf8'), text);
  assert.equal(stdout.trim(), 'no active events');
});

test('--alert: missing env and mixed invocations exit without tick/lock/state/send (DOG-20)', async (t) => {
  const { dir } = alertFiles(t);
  const fakeOrca = path.join(dir, 'fake-orca'); const marker = path.join(dir, 'called');
  fs.writeFileSync(fakeOrca, '#!/bin/sh\nprintf called > "$WD_MARKER"\nprintf \'{"ok":true,"result":{"terminals":[]}}\\n\'\n', { mode: 0o755 });
  const env = { ...process.env, HOME: dir, ORCA_CLI: fakeOrca, WD_MARKER: marker };
  for (const key of Object.keys(env)) if (key.startsWith('WATCHDOG_ALERT_')) delete env[key];
  for (const args of [['--alert'], ['--alert', '--once'], ['--dry-run', '--alert'], ['--alert', '--alert']]) {
    await pExecFile(process.execPath, [fileURLToPath(new URL('./watchdog.mjs', import.meta.url)), ...args], { env, timeout: 2000 });
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(path.join(dir, '.local')), false);
  }
});
test('spawnAlert: harmless detached helper survives parent exit (DOG-20)', async (t) => {
  assert.equal(typeof watchdog.spawnAlert, 'function');
  const { dir } = alertFiles(t); const result = path.join(dir, 'survived');
  const helper = `setTimeout(() => require('fs').writeFileSync(process.argv[1], 'survived'), 150)`;
  const parent = `import { spawn } from 'node:child_process';
    import { spawnAlert } from ${JSON.stringify(new URL('./watchdog.mjs', import.meta.url).href)};
    spawnAlert({handle:'term_x',episodeId:'ep9',bannerText:'x'}, {stateDir:process.argv[1],
      spawnImpl:(file,args,opts) => spawn(file,['-e',${JSON.stringify(helper)},process.argv[2]],opts)});`;
  await pExecFile(process.execPath, ['--input-type=module', '-e', parent, dir, result], { timeout: 2000 });
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(result) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.readFileSync(result, 'utf8'), 'survived');
});

test('tick: due outage event, status none ⇒ one outage resume, attempt persisted before send', async () => {
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed() });
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, [OUTAGE_RESUME_TEXT]);
  assert.equal(h.saved()[H].attempts, 1);
  assert.equal(h.saved()[H].status, 'resumed');
  assert.equal(h.fetchImpl.calls.length, 2);
  assert.equal(h.fetchImpl.calls[0].url, CONNECTIVITY_URL);
  assert.equal(h.fetchImpl.calls[1].url, CLAUDE_URL);
});

test('tick: a due Codex outage event fetches status.openai.com and sends the outage text', async () => {
  const TC = { ...T, handle: 'term_codex', agentIdentity: 'codex' };
  const ev = { ...seed()[H], handle: 'term_codex', platform: 'codex' };
  const h = harness({ tail: CODEX_TAIL, terminals: [TC], state: { term_codex: ev } });
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, [OUTAGE_RESUME_TEXT]);
  assert.equal(h.fetchImpl.calls.length, 2);
  assert.equal(h.fetchImpl.calls[0].url, CONNECTIVITY_URL);
  assert.match(h.fetchImpl.calls[1].url, /status\.openai\.com/);
});

test('tick: status major suppresses without consuming an attempt', async () => {
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed(), indicator: 'major' });
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, []);
  assert.equal(h.saved()[H].attempts, 0);
  assert.equal(h.saved()[H].lastAttemptAt, null);
  assert.equal(h.saved()[H].status, 'waiting');
});

test('tick: an unverifiable (null) status holds the outage send fail-closed and logs it (DOG-24)', async () => {
  // indicator null ⇒ fetchIndicator returns null (unverifiable). Connectivity is
  // still ok, but an unverifiable provider health must NOT authorize an outage
  // resume during a possibly-continuing outage. (null, not undefined: the harness
  // default only replaces undefined.)
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed(), indicator: null });
  const logs = [];
  h.deps.log = (level, msg) => logs.push(msg);
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, []);
  assert.equal(h.saved()[H].attempts, 0);
  assert.equal(h.saved()[H].status, 'waiting');
  assert.ok(logs.some((m) => m === 'hold: provider health unverifiable'), logs.join(' | '));
});

test('tick: limit events probe connectivity once, then send the limit text (DOG-19)', async () => {
  const st = { [H]: { ...LIMIT_EV, platform: 'claude', bannerText: BANNER, detectedAt: NOW.toISOString(), resetAt: NOW.toISOString(),
    attempts: 0, lastAttemptAt: null, status: 'waiting' } };
  // Banner reset ("11pm") re-parses to the stored due time, so no reset-shift hold (DOG-24).
  const h = harness({ tail: ['Claude usage limit reached. Your limit will reset at 11pm.', '> ', '? for shortcuts'], terminals: [T], state: st, indicator: 'major' });
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, [RESUME_TEXT]);
  assert.equal(h.fetchImpl.calls.length, 1);
  assert.equal(h.fetchImpl.calls[0].url, CONNECTIVITY_URL);
});

test('tick: dry-run makes no sends and no network calls', async () => {
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed() });
  await tick({ dryRun: true }, h.deps);
  assert.deepEqual(h.sent, []);
  assert.equal(h.fetchImpl.calls.length, 0);
  assert.equal(h.saved(), null);
});

test('tick: offline holds all sends without spending an attempt (DOG-19)', async () => {
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed() });
  h.deps.fetchImpl = fakeFetch(() => { throw new Error('offline'); });   // probe fails ⇒ offline
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, []);
  assert.equal(h.saved()[H].attempts, 0);
  assert.equal(h.saved()[H].lastAttemptAt, null);
  assert.equal(h.saved()[H].status, 'waiting');
});

test('tick: offline holds a due limit send too (DOG-19)', async () => {
  const st = { [H]: { ...LIMIT_EV, platform: 'claude', bannerText: BANNER, detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 0, lastAttemptAt: null, status: 'waiting' } };
  const h = harness({ tail: [...CLAUDE_BANNER, '? for shortcuts'], terminals: [T], state: st });
  h.deps.fetchImpl = fakeFetch(() => { throw new Error('offline'); });
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, []);
  assert.equal(h.saved()[H].attempts, 0);
  assert.equal(h.saved()[H].lastAttemptAt, null);
  assert.equal(h.saved()[H].status, 'waiting');
});

test('tick: online probe runs once and permits the send (DOG-19)', async () => {
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed() });   // fake fetch is ok by default
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, [OUTAGE_RESUME_TEXT]);
  assert.equal(h.fetchImpl.calls[0].url, CONNECTIVITY_URL);   // probe first
});

test('tick: a limit whose reset shifts materially later is refreshed and held, not sent early (DOG-24)', async () => {
  // Stored reset is due (NOW), but the still-present banner now shows a later
  // reset (1am tomorrow). The pre-send re-read must honour the new time and hold
  // rather than resume early and burn a retry.
  const st = { [H]: { ...LIMIT_EV, platform: 'claude', bannerText: BANNER, detectedAt: NOW.toISOString(), resetAt: NOW.toISOString(),
    attempts: 0, lastAttemptAt: null, status: 'waiting' } };
  const laterBanner = 'Claude usage limit reached. Your limit will reset at 1am.';
  const h = harness({ tail: [laterBanner, '> ', '? for shortcuts'], terminals: [T], state: st });   // now = at(10)
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, []);
  assert.equal(h.saved()[H].resetAt, parseResetTime(laterBanner, at(10)).toISOString());
  assert.equal(h.saved()[H].attempts, 0);
  assert.equal(h.saved()[H].status, 'waiting');
});

test('tick: an out-of-range reset banner creates an event with a fallback reset and does not throw (DOG-24)', async () => {
  const huge = 'Claude usage limit reached. Your limit will reset in 9999999999 days.';
  const h = harness({ tail: [huge, '> ', '? for shortcuts'], terminals: [T], state: {}, now: NOW });
  await tick({ dryRun: false }, h.deps);   // must not throw a RangeError
  const ev = h.saved()[H];
  assert.equal(ev.kind, 'limit');
  assert.equal(ev.resetAt, new Date(NOW.getTime() + 60 * 60_000).toISOString());   // 60-min fallback
  assert.deepEqual(h.sent, []);
});

test('isInputOccupied: a ">" line with text after it is a user draft', () => {
  assert.equal(isInputOccupied(['API Error: 529', '> my half typed draft', '? for shortcuts']), true);
  assert.equal(isInputOccupied(['API Error: 529', '> ', '? for shortcuts']), false);
  assert.equal(isInputOccupied(['API Error: 529', '>', '? for shortcuts']), false);
  assert.equal(isInputOccupied([]), false);
});

test('isInputOccupied: Codex draft counts, the placeholder does not', () => {
  assert.equal(isInputOccupied([CODEX_ERR, '› fix the flaky test', CODEX_FOOTER]), true);
  assert.equal(isInputOccupied([CODEX_ERR, '› Ask Codex to do anything', CODEX_FOOTER]), false);
  assert.equal(isInputOccupied([CODEX_ERR, '›', CODEX_FOOTER]), false);
});

test('isInputOccupied: a shell prompt carrying an unsubmitted command is occupied (DOG-24)', () => {
  // Belt-and-suspenders behind the final-block detection guard: a populated shell
  // line ends in ordinary text, so a naive send would append+submit the command.
  assert.equal(isInputOccupied(['API Error: 529', '', 'john@mac ~ % echo do-not-submit']), true);
  assert.equal(isInputOccupied(['$ npm test']), true);
  assert.equal(isInputOccupied(['repo git:(main) ➜ rm -rf build']), true);
  // The EMPTY shell prompt is the exited-to-shell case (isShellPrompt drops it);
  // it must NOT read as occupied, or that drop path would be masked.
  assert.equal(isInputOccupied(['john@mac ~ %']), false);
  assert.equal(isInputOccupied(['Done. 50% coverage; costs $5 total.']), false);   // not a prompt+command
});

test('isInputOccupied: an indented draft still counts as occupied (DOG-24)', () => {
  // Detection uses .trim(); the draft guard must too, or an indented draft is
  // missed and a send could append+submit the user's text. Strictly adds skips.
  assert.equal(isInputOccupied(['  > half-typed']), true);
  assert.equal(isInputOccupied(['\t› indented codex draft', CODEX_FOOTER]), true);
  assert.equal(isInputOccupied(['   > ']), false);                       // indented empty box is not a draft
  assert.equal(isInputOccupied(['  › Ask Codex to do anything']), false); // indented placeholder is not a draft
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
    loadState: () => structuredClone(state), saveState: (e) => { saved = structuredClone(e); }, log: (lvl, msg) => logged.push(`${lvl} ${msg}`), reapChoices: () => 0 };
  await tick({ dryRun: false }, deps);
  assert.deepEqual(sent, [H2]);
  assert.equal(saved[H].attempts, 1, 'attempt was persisted before the failed send');
  assert.ok(logged.some((l) => l.startsWith('warn send failed for term_') && l.includes('agent_prompt_stalled')), logged.join('\n'));
});

test('tick: a throw while processing one send candidate does not abort the others (DOG-24)', async () => {
  const H2 = 'term_two';
  const T2 = { ...T, handle: H2 };
  const sent = [];
  const logged = [];
  const reads = {};
  const orca = async (args) => {
    const [scope, verb] = args;
    if (verb === 'list') return { terminals: [T, T2] };
    if (verb === 'read') {
      const handle = args[args.indexOf('--terminal') + 1];
      reads[handle] = (reads[handle] || 0) + 1;
      // observation read is fine; the FRESH re-read for H returns a malformed
      // (non-array) tail so detectBanner throws inside the send loop.
      if (handle === H && reads[handle] === 2) return { terminal: { tail: 42 } };
      return { terminal: { tail: OUTAGE_TAIL } };
    }
    if (verb === 'wait') return {};
    if (verb === 'send') { sent.push(args[args.indexOf('--terminal') + 1]); return {}; }
    throw new Error(`unexpected orca call ${args.join(' ')}`);
  };
  const state = { ...seed(), [H2]: { ...seed()[H], handle: H2 } };
  const deps = { orca, fetchImpl: fakeFetch(() => okJson({ status: { indicator: 'none' } })), env: {}, now: () => at(10),
    loadState: () => structuredClone(state), saveState: () => {}, log: (lvl, msg) => logged.push(`${lvl} ${msg}`), reapChoices: () => 0, isDisabled: () => false };
  await tick({ dryRun: false }, deps);   // must NOT throw/abort
  assert.deepEqual(sent, [H2]);          // the healthy candidate still sends
  assert.ok(logged.some((l) => l.startsWith('warn') && l.includes(H)), logged.join('\n'));
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
    loadState: () => seed(), saveState: () => {}, log: (lvl, msg) => logged.push(msg), reapChoices: () => 0 };
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
  const deps = { orca, fetchImpl: fakeFetch(() => okJson({})), env: {}, now: () => at(10), loadState: () => ({}), saveState: () => {}, log: () => {}, reapChoices: () => 0 };
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

test('tick: a limit banner trailing a shell prompt is stale on the fresh re-read; held then deleted, never sent (DOG-24)', async () => {
  // With the generic-limit final-block guard (1.2), a banner the agent scrolled
  // past to a shell prompt no longer detects on the fresh re-read: it is held as
  // a first miss (clearedAt) this tick and deleted on the next absent tick. Both
  // ticks send nothing — the exited-to-shell case stays no-send.
  const st = { [H]: { ...LIMIT_EV, platform: 'claude', bannerText: BANNER, detectedAt: NOW.toISOString(), resetAt: NOW.toISOString(),
    attempts: 0, lastAttemptAt: null, status: 'waiting' } };
  const shellTail = ['Claude usage limit reached. Your limit will reset at 3am.', 'john@mac ~ %'];
  const h = harness({ tail: [...CLAUDE_BANNER, '? for shortcuts'], terminals: [T], state: st });
  let reads = 0; const inner = h.deps.orca;
  h.deps.orca = async (args) => (args[1] === 'read' && ++reads === 2) ? { terminal: { tail: shellTail } } : inner(args);
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, []);
  assert.ok(h.saved()[H].clearedAt, 'first miss holds with clearedAt');
  assert.equal(h.saved()[H].attempts, 0);
  const next = harness({ tail: shellTail, terminals: [T], state: h.saved() });
  await tick({ dryRun: false }, next.deps);
  assert.deepEqual(next.sent, []); assert.deepEqual(next.saved(), {});
});

test('tick: shell-prompt guard still drops a detecting banner ending in a bare ">" (DOG-24)', async () => {
  // The banner ends in a bare ">" — chrome, so it still detects on the fresh
  // re-read — but on a non-Claude terminal that ">" is a shell prompt, so the
  // prompt guard drops the event and sends nothing. Keeps the guard reachable.
  const st = { [H]: { ...LIMIT_EV, platform: 'unknown', bannerText: BANNER, detectedAt: NOW.toISOString(), resetAt: NOW.toISOString(),
    attempts: 0, lastAttemptAt: null, status: 'waiting' } };
  const term = { ...T, agentIdentity: undefined };
  // "11pm" re-parses to the stored due time so the reset-shift hold (DOG-24) does not fire first.
  const h = harness({ tail: ['Claude usage limit reached. Your limit will reset at 11pm.', '> '], terminals: [term], state: st });
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, []); assert.deepEqual(h.saved(), {});
});

test('tick: pause appearing mid-tick halts the remaining sends in the same tick (DOG-24)', async () => {
  const H2 = 'term_two';
  const T2 = { ...T, handle: H2 };
  const state = { ...seed(), [H2]: { ...seed()[H], handle: H2 } };
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T, T2], state });
  h.deps.isDisabled = () => h.sent.length >= 1;   // becomes paused right after the first send
  await tick({ dryRun: false }, h.deps);
  assert.equal(h.sent.length, 1, 'second candidate must not send once paused');
});

test('tick: two due Claude outages share one status fetch and both send when status is none', async () => {
  const H2 = 'term_two';
  const T2 = { ...T, handle: H2 };
  const state = { ...seed(), [H2]: { ...seed()[H], handle: H2 } };
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T, T2], state });
  await tick({ dryRun: false }, h.deps);
  assert.equal(h.fetchImpl.calls.filter((c) => c.url === CONNECTIVITY_URL).length, 1);
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

test('orca(): malformed JSON stdout becomes an unavailable error, not an unhandled throw (DOG-24)', async () => {
  const badExec = async () => ({ stdout: 'not json at all' });
  await assert.rejects(watchdog.orca(['terminal', 'list'], badExec), (e) => {
    assert.equal(isUnavailableError(e), true);   // the tick's list-catch treats it as "nothing to observe"
    return true;
  });
  const structured = async () => ({ stdout: JSON.stringify({ ok: false, error: { code: 'runtime_unavailable', message: 'down' } }) });
  await assert.rejects(watchdog.orca(['terminal', 'list'], structured), (e) => { assert.equal(e.code, 'runtime_unavailable'); return true; });
  const good = async () => ({ stdout: JSON.stringify({ ok: true, result: { terminals: [] } }) });
  assert.deepEqual(await watchdog.orca(['terminal', 'list'], good), { terminals: [] });
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
  const p = '/Users/example/orca-watchdog/watchdog.mjs';
  assert.equal(sanitize(`see ${p} line 3`), `see ${p} line 3`);
  assert.equal(sanitize('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc'), 'token [redacted]');
});

test('sanitize redacts secret-shaped name=value pairs incl. slash-bearing values; keeps paths (DOG-24)', () => {
  assert.equal(sanitize('api_key=sk-abc/def123ghi'), 'api_key=[redacted]');
  assert.equal(sanitize('secret: aa/bb/cc/dd112233'), 'secret: [redacted]');
  assert.equal(sanitize('password=hunter2/xyz'), 'password=[redacted]');
  assert.equal(sanitize('X-Api-Token=abc123def'), 'X-Api-Token=[redacted]');
  // ordinary filesystem paths are never redacted
  assert.equal(sanitize('/Users/example/Projects/x'), '/Users/example/Projects/x');
  assert.equal(sanitize('see /var/log/app.log now'), 'see /var/log/app.log now');
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

import { parseArgv } from './watchdog.mjs';

test('parseArgv: no-args ticks, known flags dispatch, unknown tokens fail closed (DOG-24)', () => {
  assert.deepEqual(parseArgv([]), { action: 'tick', dryRun: false });
  assert.deepEqual(parseArgv(['--once']), { action: 'tick', dryRun: false });
  assert.deepEqual(parseArgv(['--dry-run']), { action: 'tick', dryRun: true });
  assert.deepEqual(parseArgv(['--status']), { action: 'status' });
  assert.deepEqual(parseArgv(['--help']), { action: 'help' });
  assert.deepEqual(parseArgv(['-h']), { action: 'help' });
  assert.deepEqual(parseArgv(['--bogus']), { action: 'error', unknown: ['--bogus'] });
  assert.deepEqual(parseArgv(['--dr-run']), { action: 'error', unknown: ['--dr-run'] });   // typo'd --dry-run
  assert.deepEqual(parseArgv(['--status', '--bogus']), { action: 'error', unknown: ['--bogus'] });
});

test('watchdog.mjs entry: no-args ticks; --bogus fails closed without ticking; --help does not tick (DOG-24)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-argv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orcaLog = path.join(dir, 'orca.log');
  const fakeOrca = path.join(dir, 'orca');
  fs.writeFileSync(fakeOrca, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${orcaLog}"\nprintf '{"ok":true,"result":{"terminals":[]}}'\n`, { mode: 0o755 });
  const run = (args) => pExecFile(process.execPath, [path.join(process.cwd(), 'watchdog.mjs'), ...args],
    { env: { ...process.env, HOME: dir, ORCA_CLI: fakeOrca } });
  // no-args: a real tick runs and lists terminals via orca
  await run([]);
  assert.match(fs.readFileSync(orcaLog, 'utf8'), /terminal list/);
  fs.rmSync(orcaLog, { force: true });
  // --bogus: usage to stderr, exit non-zero, and NO tick (orca never called)
  await assert.rejects(run(['--bogus']), (e) => {
    assert.notEqual(e.code, 0); assert.match(e.stderr, /Usage: watchdog\.mjs/); return true;
  });
  assert.equal(fs.existsSync(orcaLog), false);
  // --help: usage to stdout, exit 0, still no tick
  const help = await run(['--help']);
  assert.match(help.stdout, /Usage: watchdog\.mjs/);
  assert.equal(fs.existsSync(orcaLog), false);
});

test('acquireLock: a stale lock is reclaimed exactly once; a fresh lock is never stolen (DOG-24)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'lock');
  // stale lock: backdate its mtime past the 10-min TTL
  fs.writeFileSync(lock, '99999');
  const old = new Date(Date.now() - 11 * 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(watchdog.acquireLock(lock), true, 'first attempt reclaims the stale lock');
  assert.equal(watchdog.acquireLock(lock), false, 'second attempt sees the fresh lock and skips');
  assert.equal(watchdog.acquireLock(lock), false, 'a fresh lock is never reclaimed');
  // no stale steal-temp files are left behind
  assert.deepEqual(fs.readdirSync(dir), ['lock']);
});

test('saveState writes 0600 state in a 0700 dir, tightening an existing loose dir (DOG-24)', (t) => {
  if (process.platform === 'win32') return;   // POSIX modes not represented
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-perm-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'state');
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o755);   // start world-readable
  watchdog.saveState({}, dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'dir tightened to 0700');
  assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600, 'state file is 0600');
});

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
