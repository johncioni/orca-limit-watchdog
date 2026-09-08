# Public distribution of Orca Limit Watchdog

Approved user plan, 2026-09-08. Tracked by DOG-18.

## Intent and boundaries

Publish the existing repository under MIT with versioned GitHub downloads and
the personal johncioni/homebrew-tap. Initial release is v0.1.0. Keep plain Node,
no dependencies, no GUI, bundled runtime, npm package, automatic updater, or
changes to detection/retry behavior. Leave the existing live deployment alone.

## Installation and operation

- Ship an architecture-independent archive. Homebrew supplies Node; archive
  users install Node separately.
- Public command `orca-limit-watchdog`: no args shows help; support --help,
  --version, doctor, start, stop, pause, resume, status, --dry-run. Invalid
  arguments fail without a tick.
- Doctor checks macOS, Node, Orca availability and required CLI capabilities,
  and launchd registration. Status separates service health, pause, and events.
- Install into stable storage, initially stopped. Starting is explicit.
- Share service management between archive and Homebrew; no brew services.
- Preserve launchd label and state location; detect existing installs and
  prevent duplicate registrations. Resolve absolute Node/Orca paths at start;
  support ORCA_CLI, without relying on interactive PATH under launchd.
- Replace Python plist generation with Node XML escaping; validate before
  registration.

## Packaging and docs

- One version source shared by CLI and release tools.
- Curated tar.gz: runtime, commands, installers, README, MIT license, changelog;
  publish SHA-256 checksums.
- Archive: versioned ~/.local/share/orca-limit-watchdog directories, stable
  current symlink, ~/.local/bin command. Validate before switching; retain
  previous version for rollback.
- Tap installs same release archive with pinned SHA; use stable Homebrew paths
  and normal upgrades. https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap
- Document stop before upgrade, doctor afterward, start again. Preserve state
  and pause on upgrades and state on removal.
- README: prerequisites, installation, first start, updates, removal,
  troubleshooting, supported agents. Explain terminal tail reads, resume
  prompt sends, retries/status-page behavior, local state/log contents.
- Add CONTRIBUTING, issue templates, security guidance, changelog, MIT license.
  Contributor setup self-contained; AGENTS.md stays symlink to CLAUDE.md;
  separate personal orchestration from contributor requirements.
- Independent community utility. Record only actually tested Orca/macOS
  versions; do not infer compatibility.

## Verification and publication

- CI macOS coverage and supported Node versions; Intel and Apple Silicon paths.
- Test missing prerequisites; paths with spaces, Unicode, XML; restricted
  launchd env; invalid args; repeat install; upgrade; rollback; removal; migration.
- Fake launchctl/Orca and isolated homes for lifecycle. Prove help, doctor,
  installation, packaging never send terminal input.
- Validate release archive/formula end to end in isolated macOS; fake agents.
- Before visibility changes, audit all Git history and GitHub surfaces (PRs,
  issues, Actions logs/artifacts) for secrets/private material, beyond gitleaks.
- Child worktree implementation, independent review and required checks before
  publishing repo/release/tap; verify anonymous download/install afterward.
- Existing deployment remains with documented post-merge workflow.
