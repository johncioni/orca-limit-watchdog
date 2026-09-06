# CLAUDE.md

Guidance for any coding agent working in this repository. Codex and other
agents read `AGENTS.md`, which is a symlink to this file. Keep it that way.

## Project snapshot

**orca-limit-watchdog** is a macOS launchd daemon (`watchdog.mjs`, plain Node,
no dependencies) that detects rate-limit banners in Orca terminals and
auto-resumes them after the reset time. Design spec:
`docs/superpowers/specs/2026-07-23-orca-limit-watchdog-design.md`. Installed by
`install.sh` (writes the plist, `launchctl bootstrap`), removed by
`uninstall.sh`. Kill switch lives under `~/.local/state`. See `README.md` for
run/status flags.

## Build / run / test

```bash
node --test                 # unit tests (patterns, time parsing, lifecycle)
node watchdog.mjs --dry-run # what it would do right now
node watchdog.mjs --status  # active events
```

No package.json by design: the daemon must run with only the system Node.
Do not add dependencies.

## Review loop

**Roles, models, effort levels, and the review loop are universal:** see
`~/.agents/MODELS.md` (role table with default model + effort per role, the
orchestrator's per-dispatch selection rule, escalation, and the review loop).
This file adds only project-specific rules.

**Required checks:** `ci`, `gitleaks`, `review-evidence`.

**Invariant files (ineligible for the docs/test/size skips; the MODELS.md
opus-implementer exception still applies):** `watchdog.mjs` (the daemon
itself: a bug here can spam `orca terminal send` into every session),
`install.sh` / `uninstall.sh` (launchctl bootstrap/bootout), the launchd
plist, `.github/*`, `CLAUDE.md`.

**Branch protection is strict:** `main` requires the PR branch to be up to
date. On `mergeStateStatus: BEHIND`, run `gh pr update-branch <n>`, wait for
the checks to go green again, then merge; never `--admin`, never a force-push.

## Safety

- Never test against live Orca terminals from an agent session; use
  `--dry-run` or the fake TUI in `e2e/fake-tui.mjs`.
- **Deployment is a post-merge step, owned by the orchestrator:** after the
  PR merges, run `install.sh` from the main checkout (launchd caches the
  plist). Never run `install.sh` from a feature worktree: it would repoint the
  live LaunchAgent at an unmerged, disposable checkout. `--status` shows
  stored events, not service health; check `launchctl print gui/$(id -u)/com.john.orca-limit-watchdog`.
