# orca-limit-watchdog — Reset-less limit alerts & connectivity gate

Design spec. Adds two capabilities to `watchdog.mjs`:

1. **Reset-less limit alert** — when an agent hits a limit we cannot auto-resume
   (no derivable reset time, e.g. Codex's `■ exceeded retry limit, last status:
   429` or a usage-limit banner with no "try again at …"), the daemon asks the
   human what to do via a native macOS alert with three buttons, instead of
   guessing or silently doing nothing.
2. **Universal connectivity gate** — before sending any resume prompt (limit or
   outage), the daemon confirms the machine is online; offline, it holds the
   send without spending an attempt.

Companion to the outage-resume design
(`2026-09-07-outage-resume-design.md`) and the original design
(`2026-07-23-orca-limit-watchdog-design.md`). Tracked as DOG-19 (connectivity
gate) and DOG-20 (reset-less alert); see "Sequencing".

**Revision 2 (2026-09-08)** incorporates Codex spec-review round 1
(`.superpowers/reviews/dog-19-20-spec-round-1.md`, REQUEST-CHANGES, 13
findings, all accepted). See "Round-1 review resolutions" for the finding→fix
map.

## Problem

The daemon resumes a stalled terminal only when it can compute *when* to act:

- A **reset-bearing limit** ("Session limit … try again at 10:12 PM") parses a
  reset time and auto-resumes. Verified against a live Codex banner:
  `detectBanner` returns `limit`, `parseResetTime` resolves the clock time.
- An **outage** banner has no reset time but a known recovery signal
  (`status.*`), so it retries on a fixed schedule; a `major`/`critical`
  indicator suppresses the send.

Two real cases fall through:

- **Reset-less limit.** Codex's retry-exhaustion line `■ exceeded retry limit,
  last status: 429` carries no reset time; the DOG-17 amendment deliberately
  excludes it from the outage rule (it is a rate limit, not a 5xx outage), and
  the limit rule cannot fire without a reset time — so `detectBanner` returns
  `null` and the terminal stalls indefinitely with no action and no notice. A
  usage-limit banner that states no "try again at …" has the same problem;
  today the limit rule's `?? now + 60 min` fallback would blind-guess an hour.
- **Sending into a dead network.** No send is gated on local reachability.
  `fetchIndicator` **fails open**: any transport error returns `null`
  (`watchdog.mjs:360-368`), and `suppressedByStatus(null)` is `false`
  (`:371`) — so an **outage** resume fires even when the machine is offline, and
  a **limit** resume (no status fetch at all) likewise fires into a dead
  session. (Revision 1 wrongly claimed outages were already gated; they are
  not.)

## Goal

Do the right, bounded thing in both cases:

- Reset-less limit: surface a **decision request** to the human (continue
  auto-retry / wait 1 h / stop) and act on the answer, defaulting to "do
  nothing" until they answer.
- Connectivity: never send into a dead network; while offline, hold rather than
  spend an attempt.

Worst-case failure stays bounded and benign: at most one line of text typed into
a terminal, and only when the machine is online and the human either consented
or the reset was known.

## Non-goals

- General status notifications, worktree-card updates, launching Orca, reviving
  exited processes, non-Orca terminals — unchanged from the original design.
- **Amendment to the original design's "notifications" non-goal:** the alert is
  a *decision request confined to the one case where autonomous resume is
  unsafe* (no derivable reset time). It is not a general notification channel.
- Detecting a specific "no internet" banner. The connectivity gate is an active
  reachability probe on the send path, independent of any agent's offline
  wording.
- Claude reset-less limits. Claude Code's limit state always carries a reset
  (its usage footer), so the reset-less path is Codex-shaped in practice, and
  the detection is gated to a Codex `■`-anchored banner (see §1). Non-Codex
  detection behaviour is left **unchanged** (no regression risk).
- Guaranteeing a fixed number of retries across an offline stretch. The 24 h
  retry cap for a consented reset-less limit is wall-clock from consent; offline
  time counts against it (a machine offline for 24 h has almost certainly seen
  the limit reset anyway). The connectivity gate prevents *wasted sends*, not
  deadline expiry.

## Sequencing

Two independent capabilities, two implementation tasks / PRs. Both touch
`watchdog.mjs` (an invariant file), so each gets the full review loop.

1. **DOG-19 — connectivity gate.** Lower risk, closes a live gap, no new I/O
   surface. Ship first.
2. **DOG-20 — reset-less limit alert.** New detached-child + osascript + choice
   file machinery and a new event kind. Ship second, on top of DOG-19.

Neither task requires the other to be correct; DOG-20's retry cycle simply
inherits DOG-19's gate once both land.

## Design

### 1. Detection: a reset-less limit banner class

A new banner `kind: 'limit-open'` (a real limit banner with no derivable reset),
added to `detectBanner`, **gated to Codex and anchored on the red history marker
`■`** — mirroring `codex-api-error` so it inherits the same low-false-positive
discipline. The change is scoped so that **non-Codex and non-`■` inputs behave
exactly as today** (including the existing `limit` `?? +60 min` fallback and the
DOG HTTP-429 negative).

**Single parse, once.** Detection builds one *banner-evidence string* — the
limit-relevant window lines with footer/veto lines excluded (the same
`isRelevant` filter the limit rule already uses for `bannerText`) — and calls
the real API `parseResetTime(evidence, now)` exactly once. (Revision 1's
`parseResetTime(window)` was wrong: the API is `(text, now)` and the raw window
includes footer durations and unrelated clocks.)

**Codex `■`-anchored classification.** When the window contains a
Codex-platform line matching:

- `^■\s*exceeded retry limit, last status: 429\b` — Codex's 429 retry-exhaustion
  (source: `codex-rs/protocol/src/error.rs`). This line does not satisfy
  `LIMIT_RE`, so it is an explicit pattern and never reaches the existing limit
  rule ⇒ always `limit-open`; **or**
- `^■\s*` followed by a limit-reached phrase (`LIMIT_RE` **and** `REACHED_RE` on
  that line, e.g. "You've hit your usage limit") — then classify by the single
  parse: `parseResetTime(evidence, now)` non-null ⇒ **`limit`** (auto-resume,
  the existing path); null ⇒ **`limit-open`**.

**Precedence, stated precisely** (Revision 1's "unchanged rules first" was not
implementable because the existing rule keys on `RESET_RE.test(text)`, not parse
success):

- For a **Codex `■`-anchored reached-limit line**, the parse-success test above
  decides `limit` vs `limit-open` — this **overrides** the old `RESET_RE`
  presence gate for that specific case. So `■ …usage limit reached, try again
  later` (RESET_RE matches "try again", but no clock parses) becomes
  `limit-open` on Codex, instead of `limit` + blind +60 min. This is the
  intended improvement and the only behaviour change; it is Codex-`■`-only.
- Every other input is untouched: non-Codex, or no `■` anchor ⇒ the existing
  `limit`/`outage`/`null` rules run verbatim, preserving the `RESET_RE`-gated
  limit path, its `+60 min` fallback, and the HTTP-429-plus-footer negative
  (which is Claude-platform, no `■`, chrome only ⇒ still `null`).
- `limit-open` vs `outage`: distinct wordings; the existing last-contributing-
  line index rule decides if both somehow match. `matchedLine` = the `■` line;
  `patternId = 'limit-open'`; precedence index = that line's window index.

**Stalled-banner safety (mirror DOG-17, do not just anchor).** A bare "window
contains a line" test is unsafe: a *historical* limit-open error followed by
resumed work or a `Reconnecting…` row would wrongly trigger and stay eligible.
`limit-open` therefore reuses the DOG-17 machinery:

- **Retry vetoes** (already defined): `Reconnecting... N/M`, `Reconnecting...
  waiting for network`, `esc to interrupt` at or after the `■` line ⇒ not
  `limit-open` (the agent is still working).
- **Bounded continuation grammar.** The banner is the `■` line plus its
  wrapped continuation — the source-verified Codex usage-limit wording continues
  across a line break to "…purchase more credits or try again at <time>." — up
  to the sentence terminator. Continuation lines are matched, not treated as
  free prose.
- **Final block.** After the banner + continuation, only recognised chrome may
  follow (the DOG-17 Codex chrome set: composer `›` bare/placeholder, `N%
  context left`, `Context N% used · …`, `─ Worked for … ─`, `? for shortcuts`).
  Arbitrary following prose ⇒ not a live banner. This admits the real wrapped
  "purchase more credits." fixture and rejects a stale error followed by new
  output.

`inferPlatform` is unchanged: a `limit-open` banner only arises on a
Codex-identified terminal, so `platform` is always `codex` for it.

### 2. Connectivity gate (universal pre-send)

A new exported, injectable helper:

```
hasConnectivity(fetchImpl = globalThis.fetch, url = CONNECTIVITY_URL): Promise<boolean>
```

- **HTTPS, fail-closed**, mirroring `fetchIndicator`'s discipline: `fetch(url, {
  redirect: 'error', signal: AbortSignal.timeout(3000) })`; return `true` only
  on a genuine `r.ok` response; **any** thrown error, timeout, non-ok status, or
  redirect ⇒ `false`. `redirect: 'error'` and the ok check make a captive
  portal (which intercepts with a redirect, or fails TLS on HTTPS interception)
  read as **offline**, which is the safe answer — a portal that can answer but
  blocks the API must not count as connectivity.
- `CONNECTIVITY_URL` default `https://captive.apple.com/hotspot-detect.html`
  (HTTPS; the macOS captive-check host, adding no new privacy surface).
  Overridable via `WATCHDOG_CONNECTIVITY_URL`, validated like the status
  override in `statusUrlFor` (must be `http:`/`https:`; a malformed override is
  ignored with a warning and the default used). Injectable in tests.
- **Safety claim, narrowed:** a `true` result means "an HTTPS request just
  succeeded", not "the API will succeed." It is a necessary, not sufficient,
  condition — enough to avoid the dead-network case without over-promising.

**Placement in `tick`.** After `reconcile` yields `sendCandidates`, if there is
**any** candidate, probe connectivity **once per tick** and cache the boolean:

- Offline ⇒ **skip every send this tick** (limit, limit-open, **and** outage —
  the Revision-1 "skip the probe for outage-only ticks" optimisation is dropped
  because `fetchIndicator` fails open). Do not increment `attempts`, set
  `lastAttemptAt`, or otherwise mutate the event. Log at `debug`: `held N
  send(s): offline`.
- Online ⇒ proceed exactly as today; outage sends still additionally consult the
  status indicator (`suppressedByStatus`).

One extra HTTPS request per tick-that-has-candidates is negligible and buys a
single, order-independent, correct gate. No persisted state: a held event stays
`waiting` and is retried next tick.

### 3. Event schema (additive, stays v2)

`limit-open` events extend the v2 event with the alert lifecycle. Backward
compatible: existing `limit`/`outage` v2 files validate unchanged and need no
migration; the v1→v2 in-memory upgrade is untouched. `parseStateFile` still
accepts only `version` 1 or 2 and still writes 2. **Old-reader note:** a
pre-DOG-20 binary rejects the new kind/statuses and backs-up-and-resets the
whole file — acceptable for a single-user daemon, documented as the rollback
cost of a downgrade.

Additions:

- `KINDS` gains `limit-open` via a new `SCHEDULE['limit-open']` entry.
- `STATUSES` gains `awaiting-user` and `dismissed`.
- New field `alertedAt: string | null` — ISO when the alert was spawned, else
  `null`. **Legacy handling:** absent/`undefined` on old `limit`/`outage` events
  is normalised to `null` before validation (do not reject `undefined`); every
  `newEvent` branch initialises it (`null` for `limit`/`outage`).
- New field `episodeId: string` on `limit-open` events — an immutable per-episode
  nonce set at creation, binding the alert dialog to exactly this episode
  (§5). Absent on `limit`/`outage`.

`SCHEDULE['limit-open']` (retry cadence after consent — "every 30 min, capped"):

```
limit-open: { bufferMs: 0, retrySpacingMs: 30*MIN, rearmMs: 10*MIN,
              maxSends: 6, deadlineMs: 24*60*MIN, resumeText: RESUME_TEXT }
```

(`RESUME_TEXT` = the existing limit resume line — a rate limit, not an outage.)

`validateEvent` changes:

- `alertedAt`: `null` or ISO (after the legacy normalisation above).
- `episodeId`: required non-empty string for `kind === 'limit-open'`; absent
  otherwise.
- `kind === 'limit-open'` ⇒ `platform === 'codex'`.
- `awaiting-user`/`dismissed` are legal only for `kind === 'limit-open'`.
- **Relax the `lastAttemptAt === null` rule** so it admits every state that can
  legitimately have made no send yet: `waiting` (as today), `awaiting-user`,
  `dismissed`, **and `gave_up` for deadline-bearing kinds** (`outage`,
  `limit-open`). A consented event can expire the 24 h deadline with `attempts:
  0, lastAttemptAt: null` (occupied input, failed reads); Revision 1 (and the
  current code, for outages) would reject it and reset the whole file. Do not
  fabricate a timestamp — admit the honest zero-attempt `gave_up`.

### 4. Reset-less alert lifecycle

`newEvent` for a `limit-open` banner creates:

```
{ handle, kind: 'limit-open', platform: 'codex', bannerText,
  detectedAt: now, resetAt: now,
  attempts: 0, lastAttemptAt: null,
  status: 'awaiting-user', alertedAt: null, episodeId: <nonce> }
```

**`tick` transitions (side effects live in `tick`, not `reconcile`; all no-ops
under `--dry-run`, see below):**

1. **Claim, then spawn — once.** For a `limit-open` event with `status ===
   'awaiting-user'` and `alertedAt === null`: **persist `alertedAt = now`
   first** (the episode claim), then spawn the alert (§5). Persist-before-spawn
   means a crash after spawn never re-alerts on restart (at-most-once alert; a
   crash *before* the child shows may drop the alert — accepted, safe direction:
   no send). No send this pass.
2. **Await the choice.** `status === 'awaiting-user'`, `alertedAt` set: read the
   choice file for this handle (§5). None ⇒ do nothing (wait indefinitely for
   the human). A choice whose `episodeId` matches the event's ⇒ **persist the
   transition, then delete the result file** (persist-before-delete: a crash
   never loses consent). A choice with a mismatched `episodeId` (stale prior
   episode) ⇒ delete and ignore.
   - **Continue** ⇒ `status = 'waiting'`, `resetAt = now`, `detectedAt = now`
     (see deadline contract below). Enters the `limit-open` send cycle:
     connectivity-gated (§2), **not** status-gated (a rate limit needs no
     `status.*` check).
   - **Wait 1 h** ⇒ `status = 'waiting'`, `resetAt = now + 60 min`, `detectedAt
     = now`. Same cycle thereafter, so a wrong 1 h guess still retries up to the
     cap.
   - **Stop** ⇒ `status = 'dismissed'`. Never alerted or sent again (§ Stop
     stickiness).
3. **Send cycle.** Once `status === 'waiting'`, the existing reconcile rule 5c /
   `tick` send path apply with the `limit-open` schedule, plus §2. **Tick
   ordering:** `sendCandidates` is computed in `reconcile` before the alert pass,
   so a just-consented event first sends on the **next** tick (≤5 min later) —
   no re-reconcile, no unconditional event scan that could disturb frozen /
   first-miss events.

**Deadline (time contract).** The 24 h `limit-open` deadline is measured from
**consent**, wall-clock. Implemented by setting `detectedAt = now` on the
Continue/Wait-1 h transition, so the existing rule 5a
(`now - detectedAt >= deadlineMs`) counts from consent for both buttons — giving
exactly 24 h consent-to-expiry (fixing Revision 1's 25 h Wait-1 h skew), with
`resetAt` independently governing first-send eligibility. Offline time counts
against this cap (§Goal).

**Rule 5a/5b exemption.** `awaiting-user` and `dismissed` are skipped by the
deadline (5a) and rearm (5b) rules: an unanswered alert never ages into
`gave_up`, and `dismissed` is terminal for the episode.

**Stop stickiness (finding #7 — John's decision: Stop survives banner
mutation).** `reconcile` rule 4 (replace on kind/platform change) is
**suppressed for a `dismissed` event**: a dismissed `limit-open` whose banner
later gains a reset time (or otherwise mutates) is **not** replaced into a fresh
auto-resumable `limit`; the dismissal persists. Only rule 3's confirmed
banner-clear (first-miss hold, second-miss delete — DOG-11) ends a dismissed
episode; a later fresh banner then starts a new episode with a new `episodeId`.
For an **`awaiting-user`** event (the human has not yet decided), a genuine
kind/platform mutation **does** replace it (the situation changed before the
decision); any pending dialog result is invalidated by `episodeId` mismatch, so
a late click cannot act on the replaced event.

**De-duplication.** Exactly one alert per episode: `alertedAt` + `episodeId` are
persisted, so a restart never re-spawns; handle-keying plus `episodeId` make
banner-text mutation unable to spawn duplicates or misapply a stale click.

### 5. The alert mechanism (self-reinvoke `--alert`, message as data)

The daemon runs by launchd and **exits after each tick**, so the alert must
outlive it: a detached child shows the dialog, waits for the click (possibly
much later), writes the choice, and exits on its own.

- **No shell, no code-interpolation.** The message is passed as **data**, never
  concatenated into an interpreter string (fixes the AppleScript-injection
  blocker). The daemon spawns a detached copy of itself in a new internal
  `--alert` mode:

  ```
  spawn(process.execPath, [__filename, '--alert'], {
    detached: true, stdio: 'ignore',
    env: { ...process.env,
           WATCHDOG_ALERT_MESSAGE: sanitize(bannerText),   // data, via env
           WATCHDOG_ALERT_HANDLE: handle,
           WATCHDOG_ALERT_EPISODE: episodeId,
           WATCHDOG_ALERT_CHOICE_FILE: <per-episode final path> },
  }).unref()
  ```

  Injectable as `deps.spawn`; tests never spawn.
- **`--alert` mode** (same `watchdog.mjs`, so the single-file convention holds):
  reads the env vars and runs `osascript` via `execFile('osascript', ['-e', 'on
  run argv', '-e', 'return button returned of (display alert "orca-limit-
  watchdog" message (item 1 of argv) buttons {"Stop","Wait 1h","Continue"}
  default button "Continue")', '-e', 'end run', '--', message])`. The message is
  `item 1 of argv` — **AppleScript data, not source** — so quotes, backslashes,
  `$()`, backticks, newlines in the banner are inert. On a button return, write
  `{ choice, episodeId, at }` to a **per-episode unique temp** then atomically
  rename to the per-episode final path `choices/<handle>.<episodeId>.json`
  (fixes the shared-`.tmp` race — each episode's temp and final names are
  unique, so concurrent dialogs never cross). **On any osascript error,
  non-zero exit, or empty result, write nothing** (the event stays
  `awaiting-user`; no empty-choice file). Handle the child's async `error` event
  as well as a throw. `--alert` never reads or writes state.json and never
  sends.
- **Consuming (`tick`, injectable `deps.readChoice`/`deps.clearChoice`):** for a
  handle's `awaiting-user` event, read `choices/<handle>.<episodeId>.json`;
  honour it only if its `episodeId` equals the event's; persist the transition;
  then delete the file. Malformed JSON, bad timestamp, missing dir, or read/
  unlink errors are **bounded per-event failures** (logged, the tick continues
  for other terminals) — never a thrown tick abort.
- **Failure is safe.** Spawn/osascript failure ⇒ no choice file ⇒ event stays
  `awaiting-user`; `alertedAt` is already set so no re-spawn storm. If the human
  never answers, the daemon does nothing. Spawn failure logged at `warn`.

**Dry-run.** `--dry-run` must produce **zero** side effects from the alert pass:
no `spawn`, no `alertedAt`/transition persistence, no choice-file read-delete,
no other fs mutation — descriptive logging only (extending the existing dry-run
contract that already skips the send loop and the final save).

### 6. Unchanged behaviour (for the reviewer's reference)

- Reset-bearing `limit` and all `outage` behaviour, banner-cleared hold
  (DOG-11), platform inference for existing kinds, the send-safety guards
  (shell-prompt / input-draft / veto), atomic state writes, backup-and-reset on
  a corrupt state file, the `major`/`critical` status suppression.
- The 5-minute launchd cadence and read → reconcile → act → exit model.
- **Non-Codex / non-`■` detection** — verbatim (see §1).

## Safety properties (delta)

- **No unsolicited reset-less send.** A `limit-open` event never sends until the
  human clicks Continue or Wait 1 h; the default (no click) is inaction.
- **No send into a dead network.** Every send (all kinds) is gated on a
  fail-closed connectivity probe; offline holds without spending an attempt.
- **No injection.** The alert message is AppleScript data via argv, spawned
  without a shell; handles/paths are daemon-supplied.
- **No cross-episode / cross-terminal consent leak.** Per-episode unique choice
  files and `episodeId` equality bind a click to exactly one episode.
- **At-most-once alert**, persisted across restarts, immune to banner-text
  mutation.
- **Crash/dry-run safe.** Persist-before-spawn and persist-before-delete bound
  crash outcomes to "no send"; dry-run is fully inert.
- **No new dependency.** `osascript`, `node` (self), and `fetch` are all
  platform-provided.
- **Tight detection.** Codex `■` anchor + retry-veto + final-block preserve the
  HTTP-429 negative and DOG-17's stalled-banner safety; non-Codex behaviour is
  unchanged.
- **State-file resilience.** Legitimate zero-attempt `gave_up` and legacy
  `alertedAt`-absent events validate, so one edge event never resets the whole
  file.

## Files

- `watchdog.mjs` — detection (`limit-open`), `SCHEDULE`/`KINDS`/`STATUSES`,
  `newEvent`, `validateEvent` (legacy `alertedAt`, `episodeId`, zero-attempt
  `gave_up`), `parseStateFile` normalisation, `hasConnectivity`, `reconcile`
  (rule-4 Stop suppression, 5a/5b exemption), `tick` (connectivity gate + alert
  lifecycle + choice consumption + dry-run guards), `--alert` mode,
  spawn/readChoice/clearChoice deps.
- `watchdog.test.mjs` — new unit tests (§Testing).
- `docs/superpowers/specs/2026-09-07-outage-resume-design.md` — cross-reference
  note pointing here for the reset-less path and the connectivity gate.
- `README.md` — document the alert, the connectivity gate + override env var,
  and the choice-file location under `~/.local/state/orca-limit-watchdog/choices/`.

No `package.json`, no new dependency (project invariant).

## Testing

All `node --test`, pure/injectable, never against live terminals (Safety).

**Connectivity gate (§2):**

- `hasConnectivity`: fake `fetchImpl` — `r.ok` ⇒ `true`; throw / timeout /
  non-ok / redirect ⇒ `false`. Malformed override ⇒ default used + warn.
- `tick` offline (probe `false`): due `limit`, `limit-open`, **and** outage
  candidates are not sent; `attempts`/`lastAttemptAt` unchanged; held logged.
- `tick` online: the same candidates send (outage still subject to
  `suppressedByStatus`).
- Captive-portal simulation: a redirecting/non-ok probe reads offline.

**Reset-less detection (§1):** against the **real captured** strings —

- `["■ exceeded retry limit, last status: 429", "› Ask Codex to do anything"]`,
  `codex` ⇒ `limit-open`.
- `["■ You've hit your usage limit. Upgrade to Pro …", "purchase more credits."]`,
  `codex` ⇒ `limit-open` (no reset present); wrapped continuation admitted.
- The live "…or try again at 10:12 PM." banner ⇒ `limit` (regression guard).
- `["■ …usage limit reached, try again later", …]`, `codex` ⇒ `limit-open`
  (RESET_RE present but no clock parses — the intended override).
- `429`-plus-a-real-reset on `codex` ⇒ `limit` (parse wins).
- The DOG false-positive fixture (Claude, no `■`) ⇒ `null` (unchanged).
- Same `■` line with `platform: 'unknown'` ⇒ `null`.
- Stalled-banner negatives: a historical `■` limit-open line followed by new
  prose / `Reconnecting…` / `esc to interrupt` / a draft / shell prompt / ANSI
  ⇒ `null`.
- Cross-class chronology and footer/unrelated-clock inputs behave per the
  filtered-evidence rule.
- **Amend the existing fallback test** (`watchdog.test.mjs:~391`): document that
  non-Codex unparseable resets are unchanged (still `limit` + fallback), and add
  the Codex-`■` override cases.

**Alert lifecycle (§4/§5):** fake `deps.spawn`, `deps.readChoice`,
`deps.clearChoice`, `deps.now` —

- First tick: persists `alertedAt` before spawning (assert order), spawn args
  carry the three buttons and the message via env (not concatenated), sends
  nothing.
- Second tick, no choice: no re-spawn, no send.
- Continue ⇒ `waiting`, `resetAt = now`, `detectedAt = now`; then (online) sends
  on the `limit-open` schedule; capped at 6.
- Wait 1 h ⇒ `waiting`, `resetAt = now + 60 min`, consent-to-deadline exactly
  24 h; no send before `resetAt`.
- Stop ⇒ `dismissed`; never sends; **survives a kind/platform mutation** (rule-4
  suppression) and is removed only by a confirmed banner-clear.
- Stale/mismatched `episodeId` choice: ignored and cleared.
- Two handles with opposite choices (deterministic interleave): each event gets
  its own choice via unique files/`episodeId`; no cross-attribution.
- `spawn` throws / child `error` event: event stays `awaiting-user`, `alertedAt`
  set, no send, warn logged.
- **Dry-run:** an unalerted event and pending Continue/Wait/Stop choices produce
  no spawn, no persistence, no choice deletion — dependencies throw if any
  forbidden effect occurs.
- **Process-survival:** a harmless isolated helper-survival test (detached child
  writes a temp file after the parent exits); Aqua/launchd dialog rendering is
  an authorised post-merge manual gate, not a unit test.

**Schema (§3):**

- `validateEvent` accepts a well-formed `limit-open` (with `episodeId`); rejects
  `platform !== 'codex'`, `awaiting-user`/`dismissed` on `limit`/`outage`,
  `awaiting-user` with `attempts > 0`, a bad `alertedAt`, a missing `episodeId`.
- `validateEvent` accepts a zero-attempt `gave_up` for `outage` and `limit-open`.
- `parseStateFile`: **round-trip every lifecycle state** (reconcile → serialise
  → parse), especially deadline expiry with no send; a legacy file whose events
  omit `alertedAt` loads (normalised to `null`); a file mixing legacy and new
  events loads; v1 still upgrades; unknown versions still reset.

**Deploy:** post-merge `install.sh` from the main checkout only; `watchdog.mjs`
changes are verified with the unit fixtures, never by re-installing from a
worktree (Safety).

## Round-1 review resolutions

Codex round 1 (`.superpowers/reviews/dog-19-20-spec-round-1.md`) raised 13
findings; all accepted, none dismissed.

1. **(blocker) outage sends offline** — §2: gate covers outage too; per-tick
   probe, optimisation dropped (`fetchIndicator` fails open, verified).
2. **(blocker) AppleScript injection** — §5: `--alert` self-reinvoke, message as
   argv **data**, no `/bin/sh`.
3. **(blocker) shared `.tmp` race** — §5: per-episode unique temp/final files +
   `episodeId` equality.
4. **(major) offline deadline / rule 5a ordering** — §4 time contract:
   wall-clock 24 h from consent (`detectedAt = now` on consent), 5a/5b exempt
   pre-consent states; offline-counts-against-cap stated in §Goal.
5. **(major) zero-attempt `gave_up` rejected** — §3: validator admits it for
   deadline-bearing kinds; round-trip tests added.
6. **(major) legacy events lack `alertedAt`** — §3: normalise absent→`null`,
   initialise in all constructors.
7. **(major) rule 4 overrides Stop** — §4: rule-4 suppressed for `dismissed`
   (John: Stop sticks until confirmed clear); `awaiting-user` replaced with
   `episodeId` invalidation.
8. **(major) reset precedence unimplementable** — §1: single filtered evidence
   string, `parseResetTime(evidence, now)` once, Codex-`■` parse-success split;
   non-Codex unchanged; fallback test amended.
9. **(major) anchor ≠ DOG-17 safety** — §1: retry vetoes + bounded continuation
   grammar + final-block chrome; negatives tested.
10. **(major) alert/choice crash & episode races** — §4/§5: persist-before-
    spawn, persist-before-delete, `episodeId` binding, child `error` handling,
    no empty-choice-on-failure.
11. **(major) dry-run protection missing** — §4/§5: alert pass fully inert under
    `--dry-run`; tests with throwing deps.
12. **(major) HTTP probe captive-portal false positive** — §2: HTTPS,
    `redirect:'error'`, `r.ok` only, fail-closed; safety claim narrowed;
    override validated.
13. **(minor) tick ordering / survival evidence** — §4: consent sends next tick,
    no double-reconcile, freezes preserved; §Testing: isolated helper-survival
    test, launchd rendering deferred to a post-merge manual gate.
