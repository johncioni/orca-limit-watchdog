# Security policy

## What this software does

orca-limit-watchdog is a local macOS `launchd` daemon. Its only outward actions
are:

- reading the tail of your connected Orca terminals via the `orca` CLI, and
- sending a fixed one-line resume prompt into a terminal when a rate limit or API
  outage clears (never when the terminal shows a shell prompt).

Its only network access is to `status.claude.com` / `status.openai.com`, and only
when an outage resume is due. It stores no secrets and ships no dependencies.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public
issue for a security problem.

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**
(<https://github.com/johncioni/orca-limit-watchdog/security/advisories/new>).

Please include:

- the version (`orca-limit-watchdog --version`) and your macOS and Node versions,
- a description of the issue and its impact,
- steps to reproduce, and any relevant `watchdog.log` excerpts (redact anything
  sensitive first).

You can expect an initial response within a few days. Because this is a
volunteer-maintained utility, please allow reasonable time for a fix before any
public disclosure.

## Supported versions

Only the latest released version receives fixes.
