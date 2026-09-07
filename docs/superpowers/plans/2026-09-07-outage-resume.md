# Outage Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the watchdog to detect Claude Code API-outage banners and resume those terminals on a status-page-gated backoff, without ever typing into a healthy agent.

**Architecture:** Everything stays in the single dependency-free `watchdog.mjs` (project convention). Pure, exported functions (`sanitize`, `detectBanner`, `inferPlatform`, `validateEvent`, `parseStateFile`, `reconcile`, `isShellPrompt`, `statusUrlFor`, `fetchIndicator`) carry all logic and are unit-tested with `node --test`; `tick()` becomes injectable (`deps` argument) so its send gate is unit-tested with a fake `orca` and fake `fetch`. State file moves to schema v2 with validation and in-memory v1 upgrade.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, built-in `fetch`. No package.json, no dependencies (CLAUDE.md).

**Spec:** `docs/superpowers/specs/2026-09-07-outage-resume-design.md` (read it first; this plan argues from it). Base design: `docs/superpowers/specs/2026-07-23-orca-limit-watchdog-design.md`.

## Global Constraints

- No dependencies, no package.json; system Node ≥ 20 only (CLAUDE.md).
- `watchdog.mjs` is an invariant file: every change is code-reviewed; keep diffs surgical.
- Never run the daemon against live Orca terminals from an agent session; only `--dry-run` and the fake TUI (CLAUDE.md). Never run `install.sh` from a worktree.
- Resume texts, verbatim: limit `Session rate limit has reset. Resume where you left off.`; outage `The API outage appears to be over. Resume where you left off.`
- Outage schedule: first send `detectedAt + 10 min`, buffer 0, retry spacing 30 min, re-arm 10 min, max 6 sends, deadline `detectedAt + 24 h`. Limit schedule unchanged (buffer 2 min, spacing 30 min, re-arm 10 min, max 3).
- Status URLs: claude `https://status.claude.com/api/v2/status.json`, codex `https://status.openai.com/api/v2/status.json`; `redirect: 'error'`, 10 s timeout; suppress only on `major`/`critical`; fail open otherwise.
- Env override `WATCHDOG_STATUS_URL_<CLAUDE|CODEX>` honoured only for `http:`/`https:` with host `127.0.0.1`, `[::1]`, or `localhost`.
- Codex outage detection is disabled in this revision (no pattern row); the platform plumbing must still support `codex`.
- Run `node --test` before every commit; all tests green. Commit locally only; **do not push**.

---

## File map

| File | Responsibility after this plan |
|---|---|
| `watchdog.mjs` | Daemon. New pure exports: `stripAnsi`, `sanitize`, `hasOutageLine`, `detectBanner(lines, platform)`, `inferPlatform(terminal, banner)`, `SCHEDULE`, `OUTAGE_RESUME_TEXT`, `newEvent`, `validateEvent`, `parseStateFile`, `reconcile`, `isShellPrompt`, `statusUrlFor`, `fetchIndicator`, `suppressedByStatus`. `tick(opts, deps)` injectable. |
| `watchdog.test.mjs` | All unit tests (one file, project convention). |
| `e2e/fake-tui.mjs` | Gains `--outage` mode; prints `? for shortcuts` as its last line in both modes. |
| `e2e/status-stub.mjs` | New: loopback HTTP server answering a scripted sequence of indicators. |
| `README.md` | Outage section, both resume texts, status-page note, loopback override. |

---

### Task 1: `stripAnsi` and `sanitize`

**Files:**
- Modify: `watchdog.mjs` (add after the `VETO_RE` line, ~line 36)
- Test: `watchdog.test.mjs`

**Triage:** BEHAVIORAL — `sanitize('\x1b[31mBearer abc123\x1b[0m')` → `'[redacted]'`; today no such function exists.

**Interfaces:**
- Consumes: nothing.
- Produces: `stripAnsi(s: string): string`; `sanitize(text: unknown, limit = 200): string` (ANSI-stripped, whitespace-collapsed, credential-redacted, truncated with `…`).

- [ ] **Step 1: Write the failing tests** (append to `watchdog.test.mjs`; extend the import line to include `stripAnsi, sanitize`)

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test 2>&1 | tail -20`
Expected: the four new tests FAIL (`stripAnsi`/`sanitize` are not exported → SyntaxError on import; that counts as failing).

- [ ] **Step 3: Implement**

Add to `watchdog.mjs` directly after the `VETO_RE` line:

```js
// CSI (ESC [ … final), OSC (ESC ] … BEL|ST), and stray C0/DEL control bytes.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g;
export function stripAnsi(s) { return String(s).replace(ANSI_RE, ''); }

// Credential shapes redacted from every logged terminal fragment. The last
// pattern (32+ opaque chars) also catches raw JWT/API-key material we have no
// prefix for; ordinary words and short git hashes are far below that length.
const SECRET_RES = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bBearer\s+\S+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /[A-Za-z0-9+/=_-]{32,}/g,
];
export function sanitize(text, limit = 200) {
  let s = stripAnsi(text).replace(/\s+/g, ' ').trim();
  for (const re of SECRET_RES) s = s.replace(re, '[redacted]');
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: all PASS (30 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat: stripAnsi and credential-redacting sanitize"
```

---

### Task 2: Kind-aware `detectBanner` with the outage rule

**Files:**
- Modify: `watchdog.mjs:33-64` (`LIMIT_RE`…`detectBanner`)
- Test: `watchdog.test.mjs`

**Triage:** BEHAVIORAL — `detectBanner(['API Error: 529 …', '> '], 'claude')` → `{ kind: 'outage', … }`; today → `null`. Existing limit fixtures must now return `kind: 'limit'`.

**Interfaces:**
- Consumes: `stripAnsi`, `sanitize` (Task 1).
- Produces: `detectBanner(lines: string[], platform: 'claude'|'codex'|'unknown' = 'unknown'): { kind: 'limit'|'outage', bannerText: string, matchedLine: string, patternId: string } | null`; `hasOutageLine(lines): boolean` (any outage-pattern line in the window, ignoring platform/final-block, for the debug tuning log); `OUTAGE_PATTERNS` (not exported).

- [ ] **Step 1: Write the failing tests** (add `hasOutageLine` to the import)

```js
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
      assert.match(b.bannerText, /^API Error/);
    }
  }
});

test('outage bannerText is sanitized and capped at 200 chars', () => {
  const b = detectBanner(outageTail('API Error: 529 ' + 'x'.repeat(300)), 'claude');
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test 2>&1 | grep -E '^(not ok|# (pass|fail))'`
Expected: the new outage tests FAIL (`hasOutageLine` not exported; `kind` undefined; outage tails return null).

- [ ] **Step 3: Implement**

Replace the block from `const LIMIT_RE` through the end of `detectBanner` in `watchdog.mjs` with:

```js
const LIMIT_RE = /((usage|rate|session|weekly|daily|\d+[- ]hour)\s+limit|quota)/i;
const REACHED_RE = /(reached|hit|exceeded)/i;
const RESET_RE = /(resets?\b|try again|available|come back)/i;
const VETO_RE = /approaching[^\n]*limit/i;

// Outage banners are platform-owned TUI shapes; there is deliberately no
// generic rule. `platforms` gates which terminal identities a row applies to.
// Codex has no row yet (spec §Non-goals): nothing it prints is unambiguous.
const OUTAGE_PATTERNS = [
  { id: 'claude-api-error', platforms: ['claude', 'unknown'],
    re: /^(⎿\s*)?API Error: (5\d\d\b|Connection error\b|.*\boverloaded_error\b)/i },
];
const RETRY_RE = /retrying in \d|attempt \d+\s*(\/|of)\s*\d+/i;
// Lines allowed AFTER the error for it to count as the final, stalled banner.
const CHROME_RES = [
  /^$/,
  /^[─│╭╮╰╯┃━┌┐└┘├┤⎿\s]+$/,
  /^>(\s.*)?$/,
  /^⎿/,
  /^(\? for shortcuts|Press |Esc |esc |Retry|⏵|⏸|✗|✓)/,
];
const isChrome = (l) => CHROME_RES.some((re) => re.test(l));
const lastIndex = (arr, pred) => { let i = -1; arr.forEach((x, j) => { if (pred(x)) i = j; }); return i; };

export function hasOutageLine(lines) {
  const window = lines.slice(-TAIL_LINES).map((l) => stripAnsi(l).trim());
  return OUTAGE_PATTERNS.some((p) => window.some((l) => p.re.test(l)));
}

export function detectBanner(lines, platform = 'unknown') {
  const window = lines.slice(-TAIL_LINES).map((l) => stripAnsi(l).trim());

  // --- limit rule (unchanged semantics; now on stripped lines) ---
  // Drop soft "approaching … limit" warning lines first, so such a warning can
  // neither be mistaken for a reached-banner nor veto a genuine reached-banner
  // that happens to share the same 15-line window (per-line veto, not whole-window).
  const kept = window.filter((l) => !VETO_RE.test(l));
  const text = kept.join('\n');
  let limit = null;
  if (LIMIT_RE.test(text) && REACHED_RE.test(text) && RESET_RE.test(text)) {
    const isRelevant = (l) => !VETO_RE.test(l) && (LIMIT_RE.test(l) || RESET_RE.test(l));
    const l = lastIndex(window, isRelevant);
    limit = { kind: 'limit', bannerText: window.filter(isRelevant).join(' | '),
      matchedLine: window[l], patternId: 'limit', index: l };
  }

  // --- outage rule ---
  let outage = null;
  for (const p of OUTAGE_PATTERNS) {
    if (!p.platforms.includes(platform)) continue;
    const e = lastIndex(window, (l) => p.re.test(l));
    if (e < 0) continue;
    if (lastIndex(window, (l) => RETRY_RE.test(l)) >= e) continue;   // still retrying
    if (!window.slice(e + 1).every(isChrome)) continue;               // stale: agent moved on
    outage = { kind: 'outage', bannerText: sanitize(window[e], 200),
      matchedLine: window[e], patternId: p.id, index: e };
    break;
  }

  const pick = (limit && outage) ? (limit.index >= outage.index ? limit : outage) : (limit ?? outage);
  if (!pick) return null;
  const { index, ...banner } = pick;
  return banner;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: all PASS, including the 30 pre-existing tests (the limit rule's behaviour is unchanged).

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat: kind-aware detectBanner with final-block-anchored Claude outage rule"
```

---

### Task 3: `inferPlatform`

**Files:**
- Modify: `watchdog.mjs` (add after `detectBanner`)
- Test: `watchdog.test.mjs`

**Triage:** BEHAVIORAL — `inferPlatform({ agentIdentity: 'codex' }, { patternId: 'claude-api-error' })` → `'codex'`; `inferPlatform({}, { patternId: 'claude-api-error' })` → `'claude'`.

**Interfaces:**
- Consumes: banner shape from Task 2.
- Produces: `inferPlatform(terminal: { agentIdentity?: string } | undefined, banner?: { patternId } | null): 'claude'|'codex'|'unknown'`. Called with one argument it yields spec §2 step 1 only (the value `detectBanner` receives).

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test 2>&1 | grep -E '^(not ok|# fail)'`
Expected: FAIL — `inferPlatform` is not exported.

- [ ] **Step 3: Implement** (after `detectBanner`)

```js
export function inferPlatform(terminal, banner = null) {
  const id = terminal?.agentIdentity;
  if (id === 'claude' || id === 'codex') return id;
  if (banner?.patternId === 'claude-api-error') return 'claude';
  return 'unknown';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat: inferPlatform from agentIdentity with Claude banner fallback"
```

---

### Task 4: Schema v2 — `SCHEDULE`, `newEvent`, `validateEvent`, `parseStateFile`, v2 save

**Files:**
- Modify: `watchdog.mjs:21-27` (constants), `watchdog.mjs:172-190` (`loadState`/`saveState`), `watchdog.mjs:278-284` (`--status`)
- Test: `watchdog.test.mjs`

**Triage:** BEHAVIORAL — `parseStateFile('{"version":1,"events":{…}}')` → events with `kind: 'limit', platform: 'unknown'`; a v2 event with `attempts: 7` → `null` (invalid).

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `OUTAGE_RESUME_TEXT`; `SCHEDULE = { limit: {...}, outage: {...} }` with fields `bufferMs, retrySpacingMs, rearmMs, maxSends, deadlineMs (null for limit), initialDelayMs (outage only), resumeText`.
  - `newEvent(o: { handle, banner, platform }, now: Date): Event`.
  - `validateEvent(key: string, ev: unknown): string | null` (first violation, or null when valid).
  - `parseStateFile(text: string): Record<string, Event> | null` (null ⇒ invalid; caller does backup-and-reset).
  - `saveState` writes `version: 2`; `--status` prints `version: 2`.

- [ ] **Step 1: Write the failing tests** (add `SCHEDULE, OUTAGE_RESUME_TEXT, newEvent, validateEvent, parseStateFile` to the import)

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test 2>&1 | grep -E '^(not ok|# fail)'`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement**

(a) Replace the constants block `BUFFER_MS` … `MAX_ATTEMPTS` (keep `MIN`, `GRACE_PAST_MS`, `TAIL_LINES`, `READ_BUDGET_MS`) with:

```js
export const OUTAGE_RESUME_TEXT = 'The API outage appears to be over. Resume where you left off.';

// Per-kind schedule (spec §4). bufferMs: wait past resetAt before sending;
// rearmMs: banner still present this long after a send = failed attempt;
// deadlineMs: give up this long after detection regardless of attempts.
export const SCHEDULE = Object.freeze({
  limit: Object.freeze({ bufferMs: 2 * MIN, retrySpacingMs: 30 * MIN, rearmMs: 10 * MIN, maxSends: 3, deadlineMs: null,
    resumeText: RESUME_TEXT }),
  outage: Object.freeze({ bufferMs: 0, retrySpacingMs: 30 * MIN, rearmMs: 10 * MIN, maxSends: 6, deadlineMs: 24 * 60 * MIN,
    initialDelayMs: 10 * MIN, resumeText: OUTAGE_RESUME_TEXT }),
});
const KINDS = Object.keys(SCHEDULE);
const PLATFORMS = ['claude', 'codex', 'unknown'];
const STATUSES = ['waiting', 'resumed', 'gave_up'];
```

(b) Add after `inferPlatform` (before the `eventKey` comment):

```js
export function newEvent(o, now) {
  const kind = o.banner.kind;
  const resetAt = kind === 'outage'
    ? new Date(now.getTime() + SCHEDULE.outage.initialDelayMs)
    : (parseResetTime(o.banner.bannerText, now) ?? new Date(now.getTime() + 60 * MIN));
  return {
    handle: o.handle, kind, platform: o.platform ?? 'unknown', bannerText: o.banner.bannerText,
    detectedAt: now.toISOString(), resetAt: resetAt.toISOString(),
    attempts: 0, lastAttemptAt: null, status: 'waiting',
  };
}

const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

// Returns the first violation as a string, or null when the event is valid (spec §3).
export function validateEvent(key, ev) {
  if (!ev || typeof ev !== 'object') return 'event: not an object';
  if (typeof ev.handle !== 'string' || ev.handle === '' || ev.handle !== key) return 'handle: must equal its key';
  if (!KINDS.includes(ev.kind)) return `kind: ${ev.kind}`;
  if (!PLATFORMS.includes(ev.platform)) return `platform: ${ev.platform}`;
  if (ev.kind === 'outage' && ev.platform === 'unknown') return 'platform: outage requires a known platform';
  if (!STATUSES.includes(ev.status)) return `status: ${ev.status}`;
  if (typeof ev.bannerText !== 'string') return 'bannerText: not a string';
  if (!isIso(ev.detectedAt)) return 'detectedAt: not a timestamp';
  if (!isIso(ev.resetAt)) return 'resetAt: not a timestamp';
  const max = SCHEDULE[ev.kind].maxSends;
  if (!Number.isInteger(ev.attempts) || ev.attempts < 0 || ev.attempts > max) return `attempts: ${ev.attempts} (0..${max})`;
  if (ev.lastAttemptAt !== null && !isIso(ev.lastAttemptAt)) return 'lastAttemptAt: not null or a timestamp';
  if (ev.lastAttemptAt === null && (ev.status !== 'waiting' || ev.attempts > 0)) return 'lastAttemptAt: required once an attempt was made';
  return null;
}

// Parses state.json text. v1 is upgraded in memory (kind limit, platform
// unknown) then validated as v2. Returns null for anything invalid.
export function parseStateFile(text) {
  let s;
  try { s = JSON.parse(text); } catch { return null; }
  if (!s || typeof s !== 'object' || !s.events || typeof s.events !== 'object') return null;
  if (s.version !== 1 && s.version !== 2) return null;
  const events = {};
  for (const [key, raw] of Object.entries(s.events)) {
    const ev = s.version === 1 ? { ...raw, kind: 'limit', platform: 'unknown' } : raw;
    if (validateEvent(key, ev) !== null) return null;
    events[key] = ev;
  }
  return events;
}
```

(c) Replace `loadState` and `saveState`:

```js
function loadState() {
  let text;
  try { text = fs.readFileSync(STATE_FILE, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return {};
    log('warn', `state file unreadable (${e.message}); reset`);
    return {};
  }
  const events = parseStateFile(text);
  if (events) return events;
  // Name the first violation so a bad file is diagnosable from the log.
  let why = 'invalid state file';
  try {
    const s = JSON.parse(text);
    if (s?.version !== 1 && s?.version !== 2) why = `unsupported version ${s?.version}`;
    else for (const [k, raw] of Object.entries(s.events ?? {})) {
      const v = validateEvent(k, s.version === 1 ? { ...raw, kind: 'limit', platform: 'unknown' } : raw);
      if (v) { why = `${k}: ${v}`; break; }
    }
  } catch (e) { why = e.message; }
  try { fs.renameSync(STATE_FILE, `${STATE_FILE}.bad-${Date.now()}`); } catch { /* gone */ }
  log('warn', `state file rejected (${why}); backed up and reset`);
  return {};
}

function saveState(events) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 2, events }, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
```

(d) In `main()`, change the `--status` output to `JSON.stringify({ version: 2, events }, null, 2)`.

(e) `reconcile` still references `BUFFER_MS`, `REARM_MS`, `RETRY_SPACING_MS`, `MAX_ATTEMPTS`; to keep this task green before Task 5 rewrites it, add these temporary aliases directly under `SCHEDULE` and delete them in Task 5:

```js
const { bufferMs: BUFFER_MS, rearmMs: REARM_MS, retrySpacingMs: RETRY_SPACING_MS, maxSends: MAX_ATTEMPTS } = SCHEDULE.limit; // removed in Task 5
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat: state schema v2 with validation, v1 upgrade, per-kind schedule"
```

---

### Task 5: `reconcile` with the spec's transition order

**Files:**
- Modify: `watchdog.mjs` (`reconcile`, ~lines 98-140 after earlier tasks)
- Test: `watchdog.test.mjs:100-207` (helpers + existing lifecycle tests) plus new tests

**Triage:** BEHAVIORAL — an outage event at `detectedAt + 24 h` → `gave_up`; a same-kind event whose observed platform changed claude→codex → replaced with `attempts: 0`.

**Interfaces:**
- Consumes: `SCHEDULE`, `newEvent` (Task 4).
- Produces: `reconcile(state, observations: Array<{ handle, banner: Banner|null, platform: 'claude'|'codex'|'unknown' }>, now: Date, liveHandles?: string[]) → { events, sendCandidates: string[] }`. Observations without `platform` are treated as `'unknown'`.

- [ ] **Step 1: Update the existing helpers and seed states, then add the failing tests**

Change the helpers at the top of the lifecycle section to:

```js
const obs = (banner, extra = {}) => [{ handle: H, platform: 'unknown', ...extra,
  banner: banner ? (typeof banner === 'string' ? { kind: 'limit', bannerText: banner } : banner) : null }];
const LIMIT_EV = { handle: H, kind: 'limit', platform: 'unknown' };
```

and in every existing lifecycle test that seeds a state object literally (`{ [H]: { handle: H, bannerText: … } }`), spread `...LIMIT_EV` in place of `handle: H` so the seeded events carry `kind` and `platform`. Then append:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test 2>&1 | grep -E '^(not ok|# fail)'`
Expected: the outage lifecycle tests FAIL (no deadline, no replace, outage resetAt parsed as limit). Existing lifecycle tests still pass.

- [ ] **Step 3: Implement** — replace `reconcile` entirely and delete the Task 4 alias line:

```js
// observations: [{ handle, banner: { kind, bannerText, … } | null, platform }]
// Applies spec §5's transition order per stored event; first matching rule wins.
export function reconcile(state, observations, now, liveHandles = null) {
  const events = structuredClone(state);
  const sendCandidates = [];
  const byHandle = new Map(observations.map((o) => [o.handle, { ...o, platform: o.platform ?? 'unknown' }]));
  // Terminals that still EXIST this tick (from `terminal list`) — a superset of
  // the ones we managed to READ: a read can fail on transient orca socket churn
  // or be skipped by the read budget. Old callers/tests omit it.
  const live = liveHandles ? new Set(liveHandles) : new Set(byHandle.keys());

  for (const [key, ev] of Object.entries(events)) {
    if (!live.has(ev.handle)) { delete events[key]; continue; }             // 1. vanished
    const o = byHandle.get(ev.handle);
    if (!o) continue;                                                        // 2. live but unread: freeze
    if (!o.banner) { delete events[key]; continue; }                         // 3. banner cleared
    if (o.banner.kind !== ev.kind || (o.platform !== 'unknown' && o.platform !== ev.platform)) {
      events[key] = newEvent(o, now); continue;                              // 4. replace (never a candidate this tick)
    }
    const sch = SCHEDULE[ev.kind];                                           // 5. same kind & platform
    if (sch.deadlineMs !== null && now - new Date(ev.detectedAt) >= sch.deadlineMs) {
      ev.status = 'gave_up'; continue;                                       // 5a
    }
    if (ev.status === 'resumed' && now - new Date(ev.lastAttemptAt) >= sch.rearmMs) {
      ev.status = ev.attempts >= sch.maxSends ? 'gave_up' : 'waiting';       // 5b
    }
    if (ev.status === 'waiting'
      && now - new Date(ev.resetAt) >= sch.bufferMs
      && ev.attempts < sch.maxSends
      && (!ev.lastAttemptAt || now - new Date(ev.lastAttemptAt) >= sch.retrySpacingMs)) {
      sendCandidates.push(key);                                              // 5c
    }
  }
  for (const o of byHandle.values()) {
    if (o.banner && !events[eventKey(o.handle)]) events[eventKey(o.handle)] = newEvent(o, now);
  }
  return { events, sendCandidates };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat: reconcile with per-kind schedule, deadline, and replace rules"
```

---

### Task 6: `isShellPrompt`

**Files:**
- Modify: `watchdog.mjs` (add after `reconcile`)
- Test: `watchdog.test.mjs`

**Triage:** BEHAVIORAL — `isShellPrompt(['john@mac ~ %'])` → `true`; `isShellPrompt(['>'], 'claude')` → `false`; `isShellPrompt(['>'])` → `true`.

**Interfaces:**
- Consumes: `stripAnsi` (Task 1).
- Produces: `isShellPrompt(tail: string[], agentIdentity?: string): boolean`.

- [ ] **Step 1: Write the failing tests**

```js
// --- prompt guard ---

test('isShellPrompt recognises shell prompt endings and fails closed on a bare ">"', () => {
  for (const p of ['john@mac ~ $', '~ %', 'root#', '❯', '➜  repo', 'λ', '❱', 'foo>', 'cmd>  ']) {
    assert.equal(isShellPrompt(['API Error: 529', p, '', '  '], 'claude'), true, p);
  }
  assert.equal(isShellPrompt(['API Error: 529', '\x1b[32m~ %\x1b[0m']), true);
  assert.equal(isShellPrompt(['API Error: 529', '> ']), true);           // no identity ⇒ shell continuation
  assert.equal(isShellPrompt(['API Error: 529', '> '], 'codex'), true);
  assert.equal(isShellPrompt(['API Error: 529', '> '], 'claude'), false);
  assert.equal(isShellPrompt(['API Error: 529', '? for shortcuts']), false);
  assert.equal(isShellPrompt([]), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test 2>&1 | grep -E '^(not ok|# fail)'`
Expected: FAIL — `isShellPrompt` not exported.

- [ ] **Step 3: Implement**

```js
const SHELL_PROMPT_RE = /[$%#❯➜λ❱>]$/;
// True when the last non-empty line of a tail is a shell prompt, i.e. the agent
// has exited and a send would land in the shell (spec §6.4). A bare ">" is
// Claude Code's empty input box only with independent evidence (agentIdentity).
export function isShellPrompt(tail, agentIdentity) {
  const last = tail.map((l) => stripAnsi(l).trim()).filter(Boolean).at(-1);
  if (last === undefined) return false;
  if (last === '>') return agentIdentity !== 'claude';
  return SHELL_PROMPT_RE.test(last);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat: shell-prompt guard"
```

---

### Task 7: Status gate primitives — `statusUrlFor`, `fetchIndicator`, `suppressedByStatus`

**Files:**
- Modify: `watchdog.mjs` (add after `isShellPrompt`)
- Test: `watchdog.test.mjs`

**Triage:** BEHAVIORAL — `statusUrlFor('claude', { WATCHDOG_STATUS_URL_CLAUDE: 'https://evil.example' })` → the real URL plus a warning; `fetchIndicator(url, fakeFetch)` → `'major'`.

**Interfaces:**
- Consumes: nothing.
- Produces: `statusUrlFor(platform, env = process.env): { url: string, warn: string | null }`; `fetchIndicator(url, fetchImpl = globalThis.fetch): Promise<string | null>` (null on any failure, never throws); `suppressedByStatus(indicator): boolean`.

- [ ] **Step 1: Write the failing tests**

```js
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
  assert.equal(await fetchIndicator(CLAUDE_URL, fakeFetch(() => { throw new TypeError('redirect'); }))), null);
});

test('suppressedByStatus only for major/critical', () => {
  assert.equal(suppressedByStatus('major'), true);
  assert.equal(suppressedByStatus('critical'), true);
  for (const v of ['none', 'minor', 'weird', null, undefined]) assert.equal(suppressedByStatus(v), false, String(v));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test 2>&1 | grep -E '^(not ok|# fail)'`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

```js
const STATUS_URLS = Object.freeze({
  claude: 'https://status.claude.com/api/v2/status.json',
  codex: 'https://status.openai.com/api/v2/status.json',
});
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

// Resolve the status page for a platform. The env override exists for the E2E
// stub only and is honoured solely for http(s) loopback URLs (spec safety §5).
export function statusUrlFor(platform, env = process.env) {
  const url = STATUS_URLS[platform];
  const override = env[`WATCHDOG_STATUS_URL_${platform.toUpperCase()}`];
  if (!override) return { url, warn: null };
  try {
    const u = new URL(override);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname)) return { url: override, warn: null };
  } catch { /* fall through */ }
  return { url, warn: `ignoring non-loopback status URL override for ${platform}` };
}

// Fetch a Statuspage indicator. Never throws: any failure is null (fail open).
export async function fetchIndicator(url, fetchImpl = globalThis.fetch) {
  try {
    const r = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const j = await r.json();
    const ind = j?.status?.indicator;
    return typeof ind === 'string' ? ind : null;
  } catch { return null; }
}

export const suppressedByStatus = (indicator) => indicator === 'major' || indicator === 'critical';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat: status-page gate primitives with loopback-only override"
```

---

### Task 8: Injectable `tick()` with the full send gate

**Files:**
- Modify: `watchdog.mjs` (`readTail`, `tick`, `main`)
- Test: `watchdog.test.mjs`

**Triage:** BEHAVIORAL — with a fake orca showing a due outage event and a fake fetch answering `major`, `tick` sends nothing and leaves `attempts` at 0; with `none` it sends `OUTAGE_RESUME_TEXT` once.

**Interfaces:**
- Consumes: everything above.
- Produces: `tick({ dryRun }, deps?)` where `deps = { orca, fetchImpl, env, now, loadState, saveState }`; defaults are the real ones. `readTail(handle, orcaFn)` takes the orca function. Exported for tests: `tick`.

- [ ] **Step 1: Write the failing tests** (add `tick` to the import)

```js
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

test('tick: banner cleared on fresh re-read deletes the event; kind change replaces it; neither sends', async () => {
  const flip = (second) => {
    const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed() });
    let reads = 0; const inner = h.deps.orca;
    h.deps.orca = async (args) => (args[1] === 'read' && ++reads === 2) ? { terminal: { tail: second } } : inner(args);
    return h;
  };
  const gone = flip(['all done', '> ', '? for shortcuts']);
  await tick({ dryRun: false }, gone.deps);
  assert.deepEqual(gone.sent, []); assert.deepEqual(gone.saved(), {});
  const changed = flip([...CLAUDE_BANNER, '? for shortcuts']);
  await tick({ dryRun: false }, changed.deps);
  assert.deepEqual(changed.sent, []);
  assert.equal(changed.saved()[H].kind, 'limit'); assert.equal(changed.saved()[H].attempts, 0);
});

test('tick: shell prompt on the fresh tail deletes the event and sends nothing', async () => {
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed() });
  let reads = 0; const inner = h.deps.orca;
  h.deps.orca = async (args) => (args[1] === 'read' && ++reads === 2) ? { terminal: { tail: [CLAUDE_529, 'john@mac ~ %'] } } : inner(args);
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, []); assert.deepEqual(h.saved(), {});
});

test('tick: one status fetch per platform per tick; claude major does not suppress codex', async () => {
  const H2 = 'term_two';
  const T2 = { ...T, handle: H2, agentIdentity: 'codex' };
  const state = { ...seed(), [H2]: { ...seed()[H], handle: H2, platform: 'codex' } };
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T, T2], state });
  h.deps.fetchImpl = fakeFetch((url) => okJson({ status: { indicator: url === CLAUDE_URL ? 'major' : 'none' } }));
  // codex has no detection row, so give its terminal a claude-shaped tail via a per-handle read
  const inner = h.deps.orca;
  h.deps.orca = async (args) => inner(args);
  await tick({ dryRun: false }, h.deps);
  assert.equal(h.deps.fetchImpl.calls.filter((c) => c.url === CLAUDE_URL).length, 1);
  assert.deepEqual(h.sent, []);            // claude suppressed; codex terminal's tail cannot match (no codex row) ⇒ event deleted, no send
  assert.equal(h.saved()[H2], undefined);
});

test('tick: v1 state file on disk is saved back as v2', async () => {
  const h = harness({ tail: ['nothing here', '> ', '? for shortcuts'], terminals: [T] });
  h.deps.loadState = () => parseStateFile(JSON.stringify({ version: 1, events: {} }));
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.saved(), {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test 2>&1 | grep -E '^(not ok|# fail)'`
Expected: FAIL — `tick` not exported / `deps` ignored.

- [ ] **Step 3: Implement** — replace `readTail`, `tick`, and the `tick` call in `main`:

```js
async function readTail(handle, orcaFn = orca) {
  const r = await orcaFn(['terminal', 'read', '--terminal', handle]);
  return r.terminal?.tail ?? [];
}

const DEFAULT_DEPS = () => ({ orca, fetchImpl: globalThis.fetch, env: process.env, now: () => new Date(), loadState, saveState, log });

export async function tick({ dryRun }, depsIn = {}) {
  const deps = { ...DEFAULT_DEPS(), ...depsIn };
  const log = deps.log;   // shadows the module logger so tests can silence it
  let terminals;
  try {
    terminals = (await deps.orca(['terminal', 'list'])).terminals ?? [];
  } catch (e) {
    if (isUnavailableError(e)) { log('debug', `orca unavailable: ${e.message.split('\n')[0]}`); return; }
    throw e;
  }
  const byHandle = new Map(terminals.map((t) => [t.handle, t]));

  const observations = [];
  const startedAt = Date.now();
  for (const t of terminals.filter((t) => t.connected && t.writable)) {
    if (readBudgetExceeded(startedAt, Date.now())) {
      log('warn', `read budget (${READ_BUDGET_MS / MIN} min) spent; skipping remaining terminals this tick`);
      break;
    }
    try {
      const tail = await readTail(t.handle, deps.orca);
      const banner = detectBanner(tail, inferPlatform(t));
      if (!banner && shouldLog('debug') && hasOutageLine(tail)) {
        log('debug', `outage line without stalled final block on ${t.handle}: ${sanitize(tail.slice(-TAIL_LINES).join(' | '), 600)}`);
      }
      observations.push({ handle: t.handle, banner, platform: inferPlatform(t, banner) });
    } catch (e) {
      log('warn', `read failed for ${t.handle}: ${e.message}`);
    }
  }

  const now = deps.now();
  const state = deps.loadState();
  // Pass every terminal that still exists so reconcile can tell a vanished
  // terminal (delete) from one merely unread this tick (freeze).
  const liveHandles = terminals.map((t) => t.handle);
  const { events, sendCandidates } = reconcile(state, observations, now, liveHandles);

  for (const key of Object.keys(events)) {
    const ev = events[key];
    if (state[key]?.detectedAt === ev.detectedAt) continue;   // not new (also skips untouched events)
    const o = observations.find((x) => x.handle === ev.handle);
    log('info', `detected ${ev.kind} on ${ev.handle} (${ev.platform}, ${o?.banner?.patternId ?? 'limit'}: ${sanitize(o?.banner?.matchedLine ?? ev.bannerText)}), resetAt ${ev.resetAt}`);
    if (ev.kind === 'outage' && shouldLog('debug')) log('debug', `outage window on ${ev.handle}: ${sanitize(o?.window ?? '', 600)}`);
  }

  const indicators = new Map();   // platform → indicator, fetched at most once per tick
  for (const key of sendCandidates) {
    const ev = events[key];
    const sch = SCHEDULE[ev.kind];
    if (dryRun) {
      log('info', `[dry-run] would resume ${ev.handle} (${ev.kind}/${ev.platform}, attempt ${ev.attempts + 1})`);
      console.log(`would resume ${ev.handle} (${ev.kind}/${ev.platform}, attempt ${ev.attempts + 1})`);
      continue;
    }
    if (ev.kind === 'outage' && ev.platform !== 'unknown') {                       // 1. status gate
      if (!indicators.has(ev.platform)) {
        const { url, warn } = statusUrlFor(ev.platform, deps.env);
        if (warn) log('warn', warn);
        indicators.set(ev.platform, await fetchIndicator(url, deps.fetchImpl));
      }
      if (suppressedByStatus(indicators.get(ev.platform))) {
        log('debug', `skip ${ev.handle}: ${ev.platform} status is ${indicators.get(ev.platform)}`); continue;
      }
    }
    try {                                                                            // 2. idle check
      await deps.orca(['terminal', 'wait', '--terminal', ev.handle, '--for', 'tui-idle', '--timeout-ms', '5000']);
    } catch (e) {
      log('info', `skip ${ev.handle}: not idle (${e.message})`); continue;
    }
    let tail;                                                                        // 3. fresh re-read
    try { tail = await readTail(ev.handle, deps.orca); } catch (e) {
      log('warn', `skip ${ev.handle}: re-read failed (${e.message}); event untouched`); continue;
    }
    const term = byHandle.get(ev.handle);
    const fresh = detectBanner(tail, inferPlatform(term));
    if (!fresh) { log('info', `skip ${ev.handle}: banner cleared before send`); delete events[key]; deps.saveState(events); continue; }
    const platform = inferPlatform(term, fresh);
    if (fresh.kind !== ev.kind || (platform !== 'unknown' && platform !== ev.platform)) {
      log('info', `skip ${ev.handle}: banner changed to ${fresh.kind}/${platform} before send; fresh event`);
      events[key] = newEvent({ handle: ev.handle, banner: fresh, platform }, now); deps.saveState(events); continue;
    }
    if (isShellPrompt(tail, term?.agentIdentity)) {                                  // 4. prompt guard
      log('warn', `skip ${ev.handle}: shell prompt on last line, agent has exited; event dropped`);
      delete events[key]; deps.saveState(events); continue;
    }
    ev.attempts += 1;                                                                // 5. persist, then send
    ev.lastAttemptAt = now.toISOString();
    ev.status = 'resumed';
    deps.saveState(events);
    await deps.orca(['terminal', 'send', '--terminal', ev.handle, '--text', sch.resumeText, '--enter']);
    log('info', `resumed ${ev.handle} (${ev.kind}, attempt ${ev.attempts})`);
  }

  for (const [key, ev] of Object.entries(events)) {
    if (ev.status === 'gave_up' && state[key]?.status !== 'gave_up') {
      log('error', `GAVE UP on ${ev.handle} (${ev.kind}) after ${ev.attempts} attempts — banner never cleared`);
    }
  }

  if (!dryRun) deps.saveState(events);
  if (dryRun) console.log(`${Object.keys(events).length} active event(s), ${sendCandidates.length} send candidate(s)`);
}
```

Also, in the observation loop, attach the stripped window for the debug log: change the `observations.push` line to
`observations.push({ handle: t.handle, banner, platform: inferPlatform(t, banner), window: tail.slice(-TAIL_LINES).join(' | ') });`
(`reconcile` ignores extra fields).

In `main()`, `await tick({ dryRun });` is unchanged (defaults apply).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: all PASS.

- [ ] **Step 5: Live dry-run (no sends, no state writes)**

Run: `WATCHDOG_DEBUG=1 node watchdog.mjs --dry-run && tail -5 ~/.local/state/orca-limit-watchdog/watchdog.log`
Expected: `N active event(s), 0 send candidate(s)` (or whatever real limit events exist), no `warn`/`error` lines from this run, no status fetch logged.

- [ ] **Step 6: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat: injectable tick with status gate, prompt guard, and per-kind resume text"
```

---

### Task 9: E2E fixtures — `fake-tui.mjs --outage` and `status-stub.mjs`

**Files:**
- Modify: `e2e/fake-tui.mjs`
- Create: `e2e/status-stub.mjs`
- Test: `watchdog.test.mjs` (stub behaviour)

**Triage:** BEHAVIORAL — `node e2e/fake-tui.mjs out.txt --outage` prints an `API Error: 529 …` banner; the stub answers `major` then `none` on successive requests.

**Interfaces:**
- Consumes: nothing.
- Produces: `node e2e/fake-tui.mjs <received-file> [<reset-time-text> | --outage]`; `node e2e/status-stub.mjs <port> <indicator,indicator,…>` (last value repeats); `status-stub.mjs` exports `startStub(port, sequence): Promise<{ close() }>`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 2>&1 | grep -E '^(not ok|# fail)'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`e2e/status-stub.mjs`:

```js
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
```

`e2e/fake-tui.mjs` (whole file):

```js
#!/usr/bin/env node
// Fake paused agent TUI for E2E testing. Prints a Claude-style limit banner
// (default) or API-outage banner (--outage), then appends anything it receives
// on stdin to the given file. The trailing "? for shortcuts" line mirrors
// Claude Code's chrome and satisfies the watchdog's final-block + prompt guard.
// Usage: node fake-tui.mjs <received-file> <reset-time-text e.g. "9:05am" | --outage>
import fs from 'node:fs';

const [outFile, mode] = process.argv.slice(2);
console.log('─'.repeat(60));
if (mode === '--outage') {
  console.log('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
} else {
  console.log(`Claude usage limit reached. Your limit will reset at ${mode}.`);
}
console.log('> ');
console.log('? for shortcuts');

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => fs.appendFileSync(outFile, d));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test && node e2e/fake-tui.mjs /dev/null --outage </dev/null | head -3`
Expected: all PASS; the fake TUI prints the rule, the API Error line, `> `.

- [ ] **Step 5: Commit**

```bash
git add e2e/fake-tui.mjs e2e/status-stub.mjs watchdog.test.mjs
git commit -m "test(e2e): outage mode for fake TUI and loopback status stub"
```

---

### Task 10: README

**Files:**
- Modify: `README.md`
- Covered by: n/a (docs)

**Triage:** MECHANICAL — prose only; `node --test` before and after proves nothing else moved.

- [ ] **Step 1: Confirm baseline green**

Run: `node --test`
Expected: PASS.

- [ ] **Step 2: Make the change** — replace the "How it works" section and add an "Outages" section and an E2E recipe:

```markdown
## How it works

launchd runs `watchdog.mjs` every 5 minutes. Each tick reads every connected
Orca terminal's tail and looks for one of two banners in the last 15 lines:

- **Rate limit** (limit phrase + reset phrase): parses the stated reset time
  and, once it has passed and the terminal is idle with the banner still
  showing, sends
  > Session rate limit has reset. Resume where you left off.

  Normally one send per event; up to two retries 30 min apart, then it gives
  up loudly in the log.
- **API outage** (Claude Code's own `API Error: 5xx / Connection error /
  overloaded_error` line as the final stalled banner, on a terminal Orca
  identifies as `claude`): waits 10 min, then sends
  > The API outage appears to be over. Resume where you left off.

  Up to 6 sends 30 min apart, hard stop 24 h after detection. Before each
  send it checks `status.claude.com`; a `major`/`critical` incident holds the
  send (without using an attempt). Any status-page problem fails open.
  Codex outage detection is not enabled yet (no captured transcript).

Both kinds refuse to send when the terminal's last line is a shell prompt
(the agent exited). Network access is limited to the two status pages and
happens only when an outage send is due; `WATCHDOG_STATUS_URL_CLAUDE` /
`_CODEX` override them for tests and are honoured only for loopback URLs.
```

Append under "## Test":

```markdown
E2E (scratch Orca terminal, never a live agent):

```bash
node e2e/status-stub.mjs 8123 major,none &                 # tick 1 held, tick 2 sends
orca terminal create --command 'node e2e/fake-tui.mjs /tmp/recv.txt --outage'   # note the handle
# preseed a due outage event for that handle (resetAt in the past), then:
WATCHDOG_STATUS_URL_CLAUDE=http://127.0.0.1:8123/api/v2/status.json node watchdog.mjs --once
WATCHDOG_STATUS_URL_CLAUDE=http://127.0.0.1:8123/api/v2/status.json node watchdog.mjs --once
cat /tmp/recv.txt   # exactly one outage resume line
```
```

- [ ] **Step 3: Verify suite still green**

Run: `node --test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: describe outage resume, status gate, and E2E recipe"
```

---

## Self-review (done while writing)

- **Spec coverage:** §1 detection → Task 2; §2 platform → Task 3; §3 schema/validation/migration → Task 4; §4 schedule → Task 4; §5 reconcile order → Task 5; §6 send gate (status, idle, re-read semantics, prompt guard, persist-then-send) → Tasks 6–8; §7 `--status` v2 and dry-run columns → Tasks 4 and 8; safety §5 loopback override + `redirect: 'error'` → Task 7; safety §6 sanitizer everywhere → Tasks 1, 2, 8; E2E fixtures → Task 9; README → Task 10. Spec test list "loopback stub answering 302 is not followed" is covered by `fetchIndicator` passing `redirect: 'error'` (asserted in Task 7) — Node's fetch then throws before any second request, so no second listener is needed.
- **Placeholders:** none.
- **Type consistency:** observation shape `{ handle, banner, platform }` (Tasks 5, 8); banner shape `{ kind, bannerText, matchedLine, patternId }` (Tasks 2, 3, 4, 8); `SCHEDULE` field names used identically in Tasks 4, 5, 8; `newEvent(o, now)` in Tasks 4, 5, 8; `statusUrlFor` returns `{ url, warn }` (Tasks 7, 8).
- **Codex note in Task 8's two-platform test:** the codex terminal's tail cannot match (no codex row), so its stored event is deleted by reconcile rule 3 — the assertion documents that, and the claude fetch-count assertion is the real point.
