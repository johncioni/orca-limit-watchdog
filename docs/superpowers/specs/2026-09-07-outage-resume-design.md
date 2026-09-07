# orca-limit-watchdog — Outage resume

**Date:** 2026-09-07
**Status:** Draft, rev 2 (after Codex round 1: all 11 findings accepted)
**Extends:** `2026-07-23-orca-limit-watchdog-design.md` (the base design; everything
not mentioned here is unchanged)

## Problem

The watchdog resumes terminals paused by a subscription **rate limit**: the
banner states a reset time, the watchdog waits for it, sends one resume line.
A platform **outage** (Anthropic or OpenAI API returning 5xx / overloaded /
dropping streams) stalls an agent terminal the same way, but the banner
carries no reset time and the current patterns do not match it, so the
terminal sits idle until a human types something. Observed in practice:

- Claude Code prints `API Error: 529 … overloaded_error` (or
  `API Error: Connection error`), exhausts its own retries, and waits for
  input.
- Codex prints a stream error / reconnecting / 5xx message, eventually stops,
  and waits for input.

## Goal

Detect outage-stalled terminals and resume each one, per terminal, once its
platform is plausibly back, with the same bounded, benign worst case as
today: a few lines of text typed into a paused terminal, never a runaway
resend loop, never a prompt injected into a healthy agent.

## Non-goals

- Waiting for *both* platforms before resuming anything. Each terminal
  depends on one platform; cross-platform fallback is the orchestrator's job
  (see `~/.agents/MODELS.md`).
- Component-level status parsing. The page-level indicator is enough for a
  suppress-only gate.
- Outage detection for Gemini, Grok, Pi, or for any terminal whose platform
  cannot be established (see §2). Rate-limit handling for them is unchanged.
- Detecting outages that the agent survives on its own (auto-retry that
  succeeds). Those show no idle banner and are correctly ignored.
- A `reconnecting…` line on its own. Intentionally unsupported until a
  captured transcript shows what Codex prints when a reconnect finally fails.

## Design

### 1. Detection: a second banner class

`detectBanner(lines, platform)` keeps its 15-line window, gains a `platform`
argument (`'claude' | 'codex' | 'unknown'`, from §2 step 1 only), and returns
`{ kind, bannerText, matchedLine, patternId }` instead of `{ bannerText }`.

**Pre-processing (both classes):** strip ANSI escape and other control
sequences from every line, then trim. The existing limit rule runs on the
stripped lines too (a no-op for the fixtures it already passes).

**Limit rule:** unchanged, produces `kind: 'limit'`.

**Outage rule** (case-insensitive). Detection is anchored to
platform-specific TUI shapes; there is no generic rule:

| id | platform gate | line pattern |
|---|---|---|
| `claude-api-error` | `claude` or `unknown` | `^(⎿\s*)?API Error:` (Claude Code's own error prefix; the marker itself is Claude-specific, so `unknown` is allowed) |
| `codex-stream` | `codex` only | `stream (error|disconnected)` |
| `codex-connection` | `codex` only | `connection (error|reset|closed|refused)|ECONNRESET|fetch failed` |

No bare HTTP status codes, no unanchored `overloaded`, no generic phrases
without positive platform identity. A `codex` terminal is identified only by
`agentIdentity` (§2); without it, Codex outages are not detected. That is an
accepted gap, logged at `debug` when a `codex-*` pattern would have matched
on an `unknown` terminal, so the gap is visible in the log.

**Retry veto, chronological:** `RETRY_RE = retrying in \d|attempt \d+\s*(/|of)\s*\d+`.
Let `e` be the index (within the window) of the last line matching an outage
pattern and `r` the index of the last line matching `RETRY_RE`. The outage
matches only if `r < e` (no retry marker at or after the last error) — a TUI
that is still retrying by itself is not stalled. Retry lines are not
dropped; they simply must be older than the error.

**Class precedence, chronological:** compute the last limit-matching line
index `l` and the last outage-matching line index `e`. `l ≥ e` ⇒ `limit`;
`e > l` ⇒ `outage`. A single line matching both counts as limit. This means
a stale limit banner followed by a newer API error is an outage, and vice
versa.

`bannerText` for outage events is the matched line only (stripped, trimmed,
≤ 200 chars). `matchedLine` and `patternId` are returned for logging.

**Tuning hook.** No captured outage transcripts exist locally, so the
patterns above are derived from the observed shapes and documented error
strings. On first detection of an outage event the watchdog logs, at `info`,
`patternId` plus the sanitized `matchedLine`. Under `WATCHDOG_DEBUG` it also
logs the stripped 15-line window, with anything that looks like a token or
key (`sk-…`, `ghp_…`, `Bearer …`, 32+ hex/base64 runs) replaced by
`[redacted]`. Once per event.

### 2. Platform inference

`inferPlatform(terminal, banner)`:

1. `terminal.agentIdentity` from `orca terminal list` when it is exactly
   `claude` or `codex` (present on Orca-launched agent terminals as of
   2026-09-07; absent on some manually launched ones). Authoritative.
2. Else, if the detected banner's `patternId` is `claude-api-error` ⇒
   `claude`. (The Claude Code error prefix is provider-specific.)
3. Else `unknown`.

There is no banner-based Codex inference: nothing Codex prints is
provider-specific enough. Pure function, unit-tested. `platform` is stored on
the event at detection and never re-inferred. Step 1's value is also what
`detectBanner` receives as its `platform` argument.

### 3. Event schema v2

```json
{ "version": 2,
  "events": { "<terminal handle>": {
      "handle": "...", "kind": "limit|outage", "platform": "claude|codex|unknown",
      "bannerText": "...", "detectedAt": "ISO", "resetAt": "ISO",
      "attempts": 0, "lastAttemptAt": null,
      "status": "waiting|resumed|gave_up" } } }
```

- Event identity stays the terminal handle alone.
- **`loadState()` contract:** returns the events map (as today). It accepts
  `version: 1` and `version: 2`. A v1 file is upgraded in memory: every
  existing field is preserved and `kind: 'limit'`, `platform: 'unknown'`
  are added. A v2 event missing `kind`, `platform`, `handle`, `detectedAt`,
  `resetAt`, `attempts`, or `status`, or with a `kind`/`status` outside the
  enums, makes the file invalid. Any other version or an invalid file follows
  the existing backup-and-reset path (`state.json.bad-<ts>`, empty state).
  `saveState()` always writes `version: 2`.

### 4. Outage schedule

Per-kind parameters (limit values are today's, unchanged):

| parameter | limit | outage |
|---|---|---|
| `resetAt` | parsed from banner (fallback +1 h) | `detectedAt + 10 min` |
| buffer past `resetAt` | 2 min | 0 |
| retry spacing | 30 min | 30 min |
| re-arm after send (verify window) | 10 min | 10 min |
| max sends | 3 | 6 |
| absolute deadline | none | `detectedAt + 24 h` |
| resume text | `Session rate limit has reset. Resume where you left off.` | `The API outage appears to be over. Resume where you left off.` |

Rationale: an outage send is cheap (the agent retries one API call, fails
again, prints a fresh banner, and the verify rule re-arms the event), so a
higher send cap is safe. The 24-hour deadline stops the watchdog polling a
terminal whose operator has clearly abandoned it. `gave_up` is logged loudly
as today.

### 5. Reconcile: transition order per event

`reconcile(state, observations, now, liveHandles)` applies, for every stored
event, exactly this order; the first matching rule ends processing for that
event:

1. **Vanished** (handle not in `liveHandles`) ⇒ delete.
2. **Live but unread this tick** ⇒ freeze: no field changes, no candidate,
   deadline and re-arm are not evaluated.
3. **Read, no banner** ⇒ delete (resume worked, or agent moved on).
4. **Read, banner of a different `kind`** ⇒ delete and create a fresh event
   of the new kind (fresh `detectedAt`, `attempts: 0`, re-inferred
   platform). Applies from any status, including `gave_up`.
5. **Read, same kind:**
   a. outage only: `now ≥ detectedAt + 24 h` and status ≠ `gave_up` ⇒
      `gave_up` (logged). No candidate.
   b. `resumed` and `now − lastAttemptAt ≥ 10 min` ⇒ `attempts ≥ maxSends`
      ? `gave_up` : `waiting`. (The final send therefore stays `resumed`
      through its verify window and becomes `gave_up` only if the banner
      outlives it; a banner that clears in that window hits rule 3 first.)
   c. `waiting`, `now ≥ resetAt + buffer`, `attempts < maxSends`, and
      (`lastAttemptAt` null or `now − lastAttemptAt ≥ 30 min`) ⇒ candidate.

New banners on handles without an event create `waiting` events as today,
with `kind`, `platform`, and the kind's `resetAt`.

Exactly-at boundaries use `≥` everywhere above (consistent with the base
design's TTL fix).

### 6. Send gate

For each candidate, in this order; any failure ends processing of that
candidate for this tick:

1. **Status gate** (outage candidates with a known platform only). Fetch
   the platform's Statuspage summary once per platform per tick, only when
   at least one such candidate exists:
   - claude: `https://status.claude.com/api/v2/status.json`
     (`status.anthropic.com` redirects there; use the final host directly)
   - codex: `https://status.openai.com/api/v2/status.json`

   Node's built-in `fetch` (Node ≥ 20), 10 s `AbortSignal.timeout`, no
   dependency. Read `status.indicator`. `major` or `critical` ⇒ **suppress**
   this tick: log `debug`, no attempt counted, `lastAttemptAt` untouched.
   `none`, `minor`, any other value, non-200, malformed JSON, or a fetch
   error ⇒ **proceed** (fail open: the page is advisory and the send is
   cheap). Each platform's result applies only to that platform's
   candidates. The fetch function is injected into the tick so tests never
   touch the network.
2. **Idle check** (existing): `terminal wait --for tui-idle --timeout-ms
   5000`; timeout ⇒ skip this tick.
3. **Fresh re-read** (existing, extended): run `detectBanner` on the fresh
   tail. No banner ⇒ delete the event, persist, do not send. Different
   `kind` ⇒ replace per §5 rule 4, persist, do not send (it becomes a
   candidate on a later tick). Same kind ⇒ continue.
4. **Prompt guard** (new, both kinds): take the last non-empty line of the
   fresh tail after ANSI/control stripping and trimming. It is a shell
   prompt if it ends in `$`, `%`, `#`, `❯`, `➜`, `λ`, `❱`, or `>` — except
   that a line that is exactly `>` is Claude Code's empty input box, not a
   shell. A shell prompt means the agent has exited and the text would land
   in a shell: delete the event, log `warn`, persist, do not send.
5. Persist the attempt, then send the kind's resume text + Enter (existing
   ordering guarantee).

Suppressed ticks are free: they do not consume attempts, and the 24-hour
deadline is the only thing that ends an event the status page keeps
reporting as down.

### 7. Unchanged behaviour (for the reviewer's reference)

Lock, tick deadline, kill switch, per-call timeouts, `runtime_unavailable`
handling, read budget, handle keying, atomic state writes, log rotation,
`--dry-run` / `--status` / `--once`. `--status` and dry-run output gain
`kind` and `platform` columns.

## Safety properties (delta)

1. Per event: at most 3 sends (limit) or 6 sends (outage); outage events
   also end 24 h after detection. Enforced by persisted attempts and
   `detectedAt`.
2. Outage detection requires a platform-anchored TUI error shape, newer than
   any retry marker, on a terminal whose platform is positively known (or
   Claude's own error prefix). Ordinary agent output that merely mentions
   errors or status codes cannot match.
3. No send while the platform's status page reports a major/critical
   incident. Fail-open on any status-fetch problem.
4. No send into a terminal whose last line is a shell prompt.
5. Network access is limited to two hard-coded HTTPS GETs, made only when an
   outage send is otherwise due. A tick with no outage candidates makes no
   network calls, so the watchdog still works fully offline for limits.
   The only override is `WATCHDOG_STATUS_URL_<CLAUDE|CODEX>`, honoured
   solely when its host is `127.0.0.1` or `localhost`; anything else is
   ignored with a `warn`.
6. Logs never contain a raw terminal window by default; the debug window is
   ANSI-stripped and secret-redacted.

## Files

```
watchdog.mjs          # stripAnsi, OUTAGE patterns table, kind-aware
                      # detectBanner, inferPlatform, per-kind schedule,
                      # reconcile order, status gate (injected fetch),
                      # prompt guard, v1→v2 load, v2 save
watchdog.test.mjs     # new fixtures and lifecycle cases (below)
e2e/fake-tui.mjs      # --outage mode: prints a Claude-style API Error banner
e2e/status-stub.mjs   # loopback HTTP server returning a scripted indicator
README.md             # outage behaviour, new resume text, status-page note,
                      # loopback-only env override
```

## Testing

Unit (`node --test`), pure functions with injected `now` and injected
`fetchStatus`:

- **Detection positives:** `API Error: 529 {"type":"error","error":{"type":"overloaded_error"…}}`
  with `⎿` prefix and without; `API Error: Connection error`; on `codex`:
  `stream error`, `stream disconnected`, `ECONNRESET`, `fetch failed`.
- **Detection negatives:** the same Codex lines on `unknown` and `claude`
  platforms; a quoted `API Error:` inside an agent's prose (mid-line, so
  the anchor fails); source code and log lines containing `500`, `529`,
  `overloaded`, `connection reset`; ordinary agent output ending at `> `;
  `Retrying in 5s…` on the line after the error (`r > e`); retry marker on
  the same line; `reconnecting…` alone; ANSI-wrapped versions of each.
- **Retry chronology:** error after retry marker ⇒ outage; retry marker after
  error ⇒ none; two errors with a retry marker between them ⇒ outage.
- **Class precedence:** old limit / new API error ⇒ outage; old API error /
  new limit ⇒ limit; one line matching both ⇒ limit.
- **`inferPlatform`:** `agentIdentity` wins over banner; `claude-api-error`
  ⇒ claude when identity absent; codex pattern with no identity ⇒ unknown
  (and detection fails anyway); garbage identity ⇒ falls through.
- **Prompt guard:** endings `$`, `%`, `#`, `❯`, `➜`, `λ`, `❱`, `foo>`
  reject; exact `>` accepts; ANSI-coloured prompt rejects; trailing
  whitespace ignored.
- **State:** v1 file loads with `kind: 'limit'`, `platform: 'unknown'`, all
  other fields intact; v2 round-trips; save always writes version 2;
  version 3 and a v2 event missing `kind` go to backup-and-reset.
- **Lifecycle (outage):** no candidate before +10 min; candidate at exactly
  +10 min; second send ≥ 30 min after the first only if the banner persists
  through the 10-min verify; sixth send stays `resumed` for 10 min then
  `gave_up`; `gave_up` at exactly +24 h with attempts left; a `gave_up`
  event whose banner clears is deleted; unread event past retry spacing and
  past the deadline stays frozen (no candidate, no `gave_up`).
- **Kind change:** limit→outage and outage→limit from `waiting`, `resumed`,
  and `gave_up` each yield a fresh event with `attempts: 0`.
- **Status gate:** `major` suppresses without consuming an attempt and the
  same event is a candidate again next tick with identical accounting;
  `critical` suppresses; `none`, `minor`, `weird` proceed; thrown fetch,
  non-JSON, non-200 proceed; `unknown` platform never calls fetch; claude
  `major` does not suppress a codex candidate in the same tick; fetch called
  at most once per platform per tick with two candidates.
- **Fresh re-read:** banner cleared ⇒ event deleted, no send; kind changed ⇒
  event replaced, no send, no attempt counted.

E2E (`e2e/`): start `status-stub.mjs` on a loopback port scripted to answer
`major` then `none`; run `fake-tui.mjs --outage` in a scratch Orca terminal;
preseed `state.json` with a due v2 outage event for that handle
(`resetAt` in the past) so no ten-minute wait is needed; set
`WATCHDOG_STATUS_URL_CLAUDE` to the stub; run `--once` twice; assert zero
sends after tick one and exactly one outage resume line after tick two.

Live: `node watchdog.mjs --dry-run` against the real Orca with no outage in
progress ⇒ "no action" and no network calls (verified by the debug log).
