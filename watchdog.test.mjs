import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBanner, parseResetTime, reconcile, eventKey, stripAnsi, sanitize, hasOutageLine, inferPlatform,
  SCHEDULE, OUTAGE_RESUME_TEXT, newEvent, validateEvent, parseStateFile } from './watchdog.mjs';
import { isShellPrompt } from './watchdog.mjs';
import { statusUrlFor, fetchIndicator, suppressedByStatus } from './watchdog.mjs';

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
  const r = reconcile(state, obs(null), new Date(NOW.getTime() + min(5)));
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
});

test('outage: limit events have no deadline', () => {
  const st = { [H]: { ...LIMIT_EV, bannerText: BANNER, detectedAt: NOW.toISOString(), resetAt: at(48 * 60).toISOString(),
    attempts: 0, lastAttemptAt: null, status: 'waiting' } };
  assert.equal(reconcile(st, obs(BANNER), at(30 * 60)).events[H].status, 'waiting');
});

test('gave_up event whose banner clears is deleted', () => {
  const r = reconcile(seed({ attempts: 6, lastAttemptAt: at(1).toISOString(), status: 'gave_up' }), obs(null), at(300));
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

test('sanitize strips ANSI, collapses whitespace and truncates', () => {
  assert.equal(sanitize('\x1b[2m  a \n\t b  \x1b[0m'), 'a b');
  assert.equal(sanitize('x'.repeat(10), 4), 'xxxx…');
});
