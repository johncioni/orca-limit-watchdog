# Changelog

All notable changes to Orca Watchdog are documented here.

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
