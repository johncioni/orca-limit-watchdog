# orca-limit-watchdog

Local, deterministic watchdog that detects rate-limited agent TUIs (Claude
Code, Codex, Gemini, …) in [Orca](https://orca.dev) terminals and sends a
resume prompt after the limit resets. Zero AI, zero tokens — it keeps working
precisely when every agent subscription is exhausted.

## How it works

launchd runs `watchdog.mjs` every 5 minutes. Each tick reads every connected
Orca terminal's tail, looks for a limit banner (limit phrase + reset phrase in
the last 15 lines), parses the stated reset time, and — once it has passed and
the terminal is idle with the banner still showing — sends:

> Session rate limit has reset. Resume where you left off.

Normally exactly one send per limit event; if the banner survives a send, up
to two retries 30 min apart, then it gives up loudly in the log.

## Install

```bash
./install.sh      # validates node ≥ 20, writes plist, launchctl bootstrap
./uninstall.sh
```

## Operate

```bash
node watchdog.mjs --dry-run          # what would it do right now
node watchdog.mjs --status           # active events
touch  ~/.local/state/orca-limit-watchdog/disabled   # pause everything
rm     ~/.local/state/orca-limit-watchdog/disabled   # re-enable
tail -f ~/.local/state/orca-limit-watchdog/watchdog.log
```

## Test

```bash
node --test       # unit tests (patterns, time parsing, lifecycle)
```

Design: `docs/superpowers/specs/2026-07-23-orca-limit-watchdog-design.md`.
