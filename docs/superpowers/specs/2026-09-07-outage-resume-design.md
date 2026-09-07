# orca-limit-watchdog — Outage resume

**Date:** 2026-09-07
**Status:** Approved for planning, rev 3 (Codex round 1: 11/11 accepted; round 2: 8/8 accepted; orchestrator adjudicated, no third round per the two-round rule)
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
- Outage detection for Codex, Gemini, Grok, or Pi in this revision. Nothing
  Codex prints on a stalled stream is known precisely enough to anchor a
  pattern that cannot also appear in agent prose; Codex detection is
  **disabled** until a captured transcript supplies a Codex-owned prefix.
  The platform plumbing (§2, §6) is built for both so enabling Codex later
  is a pattern-table change plus fixtures. Rate-limit handling for every
  platform is unchanged.
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

**Outage rule** (case-insensitive). Detection is anchored to a
platform-owned TUI error shape; there is no generic rule. The pattern table
has one live row; the `platform gate` column exists so a Codex row can be
added later without restructuring:

| id | platform gate | line pattern |
|---|---|---|
| `claude-api-error` | `claude` or `unknown` | `^(⎿\s*)?API Error: (5\d\d\b|Connection error\b|.*\boverloaded_error\b)` |

That is: Claude Code's own error prefix **and** an outage-class payload.
`API Error: 400/401/403/429 …` (auth, configuration, per-request rate
limiting) do not match; the agent handles those itself or a human must.
No bare HTTP status codes, no unanchored `overloaded`, no unprefixed
phrases. The `unknown` platform is allowed because the prefix is Claude
Code's, not the model's.

**Final-block requirement.** Let `e` be the index (within the window) of the
last line matching an outage pattern. Every line after `e` must be
TUI chrome, i.e. match one of:

- blank;
- box-drawing / rule characters only (`^[─│╭╮╰╯┃━┌┐└┘├┤⎿\s]+$`);
- a Claude Code input box: `^>(\s.*)?$`;
- a `⎿`-prefixed continuation line;
- a Claude Code hint/status line: `^(\? for shortcuts|Press |Esc |esc |Retry|⏵|⏸|✗|✓)`.

Any other trailing line (agent prose, tool output, a shell prompt) means
the error is stale and the agent moved on ⇒ **no match**. This allow-list
is deliberately narrow; it fails closed, and the tuning log (below) shows
what a real stalled tail looked like so the list can be widened from
evidence. `ANSI`-stripping happens before this check.

**Retry veto, chronological:** `RETRY_RE = retrying in \d|attempt \d+\s*(/|of)\s*\d+`.
Let `r` be the index of the last line matching `RETRY_RE`. The outage
matches only if `r < e` (no retry marker at or after the last error) — a TUI
that is still retrying by itself is not stalled. Retry lines are not
dropped; they simply must be older than the error. (A retry line after `e`
also fails the final-block requirement; the rule is stated separately so
the intent survives allow-list changes.)

**Class precedence, chronological.** The limit rule is a window-wide
conjunction, so define `l` as the index of the **last line that matches
`LIMIT_RE` or `RESET_RE`** (the last contributing line of the limit banner,
the same "relevant" lines that already form its `bannerText`). With `e` as
above: `l ≥ e` ⇒ `limit`; `e > l` ⇒ `outage`. A single line matching both
counts as limit. A stale limit banner followed by a newer API error is an
outage, and vice versa.

`bannerText` for outage events is the matched line only (stripped, trimmed,
≤ 200 chars). `matchedLine` and `patternId` are returned for logging.

**Sanitizer.** One function, `sanitize(text)`, used for every log line and
for stored `bannerText`: strip ANSI/control sequences, collapse whitespace,
replace anything that looks like a credential (`sk-[A-Za-z0-9_-]{8,}`,
`ghp_…`/`gho_…`/`github_pat_…`, `Bearer <token>`, `AKIA[0-9A-Z]{16}`, and
any run of 32+ `[A-Za-z0-9+/=_-]`) with `[redacted]`, then truncate to the
caller's limit (200 chars for a line, 600 for a window). Unit-tested on its
own.

**Tuning hook.** No captured outage transcripts exist locally, so the
pattern above is derived from the observed shape and documented error
strings. On first detection of an outage event the watchdog logs, at `info`,
`patternId` plus `sanitize(matchedLine)`. Under `WATCHDOG_DEBUG` it also
logs `sanitize(window)` (the 15 lines joined with ` | `), and, at `debug`,
any window where a pattern matched but the final-block requirement failed,
so the allow-list can be widened from evidence. Once per event.

### 2. Platform inference

`inferPlatform(terminal, banner)`:

1. `terminal.agentIdentity` from `orca terminal list` when it is exactly
   `claude` or `codex` (present on Orca-launched agent terminals as of
   2026-09-07; absent on some manually launched ones). Authoritative.
2. Else, if the detected banner's `patternId` is `claude-api-error` ⇒
   `claude`. (The Claude Code error prefix is provider-specific.)
3. Else `unknown`.

There is no banner-based Codex inference: nothing Codex prints is
provider-specific enough. Pure function, unit-tested. Step 1's value is also
what `detectBanner` receives as its `platform` argument.

`platform` is stored on the event at detection. It is re-evaluated on every
read of that terminal (ordinary reconcile and the pre-send re-read): if the
newly inferred platform is **known and different** from the stored one, the
terminal has changed agents and the event is replaced by a fresh one (§5
rule 4b). A known platform that temporarily infers as `unknown` (e.g. an
`agentIdentity` blip) does **not** trigger replacement.

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
  are added, then validated as v2. `saveState()` always writes
  `version: 2`.
- **Validation** (`validateEvent(key, ev)`, pure, unit-tested). An event is
  valid only if all hold:
  - `handle` is a non-empty string equal to its key;
  - `kind ∈ {limit, outage}`, `platform ∈ {claude, codex, unknown}`,
    `status ∈ {waiting, resumed, gave_up}`;
  - `kind: outage` ⇒ `platform ≠ unknown` (normal detection cannot create
    one, and it would bypass the status gate);
  - `bannerText` is a string;
  - `detectedAt` and `resetAt` parse as ISO timestamps;
  - `attempts` is an integer with `0 ≤ attempts ≤ maxSends(kind)`;
  - `lastAttemptAt` is `null` or an ISO timestamp, and is non-null whenever
    `status ≠ waiting` or `attempts > 0`.

  One invalid event invalidates the whole file. Any other version or an
  invalid file follows the existing backup-and-reset path
  (`state.json.bad-<ts>`, empty state, `warn` naming the first violation).

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
4. **Replace** ⇒ delete and create a fresh event (fresh `detectedAt`,
   `attempts: 0`, `lastAttemptAt: null`, `waiting`, newly inferred
   platform). Applies from any status, including `gave_up`, when either:
   a. the banner is of a different `kind`; or
   b. the newly inferred platform is known and differs from the stored one
      (§2). A stored known platform that now infers `unknown` is kept.
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

   Node's built-in `fetch` (Node ≥ 20), 10 s `AbortSignal.timeout`,
   `redirect: 'error'` (a redirect is treated like any other fetch failure;
   the hosts above are the final ones today), no dependency. Read
   `status.indicator`. `major` or `critical` ⇒ **suppress**
   this tick: log `debug`, no attempt counted, `lastAttemptAt` untouched.
   `none`, `minor`, any other value, non-200, malformed JSON, or a fetch
   error ⇒ **proceed** (fail open: the page is advisory and the send is
   cheap). Each platform's result applies only to that platform's
   candidates. The fetch function is injected into the tick so tests never
   touch the network.
2. **Idle check** (existing): `terminal wait --for tui-idle --timeout-ms
   5000`; timeout ⇒ skip this tick.
3. **Fresh re-read** (existing, extended): read the tail again and run
   `detectBanner` on it. **Read failure or timeout ⇒ leave the event and
   its accounting untouched, log `warn`, do not send** (this is not "no
   banner"). No banner ⇒ delete the event, persist, do not send. Different
   `kind` or a changed known platform ⇒ replace per §5 rule 4, persist, do
   not send (it becomes a candidate on a later tick). Same kind and
   platform ⇒ continue.
4. **Prompt guard** (new, both kinds): take the last non-empty line of the
   fresh tail after ANSI/control stripping and trimming. It is a shell
   prompt if it ends in `$`, `%`, `#`, `❯`, `➜`, `λ`, `❱`, or `>`. The
   single exception: a line that is exactly `>` is accepted as Claude
   Code's empty input box **only when the terminal's current
   `agentIdentity` (from this tick's `terminal list`) is `claude`**;
   without that independent evidence a bare `>` fails closed as a shell
   continuation prompt. A shell prompt means the agent has exited and the
   text would land in a shell: delete the event, log `warn`, persist, do
   not send.
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
2. Outage detection requires Claude Code's own error prefix with an
   outage-class payload, newer than any retry marker, followed only by
   recognised TUI chrome. Ordinary agent output that merely mentions
   errors or status codes, a non-outage `API Error`, or a stale error the
   agent has since worked past cannot match.
3. No send while the platform's status page reports a major/critical
   incident. Fail-open on any status-fetch problem.
4. No send into a terminal whose last line is a shell prompt.
5. Network access is limited to two hard-coded HTTPS GETs, made only when an
   outage send is otherwise due. A tick with no outage candidates makes no
   network calls, so the watchdog still works fully offline for limits.
   The only override is `WATCHDOG_STATUS_URL_<CLAUDE|CODEX>`, honoured
   solely when its scheme is `http:` or `https:` and its host is
   `127.0.0.1`, `::1`, or `localhost`; anything else is ignored with a
   `warn`. All status fetches use `redirect: 'error'`, so a loopback stub
   cannot bounce the daemon to an external host.
6. Every logged terminal fragment and every stored `bannerText` passes
   through the one `sanitize()` function (ANSI-stripped, credential-
   redacted, truncated), at `info` and `debug` alike.

## Files

```
watchdog.mjs          # sanitize, OUTAGE pattern table, final-block chrome
                      # allow-list, kind-aware detectBanner, inferPlatform,
                      # validateEvent, per-kind schedule, reconcile order,
                      # status gate (injected fetch, redirect:'error'),
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
  with `⎿` prefix and without; `API Error: Connection error`;
  `API Error: 503 Service Unavailable`; each followed by blank lines, a
  rule line, `> ` input box, and `? for shortcuts`; each on `claude` and on
  `unknown`.
- **Detection negatives:** `API Error: 400 …`, `401`, `403`, `429`; the
  positive line on a `codex` terminal; a quoted `API Error: 529` inside
  agent prose (mid-line, anchor fails); source code and log lines containing
  `500`, `529`, `overloaded`, `connection reset`, `stream error`,
  `ECONNRESET`, `fetch failed`; ordinary agent output ending at `> ` with no
  error; a positive error line followed by agent prose and then `> `
  (stale, fails final block); a positive line followed by a shell prompt;
  `Retrying in 5s…` on the line after the error; retry marker on the same
  line; `reconnecting…` alone; ANSI-wrapped versions of each.
- **Retry chronology:** error after retry marker ⇒ outage; retry marker after
  error ⇒ none; two errors with a retry marker between them ⇒ outage.
- **Class precedence:** old limit / new API error ⇒ outage; old API error /
  new limit ⇒ limit; limit banner whose `LIMIT_RE` line precedes the API
  error but whose `RESET_RE` line follows it ⇒ limit (last contributing
  line); one line matching both ⇒ limit.
- **`inferPlatform`:** `agentIdentity` wins over banner; `claude-api-error`
  ⇒ claude when identity absent; garbage identity ⇒ falls through.
- **`sanitize`:** strips ANSI, redacts `sk-…`, `ghp_…`, `Bearer …`, `AKIA…`,
  a 40-char hex run; leaves ordinary words and short hashes alone;
  truncates at the limit.
- **Prompt guard:** endings `$`, `%`, `#`, `❯`, `➜`, `λ`, `❱`, `foo>`
  reject; exact `>` accepts with `agentIdentity: claude` and rejects
  without; ANSI-coloured prompt rejects; trailing whitespace ignored.
- **State:** v1 file loads with `kind: 'limit'`, `platform: 'unknown'`, all
  other fields intact; v2 round-trips; save always writes version 2;
  backup-and-reset for: version 3, missing `kind`, `platform: 'gpt'`,
  `kind: outage` + `platform: unknown`, `attempts: -1`, `attempts: 7`,
  `attempts: 1.5`, `detectedAt: 'yesterday'`, handle ≠ key, `resumed` with
  `lastAttemptAt: null`.
- **Lifecycle (outage):** no candidate before +10 min; candidate at exactly
  +10 min; second send ≥ 30 min after the first only if the banner persists
  through the 10-min verify; sixth send stays `resumed` for 10 min then
  `gave_up`; `gave_up` at exactly +24 h with attempts left; a `gave_up`
  event whose banner clears is deleted; unread event past retry spacing and
  past the deadline stays frozen (no candidate, no `gave_up`).
- **Replace:** limit→outage and outage→limit from `waiting`, `resumed`,
  and `gave_up` each yield a fresh event with `attempts: 0`; platform
  claude→codex on a same-kind event likewise; known→`unknown` keeps the
  event and its accounting.
- **Status gate:** `major` suppresses without consuming an attempt and the
  same event is a candidate again next tick with identical accounting;
  `critical` suppresses; `none`, `minor`, `weird` proceed; thrown fetch,
  non-JSON, non-200 proceed; `unknown` platform never calls fetch; claude
  `major` does not suppress a codex candidate in the same tick; fetch called
  at most once per platform per tick with two candidates.
- **Fresh re-read:** banner cleared ⇒ event deleted, no send; kind changed ⇒
  event replaced, no send, no attempt counted; read throws / times out ⇒
  event unchanged, no send, no attempt counted, no deletion.
- **Status URL override:** `http://127.0.0.1:…` and `http://localhost:…`
  honoured; `https://evil.example` and `file:///…` ignored with `warn`; a
  loopback stub answering 302 to an external host ⇒ fetch failure ⇒ fail
  open, and no request reaches the redirect target (assert with a second
  loopback listener that must receive nothing).

E2E (`e2e/`): start `status-stub.mjs` on a loopback port scripted to answer
`major` then `none`; run `fake-tui.mjs --outage` in a scratch Orca terminal;
preseed `state.json` with a due v2 outage event for that handle
(`resetAt` in the past) so no ten-minute wait is needed; set
`WATCHDOG_STATUS_URL_CLAUDE` to the stub; run `--once` twice; assert zero
sends after tick one and exactly one outage resume line after tick two.

Live: `node watchdog.mjs --dry-run` against the real Orca with no outage in
progress ⇒ "no action" and no network calls (verified by the debug log).
