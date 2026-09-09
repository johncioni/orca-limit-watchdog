# DOG-19 Connectivity Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No resume prompt (limit or outage) is ever sent while the machine is offline; offline, the tick holds without spending an attempt and retries when connectivity returns.

**Architecture:** Add a fail-closed HTTPS reachability probe (`hasConnectivity`) plus a loopback-only override resolver (`connectivityUrl`), then gate `tick`'s send loop on one cached probe per real (non-dry-run) tick. All logic stays in the single dependency-free `watchdog.mjs`; verified with injected `fetchImpl` under `node --test`, never against live terminals.

**Tech Stack:** Plain Node ≥ 20 (system Node only), ESM, `node --test`, global `fetch` + `AbortSignal.timeout`.

**Spec:** `docs/superpowers/specs/2026-09-08-reset-less-limit-alert-and-connectivity-design.md` (this plan implements §2 only — the connectivity gate. The reset-less alert, `limit-open`, `episodeId`, and the `--alert` mode are DOG-20 and are out of scope here.)

## Global Constraints

- **Runtime:** plain Node ≥ 20, ESM; **no `package.json`, no dependencies** (project invariant — the daemon runs with only system Node).
- **Single file:** all daemon logic in `watchdog.mjs`; tests in `watchdog.test.mjs`.
- **`watchdog.mjs` is an invariant file:** full review loop; verify only with the unit fixtures and `bash scripts/orca-setup.sh`, **never** by running `install.sh` or sending to a live terminal.
- **Probe default URL:** `https://captive.apple.com/hotspot-detect.html` (the macOS captive-check host).
- **Override:** `WATCHDOG_CONNECTIVITY_URL`, accepted **only for a loopback host** (mirrors `statusUrlFor`); non-loopback/malformed ⇒ ignored with a warning, default used.
- **Fail-closed:** any thrown error, timeout, non-ok status, or redirect ⇒ offline (`false`).
- **Workers never push.** Commit locally; the orchestrator pushes after review.

---

### Task 1: `connectivityUrl` resolver + `hasConnectivity` probe

**Files:**
- Modify: `watchdog.mjs` — add `CONNECTIVITY_URL` next to `STATUS_URLS` (~line 343); add `connectivityUrl()` next to `statusUrlFor` (~line 349); add `hasConnectivity()` next to `fetchIndicator` (~line 361).
- Test: `watchdog.test.mjs` — new tests next to the `fetchIndicator`/`suppressedByStatus` tests (~line 660).

**Triage:** BEHAVIORAL — `hasConnectivity(fetch)` returns `true` for an ok response and `false` for a thrown/non-ok/redirect response; `connectivityUrl({WATCHDOG_CONNECTIVITY_URL:'https://evil.example/x'})` returns the default URL + a warning instead of the override.

**Interfaces:**
- Consumes: existing `LOOPBACK_HOSTS` set (already used by `statusUrlFor`).
- Produces:
  - `export const CONNECTIVITY_URL: string`
  - `export function connectivityUrl(env = process.env): { url: string, warn: string | null }`
  - `export async function hasConnectivity(fetchImpl = globalThis.fetch, url = CONNECTIVITY_URL): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Add to `watchdog.test.mjs` (import `CONNECTIVITY_URL`, `connectivityUrl`, `hasConnectivity` from `./watchdog.mjs` alongside the existing imports):

```javascript
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
```

Note: the existing `fakeFetch` helper (watchdog.test.mjs:639) already records each call as `{ url, opts }` in `.calls`, and `okJson` returns `{ ok: true, status: 200 }`, so these assertions work against the current helpers unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern='DOG-19' 2>&1 | tail -20`
Expected: FAIL — `hasConnectivity`/`connectivityUrl`/`CONNECTIVITY_URL` are not exported.

- [ ] **Step 3: Write the minimal implementation**

In `watchdog.mjs`, next to `STATUS_URLS`:

```javascript
export const CONNECTIVITY_URL = 'https://captive.apple.com/hotspot-detect.html';
```

Next to `statusUrlFor` (reusing the same loopback discipline):

```javascript
// Resolve the connectivity probe URL. An override is accepted only for a
// loopback host (as statusUrlFor does), so the e2e loopback stub can drive it;
// anything else is ignored with a warning and the default used.
export function connectivityUrl(env = process.env) {
  const override = env.WATCHDOG_CONNECTIVITY_URL;
  if (!override) return { url: CONNECTIVITY_URL, warn: null };
  try {
    const u = new URL(override);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname)) {
      return { url: override, warn: null };
    }
  } catch { /* fall through */ }
  return { url: CONNECTIVITY_URL, warn: 'ignoring non-loopback connectivity URL override' };
}
```

Next to `fetchIndicator`:

```javascript
// True when a reachability probe succeeds. Fail-closed: any error, timeout,
// non-ok status, or redirect ⇒ false. Reachability, not API-correctness — a
// captive portal that redirects or fails TLS reads as offline (the safe answer).
export async function hasConnectivity(fetchImpl = globalThis.fetch, url = CONNECTIVITY_URL) {
  try {
    const r = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    return r.ok === true;
  } catch { return false; }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern='DOG-19' 2>&1 | tail -20`
Expected: PASS (3 new tests).

- [ ] **Step 5: Run the full gate**

Run: `bash scripts/orca-setup.sh`
Expected: node floor OK, syntax checks OK, `node --test` all pass.

- [ ] **Step 6: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs
git commit -m "feat(dog-19): hasConnectivity probe + loopback-only connectivityUrl resolver"
```

---

### Task 2: Gate `tick`'s send loop on connectivity (+ update affected tick tests + docs)

**Files:**
- Modify: `watchdog.mjs` — `tick` send loop (~lines 503-521): add a lazy, cached connectivity probe **after** the `if (dryRun)` continue and **before** the outage status gate.
- Modify: `watchdog.test.mjs` — add offline/online gate tests; update the three existing tick tests whose fetch-call counts change (outage ×2, codex-outage, limit).
- Modify: `README.md` — document the connectivity gate + the `WATCHDOG_CONNECTIVITY_URL` override.

**Triage:** BEHAVIORAL — with the probe offline, a due `limit` and a due `outage` candidate are **not** sent and their `attempts`/`lastAttemptAt` are unchanged (previously they would send); dry-run still makes zero network calls.

**Interfaces:**
- Consumes: `connectivityUrl(env)`, `hasConnectivity(fetchImpl, url)` from Task 1; existing `deps.fetchImpl`, `deps.env`, `deps.log`.
- Produces: no new exported symbols (internal `tick` behaviour only).

- [ ] **Step 1: Write the failing tests**

Add to `watchdog.test.mjs` (in the tick-gate section, ~line 733):

```javascript
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
});

test('tick: online probe runs once and permits the send (DOG-19)', async () => {
  const h = harness({ tail: OUTAGE_TAIL, terminals: [T], state: seed() });   // fake fetch is ok by default
  await tick({ dryRun: false }, h.deps);
  assert.deepEqual(h.sent, [OUTAGE_RESUME_TEXT]);
  assert.equal(h.fetchImpl.calls[0].url, CONNECTIVITY_URL);   // probe first
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --test --test-name-pattern='DOG-19' 2>&1 | tail -25`
Expected: the offline tests FAIL (sends still happen — no gate yet); `online probe runs once` FAILS (no probe call recorded).

- [ ] **Step 3: Implement the gate in `tick`**

In `watchdog.mjs`, in the `sendCandidates` loop, add a cached probe. Before the loop, declare the cache:

```javascript
  const indicators = new Map();   // platform → indicator, fetched at most once per tick
  let online = null;              // connectivity, probed lazily once per real (non-dry-run) tick
```

Immediately after the `if (dryRun) { … continue; }` block and before the `if (ev.kind === 'outage')` status gate, insert:

```javascript
    if (online === null) {
      const { url, warn } = connectivityUrl(deps.env);
      if (warn) log('warn', warn);
      online = await hasConnectivity(deps.fetchImpl, url);
    }
    if (!online) { log('debug', `held ${ev.handle}: offline`); continue; }
```

(Placement matters: it is *after* the `dryRun` continue — so a dry-run tick never probes — and *before* the status gate, so it applies to every kind. `continue` on offline skips the send without touching `attempts`/`lastAttemptAt`; the event stays `waiting` and the post-loop GAVE UP pass still runs.)

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `node --test --test-name-pattern='DOG-19' 2>&1 | tail -25`
Expected: PASS.

- [ ] **Step 5: Update the three existing tick tests whose network-call expectations changed**

The probe adds one `fetchImpl` call before any send. Apply these exact edits in `watchdog.test.mjs`:

`tick: due outage event, status none …` (~line 689) — was 1 call (status); now 2 (probe, then status):
```javascript
  // before:
  assert.equal(h.fetchImpl.calls.length, 1);
  assert.equal(h.fetchImpl.calls[0].url, CLAUDE_URL);
  // after:
  assert.equal(h.fetchImpl.calls.length, 2);
  assert.equal(h.fetchImpl.calls[0].url, CONNECTIVITY_URL);
  assert.equal(h.fetchImpl.calls[1].url, CLAUDE_URL);
```

`tick: a due Codex outage event …` (~line 699) — probe first, then the openai status URL:
```javascript
  // before:
  assert.equal(h.fetchImpl.calls.length, 1);
  assert.match(h.fetchImpl.calls[0].url, /status\.openai\.com/);
  // after:
  assert.equal(h.fetchImpl.calls.length, 2);
  assert.equal(h.fetchImpl.calls[0].url, CONNECTIVITY_URL);
  assert.match(h.fetchImpl.calls[1].url, /status\.openai\.com/);
```

`tick: limit events use the limit text and never touch the network` (~line 718) — a limit send now makes exactly one call (the probe). Rename and update:
```javascript
// rename to: 'tick: limit events probe connectivity once, then send the limit text (DOG-19)'
  assert.deepEqual(h.sent, [RESUME_TEXT]);
  // before: assert.equal(h.fetchImpl.calls.length, 0);
  // after:
  assert.equal(h.fetchImpl.calls.length, 1);
  assert.equal(h.fetchImpl.calls[0].url, CONNECTIVITY_URL);
```

Leave `tick: dry-run makes no sends and no network calls` (~line 727) **unchanged** — it must still assert `h.fetchImpl.calls.length === 0` (the probe is after the `dryRun` continue). This is the regression guard for finding R2 #7.

- [ ] **Step 6: Update `README.md`**

Add a short paragraph under the run/behaviour section: the watchdog confirms local connectivity (an HTTPS probe to `https://captive.apple.com/hotspot-detect.html`) before sending any resume, holding the send while offline and retrying when back online; the probe host is overridable via `WATCHDOG_CONNECTIVITY_URL` (loopback hosts only, for testing).

- [ ] **Step 7: Run the full gate**

Run: `bash scripts/orca-setup.sh`
Expected: all `node --test` pass (new gate tests + updated existing tests), syntax OK. Confirm no unrelated test regressed.

- [ ] **Step 8: Commit**

```bash
git add watchdog.mjs watchdog.test.mjs README.md
git commit -m "feat(dog-19): gate every resume send on a fail-closed connectivity probe"
```

---

## Self-Review

- **Spec coverage (§2):** `hasConnectivity` fail-closed HTTPS probe (Task 1) ✓; loopback-only override (Task 1) ✓; per-tick cached gate over **all** send kinds (Task 2) ✓; offline holds without spending an attempt (Task 2 tests) ✓; dry-run does no network I/O (Task 2 leaves the dry-run test green; probe is after the `dryRun` continue) ✓; captive-portal fail-closed (Task 1 redirect/non-ok ⇒ false) ✓. `limit-open` gating is inherited automatically when DOG-20 adds that kind — no work here.
- **Out of scope confirmed:** no `limit-open`, `episodeId`, `alertedAt`, `--alert`, schema changes — those are DOG-20.
- **Type consistency:** `hasConnectivity(fetchImpl, url)` and `connectivityUrl(env) → {url, warn}` are used with those exact signatures in Task 2. `online` is a tri-state (`null` = unprobed) so the probe runs at most once.
- **Placeholder scan:** none — all steps carry real code or exact before→after edits.
- **Verified test infra:** `fakeFetch` (watchdog.test.mjs:639) records `{ url, opts }` and `okJson` returns `{ ok: true }`, so the `redirect:error` and `calls[i].url` assertions run against the current helpers with no infra change.
