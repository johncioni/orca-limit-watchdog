# DOG-20 Reset-less Limit Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Codex hits a limit with no derivable reset time, ask the human (native macOS alert: Continue / Wait 1h / Stop) instead of guessing or stalling silently, and act on the answer.

**Architecture:** A new Codex-anchored `limit-open` banner kind (detected when a `■` limit banner has no parseable reset), a per-episode alert lifecycle driven from `tick()` via a detached self-reinvoked `--alert` mode (message passed as osascript argv **data**, never interpolated), and additive schema/validation. All in the single dependency-free `watchdog.mjs`; verified with injected deps under `node --test`, never against live terminals.

**Tech Stack:** Plain Node ≥ 20 (system Node only), ESM, `node --test`, `node:child_process` (`spawn`, `execFile`), `node:crypto` (`randomUUID`), `node:url` (`fileURLToPath`), macOS `osascript`.

**Spec:** `docs/superpowers/specs/2026-09-08-reset-less-limit-alert-and-connectivity-design.md` (revision 4). This plan implements §1 (detection), §3 (schema), §4 (lifecycle), §5 (alert mechanism). §2 (connectivity gate) already shipped as DOG-19 and is inherited unchanged — do not re-implement it.

## Global Constraints

- **Runtime:** plain Node ≥ 20, ESM; **no `package.json`, no dependencies** (project invariant).
- **Single file:** all daemon logic in `watchdog.mjs`; tests in `watchdog.test.mjs`.
- **`watchdog.mjs` is an invariant file:** full review loop; verify only with unit fixtures + `bash scripts/orca-setup.sh`; **never** run `install.sh`, send to a live terminal, or test against live Orca terminals.
- **Scope:** DOG-20 only. Do not change the DOG-19 connectivity gate except where a new `limit-open` send naturally flows through it (no change needed — the gate is kind-agnostic).
- **Non-Codex / non-`■` detection stays byte-for-byte unchanged** (no regressions to `limit`/`outage`/`null`).
- **No injection, no shell:** the alert message reaches `osascript` as `argv` data via env; never build an AppleScript or shell string from banner text.
- **Schema stays v2, additive.** Old `limit`/`outage` files must still load.
- **Workers never push.** Commit locally; the orchestrator reviews and pushes.
- **Verify each task:** `bash scripts/orca-setup.sh` green before every commit.

## Choice-file contract (shared by Tasks 5 & 6)

- Path: `STATE_DIR/choices/<handle>.<episodeId>.json` (per-episode unique; `STATE_DIR` = `~/.local/state/orca-limit-watchdog`).
- Contents: `{ "choice": "Continue" | "Wait 1h" | "Stop", "episodeId": "<uuid>", "at": "<ISO>" }`.
- Written atomically by the `--alert` child (unique temp → rename); consumed and deleted by `tick`; honoured only if `episodeId` equals the event's.

## File Structure

All changes in `watchdog.mjs` (add to existing sections) and `watchdog.test.mjs`, plus a `README.md` paragraph. No new files (single-file invariant). New injectable deps on `DEFAULT_DEPS`: `spawn`, `readChoice`, `clearChoice`, `newEpisodeId`.

---

### Task 1: Schema & validation foundation (`limit-open` kind, statuses, fields)

**Files:**
- Modify: `watchdog.mjs` — `SCHEDULE` (add `limit-open`), `STATUSES` (add `awaiting-user`, `dismissed`), `validateEvent` (~187-203), `parseStateFile` (~207-219).
- Test: `watchdog.test.mjs` — validation + parseStateFile round-trip tests.

**Triage:** BEHAVIORAL — `validateEvent` accepts a well-formed `limit-open` event and rejects specific malformed ones; `parseStateFile` loads a legacy file whose events omit `alertedAt`.

**Interfaces:**
- Consumes: existing `KINDS = Object.keys(SCHEDULE)`, `STATUSES`, `isIso`, `SCHEDULE[kind].maxSends`.
- Produces: `SCHEDULE['limit-open']`; `STATUSES` includes `'awaiting-user'`, `'dismissed'`; `validateEvent` accepting the new fields `alertedAt` (null|ISO) and `episodeId` (string, limit-open only). These are consumed by Tasks 3-6.

- [ ] **Step 1: Write the failing tests** (add near the existing `validateEvent`/`parseStateFile` tests)

```javascript
const LO = (over = {}) => ({ handle: H, kind: 'limit-open', platform: 'codex', bannerText: 'x',
  detectedAt: NOW.toISOString(), resetAt: NOW.toISOString(), attempts: 0, lastAttemptAt: null,
  status: 'awaiting-user', alertedAt: null, episodeId: 'ep-1', ...over });

test('validateEvent: well-formed limit-open accepted (DOG-20)', () => {
  assert.equal(validateEvent(H, LO()), null);
  assert.equal(validateEvent(H, LO({ status: 'dismissed' })), null);
  assert.equal(validateEvent(H, LO({ status: 'waiting', alertedAt: NOW.toISOString() })), null);
});

test('validateEvent: limit-open rejections (DOG-20)', () => {
  assert.match(validateEvent(H, LO({ platform: 'claude' })), /platform/);      // codex only
  assert.match(validateEvent(H, LO({ episodeId: '' })), /episodeId/);           // required non-empty
  assert.match(validateEvent(H, LO({ alertedAt: 'nope' })), /alertedAt/);       // null or ISO
  assert.match(validateEvent(H, LO({ status: 'awaiting-user', attempts: 1 })), /attempts|lastAttemptAt/);
});

test('validateEvent: awaiting-user/dismissed illegal for limit/outage (DOG-20)', () => {
  const base = { handle: H, platform: 'claude', bannerText: 'x', detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 0, lastAttemptAt: null, alertedAt: null };
  assert.match(validateEvent(H, { ...base, kind: 'limit', status: 'awaiting-user' }), /status/);
});

test('validateEvent: zero-attempt gave_up accepted for deadline-bearing kinds (DOG-20)', () => {
  // outage + limit-open can expire the deadline having never sent (occupied input, failed reads)
  const out = { handle: H, kind: 'outage', platform: 'claude', bannerText: 'x', detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 0, lastAttemptAt: null, status: 'gave_up', alertedAt: null };
  assert.equal(validateEvent(H, out), null);
  assert.equal(validateEvent(H, LO({ status: 'gave_up' })), null);
});

test('parseStateFile: legacy v2 events without alertedAt load (normalised to null) (DOG-20)', () => {
  const legacy = JSON.stringify({ version: 2, events: { [H]: {
    handle: H, kind: 'limit', platform: 'claude', bannerText: 'x', detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 0, lastAttemptAt: null, status: 'waiting' } } });   // no alertedAt
  const ev = parseStateFile(legacy);
  assert.ok(ev && ev[H]);
  assert.equal(ev[H].alertedAt, null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='DOG-20' 2>&1 | tail -20`
Expected: FAIL (limit-open not a valid kind; new fields rejected).

- [ ] **Step 3: Implement**

Per spec §3. In `watchdog.mjs`:

```javascript
// SCHEDULE — add after the outage entry:
  'limit-open': Object.freeze({ bufferMs: 0, retrySpacingMs: 30 * MIN, rearmMs: 10 * MIN,
    maxSends: 6, deadlineMs: 24 * 60 * MIN, resumeText: RESUME_TEXT }),
```
```javascript
const STATUSES = ['waiting', 'resumed', 'gave_up', 'awaiting-user', 'dismissed'];
```

In `validateEvent`, after the existing checks, add (see spec §3 "validateEvent changes"):
- normalise legacy absence: treat `ev.alertedAt === undefined` as `null` before the type check (do this in `parseStateFile` per below, so validateEvent can require `null`-or-ISO);
- `alertedAt`: `ev.alertedAt !== null && !isIso(ev.alertedAt)` ⇒ `'alertedAt: not null or a timestamp'`;
- `limit-open` requires `platform === 'codex'` and a non-empty string `episodeId`; `awaiting-user`/`dismissed` legal only for `kind === 'limit-open'`;
- **relax** the existing `lastAttemptAt === null` rule to admit `waiting`, `awaiting-user`, `dismissed`, and `gave_up` (for deadline-bearing kinds `outage`/`limit-open`) — see spec §3.

In `parseStateFile`, normalise `alertedAt` to `null` when absent before validating (both v1-upgrade and v2 paths): `const ev = { alertedAt: null, ...raw, /* v1 fields */ }` (spread `raw` after the default so present values win).

- [ ] **Step 4: Run to verify pass**

Run: `node --test --test-name-pattern='DOG-20' 2>&1 | tail -20`
Expected: PASS. Then `bash scripts/orca-setup.sh` — the whole suite green (existing limit/outage validation unchanged).

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat(dog-20): limit-open schema — kind, statuses, alertedAt/episodeId, validation"
```

---

### Task 2: Detection — `limit-open` classification

**Files:**
- Modify: `watchdog.mjs` — `detectBanner` (~106-161): add the injectable `now` param, the Codex `■` limit candidate recognition, the single parse-success split, the evidence block, the continuation grammar, veto/final-block reuse, and the returned `resetAt`.
- Test: `watchdog.test.mjs` — detection fixtures (the behavioral contract); update the existing `~126` assertion.

**Triage:** BEHAVIORAL — the real captured Codex banners classify as `limit-open`/`limit` per the reset split; negatives and non-Codex inputs are unchanged.

**Interfaces:**
- Consumes: existing `LIMIT_RE`, `REACHED_RE`, `parseResetTime(text, now)`, the DOG-17 veto/final-block helpers, `stripAnsi`, `sanitize`.
- Produces: `detectBanner(lines, platform = 'unknown', now = new Date())` returning, for a Codex reset-less limit, `{ kind: 'limit-open', bannerText, matchedLine, patternId: 'limit-open', resetAt: null }`; for a reset-bearing Codex `■` limit, `{ kind: 'limit', …, resetAt: <Date-ISO or the parsed value> }`. The `resetAt` field is consumed by `newEvent` in Task 3.

**Detection contract — implement per spec §1 (authoritative).** Key points the tests below pin:
- Recognise a **Codex-platform** `■` line that is either `exceeded retry limit, last status: 429` (429 **only**; `5xx` stays the DOG-17 outage row; other statuses ⇒ no match) **or** a `LIMIT_RE`+`REACHED_RE` reached-limit line.
- Build the **selected evidence block** = that `■` line plus its bounded named continuation (≤3 wrapped lines; the usage-limit forms, and the 429 form with an optional `Try again at <time>.` continuation — spec §1). Parse it **once** with `parseResetTime(block, now)`.
- Reset parses ⇒ `kind: 'limit'`; `null` ⇒ `kind: 'limit-open'`. A rejected Codex `■` candidate does **not** fall back to the legacy `RESET_RE` rule.
- Apply the full DOG-17 retry-veto set and require the final block after the banner to be recognised chrome only.
- Non-Codex / non-`■` inputs run the existing rules verbatim.

- [ ] **Step 1: Write the failing tests** (fixtures are the contract — real captured strings + negatives)

```javascript
const H_ = 'term_codex';   // a codex-identified handle
test('detectBanner: Codex reset-less usage limit ⇒ limit-open (DOG-20)', () => {
  const b = detectBanner(["■ You've hit your usage limit. Upgrade to Pro (https://x), visit https://y to",
    'purchase more credits.', '› Ask Codex to do anything'], 'codex');
  assert.equal(b.kind, 'limit-open');
});
test('detectBanner: Codex usage limit WITH reset ⇒ limit (DOG-20)', () => {
  const b = detectBanner(["■ You've hit your usage limit. Upgrade to Pro (https://x), visit https://y to",
    'purchase more credits or try again at 10:12 PM.', '› Ask Codex to do anything'], 'codex');
  assert.equal(b.kind, 'limit');
  assert.ok(b.resetAt);   // parsed, carried for newEvent
});
test('detectBanner: bare 429 retry-exhaustion ⇒ limit-open; 429+reset ⇒ limit (DOG-20)', () => {
  assert.equal(detectBanner(['■ exceeded retry limit, last status: 429', '› Ask Codex to do anything'], 'codex').kind, 'limit-open');
  assert.equal(detectBanner(['■ exceeded retry limit, last status: 429', 'Try again at 10:12 PM.', '›'], 'codex').kind, 'limit');
});
test('detectBanner: 5xx retry-exhaustion stays outage, other status ⇒ null (DOG-20)', () => {
  assert.equal(detectBanner(['■ exceeded retry limit, last status: 503', '› Ask Codex to do anything'], 'codex').kind, 'outage');
  assert.equal(detectBanner(['■ exceeded retry limit, last status: 418', '› Ask Codex to do anything'], 'codex'), null);
});
test('detectBanner: "…usage limit reached, try again later" (no clock) on codex ⇒ limit-open (DOG-20)', () => {
  assert.equal(detectBanner(['■ usage limit reached, try again later', '› Ask Codex to do anything'], 'codex').kind, 'limit-open');
});
test('detectBanner: limit-open only on codex + ■ (DOG-20)', () => {
  assert.equal(detectBanner(['■ exceeded retry limit, last status: 429', '›'], 'unknown'), null);
  // DOG false-positive fixture unchanged (Claude, no ■, chrome):
  assert.equal(detectBanner(['error: rate limit exceeded (HTTP 429)', FOOTER, '> ', '? for shortcuts'], 'claude'), null);
});
test('detectBanner: stalled-banner negatives for limit-open (DOG-20)', () => {
  // historical error followed by active work / retry / draft ⇒ not a live banner
  assert.equal(detectBanner(['■ exceeded retry limit, last status: 429', '• Reconnecting... 2/5', 'esc to interrupt'], 'codex'), null);
  assert.equal(detectBanner(['■ exceeded retry limit, last status: 429', '› my half-typed reply'], 'codex'), null);
});
```

Also update the existing test near `watchdog.test.mjs:~126` that currently asserts the anchored Codex 429 line returns `null` — it must now assert `kind === 'limit-open'` (intentional, per spec §Testing / finding R3 #1). Leave the unanchored fallback test (`~391`) unchanged.

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='DOG-20' 2>&1 | tail -30`
Expected: the new detection tests FAIL (limit-open not produced).

- [ ] **Step 3: Implement per spec §1**

Add the injectable `now` param to `detectBanner`, the Codex `■` candidate recognition + single parse-split + evidence block + continuation grammar + veto/final-block + `resetAt` return, keeping non-Codex paths verbatim. Write tolerant regexes for the named forms; do not over-broaden (429-only; block ends at the matched form's terminal sentence). Reference spec §1 for the exact forms and precedence.

- [ ] **Step 4: Run to verify pass, then full gate**

Run: `node --test --test-name-pattern='DOG-20' 2>&1 | tail -30` → PASS
Run: `bash scripts/orca-setup.sh` → whole suite green; confirm the updated `~126` test passes and no other detection test regressed.

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat(dog-20): detect Codex reset-less limits as limit-open (one reset/no-reset split)"
```

---

### Task 3: `newEvent` for `limit-open` + injectable episode-id + carried reset

**Files:**
- Modify: `watchdog.mjs` — `newEvent` (~172-182); `DEFAULT_DEPS` (add `newEpisodeId`); import `randomUUID`.
- Test: `watchdog.test.mjs`.

**Triage:** BEHAVIORAL — `newEvent` for a `limit-open` banner produces `status: 'awaiting-user'`, `alertedAt: null`, a non-empty `episodeId`, and `resetAt = now`; a `limit`/`outage` event gets `alertedAt: null` and no `episodeId`; a reset-bearing `limit` uses the banner's carried `resetAt`.

**Interfaces:**
- Consumes: `detectBanner`'s returned `resetAt` (Task 2); `deps.newEpisodeId` (default `randomUUID`).
- Produces: `newEvent(o, now, newEpisodeId?)` (or reads `o.newEpisodeId`) — the exact wiring is an implementation choice; the event shape is the contract. Consumed by `reconcile`/`tick`.

- [ ] **Step 1: Write the failing tests**

```javascript
test('newEvent: limit-open ⇒ awaiting-user, episodeId set, resetAt=now (DOG-20)', () => {
  const o = { handle: H, platform: 'codex', banner: { kind: 'limit-open', bannerText: 'x', resetAt: null } };
  const ev = newEvent(o, NOW, () => 'ep-xyz');
  assert.equal(ev.kind, 'limit-open');
  assert.equal(ev.status, 'awaiting-user');
  assert.equal(ev.alertedAt, null);
  assert.equal(ev.episodeId, 'ep-xyz');
  assert.equal(ev.resetAt, NOW.toISOString());
});
test('newEvent: limit/outage get alertedAt:null and no episodeId (DOG-20)', () => {
  const lim = newEvent({ handle: H, platform: 'claude', banner: { kind: 'limit', bannerText: 'x', resetAt: new Date(NOW.getTime() + 3600e3).toISOString() } }, NOW);
  assert.equal(lim.alertedAt, null);
  assert.equal(lim.episodeId, undefined);
});
```

- [ ] **Step 2: Run to verify failure** → `node --test --test-name-pattern='DOG-20' 2>&1 | tail -15`

- [ ] **Step 3: Implement**

Import `randomUUID`: `import { randomUUID } from 'node:crypto';` and add to `DEFAULT_DEPS`: `newEpisodeId: randomUUID`. In `newEvent`, per spec §4: for `kind === 'limit-open'` set `status: 'awaiting-user'`, `resetAt: now.toISOString()`, `alertedAt: null`, `episodeId: <generated>`; for other kinds keep current behaviour plus `alertedAt: null`; consume the banner's `resetAt` for `limit` (fall back to the existing `+60 min` only for the non-Codex path, unchanged). Thread the generator from `tick`/`reconcile` (they call `newEvent`) — pass `deps.newEpisodeId` through.

- [ ] **Step 4: Verify** → `node --test --test-name-pattern='DOG-20'` PASS; `bash scripts/orca-setup.sh` green.

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat(dog-20): newEvent builds limit-open events with an injectable episodeId"
```

---

### Task 4: `reconcile` — create/keep limit-open events, exemptions, sticky Stop

**Files:**
- Modify: `watchdog.mjs` — `reconcile` (~278-320): rule 4 (replace) suppression for `dismissed`; rule 5a/5b exemption for `awaiting-user`/`dismissed`; awaiting-user replacement invalidation; pass `deps.newEpisodeId` into `newEvent`.
- Test: `watchdog.test.mjs`.

**Triage:** BEHAVIORAL — a `dismissed` limit-open event survives a kind/platform banner mutation (not replaced), and is removed only by a confirmed banner-clear; an `awaiting-user` event does not age into `gave_up`.

**Interfaces:**
- Consumes: Task 1 statuses, Task 3 `newEvent`/episodeId.
- Produces: reconcile transitions honouring the new statuses. Consumed by `tick`.

- [ ] **Step 1: Write the failing tests** (use the existing reconcile test harness/helpers)

```javascript
test('reconcile: dismissed limit-open survives a kind mutation (Stop is sticky) (DOG-20)', () => {
  const ev = { handle: H, kind: 'limit-open', platform: 'codex', bannerText: 'x', detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 0, lastAttemptAt: null, status: 'dismissed', alertedAt: NOW.toISOString(), episodeId: 'ep1' };
  // banner now shows a reset-bearing limit (kind mutation) — must NOT replace a dismissed event
  const obs = [{ handle: H, banner: { kind: 'limit', bannerText: 'try again at 5pm', resetAt: new Date(NOW.getTime()+3600e3).toISOString() }, platform: 'codex' }];
  const { events } = reconcile({ [H]: ev }, obs, new Date(NOW.getTime() + 60_000));
  assert.equal(events[H].status, 'dismissed');
  assert.equal(events[H].kind, 'limit-open');
});
test('reconcile: awaiting-user does not age into gave_up past the deadline (DOG-20)', () => {
  const ev = { handle: H, kind: 'limit-open', platform: 'codex', bannerText: 'x', detectedAt: new Date(NOW.getTime() - 25*60*60*1000).toISOString(),
    resetAt: NOW.toISOString(), attempts: 0, lastAttemptAt: null, status: 'awaiting-user', alertedAt: NOW.toISOString(), episodeId: 'ep1' };
  const obs = [{ handle: H, banner: { kind: 'limit-open', bannerText: 'x', resetAt: null }, platform: 'codex' }];
  const { events } = reconcile({ [H]: ev }, obs, NOW);
  assert.equal(events[H].status, 'awaiting-user');   // exempt from rule 5a
});
test('reconcile: dismissed limit-open cleared by a confirmed banner-clear (DOG-11 two-miss) (DOG-20)', () => {
  const ev = { handle: H, kind: 'limit-open', platform: 'codex', bannerText: 'x', detectedAt: NOW.toISOString(),
    resetAt: NOW.toISOString(), attempts: 0, lastAttemptAt: null, status: 'dismissed', alertedAt: NOW.toISOString(), episodeId: 'ep1', clearedAt: NOW.toISOString() };
  const obs = [{ handle: H, banner: null, platform: 'codex' }];   // second miss
  const { events } = reconcile({ [H]: ev }, obs, new Date(NOW.getTime()+60_000), [H]);
  assert.equal(events[H], undefined);
});
```

- [ ] **Step 2: Run to verify failure** → `node --test --test-name-pattern='DOG-20' 2>&1 | tail -20`

- [ ] **Step 3: Implement per spec §4** ("Deadline & rearm interaction" + "Stop stickiness"): in rule 4, skip replacement when `ev.status === 'dismissed'`; in rules 5a/5b, `continue` when `ev.status === 'awaiting-user' || 'dismissed'`; keep DOG-11 rule 3 (banner-clear) applying to all statuses including dismissed; pass the episode-id generator through to `newEvent`.

- [ ] **Step 4: Verify** → pattern PASS; `bash scripts/orca-setup.sh` green (existing reconcile tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat(dog-20): reconcile honours limit-open — sticky Stop, pre-consent deadline exemption"
```

---

### Task 5: `tick` alert lifecycle (spawn claim, choice consume, transitions)

**Files:**
- Modify: `watchdog.mjs` — `tick` (add an alert-lifecycle pass; `DEFAULT_DEPS` gains `spawn`, `readChoice`, `clearChoice`).
- Test: `watchdog.test.mjs` — with fake `spawn`/`readChoice`/`clearChoice`.

**Triage:** BEHAVIORAL — an `awaiting-user` limit-open event spawns exactly one alert (claim `alertedAt` before spawn) and sends nothing; a pending `Continue`/`Wait 1h`/`Stop` choice transitions the event; dry-run does none of it.

**Interfaces:**
- Consumes: Task 1-4; `deps.spawn`, `deps.readChoice(handle, episodeId)`, `deps.clearChoice(handle, episodeId)`.
- Produces: the alert pass; the choice-file contract (see top). Task 6 supplies the real deps.

- [ ] **Step 1: Write the failing tests** (fake deps; assert order and inertness)

```javascript
// helper: a limit-open awaiting-user event + a codex terminal on a live limit-open banner
test('tick: awaiting-user spawns one alert, claims alertedAt first, sends nothing (DOG-20)', async () => { /* fake spawn records calls; assert alertedAt persisted before spawn; sent == [] */ });
test('tick: pending Continue ⇒ waiting, resetAt=now, detectedAt=now (DOG-20)', async () => { /* fake readChoice returns {choice:'Continue',episodeId,at}; assert transition + clearChoice called */ });
test('tick: pending Wait 1h ⇒ resetAt=now+60m (DOG-20)', async () => { /* ... */ });
test('tick: pending Stop ⇒ dismissed, never sends (DOG-20)', async () => { /* ... */ });
test('tick: stale/mismatched episodeId choice ignored and cleared (DOG-20)', async () => { /* readChoice returns wrong episodeId ⇒ no transition, clearChoice called */ });
test('tick: dry-run does not spawn/persist/consume (DOG-20)', async () => { /* deps.spawn throws if called; assert no throw, no save */ });
```

Fill each with the harness pattern from the existing tick tests (fake `orca`, in-memory `state`, `saved()`); add `spawn`, `readChoice`, `clearChoice` to the harness deps (defaults: `spawn` records calls, `readChoice` returns null). Model the assertions on spec §4.

- [ ] **Step 2: Run to verify failure** → `node --test --test-name-pattern='DOG-20' 2>&1 | tail -25`

- [ ] **Step 3: Implement per spec §4** — an alert-lifecycle pass in `tick` (before or alongside the send loop): for each `limit-open` event, (a) `awaiting-user` + `alertedAt === null` ⇒ persist `alertedAt = now` **then** `deps.spawn(...)` (Task 6 wires the real spawn); (b) `awaiting-user` + `alertedAt` set ⇒ `deps.readChoice`; on an episode-matched choice, apply the Continue/Wait 1h/Stop transition (set `detectedAt = now` on consent per the deadline contract), persist, **then** `deps.clearChoice`; mismatched ⇒ clear and ignore. All of this is a **no-op under `dryRun`** (guard the whole pass). A consented `waiting` event then flows through the existing send loop next tick, inheriting the DOG-19 connectivity gate. Add `spawn`/`readChoice`/`clearChoice` to `DEFAULT_DEPS` (stubs acceptable here; real impl in Task 6).

- [ ] **Step 4: Verify** → pattern PASS; `bash scripts/orca-setup.sh` green.

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat(dog-20): tick alert lifecycle — claim-before-spawn, episode-bound choice, dry-run inert"
```

---

### Task 6: `--alert` mode + real `spawn`/choice-file deps + entry routing

**Files:**
- Modify: `watchdog.mjs` — add `runAlert()`, the real `DEFAULT_DEPS.spawn`/`readChoice`/`clearChoice`, the `--alert` entry routing (before `main`); import `spawn`, `fileURLToPath`.
- Test: `watchdog.test.mjs` — invoke `runAlert` with a fake `execFile` + tmp dir; assert choice-file contract, button allow-list, error-safety, and no tick/state/send.

**Triage:** BEHAVIORAL — `runAlert` with a fake osascript returning `Continue` writes exactly the choice-file contract to a per-episode path; on osascript error/empty/invalid it writes nothing.

**Interfaces:**
- Consumes: Task 5's choice-file contract; `STATE_DIR`.
- Produces: `runAlert(env, { execFileImpl })` (injectable); `DEFAULT_DEPS.spawn` that launches `process.execPath [SELF, '--alert']` with the alert env; `readChoice`/`clearChoice` that read/delete `choices/<handle>.<episodeId>.json`.

- [ ] **Step 1: Write the failing tests**

```javascript
test('runAlert: writes the choice-file contract for an allowed button (DOG-20)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-alert-'));
  const env = { WATCHDOG_ALERT_MESSAGE: 'term_x — hit limit', WATCHDOG_ALERT_EPISODE: 'ep9',
    WATCHDOG_ALERT_CHOICE_FILE: path.join(dir, 'choices', 'term_x.ep9.json') };
  await runAlert(env, { execFileImpl: async () => ({ stdout: 'Continue\n' }) });
  const j = JSON.parse(fs.readFileSync(env.WATCHDOG_ALERT_CHOICE_FILE, 'utf8'));
  assert.equal(j.choice, 'Continue'); assert.equal(j.episodeId, 'ep9'); assert.ok(j.at);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('runAlert: osascript error or non-allowlisted button writes nothing (DOG-20)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-alert-'));
  const file = path.join(dir, 'choices', 'term_x.ep9.json');
  const env = { WATCHDOG_ALERT_MESSAGE: 'm', WATCHDOG_ALERT_EPISODE: 'ep9', WATCHDOG_ALERT_CHOICE_FILE: file };
  await runAlert(env, { execFileImpl: async () => { throw new Error('boom'); } });
  await runAlert(env, { execFileImpl: async () => ({ stdout: 'Delete everything\n' }) });   // not allowlisted
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify failure** → `node --test --test-name-pattern='DOG-20' 2>&1 | tail -15`

- [ ] **Step 3: Implement per spec §5**

- Imports: `import { spawn } from 'node:child_process';` and `import { fileURLToPath } from 'node:url';`.
- `runAlert(env, { execFileImpl = pExecFile } = {})`: read `WATCHDOG_ALERT_MESSAGE`/`_EPISODE`/`_CHOICE_FILE`; run `execFileImpl('/usr/bin/osascript', ['-e','on run argv','-e','return button returned of (display alert "orca-limit-watchdog" message (item 1 of argv) buttons {"Stop","Wait 1h","Continue"} default button "Continue")','-e','end run','--', message])`; trim stdout; **only** if it is exactly `Stop`/`Wait 1h`/`Continue`, `mkdir -p` the choices dir and atomically write `{choice, episodeId, at}` (unique temp → rename); on any throw/empty/invalid, write nothing. Never read/write `state.json`, never send.
- `DEFAULT_DEPS.spawn = (ev) => spawn(process.execPath, [fileURLToPath(import.meta.url), '--alert'], { detached: true, stdio: 'ignore', env: { ...process.env, WATCHDOG_ALERT_MESSAGE: `${ev.handle} — ${sanitize(ev.bannerText)}`, WATCHDOG_ALERT_EPISODE: ev.episodeId, WATCHDOG_ALERT_CHOICE_FILE: <path> } }).unref();`
- `readChoice(handle, episodeId)` / `clearChoice(handle, episodeId)`: read/parse/delete `path.join(STATE_DIR, 'choices', `${handle}.${episodeId}.json`)`; all fs errors are bounded (return null / best-effort).
- **Entry routing (finding R2 #4):** in the entry guard, dispatch `--alert` exclusively before `main()`:
  ```javascript
  if (entryIsThisFile) {
    if (process.argv.includes('--alert')) { await runAlert(process.env); }
    else { await main(); }
  }
  ```
  `runAlert` must never acquire the lock, set the tick deadline, run a tick, or send.

- [ ] **Step 4: Verify** → pattern PASS; `bash scripts/orca-setup.sh` green. Also `node watchdog.mjs --alert` with no env exits cleanly without running a tick (manual smoke check; do NOT let it send).

- [ ] **Step 5: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat(dog-20): --alert self-reinvoke mode, choice-file deps, exclusive entry routing"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md` — document the reset-less alert (Continue / Wait 1h / Stop), the choice-file location, and that it is Codex-only.
- Covered by: n/a (docs); guarded by `node --test` staying green.

**Triage:** MECHANICAL — prose only; no behaviour changes; the suite stays green.

- [ ] **Step 1: Confirm baseline green** — `bash scripts/orca-setup.sh` → PASS.
- [ ] **Step 2: Add the README paragraph** — per spec §Files: when a Codex terminal hits a limit with no reset time, the watchdog shows a native macOS alert (Continue = retry every 30 min capped 6/24h, Wait 1h, Stop) and acts on the click; no click ⇒ it does nothing; choice files live under `~/.local/state/orca-limit-watchdog/choices/`.
- [ ] **Step 3: Verify** — `bash scripts/orca-setup.sh` → PASS (unchanged).
- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(dog-20): document the reset-less limit alert and choice files"
```

---

## Self-Review

- **Spec coverage:** §1 detection → Task 2; §3 schema/validation → Task 1 (+ episodeId in Task 3); §4 lifecycle → Tasks 3 (newEvent), 4 (reconcile), 5 (tick alert pass); §5 alert mechanism → Task 6. §2 connectivity gate → inherited from DOG-19 (a consented `limit-open` send flows through the existing gate; no work here). README → Task 7.
- **Placeholder scan:** the detection regexes (Task 2) and the tick-alert-pass body (Task 5) are specified by their fixtures/contract + spec §1/§4 rather than transcribed line-for-line — deliberate, because the reviewer classed the exact regexes as TDD territory and the fixtures are the binding contract. Every task has concrete test code and exact commit messages. No "TBD"/"handle edge cases".
- **Type consistency:** `detectBanner(lines, platform, now)` and its `resetAt` return (Task 2) are consumed by `newEvent` (Task 3); `episodeId`/`alertedAt` shapes (Task 1) are used in Tasks 3-6; the choice-file contract (top) is shared verbatim by Tasks 5 (consume) and 6 (produce); `deps.spawn`/`readChoice`/`clearChoice`/`newEpisodeId` are introduced as stubs in the task that first needs them and made real in Task 6/3.
- **Ordering:** Tasks 1→2→3→4→5→6 build strictly upward; Task 5 uses stub deps so it is testable before Task 6 supplies the real ones. Task 7 is docs-last.
- **Invariant-file discipline:** every task verifies with `scripts/orca-setup.sh`, never `install.sh` or live terminals; dry-run inertness is explicitly tested (Task 5); the `--alert` handler is isolated from the tick/lock/deadline (Task 6).
