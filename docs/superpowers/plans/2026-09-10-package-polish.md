# DOG-28 package polish — approved plan

Implement in this child worktree, one task at a time. Parent supervises and
launches independent Opus review. Local commits only; never push.

## Checklist

- [ ] 1. Operational status: service registration (distinct from a running
  periodic process), installed version, last completed check, last successful
  resume, pending events and latest waiting reason. Separate versioned atomic
  owner-only health.json; event-state format unchanged. Reasons: offline,
  provider health, reset time, user choice, busy terminal, draft input, failed
  read/send, exhausted retries. Label observations. Missing/corrupt metadata is
  unknown, never resets events or changes eligibility. Dry run writes none.
- [ ] 2. Logs: latest 100 activity lines; logs --follow, --lines N,
  --source activity|stdout|stderr. Follow append/truncate/replace, clean Ctrl-C,
  missing files normal. At existing 1MB threshold bound activity by bytes and
  lines; maintain launchd stdout/stderr during normal locked ticks, newest
  500KB maximum, without renaming open files. Owner-only; reject unexpected
  symlinks. No retention writes in dry/read-only commands. Document startup
  failures may prevent maintenance.
- [ ] 3. Doctor: inspect saved plist and loaded job Node/runtime/Orca paths;
  missing targets, stale runtime versions, saved-loaded disagreement. Accept
  valid stable symlinks including explicit Node override. Diagnose malformed
  event/health metadata read-only. Deliberately stopped is valid. Specific
  recovery commands, no automatic repair/restart/register/send.
- [ ] 4. Packaging: Bash, Zsh, Fish completions for all public commands/log
  options; man orca-watchdog covers installation, operation, upgrades,
  diagnostics, logs, locations. Curated release assets and Homebrew standard
  dirs; archive manual shell/man setup. No external tap edits/publication.
- [ ] 5. Documentation and final gates: help, troubleshooting, upgrade guidance,
  changelog. README install block includes exactly the sequence
  `brew tap johncioni/tap`, `brew trust johncioni/tap`,
  `brew install johncioni/tap/orca-watchdog`. First start explicit; upgrades
  stop -> upgrade -> doctor -> start; Homebrew manages upgrades.

## Verification and evidence

Failing tests BEFORE behavioral implementation. Cover completed, unavailable,
failed, interrupted checks; successful/failed sends; reasons; stale/missing/
corrupt metadata; unchanged resume decisions. Cover log limits, long lines,
Unicode, missing/follow/truncate/replace, permissions/symlinks. Doctor uses fake
launchctl/plutil/Orca for healthy/stopped/missing/stale/mismatch. Verify release
contents, completion syntax, man rendering, formula installation assets.
Run `bash scripts/orca-setup.sh`, `node --test`, `git diff --check`.
Runtime execution uses isolated HOME and fakes only.

No live sends, install.sh, launchctl mutations, state deletion, deployment,
dependencies, updater, upgrade polling, or publication. Record meaningful
RED/GREEN progress in gitignored HANDOFF.md (<60 lines). Finish with local
commits (unsigned if signing app unavailable, explain), clean tracked status,
fresh HANDOFF.md and .superpowers/package-polish-result.md with SHAs,
verification and limitations. Escalate there if harder than assumed.
