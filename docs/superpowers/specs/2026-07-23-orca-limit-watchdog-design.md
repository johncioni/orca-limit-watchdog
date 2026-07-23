# orca-limit-watchdog — Design

**Date:** 2026-07-23
**Status:** Approved

## Problem

Agent TUI sessions running in Orca (Claude Code, Codex, Gemini, Grok, Pi) hit
subscription rate limits and sit paused at a limit banner until a human sends a
resume prompt. Overnight and unattended runs stall for hours. A prior machine
had an ad-hoc loop doing this; this is the clean, version-controlled rebuild.

## Goal

A local, deterministic (zero-token, no-AI) watchdog that detects rate-limited
Orca agent terminals, notes the stated reset time, and sends one resume prompt
after the limit resets. It must keep working precisely when every agent
subscription is exhausted, and be trustworthy enough to run while the user
sleeps.

## Non-goals

- Launching Orca or reviving agent processes that *exited* (only paused TUIs).
- macOS notifications, Orca worktree-card status updates (future work).
- Monitoring non-Orca terminals (Terminal.app, iTerm, tmux).

## Architecture

One dependency-free Node script (`watchdog.mjs`, Node ≥ 20, ESM) run by a
launchd LaunchAgent every 5 minutes (`StartInterval 300`, `RunAtLoad true`).
Each run: read Orca state → reconcile with the state file → act → exit.

- Orca app not running (`orca` returns `runtime_unavailable`): log at debug
  level, exit 0. Never launch Orca.
- Lockfile (`state dir/lock`, containing pid) prevents overlapping runs; a
  lock older than 10 minutes with a dead pid is stolen.
- Kill switch: if `state dir/disabled` exists, exit immediately. Enable/disable
  with `touch` / `rm`.

`ORCA_CLI` env var overrides the orca binary path (default `orca`, resolved
via PATH with `/usr/local/bin` appended, since launchd's PATH is minimal).

## Detection

1. `orca terminal list --json` → all terminals (handle, worktree, title).
2. For each terminal: `orca terminal read --terminal <handle> --json` and take
   the tail (last ~40 visible lines) of the returned content.
3. Match the tail against the pattern table. First match wins; the generic
   fallback runs only if no agent-specific pattern matches.

### Pattern table

| Agent | Limit-banner patterns (case-insensitive) |
|---|---|
| Claude Code | `usage limit reached`, `\d+-hour limit reached`, `weekly limit reached`, `approaching usage limit` is **ignored** (warning, not a pause) |
| Codex | `you've hit your usage limit`, `usage limit.*try again`, `rate limit reached` |
| Gemini | `quota exceeded`, `rate limit`, `daily limit` |
| Grok / Pi / other | generic fallback |
| Generic fallback | `(usage|rate|session) limit` AND `(reached|hit|exceeded)` |

Patterns live in one exported table (`PATTERNS`) so new banner formats are a
one-line addition.

### Reset-time parsing

From the matched banner region, extract the first parsable reset expression:

- `resets [at] 3am`, `resets [at] 4:30pm` — 12-hour clock
- `try again at 14:00`, `resets at 09:15` — 24-hour clock
- `resets in 2 hours`, `try again in 45 minutes`, `in 1 hour 30 minutes` — relative
- Parsed absolute times ≤ now roll forward to the next day (banner said `3am`,
  it is 11pm → tomorrow 03:00). Local timezone throughout.

If a limit banner matches but no time parses: **probe mode** — re-check every
30 minutes. If a probe finds the banner cleared, mark the event `cleared`
(someone or something else resumed it — never send). If the banner persists,
attempt one resume per probe interval starting one hour after detection
(banner-present + idle rules still apply; bounded retry, max 6 attempts, then
mark `gave_up` and log loudly).

## State machine

State file: `~/.local/state/orca-limit-watchdog/state.json`
Event key: `hash(terminal handle + normalized banner text)`.

```
detected ──(reset time parsed)──▶ waiting ──(now ≥ resetAt + 2min)──▶ ready
detected ──(no time parsed)─────▶ probing ──(backoff elapsed, banner persists)─▶ ready
probing ──(banner gone)──▶ cleared
ready ──(banner still in tail AND tui-idle ≤5s)──▶ send resume ──▶ resumed
ready ──(banner gone)──▶ cleared   (someone else resumed it; do nothing)
ready ──(not idle)─────▶ stays ready, retried next run
```

- `resumed` events never fire again. A new banner in the same terminal (text
  or position differs) is a new event.
- Events are pruned when: handle stale/missing from `terminal list`, event
  older than 7 days, or state `resumed`/`cleared` older than 24 h.
- Resume send: `orca terminal send --terminal <handle> --text "Session rate
  limit has reset. Resume where you left off." --enter --json`.
- Idle check: `orca terminal wait --terminal <handle> --for tui-idle
  --timeout-ms 5000 --json`; timeout ⇒ treat as busy ⇒ skip this run.

## Safety properties

1. **Send-once-per-event** — enforced by state, not by pattern absence.
2. **Banner-present + idle required** — cannot type into a session that
   already resumed or is actively producing output.
3. **Text + Enter only** — never `--interrupt`, never control sequences.
4. **Fail-quiet** — any `orca` error logs and exits 0; launchd cadence is
   never broken by a crash loop.
5. **Corrupt state** — backed up to `state.json.bad-<ts>` and reset to empty.

## File layout

```
~/Projects/orca-limit-watchdog/
  watchdog.mjs                          # everything: CLI, patterns, state, actions
  watchdog.test.mjs                     # node --test unit tests
  com.john.orca-limit-watchdog.plist    # launchd agent (template; install.sh fills $HOME)
  install.sh                            # copy plist → ~/Library/LaunchAgents, launchctl bootstrap
  uninstall.sh                          # launchctl bootout + rm plist
  README.md
  docs/superpowers/specs/               # this spec
Runtime state (not in repo):
~/.local/state/orca-limit-watchdog/{state.json,watchdog.log,lock,disabled}
```

Log: append-only, `ISO-ts level message` lines; truncated to the newest ~500
lines when it exceeds 1 MB.

## CLI contract

- `node watchdog.mjs` — one normal tick (what launchd runs).
- `--once --dry-run` — full tick against live Orca, prints intended actions,
  sends nothing, does not mutate state.
- `--status` — human-readable dump of current events and next actions.

## Testing

- **Unit (`node --test`)**: pattern table against real banner fixtures per
  agent (positive + negative, including the Claude "approaching" warning that
  must NOT match); reset-time parser cases (12h, 24h, relative, midnight
  rollover, unparsable); state transitions (once-per-event, new-event
  detection, pruning).
- **E2E dry-run**: `--once --dry-run` against live Orca with no limits —
  expect "no action".
- **E2E live**: scratch Orca terminal, `cat` a fake Claude limit banner with a
  reset time 1 minute in the future, run two ticks manually, verify exactly
  one resume message arrives and state shows `resumed`.

## Future work (explicitly deferred)

macOS notification on resume; `orca worktree set --comment "rate-limited
until <t>"` for card visibility; syncing this repo to the other machine.
