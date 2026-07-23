# orca-limit-watchdog — Design

**Date:** 2026-07-23
**Status:** Approved (rev 2, post Codex review — simplified)

## Problem

Agent TUI sessions running in Orca (Claude Code, Codex, Gemini, Grok, Pi) hit
subscription rate limits and sit paused at a limit banner until a human sends a
resume prompt. Overnight and unattended runs stall for hours.

## Goal

A local, deterministic (zero-token, no-AI) watchdog that detects rate-limited
Orca agent terminals and sends a resume prompt after the limit resets —
normally exactly one, at most three. It must keep working precisely when every
agent subscription is exhausted. Worst-case failure is bounded and benign: one
line of text typed into a terminal.

## Non-goals

Launching Orca; reviving exited processes; non-Orca terminals; notifications;
worktree-card updates; per-agent banner classification.

## Architecture

One dependency-free Node script (`watchdog.mjs`, Node ≥ 20, ESM) run by a
launchd LaunchAgent every 5 minutes (`StartInterval 300`, `RunAtLoad true`).
Each tick: read Orca state → reconcile with state file → act → exit.

- Every `orca` invocation: `execFile` with 15 s timeout; on timeout, kill and
  treat as failed. A failure on one terminal logs and skips that terminal; the
  tick continues.
- Global tick deadline: 4 minutes (timer → log + exit 1).
- Lock: `open(lockPath, 'wx')` (atomic); lock file older than 10 min is
  removed and re-acquired unconditionally — with per-call timeouts and the
  tick deadline, no legitimate tick lasts 10 minutes.
- Orca not running (`runtime_unavailable`): log debug, exit 0. Never launch it.
- Kill switch: if `<state dir>/disabled` exists, exit immediately.
- launchd plist carries the **absolute node path** resolved and validated
  (≥ 20) by `install.sh` at install time; no PATH assumptions.

## Detection

Per terminal (`orca terminal list --json`, then `terminal read`): take the
**last 15 lines** of output. A limit banner is detected when BOTH match there
(case-insensitive):

- limit phrase: `(usage|rate|session|weekly|\d+-hour) limit` followed within
  the same 15-line window by `(reached|hit|exceeded)` — plus Codex's exact
  `you've hit your usage limit`
- reset phrase: `resets?|try again|available|come back`

`approaching .* limit` anywhere in the window vetoes the match (warning
banners, not pauses). No per-agent classification — one conservative rule.

### Reset-time parsing

First parsable expression near the match: `3am` / `4:30pm` (12 h),
`14:00` (24 h), `in 2 hours [15 minutes]` (relative). Local time.
Absolute times up to **2 h in the past** mean "already reset — act now";
older ones roll to the next day. Unparsable ⇒ `resetAt = detectedAt + 1 h`.
DST shifts are absorbed by the retry rule; no special handling.

## State machine

State file `~/.local/state/orca-limit-watchdog/state.json`, written atomically
(tmp + rename). Schema v1:

```json
{ "version": 1,
  "events": { "<terminal handle>": {
      "handle": "...", "bannerText": "...", "detectedAt": "ISO",
      "resetAt": "ISO", "attempts": 0, "lastAttemptAt": null,
      "status": "waiting|resumed|gave_up" } } }
```

Event identity is the **terminal handle alone** — a terminal can only be
rate-limited by one limit at a time. Keying by banner text was tried first and
failed in E2E: the watchdog's own echoed resume text mutates the tail, which
changed the fingerprint and spawned a duplicate event (a resend loop). Handle
keying makes banner-text mutations (echoes, countdown digits) irrelevant.

Lifecycle (uniform — no separate probe mode):

- **detected** → create event, `status: waiting`.
- **ready** (now ≥ resetAt + 2 min): idle-check (`terminal wait --for
  tui-idle --timeout-ms 5000`; timeout ⇒ skip, retry next tick) → **re-read
  tail; banner must still be present** → record attempt in state and persist
  → send `Session rate limit has reset. Resume where you left off.` + Enter →
  `status: resumed`.
- **verify**: if the banner is still in the tail ≥ 10 min after an attempt,
  the attempt failed (sent too early, lost, or ignored) → back to `waiting`
  with next attempt ≥ 30 min out. Max 3 attempts, then `gave_up` (logged
  loudly).
- **end of life**: an event whose terminal no longer shows any limit banner is
  finished — delete it. A banner appearing again later on that terminal is a
  new event. Events whose handle vanishes from `terminal list` (or is stale)
  are deleted.

Ordering guarantee: attempt is persisted **before** the send; a crash between
the two wastes one attempt and the verify rule recovers the resume. Corrupt
state → backed up to `state.json.bad-<ts>`, reset empty; worst case one extra
resume into a still-bannered (i.e. still paused) terminal.

## Safety properties

1. At most 3 sends per event, normally 1; enforced by persisted attempts.
2. Send requires: banner in last 15 lines on a fresh read after the idle
   check. Best-effort against races; residual worst case is one line of text.
3. Text + Enter only; never `--interrupt`.
4. Any failure logs and exits cleanly; launchd cadence is never broken.

## Files

```
watchdog.mjs            # everything: patterns, parser, state, tick, CLI
watchdog.test.mjs       # node --test
e2e/fake-tui.mjs       # prints a real Claude banner, echoes stdin to a file
com.john.orca-limit-watchdog.plist   # template; install.sh fills node path + $HOME
install.sh / uninstall.sh
README.md
```

Runtime: `~/.local/state/orca-limit-watchdog/{state.json,watchdog.log,lock,disabled}`.
Log: `ISO-ts level msg` lines, truncated to newest ~500 lines past 1 MB.

## CLI

`node watchdog.mjs` (tick) · `--once --dry-run` (print intended actions, no
sends, no state writes) · `--status` (dump events).

## Testing

- `node --test`: banner fixtures per agent (positive; negatives including the
  "approaching" veto, code-discussing-limits, missing reset phrase);
  time parsing (12 h/24 h/relative/2 h-grace/rollover/unparsable); lifecycle
  (once-per-event, retry-after-10-min, max-3, banner-absent deletion,
  reappear-as-new-event).
- Live dry-run against Orca with no limits ⇒ "no action".
- E2E: run `e2e/fake-tui.mjs` in a scratch Orca terminal with a resetAt 1 min
  out; two manual ticks; assert exactly one resume line lands in the fake
  TUI's received-input file.
