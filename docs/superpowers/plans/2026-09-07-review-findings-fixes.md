# Review Findings Fixes (DOG-3 … DOG-15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the thirteen findings of the 2026-09-07 whole-project review (Linear DOG-3 … DOG-15) in three PRs without changing the watchdog's architecture.

**Architecture:** All changes are local edits to `watchdog.mjs` (pure functions and the `tick` loop), `install.sh`, and `watchdog.test.mjs`, in the existing style: exported pure functions unit-tested directly, `tick` tested through the `harness()` fake-orca helper already in the test file. Three PRs, each an independent branch from `main`: **PR 1 detection and timing** (Tasks 1–4), **PR 2 send safety** (Tasks 5–8), **PR 3 hygiene** (Tasks 9–13).

**Tech Stack:** Node ≥ 20 built-ins only (`node:test`, `node:assert/strict`, `node:child_process`, `node:fs`), bash. No package.json, no dependencies.

**Spec:** The findings list in Linear DOG-3 … DOG-15 (each issue carries file:line, verified failure scenario, and fix). Original behaviour specs: `docs/superpowers/specs/2026-07-23-orca-limit-watchdog-design.md` and `docs/superpowers/specs/2026-09-07-outage-resume-design.md`.

## Global Constraints

- **Zero dependencies, system Node only.** Never add a package.json or `node_modules`. (CLAUDE.md "Build / run / test")
- **Never run `install.sh`, `uninstall.sh`, or `launchctl` from the worktree.** Deploy is the orchestrator's post-merge step from the main checkout. (CLAUDE.md "Safety")
- **Never test against live Orca terminals.** Only `node --test`, `node watchdog.mjs --dry-run`, and the fakes in `e2e/`. Never call `orca terminal send`. (CLAUDE.md "Safety")
- **Keep every existing export and its signature.** `watchdog.test.mjs` imports them by name.
- **Full gate before each commit:** `bash scripts/orca-setup.sh` (node floor, syntax checks, `node --test`) must exit 0.
- **Commit per task; never push.** The orchestrator pushes and opens PRs. Commit trailers: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **`watchdog.mjs` and `install.sh` are invariant files.** Every PR body carries `Review skipped: opus-implementer` (MODELS.md: the implementer is the code-reviewer model) and the orchestrator still runs the required checks.
- Line references below are to `main` at commit `ebe4728`; re-locate by content if they drift.

---

## PR 1 — detection and timing (branch `fix/detection-timing`, DOG-3 DOG-4 DOG-5 DOG-8)

### Task 1: Require limit + reached on one line; ignore the Claude Code usage footer (DOG-3)

**Files:**
- Modify: `watchdog.mjs:43-46` (regexes) and `watchdog.mjs:108-123` (limit rule in `detectBanner`)
- Test: `watchdog.test.mjs` (after the `'no match on ordinary code/log output mentioning limits'` test, ~line 61)

**Triage:** BEHAVIORAL — `detectBanner(['error: rate limit exceeded (HTTP 429)', FOOTER, '> ', '? for shortcuts'], 'claude')` returns a limit banner today; after this task it returns `null`.

**Interfaces:**
- Consumes: `detectBanner(lines, platform)` (existing export), `LIMIT_RE`, `REACHED_RE`, `RESET_RE`, `VETO_RE`, `sanitize`.
- Produces: unchanged `detectBanner` signature and return shape `{ kind, bannerText, matchedLine, patternId }`. New module constant `FOOTER_RE`. Footer lines are excluded from `bannerText`, which Task 2 relies on (the footer's "resets in 3h 8m" must not feed `parseResetTime`).

- [ ] **Step 1: Write the failing tests**

Add to `watchdog.test.mjs` right after the `'no match on ordinary code/log output mentioning limits'` test:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern='DOG-3|share a line|next to the footer'`
Expected: the first two FAIL (a banner object is returned instead of `null`); the third fails on `doesNotMatch` (bannerText contains `3h 8m`).

- [ ] **Step 3: Implement**

In `watchdog.mjs`, after `const VETO_RE = …;` (line 46) add:

```js
// Claude Code's persistent status footer ("Context … │ Usage … (resets in 3h 8m)")
// is on screen in every Claude terminal and always satisfies RESET_RE. It is
// chrome, never evidence: dropped before the limit rule runs.
const FOOTER_RE = /│\s*Usage\s/;
```

Replace the limit rule (lines 115-123) with:

```js
  const kept = window.filter((l) => !VETO_RE.test(l) && !FOOTER_RE.test(l));
  const text = kept.join('\n');
  let limit = null;
  // The limit phrase and the reached word must sit on ONE line: a banner says
  // "usage limit reached"; prose and logs scatter the words across lines.
  const reachedLine = (l) => LIMIT_RE.test(l) && REACHED_RE.test(l);
  if (kept.some(reachedLine) && RESET_RE.test(text)) {
    const isRelevant = (l) => !VETO_RE.test(l) && !FOOTER_RE.test(l) && (LIMIT_RE.test(l) || RESET_RE.test(l));
    const l = lastIndex(window, isRelevant);
    limit = { kind: 'limit', bannerText: sanitize(window.filter(isRelevant).join(' | '), 600),
      matchedLine: window[l], patternId: 'limit', index: l };
  }
```

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: all pass (the three Claude/Codex/Gemini fixtures each carry limit + reached on one line, so they still match).

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "fix(detect): ignore the Claude usage footer; require limit+reached on one line (DOG-3)"
```

### Task 2: Parse compact relative resets like "in 3h 8m" (DOG-4)

**Files:**
- Modify: `watchdog.mjs:200` (`relHM` regex in `parseResetTime`)
- Test: `watchdog.test.mjs` (in the `parseResetTime` section; search for `test('parses relative`)

**Triage:** BEHAVIORAL — `parseResetTime('resets in 3h 8m', now)` returns `null` today (caller falls back to +1 h); after this task it returns `now + 188 min`.

**Interfaces:**
- Consumes: `parseResetTime(text, now)` (existing export).
- Produces: same signature; additionally recognises `Nh`, `Nh Mm`, `N hr`, `N hrs`.

- [ ] **Step 1: Write the failing test**

```js
test('parses compact relative resets "in 3h 8m", "in 2h", "in 1hr 5m" (DOG-4)', () => {
  const now = new Date('2026-09-07T10:00:00');
  assert.equal(parseResetTime('Usage 41% (resets in 3h 8m)', now).getTime(), now.getTime() + 188 * 60_000);
  assert.equal(parseResetTime('resets in 2h', now).getTime(), now.getTime() + 120 * 60_000);
  assert.equal(parseResetTime('try again in 1hr 5m', now).getTime(), now.getTime() + 65 * 60_000);
  assert.equal(parseResetTime('resets in 45m', now).getTime(), now.getTime() + 45 * 60_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --test-name-pattern='DOG-4'`
Expected: FAIL — `TypeError: Cannot read properties of null (reading 'getTime')` on the first assertion.

- [ ] **Step 3: Implement**

Change line 200 from

```js
  const relHM = text.match(/\bin\s+(\d+)\s*h(?:ou)?rs?\b(?:\s*(?:and\s+)?(\d+)\s*m(?:in(?:ute)?s?)?)?/i);
```

to

```js
  // "in 2 hours 15 minutes", "in 2h 30m", "in 3h", "in 1hr 5m"
  const relHM = text.match(/\bin\s+(\d+)\s*h(?:(?:ou)?rs?)?\b(?:\s*(?:and\s+)?(\d+)\s*m(?:in(?:ute)?s?)?)?/i);
```

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "fix(time): parse compact relative resets like 'in 3h 8m' (DOG-4)"
```

### Task 3: Date-qualified and multi-day resets (DOG-5)

**Files:**
- Modify: `watchdog.mjs:199-224` (`parseResetTime`)
- Test: `watchdog.test.mjs` (`parseResetTime` section)

**Triage:** BEHAVIORAL — `parseResetTime('resets in 3 days', now)` is `null` today and `'resets Sep 12 at 3pm'` is today 15:00; after this task they return `now + 3 days` and Sep 12 15:00.

**Interfaces:**
- Consumes: `parseResetTime`, `GRACE_PAST_MS`, `MIN`.
- Produces: same signature. Order of precedence inside the function becomes: `in N days` → `in Nh Mm` → `in Nm` → `Month D [time]` → time-of-day only.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='DOG-5'`
Expected: FAIL on the first assertion (`null.getTime`).

- [ ] **Step 3: Implement**

Replace the whole `parseResetTime` function (lines 199-224) with:

```js
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i;

// Reads a clock time ("3pm", "3:30 p.m.", "14:00") out of text. Returns
// { h, m } or null.
function parseClock(text) {
  const t12 = text.match(/\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?\b/i);
  if (t12) return { h: Number(t12[1]) % 12 + (t12[3].toLowerCase() === 'p' ? 12 : 0), m: Number(t12[2] || 0) };
  const t24 = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (t24) return { h: Number(t24[1]), m: Number(t24[2]) };
  return null;
}

export function parseResetTime(text, now) {
  // "in 3 days" (weekly limits) — a day count, never a clock time.
  const relD = text.match(/\bin\s+(\d+)\s+days?\b/i);
  if (relD) return new Date(now.getTime() + Number(relD[1]) * 24 * 60 * MIN);

  // "in 2 hours 15 minutes", "in 2h 30m", "in 3h", "in 1hr 5m"
  const relHM = text.match(/\bin\s+(\d+)\s*h(?:(?:ou)?rs?)?\b(?:\s*(?:and\s+)?(\d+)\s*m(?:in(?:ute)?s?)?)?/i);
  if (relHM) {
    const mins = Number(relHM[1]) * 60 + Number(relHM[2] || 0);
    return new Date(now.getTime() + mins * MIN);
  }
  const relM = text.match(/\bin\s+(\d+)\s*m(?:in(?:ute)?s?)?\b/i);
  if (relM) return new Date(now.getTime() + Number(relM[1]) * MIN);

  const clock = parseClock(text);

  // "Sep 12 at 3pm", "September 12, 09:30", "on Sep 12" (midnight when no time)
  const md = text.match(MONTH_DAY_RE);
  if (md) {
    const month = MONTHS.indexOf(md[1].slice(0, 3).toLowerCase());
    const candidate = new Date(now);
    candidate.setMonth(month, Number(md[2]));
    candidate.setHours(clock?.h ?? 0, clock?.m ?? 0, 0, 0);
    if (candidate <= now && now - candidate > GRACE_PAST_MS) candidate.setFullYear(candidate.getFullYear() + 1);
    return candidate;
  }

  if (!clock) return null;
  const candidate = new Date(now);
  candidate.setHours(clock.h, clock.m, 0, 0);
  if (candidate <= now && now - candidate > GRACE_PAST_MS) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}
```

Delete the old `parseResetTime` entirely (the new one replaces lines 199-224; the Task 2 regex is carried over unchanged).

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: all pass, including the existing 12h/24h/rollover tests (they take the last branch, whose logic is unchanged).

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "fix(time): parse 'in N days' and month-day resets instead of defaulting to today (DOG-5)"
```

### Task 4: Strip two-byte ANSI escapes (DOG-8)

**Files:**
- Modify: `watchdog.mjs:48-49` (`ANSI_RE`)
- Test: `watchdog.test.mjs` (next to `'stripAnsi removes CSI, OSC and control bytes'`, ~line 707)

**Triage:** BEHAVIORAL — `stripAnsi('? for shortcuts\x1b>')` returns `'? for shortcuts>'` today and `isShellPrompt` on that tail is `true`; after this task they return `'? for shortcuts'` and `false`.

**Interfaces:**
- Consumes: `stripAnsi`, `isShellPrompt` (existing exports).
- Produces: unchanged signatures.

- [ ] **Step 1: Write the failing test**

```js
test('stripAnsi removes two-byte escapes so a stray ">" cannot fake a shell prompt (DOG-8)', () => {
  assert.equal(stripAnsi('? for shortcuts\x1b>'), '? for shortcuts');
  assert.equal(stripAnsi('\x1b=\x1b(Bhello\x1b7\x1b8'), 'hello');
  assert.equal(isShellPrompt(['API Error: 529', '? for shortcuts\x1b>'], 'claude'), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='DOG-8'`
Expected: FAIL — `'? for shortcuts>' !== '? for shortcuts'`.

- [ ] **Step 3: Implement**

Replace lines 48-49 with:

```js
// CSI (ESC [ … final), OSC (ESC ] … BEL|ST), charset selects (ESC ( B),
// two-byte escapes (ESC = > 7 8 c D E H M N O Z), and stray C0/DEL bytes.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78cDEHMNOZ]|[\x00-\x08\x0b-\x1f\x7f]/g;
```

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Commit, then run the PR gate**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "fix(ansi): strip two-byte escapes so a stray '>' cannot trip the prompt veto (DOG-8)"
bash scripts/orca-setup.sh   # must exit 0; this is PR 1's gate
```

---

## PR 2 — send safety (branch `fix/send-safety`, DOG-7 DOG-9 DOG-10 DOG-11)

Branch from `main` after PR 1 merges (`git fetch origin && git checkout -b fix/send-safety origin/main`).

### Task 5: Skip the send when the input box holds a draft (DOG-7)

**Files:**
- Modify: `watchdog.mjs:270-279` (add `isInputOccupied` next to `isShellPrompt`) and `watchdog.mjs:475-478` (send gate step 4)
- Test: `watchdog.test.mjs` (tick section, after `'tick: dry-run makes no sends and no network calls'`)

**Triage:** BEHAVIORAL — with tail `[CLAUDE_529, '', '> my half typed draft', '? for shortcuts']` and a due outage event, `tick` sends today; after this task it sends nothing and leaves the event untouched.

**Interfaces:**
- Consumes: `harness()`, `seed()`, `T`, `CLAUDE_529`, `OUTAGE_RESUME_TEXT` from the test file; `stripAnsi`.
- Produces: new export `isInputOccupied(tail) → boolean`.

- [ ] **Step 1: Write the failing tests**

Add `isInputOccupied` to the `import { isShellPrompt } from './watchdog.mjs';` line, then:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='isInputOccupied|DOG-7'`
Expected: the first FAILS at import (`isInputOccupied` is not exported); the second FAILS with `sent` equal to `[OUTAGE_RESUME_TEXT]`.

- [ ] **Step 3: Implement**

After `isShellPrompt` (line 279) add:

```js
// True when Claude Code's input box (a line starting with ">") already holds
// text. A send would be appended to that draft and --enter would submit both,
// so the tick skips and the event stays as it is (spec §6.4 spirit).
const INPUT_DRAFT_RE = /^>\s+\S/;
export function isInputOccupied(tail) {
  return tail.map((l) => stripAnsi(l).trimEnd()).some((l) => INPUT_DRAFT_RE.test(l));
}
```

In `tick`, after the prompt guard block (step 4, ends at line 478) and before `ev.attempts += 1;`, insert:

```js
    if (isInputOccupied(tail)) {                                                     // 4b. draft guard
      log('info', `skip ${ev.handle}: input box holds a draft; event untouched`); continue;
    }
```

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: all pass. (`OUTAGE_TAIL` uses `'> '`, which trims to `'>'` and is not a draft.)

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "fix(send): never type into an input box that already holds a draft (DOG-7)"
```

### Task 6: A failed send must not abort the tick (DOG-10)

**Files:**
- Modify: `watchdog.mjs:483-484` (the send call)
- Test: `watchdog.test.mjs` (tick section)

**Triage:** BEHAVIORAL — two due terminals where the first send throws: today the second is never sent and `tick` rejects; after this task the second is sent, the failure is logged, and `tick` resolves.

**Interfaces:**
- Consumes: `tick`, `seed`, `OUTAGE_TAIL`, `okJson`, `fakeFetch`, `at`, `H`.
- Produces: no new exports. Log line format `send failed for <handle> (attempt N): <message>`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='DOG-10'`
Expected: FAIL — `tick` rejects with `Command failed: agent_prompt_stalled`.

- [ ] **Step 3: Implement**

Replace lines 483-484:

```js
    await deps.orca(['terminal', 'send', '--terminal', ev.handle, '--text', sch.resumeText, '--enter']);
    log('info', `resumed ${ev.handle} (${ev.kind}, attempt ${ev.attempts})`);
```

with:

```js
    try {
      await deps.orca(['terminal', 'send', '--terminal', ev.handle, '--text', sch.resumeText, '--enter']);
      log('info', `resumed ${ev.handle} (${ev.kind}, attempt ${ev.attempts})`);
    } catch (e) {
      // The attempt is already persisted (no double-send on retry); the other
      // candidates and the GAVE UP pass must still run this tick.
      log('warn', `send failed for ${ev.handle} (attempt ${ev.attempts}): ${sanitize(e.message)}`);
    }
```

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "fix(send): a failed terminal send no longer aborts the rest of the tick (DOG-10)"
```

### Task 7: Read terminals with bounded concurrency (DOG-9)

**Files:**
- Modify: `watchdog.mjs:405-422` (the read loop in `tick`)
- Test: `watchdog.test.mjs` (tick section)

**Triage:** BEHAVIORAL — with 8 terminals whose reads each take 50 ms, `tick` takes ≥ 400 ms today; after this task it takes about 100 ms and still produces 8 observations.

**Interfaces:**
- Consumes: `readTail`, `readBudgetExceeded`, `detectBanner`, `inferPlatform`, `hasOutageLine`, `sanitize`.
- Produces: module constant `READ_CONCURRENCY = 4`. `observations` order is no longer terminal-list order; `reconcile` is order-independent (it builds a `Map` by handle).

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='DOG-9'`
Expected: FAIL — `peak in-flight reads 1`.

- [ ] **Step 3: Implement**

After `const READ_BUDGET_MS = …;` (line 39) add:

```js
const READ_CONCURRENCY = 4;        // parallel `terminal read`s per tick; orca serialises beyond a few
```

Replace the read loop (lines 405-422) with:

```js
  const observations = [];
  const startedAt = Date.now();
  const queue = terminals.filter((t) => t.connected && t.writable);
  let budgetSpent = false;
  const worker = async () => {
    while (queue.length > 0) {
      if (readBudgetExceeded(startedAt, Date.now())) { budgetSpent = true; return; }
      const t = queue.shift();
      try {
        const tail = await readTail(t.handle, deps.orca);
        const banner = detectBanner(tail, inferPlatform(t));
        if (!banner && shouldLog('debug') && hasOutageLine(tail)) {
          log('debug', `outage-pattern line present but not detected (platform gate, retry veto, or final block) on ${t.handle}: ${sanitize(tail.slice(-TAIL_LINES).join(' | '), 600)}`);
        }
        observations.push({ handle: t.handle, banner, platform: inferPlatform(t, banner), window: tail.slice(-TAIL_LINES).join(' | ') });
      } catch (e) {
        log('warn', `read failed for ${t.handle}: ${sanitize(e.message)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, worker));
  if (budgetSpent) log('warn', `read budget (${READ_BUDGET_MS / MIN} min) spent; skipped ${queue.length} terminal(s) this tick`);
```

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: all pass, including `'read loop stops once the tick budget is spent'` (it tests `readBudgetExceeded` directly).

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "perf(tick): read terminals four at a time instead of sequentially (DOG-9)"
```

### Task 8: Keep attempts across a one-tick banner gap (DOG-11)

**Files:**
- Modify: `watchdog.mjs:166-181` (`validateEvent`), `watchdog.mjs:242-249` (reconcile rules 3–4), `watchdog.mjs:469` (fresh re-read "banner cleared" branch)
- Modify: `docs/superpowers/specs/2026-09-07-outage-resume-design.md` (append an amendment)
- Test: `watchdog.test.mjs` (reconcile section; search for `test('reconcile`)

**Triage:** BEHAVIORAL — an event with `attempts: 2` whose banner is absent for one tick is deleted today (next detection restarts at 0); after this task it survives one absent tick with `clearedAt` set and is deleted only on the second consecutive absent tick.

**Interfaces:**
- Consumes: `reconcile(state, observations, now, liveHandles)`, `validateEvent`, `newEvent`, `isIso`.
- Produces: optional event field `clearedAt: ISO string` (absent on every event that saw its banner last tick). `validateEvent` accepts it absent or ISO. No schema version bump: readers ignore unknown fields and v2 files without it stay valid.

- [ ] **Step 1: Write the failing tests**

```js
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
```

(`at`, `H`, `BANNER` are helpers already defined in the reconcile section of the test file; reuse them. If a name differs there, use the existing one.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='DOG-11|clearedAt'`
Expected: the first FAILS (`kept after one absent tick`); the second FAILS on `clearedAt` still present; the third FAILS on the garbage case returning `null`.

- [ ] **Step 3: Implement**

In `validateEvent`, before `return null;` (line 180) add:

```js
  if (ev.clearedAt !== undefined && !isIso(ev.clearedAt)) return 'clearedAt: not a timestamp';
```

In `reconcile`, replace rule 3 (line 246):

```js
    if (!o.banner) { delete events[key]; continue; }                         // 3. banner cleared
```

with:

```js
    if (!o.banner) {                                                         // 3. banner cleared
      // One absent read is not proof: the agent scrolls, orca returns a short
      // tail, a redraw lands mid-read. Deleting on the first miss resets
      // attempts to 0 and lets a flickering banner be sent to without bound.
      if (ev.clearedAt) { delete events[key]; continue; }                    //    3a. second consecutive miss
      ev.clearedAt = now.toISOString(); continue;                            //    3b. first miss: hold
    }
    delete ev.clearedAt;                                                     //    banner present again
```

In `tick`, replace line 469:

```js
    if (!fresh) { log('info', `skip ${ev.handle}: banner cleared before send`); delete events[key]; deps.saveState(events); continue; }
```

with:

```js
    if (!fresh) {   // same hold as reconcile rule 3b: one miss is not proof
      log('info', `skip ${ev.handle}: banner cleared before send; holding`);
      ev.clearedAt = now.toISOString(); deps.saveState(events); continue;
    }
```

Append to `docs/superpowers/specs/2026-09-07-outage-resume-design.md`:

```markdown

## Amendment 2026-09-07 (DOG-11): banner-cleared hold

Rule 3 ("banner cleared → delete") now requires the banner to be absent on
two consecutive ticks. The first miss stamps `clearedAt` on the event and
freezes it; a second miss deletes it; the banner reappearing removes
`clearedAt` and keeps `attempts`. This closes the loophole where a
flickering read reset the retry cap every 30 minutes.
```

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: all pass. Two existing tests assert deletion on a single cleared tick (search for `banner cleared` in the reconcile and tick sections): update each to run reconcile/tick twice with the banner absent and assert deletion after the second, keeping their other assertions.

- [ ] **Step 5: Commit, then run the PR gate**

```bash
git add watchdog.mjs watchdog.test.mjs docs/superpowers/specs/2026-09-07-outage-resume-design.md
git commit -m "fix(reconcile): hold an event for one absent tick so attempts survive a flicker (DOG-11)"
bash scripts/orca-setup.sh   # PR 2 gate
```

---

## PR 3 — hygiene (branch `fix/hygiene`, DOG-6 DOG-12 DOG-13 DOG-14 DOG-15)

Branch from `main` after PR 2 merges.

### Task 9: Entry guard works through a symlinked path (DOG-6)

**Files:**
- Modify: `watchdog.mjs:5-9` (imports) and `watchdog.mjs:526` (entry guard); `install.sh:5`
- Test: `watchdog.test.mjs` (end of file)

**Triage:** BEHAVIORAL — `node <symlink-to-repo>/watchdog.mjs --status` prints nothing today; after this task it prints `no active events`.

**Interfaces:**
- Consumes: `node:fs`, `node:url`.
- Produces: none.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='DOG-6'`
Expected: FAIL — `'' !== 'no active events'`.

- [ ] **Step 3: Implement**

Add to the imports (after line 9): `import { pathToFileURL } from 'node:url';`

Replace line 526:

```js
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
```

with:

```js
// import.meta.url is the real path; argv[1] may be a symlink. Compare real to real,
// through pathToFileURL so spaces and unicode are percent-encoded on both sides.
const entryIsThisFile = (() => {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (entryIsThisFile) {
```

In `install.sh` line 5, change `pwd` to `pwd -P`:

```bash
REPO="$(cd "$(dirname "$0")" && pwd -P)"
```

- [ ] **Step 4: Run the full suite**

Run: `node --test && bash -n install.sh`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs install.sh
git commit -m "fix(cli): run main() when invoked through a symlink; install.sh resolves the real repo path (DOG-6)"
```

### Task 10: Redaction leaves paths alone (DOG-12)

**Files:**
- Modify: `watchdog.mjs:52-62` (`SECRET_RES` last pattern and comment)
- Test: `watchdog.test.mjs` (next to `'sanitize leaves ordinary text and short hashes alone'`)

**Triage:** BEHAVIORAL — `sanitize('/Users/john/Projects/orca-limit-watchdog/watchdog.mjs')` returns `'[redacted].mjs'` today; after this task the path is returned unchanged, while a 40-char token is still redacted.

**Interfaces:**
- Consumes: `sanitize`.
- Produces: unchanged signature.

- [ ] **Step 1: Write the failing test**

```js
test('sanitize keeps filesystem paths but still redacts long opaque tokens (DOG-12)', () => {
  const p = '/Users/john/Projects/orca-limit-watchdog/watchdog.mjs';
  assert.equal(sanitize(`see ${p} line 3`), `see ${p} line 3`);
  assert.equal(sanitize('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc'), 'token [redacted]');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='DOG-12'`
Expected: FAIL — path collapsed to `[redacted].mjs`.

- [ ] **Step 3: Implement**

Replace the last entry of `SECRET_RES` (line 61) and its comment (lines 52-54):

```js
// Credential shapes redacted from every logged terminal fragment. The last
// pattern (32+ opaque chars, no "/") also catches raw JWT/API-key material we
// have no prefix for; ordinary words and short git hashes are far below that
// length, and "/" is excluded so a long path is not swallowed as one run.
const SECRET_RES = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bBearer\s+\S+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(?<![/\w])[A-Za-z0-9+=_-]{32,}(?![/\w])/g,
];
```

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: all pass, including `'sanitize redacts credentials and long opaque runs'` (its fixtures contain no `/`).

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "fix(log): stop redacting ordinary paths as opaque runs (DOG-12)"
```

### Task 11: Sanitize CLI error messages before logging (DOG-13)

**Files:**
- Modify: `watchdog.mjs:461`, `watchdog.mjs:465`, `watchdog.mjs:519` (the read-loop and send-catch lines were already wrapped in Tasks 6 and 7)
- Test: `watchdog.test.mjs` (tick section)

**Triage:** BEHAVIORAL — an orca error whose message spans two lines produces a two-line log entry today; after this task every log entry is a single line.

**Interfaces:**
- Consumes: `sanitize`, `tick`, `harness`-style deps.
- Produces: none.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='DOG-13'`
Expected: FAIL on `doesNotMatch(/\n/)`.

- [ ] **Step 3: Implement**

Wrap each remaining raw `${e.message}` in `sanitize(...)`:

- line 461: `log('info', \`skip ${ev.handle}: not idle (${sanitize(e.message)})\`); continue;`
- line 465: `log('warn', \`skip ${ev.handle}: re-read failed (${sanitize(e.message)}); event untouched\`); continue;`
- line 519 (in `main`): `log('error', \`tick failed: ${sanitize(e.message)}\`);`
- line 400 (`orca unavailable`): already takes only the first line; leave it.

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "fix(log): sanitize orca error messages so a CLI error cannot inject log lines (DOG-13)"
```

### Task 12: Remove the unreachable platform check (DOG-14)

**Files:**
- Modify: `watchdog.mjs:448`
- Covered by: `watchdog.test.mjs` tick section (`'tick: due outage event, status none ⇒ …'`, `'tick: limit events use the limit text and never touch the network'`, `'tick: codex terminal with a Claude-shaped tail cannot become a candidate'`)

**Triage:** MECHANICAL — `validateEvent` (line 171) already rejects outage events with platform `unknown`, and `reconcile` builds events only from `newEvent`, which for outages always carries the terminal's inferred platform; no input reaches line 448 with `kind === 'outage' && platform === 'unknown'`. The listed tests pin the status-gate behaviour on both sides.

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing.

- [ ] **Step 1: Confirm baseline green**

Run: `node --test`
Expected: PASS.

- [ ] **Step 2: Make the change**

Line 448, before → after:

```js
    if (ev.kind === 'outage' && ev.platform !== 'unknown') {                       // 1. status gate
```
```js
    if (ev.kind === 'outage') {   // 1. status gate (validateEvent guarantees a known platform)
```

- [ ] **Step 3: Verify suite still green**

Run: `node --test && node --check watchdog.mjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add watchdog.mjs
git commit -m "refactor(tick): drop the unreachable unknown-platform check on the status gate (DOG-14)"
```

### Task 13: install.sh survives `|` and `&` in paths (DOG-15)

**Files:**
- Modify: `install.sh:15-17`

**Triage:** BEHAVIORAL — rendering the plist with `REPO='/tmp/a|b'` corrupts the sed expression today; after this task the plist contains the literal path. Verified by a rendering check in the test file (no launchctl involved).

**Interfaces:**
- Consumes: `com.john.orca-limit-watchdog.plist` placeholders `__NODE__`, `__REPO__`, `__STATE__`.
- Produces: `render_plist SRC DST` bash function inside `install.sh` (not sourced elsewhere; the test replicates the call by running `bash -c` with the function extracted).

- [ ] **Step 1: Write the failing test**

```js
test('install.sh renders the plist without sed-delimiter corruption for paths containing | and & (DOG-15)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-plist-'));
  const out = path.join(tmp, 'out.plist');
  const script = `
    set -euo pipefail
    NODE_BIN='/opt/a|b/node'; REPO='/Users/x&y/repo'; STATE='/tmp/state'
    $(sed -n '/^render_plist()/,/^}/p' install.sh)
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
```

(`fs`, `os`, `path`, `pExecFile` were imported in Task 9.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='DOG-15'`
Expected: FAIL — `render_plist: command not found` (the function does not exist yet).

- [ ] **Step 3: Implement**

In `install.sh`, replace lines 15-17:

```bash
mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__REPO__|$REPO|g" -e "s|__STATE__|$STATE|g" \
  "$REPO/$LABEL.plist" > "$PLIST_DST"
```

with:

```bash
# Substitute the plist placeholders with plain string replacement (no sed
# delimiter or backreference surprises when a path contains | & or \).
render_plist() {
  NODE_BIN="$NODE_BIN" REPO="$REPO" STATE="$STATE" python3 - "$1" "$2" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
for key, env in (("__NODE__", "NODE_BIN"), ("__REPO__", "REPO"), ("__STATE__", "STATE")):
    text = text.replace(key, os.environ[env])
open(dst, "w", encoding="utf-8").write(text)
PY
}

mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
render_plist "$REPO/$LABEL.plist" "$PLIST_DST"
```

`python3` is present on every macOS with the command line tools, which `install.sh` already assumes for `launchctl` targets, and CI already validates the plist with `python3 -c plistlib`.

- [ ] **Step 4: Run the full suite**

Run: `node --test && bash -n install.sh`
Expected: all pass.

- [ ] **Step 5: Commit, then run the PR gate**

```bash
git add install.sh watchdog.test.mjs
git commit -m "fix(install): render the plist by string replacement, not sed (DOG-15)"
bash scripts/orca-setup.sh   # PR 3 gate
```

---

## Orchestrator steps per PR (not for the implementer)

1. Push the branch, open the PR with the template; body carries `Review skipped: opus-implementer` and lists the DOG issues it closes.
2. Wait for `ci`, `gitleaks`, `review-evidence`; on `BEHIND`, `gh pr update-branch`; squash-merge; never `--admin`.
3. **Deploy:** every PR touches `watchdog.mjs`, so after each merge run `./install.sh` from `/Users/john/Projects/orca-limit-watchdog` on `main`, then `node watchdog.mjs --dry-run` and `launchctl print gui/$(id -u)/com.john.orca-limit-watchdog | head`.
4. Move the PR's DOG issues to Done with the PR link; refresh `HANDOFF.md`.
