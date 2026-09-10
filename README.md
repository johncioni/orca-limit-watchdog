# Orca Watchdog

**Orca Watchdog** is a local [launchd](https://www.launchd.info/) daemon for
macOS that watches your connected [Orca](https://orca.dev) terminals for a
stalled agent TUI and sends a one-line resume prompt when — and only when — it
is safe to. Zero AI, zero tokens: it does its job precisely when the agent
subscriptions it watches are exhausted. (The installed command is
`orca-watchdog`.)

It handles these conditions:

- **Rate limit** — a terminal shows a limit banner with a stated reset time. The
  watchdog waits until that time has passed and the terminal is still idle on the
  banner, then sends one resume prompt.
- **API outage** — a terminal shows an outage banner (Claude Code's own
  `API Error: 5xx / Connection error / overloaded_error`, or Codex's error line).
  The watchdog waits out a hold, re-checks the relevant status page
  (`status.claude.com` / `status.openai.com`), and resumes once the incident
  clears.
- **Codex limit with no reset time** — asks you what to do in a native macOS
  alert; nothing is sent until you choose Continue or Wait 1h.

It is plain Node with no dependencies and no network access beyond a
lightweight connectivity probe (before any resume) and the two status pages
(contacted only when an outage resume is actually due).

## Requirements

- **macOS** (uses `launchd` and `plutil`).
- **Node.js 22 or newer.** Homebrew installs this for you; the archive install
  expects `node` on your `PATH` (or set `ORCA_WATCHDOG_NODE`).
- **[Orca](https://orca.dev)** with its `orca` CLI available (or set `ORCA_CLI`
  to its absolute path). The watchdog needs `orca terminal list/read/wait/send`.

## Install

The watchdog installs **stopped**. Nothing is registered with `launchd` and no
terminal is ever touched until you explicitly `start` it.

### Homebrew (recommended)

On newer Homebrew, first trust the third-party tap with `brew trust johncioni/tap`
(or approve interactively) before installing:

```bash
brew install johncioni/tap/orca-watchdog
```

### Archive

Download the release archive and its checksum from the
[releases page](https://github.com/johncioni/orca-watchdog/releases),
verify it, then run the bundled installer:

```bash
# from the download directory, with the .tar.gz and .sha256 side by side:
shasum -a 256 -c orca-watchdog-0.1.0.tar.gz.sha256   # verify the download
tar xzf orca-watchdog-0.1.0.tar.gz
cd orca-watchdog-0.1.0
./install.sh
```

The archive installs a versioned copy under
`~/.local/share/orca-watchdog/<version>/` and links the command into
`~/.local/bin/orca-watchdog` (make sure `~/.local/bin` is on your `PATH`).

## First run

```bash
orca-watchdog doctor   # confirm macOS, Node, Orca, and launchd state
orca-watchdog start    # validate, then register the LaunchAgent
orca-watchdog status   # service health, pause state, active events
```

Once started, `launchd` runs the watchdog every 5 minutes.

## Operate

```bash
orca-watchdog status     # service / pause / events, reported separately
orca-watchdog pause      # stop acting without unregistering or losing state
orca-watchdog resume     # re-enable
orca-watchdog --dry-run  # run one observation-only tick; never sends input
orca-watchdog stop       # unregister the LaunchAgent (state is retained)
```

Logs and state live under `~/.local/state/orca-watchdog/`:
`watchdog.log` (activity), `launchd.out.log` / `launchd.err.log` (service
output), `state.json` (tracked events), and `disabled` (present while paused).

## Update

**Homebrew:**

```bash
orca-watchdog stop
brew upgrade johncioni/tap/orca-watchdog
orca-watchdog doctor && orca-watchdog start
```

**Archive:** stop, install the new archive (it keeps the previous version for
rollback), then start again:

```bash
orca-watchdog stop
cd orca-watchdog-<new-version> && ./install.sh
orca-watchdog doctor && orca-watchdog start
```

If a new version misbehaves, roll back to the previous one and start:

```bash
orca-watchdog stop
./install.sh --rollback
orca-watchdog start
```

Your pause state and tracked events are preserved across updates.
Downgrading to a version from before the reset-less alert feature causes that
version to back up and reset a state file containing the new event kind.

## Remove

```bash
orca-watchdog stop
brew uninstall johncioni/tap/orca-watchdog   # Homebrew
./uninstall.sh                                      # archive
```

Removal unregisters the service and deletes the installed copy but **retains
your state** at `~/.local/state/orca-watchdog/`. Delete that directory by
hand if you want a clean slate.

## Troubleshooting

- **`orca-watchdog doctor`** is the first stop: it reports macOS, Node,
  Orca CLI, launchd registration, pause, and event state, and exits non-zero if
  anything required is missing.
- **`orca` not found under launchd?** launchd runs with a minimal `PATH`. The
  watchdog resolves absolute paths to Node and Orca when you `start`, so start it
  from a shell where `orca` resolves, or set `ORCA_CLI` to an absolute path.
- **Nothing happens on a stalled terminal?** Run `orca-watchdog --dry-run`
  to see what the current tick observes, and check `watchdog.log`.

## How it works

`launchd` runs `watchdog.mjs` every 5 minutes. Each tick reads every connected
Orca terminal's tail and looks for a rate-limit or outage banner in the last few
lines:

- **Rate limit:** parses the stated reset time; once it has passed and the
  terminal is still idle on the banner, sends one resume prompt. Normally one
  send per event, with up to two retries 30 minutes apart before it gives up
  loudly in the log.
- **API outage:** waits 10 minutes, then before each send checks the relevant
  status page. A `major`/`critical` incident holds the send without consuming an
  attempt; any other status-page trouble fails open. Up to 6 sends 30 minutes
  apart, with a hard stop 24 hours after detection. Codex terminals are held
  additionally while `Reconnecting... N/5` or `esc to interrupt` is on screen.

Before sending **any** resume (limit or outage), the watchdog confirms the
machine is actually online with a single HTTPS reachability probe to
`https://captive.apple.com/hotspot-detect.html`. While offline it holds the send
without spending an attempt and retries on a later tick once connectivity
returns, so a resume prompt is never fired into the void during a local network
drop. The probe host is overridable via `WATCHDOG_CONNECTIVITY_URL` (loopback
hosts only, for testing); anything else is ignored with a warning.

For a Codex `■` limit banner with no derivable reset time, the watchdog shows
one native macOS alert per episode. **Continue** enables retries starting on
the next tick, spaced 30 minutes apart, capped at 6 sends and 24 hours from
your choice. **Wait 1h** delays the first retry by an hour, with the same
24-hour cap from your choice; offline time counts toward that cap. **Stop**
suppresses retries until the banner is confirmed gone, even if its wording or
reset time changes. No click means no send. Choices are stored per terminal
and episode under `~/.local/state/orca-watchdog/choices/` and deleted
after consumption. This alert is Codex-only; dry-run never opens it or consumes
a choice.

All kinds **refuse to send when the terminal's last line is a shell prompt**
(the agent has exited). Outage detection is scoped to terminals Orca identifies
as Claude Code or Codex; rate-limit detection is generic. Network access is
limited to the connectivity probe (once per tick that has a send due) and the two
status pages (only when an outage send is due).

## Contributing & security

- Contributor setup and workflow: [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Reporting a vulnerability: [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE) © John Cioni. An independent community utility; not affiliated
with Orca, Anthropic, or OpenAI.
