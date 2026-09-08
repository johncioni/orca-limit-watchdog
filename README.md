# orca-limit-watchdog

Local, deterministic watchdog that detects rate-limited agent TUIs (Claude
Code, Codex, Gemini, …) in [Orca](https://orca.dev) terminals and sends a
resume prompt after the limit resets. Zero AI, zero tokens — it keeps working
precisely when every agent subscription is exhausted.

## How it works

launchd runs `watchdog.mjs` every 5 minutes. Each tick reads every connected
Orca terminal's tail and looks for one of two banners in the last 15 lines:

- **Rate limit** (limit phrase + reset phrase): parses the stated reset time
  and, once it has passed and the terminal is idle with the banner still
  showing, sends
  > Session rate limit has reset. Resume where you left off.

  Normally one send per event; up to two retries 30 min apart, then it gives
  up loudly in the log.
- **API outage** (Claude Code's own `API Error: 5xx / Connection error /
  overloaded_error` line as the final stalled banner, on a terminal running
  Claude Code—identified by Orca as `claude`, or by Claude Code's own
  `API Error:` banner; a bare `>` last line is trusted only with the Orca
  identity): waits 10 min, then sends
  > The API outage appears to be over. Resume where you left off.

  Up to 6 sends 30 min apart, hard stop 24 h after detection. Before each
  send it checks `status.claude.com`; a `major`/`critical` incident holds the
  send (without using an attempt). Any status-page problem fails open.
  Codex outage detection is not enabled yet (no captured transcript).

Both kinds refuse to send when the terminal's last line is a shell prompt
(the agent exited). Network access is limited to the two status pages and
happens only when an outage send is due; `WATCHDOG_STATUS_URL_CLAUDE` /
`_CODEX` override them for tests and are honoured only for loopback URLs.

## Install

```bash
./install.sh      # validates node ≥ 20, writes plist, launchctl bootstrap
./uninstall.sh
```

## Operate

```bash
node watchdog.mjs --dry-run          # what would it do right now
node watchdog.mjs --once             # readability alias for one normal tick
node watchdog.mjs --status           # active events
touch  ~/.local/state/orca-limit-watchdog/disabled   # pause everything
rm     ~/.local/state/orca-limit-watchdog/disabled   # re-enable
tail -f ~/.local/state/orca-limit-watchdog/watchdog.log
```

## Test

```bash
node --test       # unit tests (patterns, time parsing, lifecycle)
```

`--once` is a readability alias for a single normal tick; it does not change
the daemon's one-tick-per-invocation behavior.

E2E (scratch Orca terminal, never a live agent):

```bash
node e2e/status-stub.mjs 8123 major,none &                 # tick 1 held, tick 2 sends
orca terminal create --command 'node e2e/fake-tui.mjs /tmp/recv.txt --outage'   # note the handle
# preseed a due outage event for that handle (resetAt in the past), then:
WATCHDOG_STATUS_URL_CLAUDE=http://127.0.0.1:8123/api/v2/status.json node watchdog.mjs --once
WATCHDOG_STATUS_URL_CLAUDE=http://127.0.0.1:8123/api/v2/status.json node watchdog.mjs --once
cat /tmp/recv.txt   # exactly one outage resume line
```

## Develop

```bash
bash scripts/orca-setup.sh   # full local gate: node >= 20, syntax checks, node --test
```

`orca.yaml` runs that script when Orca creates a worktree for this repo, so a
spawned agent lands in a checkout that has already passed the gate. The agent
workflow (roles, review loop, Orca and Linear conventions) is in `CLAUDE.md`.

Design specs:

- `docs/superpowers/specs/2026-07-23-orca-limit-watchdog-design.md` (rate-limit resume)
- `docs/superpowers/specs/2026-09-07-outage-resume-design.md` (API-outage resume)
