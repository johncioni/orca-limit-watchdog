# orca-limit-watchdog — Outage resume

**Date:** 2026-09-07
**Status:** Draft (pending Codex spec review)
**Extends:** `2026-07-23-orca-limit-watchdog-design.md` (the base design; everything
not mentioned here is unchanged)

## Problem

The watchdog resumes terminals paused by a subscription **rate limit**: the
banner states a reset time, the watchdog waits for it, sends one resume line.
A platform **outage** (Anthropic or OpenAI API returning 5xx / overloaded /
dropping streams) stalls an agent terminal the same way, but the banner
carries no reset time and the current patterns do not match it, so the
terminal sits idle until a human types something. Observed in practice:

- Claude Code prints `API Error: 529 … overloaded_error` (or a connection
  error), exhausts its own retries, and waits for input.
- Codex prints a stream error / reconnecting / 5xx message, eventually stops,
  and waits for input.

## Goal

Detect outage-stalled terminals and resume each one, per terminal, once its
platform is plausibly back, with the same bounded, benign worst case as
today: a few lines of text typed into a paused terminal, never a runaway
resend loop.

## Non-goals

- Waiting for *both* platforms before resuming anything. Each terminal
  depends on one platform; cross-platform fallback is the orchestrator's job
  (see `~/.agents/MODELS.md`).
- Component-level status parsing (e.g. "Claude Code" vs "Claude API"). The
  page-level indicator is enough for a suppress-only gate.
- Outage patterns for Gemini, Grok, Pi. Their terminals fall under
  `platform: unknown` and get the backoff schedule without a status gate.
- Detecting outages that the agent survives on its own (auto-retry that
  succeeds). Those show no idle banner and are correctly ignored.

## Design

### 1. Detection: a second banner class

`detectBanner(lines)` keeps its 15-line window and returns
`{ kind, bannerText }` instead of `{ bannerText }`:

1. Run the existing rate-limit rule first. Match ⇒ `kind: 'limit'`.
2. Otherwise run the outage rule. Match ⇒ `kind: 'outage'`.
3. Otherwise `null`.

Limit wins over outage: a limit banner is the more specific diagnosis and has
a real reset time.

**Outage rule** (case-insensitive, over the window after dropping vetoed
lines):

- `OUTAGE_RE`: any line matching
  `api error|overloaded|stream (error|disconnected)|connection (error|reset|closed|refused)|ECONNRESET|fetch failed|\b(500|502|503|529)\b`
- `OUTAGE_VETO_RE` (per line, dropped before matching, same mechanism as the
  existing `approaching … limit` veto): `retrying in \d|attempt \d+\s*(/|of)\s*\d+`
  A TUI that is still retrying by itself is not stalled; typing into it
  would queue a stray prompt. `reconnecting` is deliberately neither a match
  nor a veto: we have no captured transcript showing whether Codex's final
  stalled line is a reconnect or a stream error, so a terminal stuck at
  "reconnecting…" is covered by the 10-minute first-send delay plus the idle
  check, and the tuning log below tells us which it was.
- The `\b(500|502|503|529)\b` alternative is the riskiest for false
  positives (any code output containing those numbers). It only fires when
  the terminal also passes the idle check at send time and no line in the
  window is a shell prompt; see §5.

**Tuning hook.** No captured outage transcripts exist locally, so the initial
pattern set is derived from the two observed shapes above and documented
error strings. On first detection of an outage event the watchdog logs the
matched window verbatim (`info`, lines joined with ` | `, truncated to 600
chars) so the patterns can be tuned from `watchdog.log` after the first real
outage. This is the only new log volume; it happens once per event.

### 2. Platform inference

`inferPlatform(terminal, bannerText)`:

1. `terminal.agentIdentity` from `orca terminal list` when it is `claude` or
   `codex` (verified present on Orca-launched agent terminals as of
   2026-09-07; absent on some manually launched ones).
2. Else from the banner: `api error|overloaded` ⇒ `claude`;
   `stream|codex` ⇒ `codex`.
3. Else `unknown`.

Pure function, unit-tested. `platform` is stored on the event at detection
and never re-inferred.

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
- **Migration:** a v1 file loads as v2 with `kind: 'limit'`,
  `platform: 'unknown'` on every event. The file is rewritten as v2 on the
  next save. No other version is accepted (existing corrupt-file handling
  applies).
- **Kind change on a live handle:** if a terminal with an `outage` event now
  shows a `limit` banner (or vice versa), the old event is deleted and a new
  one created with fresh attempt accounting. The two kinds have different
  schedules and different resume text; carrying attempts across would be
  wrong in both directions.

### 4. Outage schedule

Per-kind parameters (limit values are today's, unchanged):

| parameter | limit | outage |
|---|---|---|
| `resetAt` | parsed from banner (fallback +1 h) | `detectedAt + 10 min` |
| buffer past `resetAt` | 2 min | 0 |
| retry spacing | 30 min | 30 min |
| re-arm after send (verify window) | 10 min | 10 min |
| max sends | 3 | 6 |
| absolute deadline | none | `detectedAt + 24 h` ⇒ `gave_up` |
| resume text | `Session rate limit has reset. Resume where you left off.` | `The API outage appears to be over. Resume where you left off.` |

Rationale: an outage send is cheap (the agent retries one API call, fails
again, prints a fresh banner, and the verify rule re-arms the event), so a
higher send cap is safe. The 24-hour deadline stops the watchdog polling a
terminal whose operator has clearly abandoned it. `gave_up` is logged loudly
as today.

### 5. Send gate for outage events

An outage event that is `waiting`, past `resetAt`, under both caps, and past
the retry spacing is a send candidate. Before sending, in this order:

1. **Status gate** (new; `platform` known only). Fetch that platform's
   Statuspage summary with a 10 s timeout, once per tick, only when at
   least one outage send candidate exists for that platform:
   - claude: `https://status.claude.com/api/v2/status.json`
     (`status.anthropic.com` redirects there; use the final host directly)
   - codex: `https://status.openai.com/api/v2/status.json`

   Read `status.indicator`. `major` or `critical` ⇒ **suppress** this tick:
   log `debug`, do not count an attempt, do not touch `lastAttemptAt`.
   `none`, `minor`, any other value, a non-200, malformed JSON, or a fetch
   error ⇒ **proceed** (fail open: the status page is advisory, and the
   send is cheap). The fetch uses Node's built-in `fetch` (Node ≥ 20); no
   dependency is added.
2. **Idle check** (existing): `terminal wait --for tui-idle --timeout-ms
   5000`; timeout ⇒ skip this tick.
3. **Fresh re-read** (existing): the banner must still be present, and of
   the same `kind`.
4. **Prompt guard** (new, both kinds): if the last non-empty line of the
   fresh tail ends in `$`, `%`, or `❯` (a shell prompt), the agent has
   exited and the text would land in a shell. A bare `>` is not treated as a
   shell prompt: Claude Code's input box renders as `> `. Delete the event, log `warn`, do not send. This mainly
   protects the numeric outage alternatives from firing on ordinary
   command output after an agent has quit.
5. Persist the attempt, then send the kind's resume text + Enter (existing
   ordering guarantee).

Suppressed ticks are free: they do not consume attempts, and the 24-hour
deadline is the only thing that ends an event the status page keeps
reporting as down.

### 6. Unchanged behaviour (for the reviewer's reference)

Lock, tick deadline, kill switch, per-call timeouts, `runtime_unavailable`
handling, read budget, handle keying, verify/re-arm, banner-cleared
deletion, vanished-terminal deletion, freeze-on-unread, atomic state writes,
log rotation, `--dry-run` / `--status` / `--once`. `--status` and dry-run
output gain `kind` and `platform` columns.

## Safety properties (delta)

1. Per event: at most 3 sends (limit) or 6 sends (outage); outage events
   also end 24 h after detection. Enforced by persisted attempts and
   `detectedAt`.
2. No send while the platform's status page reports a major/critical
   incident. Fail-open on any status-fetch problem.
3. No send into a terminal whose last line is a shell prompt.
4. Network access is limited to two hard-coded HTTPS GETs, made only when an
   outage send is otherwise due. A tick with no outage candidates makes no
   network calls, so the watchdog still works fully offline for limits.

## Files

```
watchdog.mjs          # OUTAGE_RE/OUTAGE_VETO_RE, kind-aware detectBanner,
                      # inferPlatform, per-kind schedule table, status gate,
                      # prompt guard, v1→v2 migration
watchdog.test.mjs     # new fixtures and lifecycle cases (below)
e2e/fake-tui.mjs      # --outage mode: prints a Claude-style 529 banner
README.md             # outage behaviour, new resume text, status-page note
```

## Testing

Unit (`node --test`), all pure functions with injected `now` and injected
`fetchStatus`:

- Detection: Claude `API Error: 529 … overloaded_error` ⇒ outage; Codex
  `stream error` / `stream disconnected` ⇒ outage; `Retrying in 5s…` in the
  window ⇒ no outage (veto); `reconnecting…` ⇒ no outage; a window with both a
  limit banner and an API-error line ⇒ `limit`; code output discussing
  "connection reset" with a shell prompt on the last line ⇒ detected at
  reconcile time but rejected by the prompt guard (guard tested separately
  as a pure function on the tail).
- `inferPlatform`: agentIdentity wins; banner fallback for both platforms;
  unknown otherwise.
- Lifecycle: outage first send at +10 min, not before; second send ≥ 30 min
  after the first only if the banner persists after the 10-min verify;
  `gave_up` after 6 sends; `gave_up` at +24 h even with attempts left;
  kind change deletes and recreates the event; v1 state loads with
  `kind: 'limit'`.
- Status gate: `major` suppresses without consuming an attempt; `none` and
  `minor` proceed; thrown fetch / non-JSON / non-200 proceed; unknown
  platform never calls fetch; fetch called at most once per platform per
  tick.
- Prompt guard: `$`, `%`, `❯` endings reject; `> ` (Claude input box) does
  not.

E2E: `e2e/fake-tui.mjs --outage` in a scratch Orca terminal; with
`WATCHDOG_STATUS_URL_CLAUDE` pointed at a local file server returning
`major` for the first tick and `none` for the second, assert zero sends on
tick one and exactly one outage resume line on tick two. The env override
exists only for this test and is documented as such.

Live: `node watchdog.mjs --dry-run` against the real Orca with no outage in
progress ⇒ "no action" and no network calls (verified by the debug log).
