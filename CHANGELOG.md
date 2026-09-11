# Changelog

All notable changes to Orca Watchdog are documented here.

## 1.1.0 - 2026-09-10

- **Richer `status`**: reports service registration (distinct from a running
  periodic process), the installed version, the last completed check, the last
  successful resume, and pending events with the latest waiting reason. Backed by
  a separate owner-only `health.json`; the event-state format is unchanged, and
  missing or corrupt metadata reads as unknown without ever resetting events.
- **New `logs` command**: prints the latest 100 activity lines, with `--follow`,
  `--lines N`, and `--source activity|stdout|stderr`. Read-only — it never
  rotates or truncates a log. During normal locked ticks the launchd stdout/stderr
  logs are bounded (newest 500KB) without renaming the open files.
- **Deeper `doctor`**: inspects the saved plist and the loaded launchd job for
  Node/runtime/Orca paths, flagging missing targets, stale runtime versions, and
  saved-vs-loaded disagreement. A deliberately stopped service is a valid state;
  malformed event/health metadata is diagnosed read-only and never repaired.
- **Shell completions and a man page**: Bash, Zsh, and Fish completions for every
  command and the `logs` options, plus `man orca-watchdog`. Homebrew installs both
  into the standard directories; the release archive ships `completions/` and
  `man/` for manual setup.
- **Robustness hardening**: state and health files are now written atomically
  (an exclusive temp file plus rename), so a crash mid-write can't leave a partial
  file and a symlink/hardlink tamper of a valid state can't block a send. A
  non-regular `state.json` or choice file (for example a FIFO) can no longer hang
  a tick, `status`, or `doctor`: it reads as unreadable and resets, never a send.

## 1.0.0 - 2026-09-10

- **Renamed the project to `orca-watchdog`** (command, install paths, launchd
  label, Homebrew formula). The domain term "rate limit" is unchanged.
- **Send-safety and robustness pass** across the daemon:
  - Fixed Claude API-outage detection, which the always-present usage footer had
    silently suppressed; outage resumes now fire (still fully gated).
  - The status-page gate is now **fail-closed**: an unreachable or unverifiable
    status page holds an outage resume instead of allowing it.
  - Added the "already resumed / scrolled-past banner" guard to generic rate-limit
    detection, so a stale banner no longer re-triggers a send.
  - `pause` now halts the remaining sends of an in-flight tick, not just future ticks.
  - Unknown CLI arguments fail closed (never a live tick); `--help` no longer ticks.
  - Hardened against untrusted terminal text (ReDoS/overflow bounds, per-terminal
    fault isolation so one bad read can't abort the tick, wider secret redaction).
  - Tightened lifecycle edges: reset-time refresh, failed-alert re-arm, atomic lock
    reclaim, safer install/service checks, `0600`/`0700` state permissions.
- **Overhauled the README** with a launchd/tick flowchart and an accurate,
  fail-closed description of the status gate.

## 0.1.1 - 2026-09-09

- Bake a stable Node path into the launchd plist (honor `ORCA_WATCHDOG_NODE`) so a `brew upgrade node` no longer breaks the service until the next `start`.
- Reap orphaned reset-less-limit alert choice files so they cannot accumulate.
- Report the accurate first violation when an invalid state file is rejected.
- Document the Homebrew tap trust step for newer Homebrew.

## 0.1.0 - 2026-09-08

- Initial public release.
- Detect agent rate-limit and supported API-outage banners in Orca terminals.
- Resume safely after reset times or outage recovery, with bounded retries.
- Add explicit service management, archive installation, and Homebrew release tooling.
