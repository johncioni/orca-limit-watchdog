# Security policy

## What this software does

Orca Watchdog (the `orca-watchdog` command) is a local macOS `launchd`
daemon. Its only outward actions are:

- reading the tail of your connected Orca terminals via the `orca` CLI, and
- sending a fixed one-line resume prompt into a terminal when a rate limit or API
  outage clears (never when the terminal shows a shell prompt).

Its only network access is:

- `captive.apple.com` (a reachability probe) before **any** due resume — rate-limit
  or outage — so it never resumes while the machine is offline; and
- `status.claude.com` / `status.openai.com` (Statuspage JSON) only when an **outage**
  resume is due, to hold the resume if the provider still reports a major/critical
  incident.

Both the connectivity probe and the status URLs accept a loopback
(`127.0.0.1` / `localhost` / `[::1]`) override, honoured only for the end-to-end test
stubs; any non-loopback override is ignored. It stores no secrets and ships no
dependencies.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public
issue for a security problem.

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**
(<https://github.com/johncioni/orca-watchdog/security/advisories/new>).

Please include:

- the version (`orca-watchdog --version`) and your macOS and Node versions,
- a description of the issue and its impact,
- steps to reproduce, and any relevant `watchdog.log` excerpts (redact anything
  sensitive first).

You can expect an initial response within a few days. Because this is a
volunteer-maintained utility, please allow reasonable time for a fix before any
public disclosure.

## Supported versions

Only the latest released version receives fixes.
