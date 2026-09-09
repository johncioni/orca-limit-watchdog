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

**Revision 4 (2026-09-08)** incorporates Codex spec-review rounds 1-3
(`.superpowers/reviews/dog-19-20-spec-round-{1,2,3}.md`). Round 1: 13 findings,
all accepted. Round 2: 10 confirmed resolved, rest addressed. Round 3: all
round-2 fixes verified with no regressions, 2 bounded detection corrections
(both my Revision-3 edits) fixed here. See the "review resolutions" sections at
the end for the finding→fix maps.

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

**Detector contract (finding R2 #2).** `detectBanner` gains an injectable `now`
— `detectBanner(lines, platform = 'unknown', now = new Date())` — backward
compatible with existing two-argument callers. When it selects a limit/limit-open
banner it parses the reset time **once**, over the *selected evidence block*
(below), and returns that parsed `resetAt` (or `null`) on the banner object so
`newEvent` consumes it directly and **never re-parses** the truncated
`bannerText`. (Revision 2 left a second parse in `newEvent` over the
sanitized/600-char-capped `bannerText`; a reset beyond the cap could classify as
`limit` then vanish at construction, reviving the blind fallback.)

**Selected evidence block.** Classification parses only the *chosen candidate's
contiguous block* — the `■` line plus its bounded continuation (below) — **not**
a whole-window `isRelevant` join, so an earlier, unrelated reset-bearing line can
never be attached to a newer no-reset limit. `bannerText` for storage is built
from that same block.

**Codex `■`-anchored classification — both shapes, one split (findings R2
#1, #8).** A Codex-platform `■` line that is EITHER:

- `^■\s*exceeded retry limit, last status: 429\b` — the **429-only**
  retry-exhaustion line (source: `codex-rs/protocol/src/error.rs`); it does not
  satisfy `LIMIT_RE`, so it is recognised explicitly. **The status must be 429**:
  `5\d\d` on this line is already the DOG-17 **outage** pattern
  (`watchdog.mjs:87`) and stays there; any other status matches neither rule
  (`null`). Generalising to `<status>` (a Revision-3 slip) would collide with the
  outage pattern and, on the limit-favouring index tie, convert a status-gated
  5xx outage into an alert — do not; **or**
- `^■\s*` + a limit-reached phrase (`LIMIT_RE` **and** `REACHED_RE`, e.g.
  "You've hit your usage limit"),

forms a **Codex limit candidate**, classified by a single
`parseResetTime(evidenceBlock, now)`: reset parses ⇒ **`limit`** (auto-resume);
`null` ⇒ **`limit-open`**. Thus `■ exceeded retry limit, last status: 429` alone
⇒ `limit-open`; that line (or a usage-limit line) **plus a real "try again at
<time>" continuation** ⇒ `limit`; `■ …usage limit reached, try again later` (no
clock) ⇒ `limit-open`. This resolves the Revision-2 contradiction (429 was
wrongly "always limit-open" while a test required 429+reset ⇒ `limit`): **both
shapes go through the same split.**

**No legacy fallback for a rejected Codex candidate.** Once a line is a Codex
`■` limit candidate it is classified only by the split above; it never falls
through to the old `RESET_RE`-gated limit rule and cannot regain automatic
eligibility that way. Non-Codex / non-`■` inputs still run the existing rules
verbatim (preserving the `+60 min` fallback and the HTTP-429-plus-footer
negative, which is Claude-platform, no `■` ⇒ still `null`).

**Arbitration.** A parsed Codex `limit` competes with an `outage` by the existing
last-contributing-line index — its index is the block's **last** line — same as
today; `limit-open` uses the `■` line's index. With multiple limit lines the
last wins. `matchedLine` = the `■` line; `patternId` = `'limit'` or
`'limit-open'`.

**Stalled-banner safety and continuation grammar (mirror DOG-17, findings R2
#3, #9).** A bare "window contains a line" test is unsafe: a *historical*
limit-open error followed by resumed work or a `Reconnecting…` row would wrongly
trigger. The candidate block and its final-block check reuse DOG-17 exactly:

- **Full retry veto set** (not only three examples): the complete existing veto
  list applies at/after the `■` line — `esc to interrupt`, every `Reconnecting…`
  form, etc. ⇒ not a stalled banner.
- **Bounded continuation, named forms.** The banner block is the `■` line plus
  the source-verified Codex usage-limit continuation, matched as **named forms up
  to ≤ 3 wrapped lines**, not arbitrary following sentences:
  - `You've hit your usage limit.` [+ `Upgrade to Pro (<url>), visit <url> to
    purchase more credits`] [+ `or try again at <time>.`] — the live wrap spans
    "…to" / "purchase more credits or try again at <time>.";
  - `You've hit your usage limit. Try again at <time>.`;
  - `exceeded retry limit, last status: 429` [+ an optional bounded `Try again
    at <time>.` continuation on the next line]. The bare line ⇒ `limit-open`; the
    line **plus** the reset continuation puts that time in the evidence block so
    the single parse yields `limit`. Unrelated following prose is not a valid
    continuation and is rejected (finding R3 #2 — this keeps the "429 + reset ⇒
    limit" contract reachable, which the single-line form contradicted).
  The block ends at the terminal sentence of the matched form. An *internal*
  period (after "usage limit.") is distinguished from the banner's end, so the
  required wrapped "purchase more credits." fixture is accepted while near-miss
  trailing prose is rejected.
- **Final block.** After the matched block, only DOG-17 Codex chrome may follow
  (composer `›` bare/placeholder, `N% context left`, `Context N% used · …`,
  `─ Worked for … ─`, `? for shortcuts`). Arbitrary prose ⇒ not live ⇒ the
  candidate is rejected (and, per above, does not fall back to legacy limit
  detection).

The implementer writes tolerant regexes for these named forms and tests them
against the real captured fixtures plus near-miss continuation / stale-prose
negatives.

`inferPlatform` is unchanged: a `limit-open` banner only arises on a
Codex-identified terminal, so `platform` is always `codex` for it.

### 2. Connectivity gate (universal pre-send)

A new exported, injectable helper:

```
hasConnectivity(fetchImpl = globalThis.fetch, url = CONNECTIVITY_URL): Promise<boolean>
```

- **HTTPS default, fail-closed**, mirroring `fetchIndicator`'s discipline:
  `fetch(url, { redirect: 'error', signal: AbortSignal.timeout(3000) })`; return
  `true` only on a genuine `r.ok` response; **any** thrown error, timeout,
  non-ok status, or redirect ⇒ `false`. `redirect: 'error'` and the ok check
  make a captive portal that intercepts with a redirect, or fails TLS on HTTPS
  interception, read as **offline** (the safe answer).
- `CONNECTIVITY_URL` default `https://captive.apple.com/hotspot-detect.html`
  (the macOS captive-check host, no new privacy surface). **Override contract
  (finding R2 #9), stated once and consistently:** overridable via
  `WATCHDOG_CONNECTIVITY_URL` but — exactly like `statusUrlFor` — the override is
  accepted **only for a loopback host** (`http:`/`https:`; this is how the
  `e2e/status-stub` test drives it); any non-loopback or malformed override is
  ignored with a warning and the default used. So `true` means "the configured
  probe URL returned ok" (HTTPS for the real default; loopback HTTP only under a
  test override).
- **Safety claim, narrowed (finding R2 #9, #12):** `true` means a probe request
  just succeeded, not that the API will succeed — a portal that *allows the probe
  host* while restricting other traffic can still read online. It is a
  necessary, not sufficient, condition: enough to avoid the dead-network case
  without over-promising. Redirect/TLS failures hold sends; probe reachability
  never establishes API reachability.

**Placement in `tick`.** After `reconcile` yields `sendCandidates`, if there is
**any** candidate, probe connectivity **once per tick** and cache the boolean.
**Dry-run bypass (finding R2 #7):** under `--dry-run` the tick performs **no
network I/O at all** — neither the connectivity probe nor the outage
`fetchIndicator` runs (the existing dry-run test forbids network calls); it logs
the candidates it *would* gate and sends nothing. The gate below applies only on
a real run:

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
  nonce binding the alert dialog to exactly this episode (§5). **Source (finding
  R2 #5):** `randomUUID()` from `node:crypto` (dependency-free, available below
  the Node 20 floor), generated once per new episode via an **injectable
  generator** (`deps.newEpisodeId`) so reconcile tests are deterministic. A
  timestamp or per-process counter is unacceptable — episode uniqueness is now
  the consent-isolation boundary, and two same-handle episodes created at the
  same injected `now` must still differ. The ID is filename-safe (UUID) and is
  the only variable component of the choice-file name; the `handle` path
  component is validated/encoded before use in a path. Absent on
  `limit`/`outage`.

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
  blocker; the env→argv transport is what makes it safe, so it is kept). The
  daemon spawns a detached copy of itself in a new internal `--alert` mode:

  ```
  import { fileURLToPath } from 'node:url';
  const SELF = fileURLToPath(import.meta.url);   // __filename does NOT exist in ESM (R2 #4)
  spawn(process.execPath, [SELF, '--alert'], {
    detached: true, stdio: 'ignore',
    env: { ...process.env,
           WATCHDOG_ALERT_MESSAGE: <handle + ' — ' + sanitize(bannerText)>, // handle shown (R2 #6)
           WATCHDOG_ALERT_EPISODE: episodeId,
           WATCHDOG_ALERT_CHOICE_FILE: <per-episode final path> },
  }).unref()
  ```

  The displayed message leads with the terminal `handle` (and, if cheaply
  available, its title) **outside** the banner truncation, so two terminals with
  identical banner text produce **distinguishable** dialogs (R2 #6). Injectable
  as `deps.spawn`; tests never spawn.
- **`--alert` mode — exclusive, early dispatch (finding R2 #4).** The entry
  guard must detect `--alert` and route to the alert handler **before** any
  normal `main()` / lock / state-file / disabled-file / tick-deadline
  processing, and `return` — so `--alert` can never fall through to a tick,
  inherit the 4-minute deadline, or send. (`main()` today ignores unknown flags
  and reaches a tick, so an explicit early branch is required, not flag
  tolerance.) A malformed/mixed alert invocation, or missing/invalid env data,
  logs and exits **without** running a tick. The handler:
  - runs `osascript` at its **absolute system path** via `execFile('/usr/bin/osascript',
    ['-e', 'on run argv', '-e', 'return button returned of (display alert
    "orca-limit-watchdog" message (item 1 of argv) buttons
    {"Stop","Wait 1h","Continue"} default button "Continue")', '-e', 'end run',
    '--', message])`. The message is `item 1 of argv` — **AppleScript data, not
    source** — so quotes, backslashes, `$()`, backticks, newlines, a leading
    dash, and Unicode are inert;
  - **validates and trims** the returned button against the exact three-value
    allow-list (`Stop` / `Wait 1h` / `Continue`); anything else ⇒ write nothing;
  - **creates the `choices/` directory** if absent, writes `{ choice, episodeId,
    at }` to a **per-episode unique temp**, then atomically renames to the
    per-episode final path `choices/<handle>.<episodeId>.json` (unique temp and
    final names ⇒ concurrent dialogs never cross);
  - **awaits its own execFile/write** before exiting (it must not race the
    parent's exit or enter any tick timeout);
  - **on any osascript error, non-zero exit, or empty/invalid result, writes
    nothing** (the event stays `awaiting-user`; no empty-choice file). Handles
    the child's async `error` event as well as a throw.
  `--alert` never reads or writes `state.json` and never sends.
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
- **Dry-run makes no network call (finding R2 #7):** due `limit`, `limit-open`,
  `outage`, and mixed-candidate ticks under `--dry-run` with a `fetchImpl` that
  **throws if called** — neither the connectivity probe nor `fetchIndicator`
  runs; candidates are logged, nothing sends.

**Reset-less detection (§1):** against the **real captured** strings —

- `["■ exceeded retry limit, last status: 429", "› Ask Codex to do anything"]`,
  `codex` ⇒ `limit-open`.
- **Exact-kind status coverage (finding R3 #1):** bare `…429` ⇒ `limit-open`;
  `…429` + `Try again at 10:12 PM.` ⇒ `limit` (continuation parse, finding R3
  #2); `…last status: 503 …` ⇒ **`outage`** (stays on the DOG-17 path, not a
  limit); a non-429/non-5xx status ⇒ `null`. Assert the exact `kind`, not just
  truthiness — the existing 503 fixture (`watchdog.test.mjs:120-122`) only
  asserts truthy and would miss this regression; tighten it.
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
- **Intentional existing-test changes (finding R2 #8):** the assertion at
  `watchdog.test.mjs:~126` that the anchored Codex `■ …429` line returns `null`
  **must flip to `limit-open`** (this is the feature). The unanchored fallback
  test at `~391-394` **retains** its current expectation (non-Codex unparseable
  reset ⇒ `limit` + fallback, unchanged). Keep an **ANSI-wrapped valid banner**
  positive case distinct from the "ANSI-only ⇒ null" negative.

**Alert lifecycle (§4/§5):** fake `deps.spawn`, `deps.readChoice`,
`deps.clearChoice`, `deps.now` —

- First tick: persists `alertedAt` before spawning (assert order); **parent
  spawn** assertion checks argv `[SELF, '--alert']` + the env (message with
  handle, episodeId, choice-file) — the three buttons belong to the **helper's
  `execFile('/usr/bin/osascript', …)`**, asserted separately in an `--alert`-mode
  test, not on the parent spawn (finding R2 #8). Sends nothing.
- `--alert` mode (invoked directly with env set, `deps.execFile` faked): builds
  the osascript argv with the three buttons and the message as `item 1 of argv`;
  validates the returned button against the allow-list; writes the per-episode
  choice file; is inert on osascript error/empty/invalid; never touches state or
  sends; a bad/mixed invocation exits without a tick.
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

## Round-2 review resolutions (Revision 3)

Codex round 2 (`.superpowers/reviews/dog-19-20-spec-round-2.md`) confirmed 10 of
13 round-1 findings resolved and raised the following; all accepted and
addressed in Revision 3.

- **R2 #1 / #8 (429 classification contradiction)** — §1: both Codex `■` limit
  shapes (429 line and reached-limit line) go through the **same** reset/no-reset
  split; 429+reset ⇒ `limit`, bare 429 ⇒ `limit-open`. Test-list corrected.
- **R2 #2 (detector→event contract)** — §1: `detectBanner(lines, platform, now)`,
  parse once over the *selected contiguous block*, carry `resetAt` into
  `newEvent` (no second parse of capped `bannerText`); arbitration and legacy
  construction specified.
- **R2 #3 (continuation grammar)** — §1: named, bounded (≤3-line) Codex banner
  forms; internal-period vs banner-end distinction; full veto set; final-block
  chrome; rejected candidate does not fall back to legacy detection.
- **R2 #4 (ESM self-reinvoke)** — §5: `fileURLToPath(import.meta.url)` (not
  `__filename`); exclusive early `--alert` dispatch before main/lock/state/tick;
  absolute `/usr/bin/osascript`; button allow-list; awaits its own work.
- **R2 #5 (nonce source)** — §3: `randomUUID()` from `node:crypto`, injectable
  generator, filename-safe, handle path component validated.
- **R2 #6 (dialog identifies terminal)** — §5: displayed message leads with the
  handle (outside truncation) so identical banners on different handles render
  distinguishably.
- **R2 #7 (probe in dry-run)** — §2/§Testing: dry-run does **no** network I/O
  (no probe, no `fetchIndicator`); tests use a throwing `fetchImpl`.
- **R2 #9 (override/portal contract)** — §2: override accepted only for a
  loopback host (like `statusUrlFor`); `true` = "probe returned ok", never API
  reachability; portal-allows-probe caveat stated.

## Round-3 review resolutions (Revision 4)

Codex round 3 (`.superpowers/reviews/dog-19-20-spec-round-3.md`) verified all
nine round-2 fixes with no regressions in the settled helper/schema/connectivity
design, and raised two bounded detection corrections (both introduced by
Revision-3 edits); both fixed here:

- **R3 #1 (retry-limit status over-broadened)** — §1: restored **429-only** for
  the `exceeded retry limit` line; `5xx` stays on the DOG-17 outage path, other
  statuses ⇒ `null`. §Testing adds exact-kind assertions (429⇒limit-open,
  503⇒outage, other⇒null) and tightens the truthy-only 503 fixture.
- **R3 #2 (429 reset-continuation unreachable)** — §1: the 429 named form now
  allows an optional bounded `Try again at <time>.` continuation, so
  `429`+reset ⇒ `limit` is reachable (resolving the contradiction with the
  classification contract); bare 429 ⇒ `limit-open`; unrelated prose rejected.

Review-policy note: rounds 1-3 are complete (round 3 was at John's request,
beyond the two-round default). The design is verified stable; remaining work is
implementation, where the detection fixtures above are pinned in the DOG-20 plan
and TDD'd against the real captured strings under the Opus code-review loop.
