# orca-limit-watchdog — Reset-less limit alerts & connectivity gate

Design spec. Adds two capabilities to `watchdog.mjs`:

1. **Reset-less limit alert** — when an agent hits a limit we cannot auto-resume
   (no derivable reset time, e.g. Codex's `■ exceeded retry limit, last status:
   429` or a usage-limit banner with no "try again at …"), the daemon asks the
   human what to do via a native macOS alert with three buttons, instead of
   guessing or silently doing nothing.
2. **Universal connectivity gate** — before sending any resume prompt (limit or
   outage), the daemon confirms the machine is online; offline, it pauses
   without spending an attempt and resumes when connectivity returns.

Companion to the outage-resume design
(`2026-09-07-outage-resume-design.md`) and the original design
(`2026-07-23-orca-limit-watchdog-design.md`). Tracked as DOG-19 (connectivity
gate) and DOG-20 (reset-less alert); see "Sequencing".

## Problem

The daemon resumes a stalled terminal only when it can compute *when* to act:

- A **reset-bearing limit** ("Session limit … try again at 10:12 PM") parses a
  reset time and auto-resumes. This already works — verified against a live
  Codex banner: `detectBanner` returns `limit`, `parseResetTime` resolves the
  clock time, and the terminal would resume at reset + 2 min.
- An **outage** banner has no reset time but a known recovery signal
  (`status.*`), so it retries on a fixed schedule gated on the status page.

Two real cases fall through:

- **Reset-less limit.** Codex's retry-exhaustion line `■ exceeded retry limit,
  last status: 429` carries no reset time; the DOG-17 amendment deliberately
  excludes it from the outage rule (it is a rate limit, not a 5xx outage), and
  the limit rule cannot fire without a reset time — so `detectBanner` returns
  `null` and the terminal stalls indefinitely with no action and no notice.
  A usage-limit banner that states no "try again at …" has the same problem;
  today the limit rule's `?? now + 60 min` fallback would blind-guess an hour,
  which is arbitrary.
- **Local network outage.** A **limit** resume has no reachability check at all,
  so a rate-limit reset that fires while the machine is offline types a resume
  prompt into a dead session. (Outage resumes are already implicitly gated: the
  `status.*` fetch fails when offline, so the send is held.)

## Goal

Do the right, bounded thing in both cases:

- Reset-less limit: surface a **decision request** to the human (continue
  auto-retry / wait 1 h / stop) and act on the answer, defaulting to "do
  nothing" until they answer.
- Connectivity: never send into a dead network; pause (not spend) attempts while
  offline; resume when back.

Worst-case failure stays bounded and benign: at most one line of text typed into
a terminal, and only when the machine is online and the human either consented
or the reset was known.

## Non-goals

- General status notifications, worktree-card updates, launching Orca, reviving
  exited processes, non-Orca terminals — unchanged from the original design.
- **Amendment to the original design's "notifications" non-goal:** the original
  spec lists "notifications" as out of scope. This spec narrowly amends that:
  the alert is a *decision request confined to the one case where autonomous
  resume is unsafe* (no derivable reset time). It is not a general notification
  channel — no "resumed OK", no "outage detected", no status chatter.
- Detecting a specific "no internet" banner. The connectivity gate is an active
  reachability probe on the send path, so it does not depend on matching any
  agent's offline wording.
- Claude reset-less limits. Claude Code's limit state always carries a reset
  (its usage footer), so the reset-less path is Codex-shaped in practice. The
  detection is written generally but gated to a Codex `■`-anchored banner to
  keep false positives out (see §1).

## Sequencing

Two independent capabilities, two implementation tasks / PRs. Both touch
`watchdog.mjs` (an invariant file), so each gets the full review loop.

1. **DOG-19 — connectivity gate.** Lower risk, closes a live gap, no new I/O
   surface. Ship first.
2. **DOG-20 — reset-less limit alert.** New detached-child + osascript + choice
   file machinery and a new event kind. Ship second, on top of DOG-19.

The connectivity gate (§2) applies to the reset-less retry cycle once DOG-20
lands, but neither task requires the other to be correct.

## Design

### 1. Detection: a reset-less limit banner class

A new banner `kind: 'limit-open'` ("open-ended" — a real limit banner with no
derivable reset). Added to `detectBanner`, gated to **Codex** and anchored on
the red history marker `■`, mirroring the `codex-api-error` approach so it
inherits the same low-false-positive discipline.

`detectBanner` recognises `limit-open` when the window contains a line matching
either:

- `^■\s*exceeded retry limit, last status: 429\b` — Codex's 429 retry-exhaustion
  (source: `codex-rs/protocol/src/error.rs`; the DOG-17 amendment names this the
  rate-limit path), **or**
- `^■\s*` followed by a limit-reached phrase (`LIMIT_RE` **and** `REACHED_RE` on
  that line, e.g. "You've hit your usage limit") **and** `parseResetTime(window)
  === null` (no reset time anywhere in the window).

**Precedence (unchanged rules first):**

- The existing reset-bearing `limit` rule wins whenever it matches — if a reset
  time parses, we auto-resume and never alert. `limit-open` is strictly the
  no-reset residue.
- `limit-open` requires the Codex `■` anchor, so it cannot fire on the DOG
  false-positive fixture `['error: rate limit exceeded (HTTP 429)', FOOTER, '>
  ', '? for shortcuts']` (Claude platform, no `■`, chrome only) — that stays
  `null`.
- `limit-open` vs `outage`: distinct wordings; if both somehow match, the
  existing last-contributing-line rule decides, same as `limit` vs `outage`.

`inferPlatform` is unchanged: a `limit-open` banner only arises on a terminal
Orca identifies as `codex`, so `platform` is always `codex` for it.

**Replaces the blind fallback.** The limit rule's `parseResetTime(…) ?? now + 60
min` guess is removed for the no-reset case: a reset-bearing limit still
auto-resumes; a no-reset Codex `■` limit becomes `limit-open` and routes to the
alert; anything else stays `null` as before.

### 2. Connectivity gate (universal pre-send)

A new exported, injectable helper:

```
hasConnectivity(fetchImpl = globalThis.fetch, url = CONNECTIVITY_URL): Promise<boolean>
```

- `CONNECTIVITY_URL` default `http://captive.apple.com/hotspot-detect.html` —
  the endpoint macOS itself probes for captive-portal detection, so it adds no
  new privacy surface on a Mac. Overridable via env
  (`ORCA_WATCHDOG_CONNECTIVITY_URL`) and injectable in tests.
- Implementation: `fetch(url, { method: 'GET', signal: AbortSignal.timeout(3000)
  })`. **Any** HTTP response (2xx or not) ⇒ online (`true`); a thrown
  network/abort error ⇒ offline (`false`). Reachability, not correctness.

**Placement in `tick`.** After `reconcile` yields `sendCandidates`, and before
the first send fires, probe connectivity **once per tick** and cache the result:

- Offline ⇒ **skip every send this tick.** Do not increment `attempts`, do not
  set `lastAttemptAt`, do not advance the outage `deadlineMs` clock (the
  deadline is measured from `detectedAt`, which is untouched — a paused event
  simply waits). Log at `debug`: `held N send(s): offline`.
- Online ⇒ proceed exactly as today.

**No double round-trip for outages.** An outage send already runs
`fetchIndicator(status.*)`; a successful indicator fetch proves connectivity, so
for a tick whose candidates are all outages the existing status fetch satisfies
the gate and the extra probe is skipped. The connectivity probe's real effect is
on `limit` and `limit-open` sends, which have no status gate. (Simplest correct
implementation: probe lazily the first time a non-outage candidate is about to
send; if only outage candidates exist, rely on their indicator fetch.)

No persisted state: the gate is a tick-time check. A held event stays `waiting`
and is retried next tick.

### 3. Event schema (additive, stays v2)

`limit-open` events extend the v2 event with the alert lifecycle. Backward
compatible: existing `limit`/`outage` v2 files validate unchanged and need no
migration; the v1→v2 in-memory upgrade is untouched. `parseStateFile` still
accepts only `version` 1 or 2 and still writes 2.

Additions:

- `KINDS` gains `limit-open` via a new `SCHEDULE['limit-open']` entry.
- `STATUSES` gains `awaiting-user` and `dismissed`.
- New event field `alertedAt: string | null` (ISO when the alert was spawned,
  else `null`). Only meaningful for `limit-open`; `null` for `limit`/`outage`.

`SCHEDULE['limit-open']` (retry cadence once the user consents — "every 30 min,
capped", matching the outage cadence):

```
limit-open: { bufferMs: 0, retrySpacingMs: 30*MIN, rearmMs: 10*MIN,
              maxSends: 6, deadlineMs: 24*60*MIN, resumeText: RESUME_TEXT }
```

(`RESUME_TEXT` = the existing limit resume line, "Session rate limit has reset.
Resume where you left off." — a rate limit, not an outage.)

`validateEvent` additions:

- `alertedAt` validated like `lastAttemptAt`: `null` or an ISO timestamp.
- For `kind === 'limit-open'`, `platform` must be `codex` (parallels "outage
  requires a known platform").
- `status === 'awaiting-user'` and `status === 'dismissed'` are legal only for
  `kind === 'limit-open'`.
- An `awaiting-user`/`dismissed` event has `attempts === 0` and `lastAttemptAt
  === null` (no send has happened).
- **Relax the existing `lastAttemptAt === null` rule.** Today it reads: if
  `lastAttemptAt === null` then `status` must be `waiting` and `attempts === 0`.
  Extend the permitted statuses to include `awaiting-user` and `dismissed`
  (both legitimately have `lastAttemptAt === null`); otherwise a valid
  pre-consent event would be rejected and the state file backed-up-and-reset.

### 4. Reset-less alert lifecycle

`newEvent` for a `limit-open` banner creates:

```
{ handle, kind: 'limit-open', platform: 'codex', bannerText,
  detectedAt: now, resetAt: now,               // eligibility governed by status, not time
  attempts: 0, lastAttemptAt: null,
  status: 'awaiting-user', alertedAt: null }
```

**`tick` transitions (side effects live in `tick`, not `reconcile`):**

1. **Spawn the alert once.** A `limit-open` event with `status ===
   'awaiting-user'` and `alertedAt === null`: spawn the alert (below), set
   `alertedAt = now`, persist. No send.
2. **Await the choice.** `status === 'awaiting-user'` with `alertedAt` set: read
   the choice file for this handle (§5). None yet ⇒ do nothing (safe default:
   wait indefinitely for the human). A valid choice ⇒ transition:
   - **Continue** ⇒ `status = 'waiting'`, `resetAt = now`. Enters the
     `limit-open` send cycle: retry every 30 min, capped at 6 / 24 h,
     **connectivity-gated (§2) but not status-gated** (a rate limit needs no
     `status.*` check).
   - **Wait 1 h** ⇒ `status = 'waiting'`, `resetAt = now + 60 min`. Same
     `limit-open` cycle thereafter, so a wrong 1 h guess still retries up to the
     cap rather than stalling.
   - **Stop** ⇒ `status = 'dismissed'`. Never alerted or sent again for this
     event. If the banner later clears (reconcile rule 3) the event is deleted;
     a fresh limit-open banner starts a new episode.
3. **Send cycle.** Once `status === 'waiting'`, the existing reconcile rule 5c /
   `tick` send path apply with the `limit-open` schedule, plus the connectivity
   gate (§2).

**Deadline & rearm interaction with `reconcile` rule 5.** Two required changes so
the "wait indefinitely for the human" default holds:

- **Rule 5a/5b exempt pre-consent/terminal states.** `awaiting-user` and
  `dismissed` events are skipped by the deadline (5a) and rearm (5b) rules — an
  `awaiting-user` event must never age into `gave_up` while waiting for a click,
  and `dismissed` is terminal for the episode (only a banner-clear, reconcile
  rule 3, removes it).
- **The `limit-open` deadline is measured from consent, not detection.** So a
  human who answers a day later still gets a full 24 h retry window (and, since
  the limit almost certainly reset by then, an immediate success). Anchor the
  `limit-open` deadline on the consent moment — e.g. on the `resetAt` set at
  consent (`now` for Continue, `now + 1 h` for Wait 1 h) rather than
  `detectedAt` — or an equivalent stored consent timestamp.

**De-duplication.** Exactly one alert per episode: `alertedAt` is persisted, so a
daemon restart (the daemon exits after every tick) never re-spawns. Banner
mutations cannot spawn duplicates — events are keyed by handle (unchanged).

### 5. The alert mechanism (osascript, detached, choice file)

The daemon runs by launchd and **exits after each tick**, so the alert must
outlive the daemon. It is a detached child that shows the dialog, waits for the
click (possibly minutes later), writes the choice, and exits on its own.

- **Spawn:** `child_process.spawn('/bin/sh', ['-c', SCRIPT], { detached: true,
  stdio: 'ignore' }).unref()` — injectable as `deps.spawn` for tests (the tests
  never shell out). `SCRIPT` runs `osascript` to display the alert and writes the
  result atomically to the choice file:

  ```
  CHOICE="$(osascript -e 'display alert "orca-limit-watchdog" \
     message "<handle>: <sanitized bannerText>. Codex hit a limit with no reset time." \
     buttons {"Stop","Wait 1h","Continue"} default button "Continue"' \
     -e 'button returned of result')"
  printf '%s' "{\"choice\":\"$CHOICE\",\"at\":\"<now ISO>\"}" > "<dir>/.tmp" && mv "<dir>/.tmp" "<file>"
  ```

  (`osascript` and `sh` are both system-provided — zero dependencies. The
  LaunchAgent runs in the user's Aqua GUI session, so `display alert` renders.)
  `bannerText` is passed through `sanitize` and shell-quoted; the handle and
  timestamp are daemon-supplied, never user text.
- **Choice file:** `STATE_DIR/choices/<handle>.json` holding `{ choice, at }`.
  `choice` ∈ {`Continue`, `Wait 1h`, `Stop`}.
- **Consuming a choice (`tick`, injectable `deps.readChoice`/`deps.clearChoice`):**
  read the file for the event's handle; honour it only if `at >= alertedAt`
  (guards a stale click from a previous episode); then **delete the file**
  (idempotent — one transition per click). A file with `at < alertedAt`, or an
  unrecognised `choice`, is deleted and ignored.
- **Failure is safe.** If `spawn`/`osascript` fails (no GUI session, spawn
  error), no choice file appears and the event stays `awaiting-user`: no blind
  send. `alertedAt` is still set, so we do not spam re-spawns; if the human never
  answers, the daemon does nothing. Log spawn failure at `warn`.

### 6. Unchanged behaviour (for the reviewer's reference)

- Reset-bearing `limit` and all `outage` behaviour, banner-cleared hold
  (DOG-11), platform inference for existing kinds, the send-safety guards
  (shell-prompt / input-draft / veto), atomic state writes, backup-and-reset on
  a corrupt state file.
- The 5-minute launchd cadence and read → reconcile → act → exit model.

## Safety properties (delta)

- **No unsolicited reset-less send.** A `limit-open` event never sends until the
  human clicks Continue or Wait 1 h; the default (no click) is inaction.
- **No send into a dead network.** Every send (all kinds) is gated on
  connectivity; offline holds without spending an attempt or advancing the
  deadline.
- **Bounded retries.** `limit-open` is capped at 6 sends / 24 h like an outage;
  `Stop` is terminal for the episode.
- **One alert per episode**, surviving daemon restarts, immune to banner-text
  mutation (handle-keyed, `alertedAt`-persisted).
- **No new external dependency and no new persisted secret.** `osascript`, `sh`,
  and `fetch` are all platform-provided; the connectivity URL is the OS's own
  captive-portal probe.
- **Tight detection.** `limit-open` requires a Codex `■` anchor, so the existing
  HTTP-429 false-positive negative (DOG) still returns `null`.

## Files

- `watchdog.mjs` — detection (`limit-open` class), `SCHEDULE`/`KINDS`/`STATUSES`,
  `newEvent`, `validateEvent`, `hasConnectivity`, `tick` (connectivity gate +
  alert lifecycle + choice consumption), spawn/readChoice/clearChoice deps.
- `watchdog.test.mjs` — new unit tests (§Testing).
- `docs/superpowers/specs/2026-09-07-outage-resume-design.md` — cross-reference
  note pointing here for the reset-less path.
- `README.md` — document the alert and the connectivity gate; the choice-file
  location under `~/.local/state/orca-limit-watchdog/choices/`.

No `package.json`, no new dependency (project invariant).

## Testing

All `node --test`, pure/injectable, never against live terminals (Safety).

**Connectivity gate (§2):**

- `hasConnectivity`: fake `fetchImpl` returning a response ⇒ `true`; throwing /
  timing out ⇒ `false`.
- `tick` offline (fake `fetchImpl` throws): a due `limit` and a due `limit-open`
  candidate are **not** sent; `attempts`/`lastAttemptAt` unchanged; logged held.
- `tick` online: the same candidates send.
- Outage-only tick: no extra connectivity probe beyond `fetchIndicator` (assert
  via the injected fetch call count).

**Reset-less detection (§1):** against the **real captured** strings —

- `detectBanner(["■ exceeded retry limit, last status: 429", "› Ask Codex to do
  anything"], 'codex').kind === 'limit-open'`.
- `detectBanner(["■ You've hit your usage limit. Upgrade to Pro …", "purchase
  more credits."], 'codex').kind === 'limit-open'` (no reset present).
- Reset-bearing stays `limit`: the live banner "…or try again at 10:12 PM."
  ⇒ `kind === 'limit'` (regression guard for the working path).
- The DOG false-positive fixture still ⇒ `null`.
- `limit-open` only on `codex`: the same `■` line with `platform: 'unknown'`
  ⇒ `null`.

**Alert lifecycle (§4/§5):** with fake `deps.spawn`, `deps.readChoice`,
`deps.clearChoice`, `deps.now` —

- First tick on a `limit-open` event: spawns once (asserts `spawn` args include
  the three buttons), sets `alertedAt`, sends nothing.
- Second tick, no choice yet: does not re-spawn, sends nothing.
- Choice `Continue`: → `waiting`, `resetAt = now`, then (online) sends on the
  `limit-open` schedule; capped at 6.
- Choice `Wait 1h`: → `waiting`, `resetAt = now + 60 min`; no send before then.
- Choice `Stop`: → `dismissed`; never sends; banner-clear deletes the event.
- Stale choice (`at < alertedAt`): ignored and cleared.
- `spawn` throws: event stays `awaiting-user`, `alertedAt` set, no send, warn
  logged.

**Schema (§3):**

- `validateEvent` accepts a well-formed `limit-open` event and rejects: a
  `limit-open` with `platform !== 'codex'`; `awaiting-user`/`dismissed` on a
  `limit`/`outage`; `awaiting-user` with `attempts > 0`; a bad `alertedAt`.
- `parseStateFile` round-trips a v2 file containing a `limit-open` event and
  still upgrades v1 and rejects unknown versions.

**Deploy:** post-merge `install.sh` from the main checkout only; `watchdog.mjs`
changes are verified with the unit fixtures, never by re-installing from a
worktree (Safety).
