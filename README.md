# Orca Watchdog

**Orca Watchdog** is a local [launchd](https://www.launchd.info/) daemon for
macOS that watches your connected [Orca](https://onorca.dev) terminals for a
stalled agent TUI and sends a one-line resume prompt when — and only when — it
is safe to. Zero AI, zero tokens: it acts precisely when the agent subscriptions
it watches are exhausted or a provider is down, and does nothing the rest of the
time. (The installed command is `orca-watchdog`.)

It handles three conditions:

- **Rate limit** — a terminal shows a limit banner with a stated reset time. The
  watchdog waits until that time has passed and the terminal is still idle on the
  banner, then sends one resume prompt.
- **API outage** — a terminal shows an outage banner (Claude Code's own
  `API Error: 5xx / Connection error / overloaded_error`, or Codex's error line).
  The watchdog waits out a hold, re-checks the relevant status page
  (`status.claude.com` / `status.openai.com`), and resumes once the incident
  clears.
- **Codex limit with no reset time** — asks you what to do in a native macOS
  alert; nothing is sent until you choose **Continue** or **Wait 1h**.

It is plain Node with no dependencies, and its only network access is a
lightweight connectivity probe (before any resume) and the two status pages
(contacted only when an outage resume is actually due).

> [!IMPORTANT]
> The watchdog's entire blast radius is `orca terminal send` into your live
> agent terminals. Every design choice errs toward **not** sending: it installs
> stopped, holds instead of guessing whenever a check is inconclusive, and never
> touches a terminal that is busy, holds a draft, or has dropped to a shell
> prompt.

## Requirements

- **macOS** (uses `launchd` and `plutil`).
- **Node.js 22 or newer.** Homebrew installs this for you; the archive install
  expects `node` on your `PATH` (or set `ORCA_WATCHDOG_NODE` to an absolute path).
- **[Orca](https://onorca.dev)** with its `orca` CLI available (or set `ORCA_CLI`
  to its absolute path). The watchdog needs `orca terminal list/read/wait/send`.

## Install

The watchdog installs **stopped**. Nothing is registered with `launchd` and no
terminal is ever touched until you explicitly `start` it.

### Homebrew (recommended)

Add the tap, trust it (newer Homebrew requires trusting third-party taps), then
install:

```bash
brew tap johncioni/tap
brew trust johncioni/tap
brew install johncioni/tap/orca-watchdog
```

Homebrew installs Node for you and manages upgrades (see [Update](#update)). It
also installs the shell completions and the `man orca-watchdog` page.

### Archive

Download the release archive and its checksum from the
[releases page](https://github.com/johncioni/orca-watchdog/releases), verify it,
then run the bundled installer (substitute the version you downloaded for
`<version>`):

```bash
# from the download directory, with the .tar.gz and .sha256 side by side:
shasum -a 256 -c orca-watchdog-<version>.tar.gz.sha256   # verify the download
tar xzf orca-watchdog-<version>.tar.gz
cd orca-watchdog-<version>
./install.sh
```

The archive installs a versioned copy under
`~/.local/share/orca-watchdog/<version>/` and links the command into
`~/.local/bin/orca-watchdog` (make sure `~/.local/bin` is on your `PATH`).

The archive also ships shell completions and a man page under `completions/` and
`man/`, but `install.sh` does not wire them into your shell — set them up by hand
if you want them (Homebrew does this for you). From the extracted directory:

```bash
# Bash (with bash-completion): source it, or copy into a completions dir
source completions/orca-watchdog.bash
# Zsh: place _orca-watchdog on your $fpath, e.g.
cp completions/_orca-watchdog ~/.zsh/completions/   # then: fpath+=~/.zsh/completions; autoload -Uz compinit; compinit
# Fish
cp completions/orca-watchdog.fish ~/.config/fish/completions/
# Man page: copy into a directory on your $MANPATH, e.g.
cp man/orca-watchdog.1 ~/.local/share/man/man1/       # then: man orca-watchdog
```

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
orca-watchdog logs       # latest activity (read-only); --follow, --lines, --source
orca-watchdog pause      # stop acting without unregistering or losing state
orca-watchdog resume     # re-enable
orca-watchdog --dry-run  # run one observation-only tick; never sends input
orca-watchdog stop       # unregister the LaunchAgent (state is retained)
```

`pause` takes effect immediately — it also halts the remaining sends of a tick
that is already running, not just future ticks.

Logs and state live under `~/.local/state/orca-watchdog/`: `watchdog.log`
(activity), `launchd.out.log` / `launchd.err.log` (service output), `state.json`
(tracked events), and `disabled` (present while paused). State and log files are
created owner-only (`0600`).

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

Your pause state and tracked events are preserved across updates. Downgrading to
a version from before the reset-less alert feature causes that version to back up
and reset a state file that contains the newer event kind.

## Remove

```bash
orca-watchdog stop
brew uninstall johncioni/tap/orca-watchdog   # Homebrew
./uninstall.sh                               # archive
```

Removal unregisters the service and deletes the installed copy but **retains your
state** at `~/.local/state/orca-watchdog/`. Delete that directory by hand if you
want a clean slate.

## Troubleshooting

- **`orca-watchdog doctor`** is the first stop: it reports macOS, Node, Orca CLI,
  launchd registration, pause, and event state, and exits non-zero if anything
  required is missing.
- **`orca` not found under launchd?** launchd runs with a minimal `PATH`. The
  watchdog resolves absolute paths to Node and Orca when you `start`, so start it
  from a shell where `orca` resolves, or set `ORCA_CLI` to an absolute path.
- **Nothing happens on a stalled terminal?** Run `orca-watchdog --dry-run` to see
  what the current tick observes, and read the activity log with
  `orca-watchdog logs`.
- **Inspecting logs.** `orca-watchdog logs` prints the latest activity (read-only);
  add `--follow` to watch it live, `--lines N` for more history, or
  `--source stdout|stderr` to see the launchd job's own output — the first place to
  look if the service is registered but ticks never run.

## How it works

`launchd` runs `watchdog.mjs` every 5 minutes. Each tick reads every connected
Orca terminal's tail, looks for a banner in the last 15 lines, reconciles what it
finds against the events it is already tracking, and then — for any event whose
resume is due — walks a fixed sequence of safety gates before it will send. If
any gate is inconclusive, it holds and tries again on a later tick.

```mermaid
flowchart TD
    A["launchd timer — every 5 min"] --> P{"Paused, or another<br/>tick already running?"}
    P -->|yes| Z(["Do nothing"])
    P -->|no| R["Read every connected<br/>Orca terminal's tail"]
    R --> D["Detect a banner in the last 15 lines:<br/>rate limit, outage, or Codex reset-less limit"]
    D --> RC["Reconcile events<br/>(new, cleared, replaced, re-armed, gave up)"]
    RC --> Q{"Any event due<br/>to resume?"}
    Q -->|no| Z
    Q -->|yes, each| G0{"Paused now?"}
    G0 -->|yes| Z
    G0 -->|no| G1{"Online?<br/>probe captive.apple.com"}
    G1 -->|offline| HOLD["Hold — no attempt spent,<br/>retry next tick"]
    G1 -->|online| G2{"Outage? re-check<br/>the status page"}
    G2 -->|incident or unverifiable| HOLD
    G2 -->|healthy / not an outage| G3{"Terminal idle?<br/>orca wait tui-idle"}
    G3 -->|busy| SKIP["Skip this tick"]
    G3 -->|idle| G4["Re-read the tail<br/>and re-detect the banner"]
    G4 --> G5{"Still the same banner,<br/>still due?"}
    G5 -->|no| SKIP
    G5 -->|yes| G6{"Last line a shell prompt?<br/>(agent has exited)"}
    G6 -->|yes| DROP["Drop the event"]
    G6 -->|no| G7{"Input box holds<br/>a draft?"}
    G7 -->|yes| SKIP
    G7 -->|no| SEND(["Send ONE resume prompt<br/>orca terminal send"])
```

The details behind the diagram:

- **Rate limit.** Parses the stated reset time; once it has passed and the
  terminal is still idle on the banner, sends one resume prompt. Normally one send
  per event, with up to two retries 30 minutes apart before it gives up loudly in
  the log. If the banner is still on screen but its reset time moves materially
  later, the watchdog honours the new time and keeps waiting.
- **API outage.** Waits 10 minutes, then before each send re-checks the relevant
  status page. A `major`/`critical` incident holds the send without consuming an
  attempt — and so does a status page that can't be reached or returns an
  unexpected response: the gate is **fail-closed**, so only a confirmed-healthy
  status lets the resume proceed (`hold: provider health unverifiable` is logged
  otherwise). Up to 6 sends 30 minutes apart, with a hard stop 24 hours after
  detection. Codex terminals are additionally held while `Reconnecting... N/5` or
  `esc to interrupt` is on screen.
- **Connectivity probe.** Before sending **any** resume, the watchdog confirms the
  machine is online with a single HTTPS reachability probe to
  `https://captive.apple.com/hotspot-detect.html`. While offline it holds without
  spending an attempt and retries once connectivity returns, so a resume is never
  fired into the void during a local network drop. The probe host is overridable
  via `WATCHDOG_CONNECTIVITY_URL` (loopback hosts only, for testing); anything
  else is ignored with a warning.
- **Codex reset-less limit.** For a Codex `■` limit banner with no derivable reset
  time, the watchdog shows one native macOS alert per episode. **Continue** enables
  retries starting on the next tick, spaced 30 minutes apart, capped at 6 sends and
  24 hours from your choice. **Wait 1h** delays the first retry by an hour, with the
  same 24-hour cap (offline time counts toward it). **Stop** suppresses retries
  until the banner is confirmed gone, even if its wording or reset time changes. No
  click means no send. Choices are stored per terminal and episode under
  `~/.local/state/orca-watchdog/choices/` and deleted after consumption. This alert
  is Codex-only, and `--dry-run` never opens it or consumes a choice.

A few invariants worth stating plainly: every kind **refuses to send when the
terminal's last line is a shell prompt** (the agent has exited) or when the input
box already holds a draft. Outage detection is scoped to terminals Orca identifies
as Claude Code or Codex; rate-limit detection is generic. Untrusted terminal text
is length-capped and sanitized (secrets redacted) before it is matched or logged,
and a malformed read or parse on one terminal can never abort the tick for the
others. Network access is limited to the connectivity probe (once per tick that
has a send due) and the two status pages (only when an outage send is due).

## Contributing & security

- Contributor setup and workflow: [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Reporting a vulnerability: [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE) © John Cioni. An independent community utility; not affiliated
with Orca, Anthropic, or OpenAI.
