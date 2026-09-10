# CLAUDE.md

Guidance for any coding agent working in this repository. Codex and other
agents read `AGENTS.md`, which is a symlink to this file. Keep it that way.

## Project snapshot

**orca-watchdog** is a macOS launchd daemon (`watchdog.mjs`, plain Node,
no dependencies) that watches every connected Orca terminal for a stalled
agent TUI and sends a resume prompt when it is safe to:

- **Rate limit:** banner with a stated reset time; resumes after the reset.
- **API outage:** Claude Code's own `API Error: 5xx / Connection error /
  overloaded_error` banner, or Codex's `■ …` error line (source-verified
  wording, Codex-identified terminals only); resumes after a hold, gated on
  `status.claude.com` / `status.openai.com`.

Installed by `install.sh` (writes the plist, `launchctl bootstrap`), removed by
`uninstall.sh`. Kill switch lives under `~/.local/state`. See `README.md` for
run/status flags.

Names: GitHub repo `orca-watchdog`; Orca repo card **Orca Watchdog**;
Linear team **Orca Watchdog**, key `DOG`, workspace `johncioni`.

## Working agreement

- **Roles, models, effort levels, and the review loop are universal:** see
  `~/.agents/MODELS.md` (role table with default model + effort per role, the
  orchestrator's per-dispatch selection rule, escalation, and the review
  loop). This file adds only project-specific rules.
- **Proceed autonomously on clear next steps.** When a step finishes and the
  next action is well-defined and low-ambiguity — merging an approved /
  CI-green PR, advancing to the next task in an approved plan, running the
  next verification or CI step, committing already-reviewed work, updating
  Linear / the worktree card, addressing review-round findings on the same
  branch — just take it; don't ask permission. Only stop to prompt John
  when: (a) **only he can act** — Orca app repo settings or hook-trust prompts,
  launchd on his machine, anything needing his credentials; (b) the action is
  **destructive** — `uninstall.sh`, `launchctl bootout`, deleting or
  rewriting `~/.local/state/orca-watchdog/*`; (c) it's
  **outward-facing** — any `orca terminal send` to a live agent terminal
  (that is the watchdog's entire blast radius: a bad send lands in every
  session); or (d) there's a **genuine decision or ambiguity** — scope,
  design direction, or the "next step" isn't actually clear. When you do
  proceed, state what you did and why in one line so he can course-correct.
- **Docfix engine:** `scripts/docfix.sh` is not ported here yet — port it
  when first needed (engine chain is defined in `~/.agents/MODELS.md`).

## Build / run / test

```bash
bash scripts/orca-setup.sh  # full local gate: node >= 20, syntax checks, node --test
node --test                 # unit tests (patterns, time parsing, lifecycle)
node watchdog.mjs --dry-run # what it would do right now
node watchdog.mjs --status  # active events
```

No package.json by design: the daemon must run with only the system Node.
Do not add dependencies.

## Review loop

**Required checks:** `ci`, `gitleaks`, `review-evidence`.

**Invariant files (ineligible for the docs/test/size skips; the MODELS.md
opus-implementer exception still applies):** `watchdog.mjs` (the daemon
itself: a bug here can spam `orca terminal send` into every session),
`install.sh` / `uninstall.sh` (launchctl bootstrap/bootout), the launchd
plist, `orca.yaml` / `scripts/orca-setup.sh` (execute on every
`orca worktree create`), `.github/*`, `CLAUDE.md`.

**Branch protection is strict:** `main` requires the PR branch to be up to
date. On `mergeStateStatus: BEHIND`, run `gh pr update-branch <n>`, wait for
the checks to go green again, then merge; if more commits are needed after
the update, `git pull` in the worktree first — never `--admin`, never a
force-push (decision 2026-08-30).

## Orca (the ADE this project lives in)

- The **main worktree is the orchestration hub** (specs, plans, Linear,
  reviews, post-merge deploy) — no implementation happens there.
- **Each implementation plan gets its own Orca child worktree**
  (`orca worktree create --name <plan> --parent-worktree active --agent codex
  --prompt "<brief>" --linear-issue DOG-<n>`); the implementer works in the
  child; the code reviewer (a new Orca terminal in that same worktree)
  reviews between tasks, and the orchestrator adjudicates.
- New worktrees run `scripts/orca-setup.sh` (node floor, syntax checks,
  `node --test`; idempotent, offline, safe by hand). The committed
  `orca.yaml` wires it as the repo's setup hook (plus the archive hook and
  the issue command), so every child worktree lands having passed the gate.
  Orca asks once to trust each new version of the script; keep the repo's
  command source at its default ("orca.yaml only") rather than local-only.
- Agents update Orca card state at meaningful checkpoints:
  `orca worktree set --worktree active --comment "<short status>"` and
  `--workspace-status` (todo / in-progress / in-review / completed).
- **Implementers verify with `--dry-run` and the fakes in `e2e/`** (fake
  TUI, loopback status stub), never against live agent terminals, and
  never by running `install.sh` from a worktree (see Safety).
- **Terminal hygiene:** Orca never auto-closes terminals. Default to one
  persistent agent terminal per worktree/plan (send successive briefs via
  `orca terminal send`). If a stage needs an isolated terminal, close it
  after harvesting the result (`orca terminal close`); at plan completion,
  sweep `orca terminal list` and close everything but the live agent
  terminal.
- **Credential guardrail:** agents never search credential stores
  (1Password, keychains, browser vaults) or mint/borrow tokens. If an
  operation fails for lack of a credential or scope, stop and escalate to
  the human with exactly what is needed and why.

## Linear

Linear is the durable backlog (team **Orca Watchdog**, key `DOG`, workspace
`johncioni`). Orca worktrees are the per-dispatch unit; Linear issues track
the work across sessions.

- Features, bugs, and deferred items get a `DOG-n` issue:
  `orca linear create --team DOG --title "..." --body "..."`.
- Every spec and plan is tracked by an issue carrying the doc path (and its
  artifact link, if published); link the worktree with `--linear-issue DOG-n`.
- Keep status in sync at the gates: In Progress on dispatch, a comment with
  the PR at review, Done after merge — and, when `watchdog.mjs` or the plist
  changed, after the post-merge `install.sh` deploy has been verified.

## Safety

- Never test against live Orca terminals from an agent session; use
  `--dry-run` or the fake TUI in `e2e/fake-tui.mjs`.
- **Deployment is a post-merge step, owned by the orchestrator:** after the
  PR merges, run `install.sh` from the main checkout (launchd caches the
  plist). Never run `install.sh` from a feature worktree: it would repoint the
  live LaunchAgent at an unmerged, disposable checkout. `--status` shows
  stored events, not service health; check `launchctl print gui/$(id -u)/com.john.orca-watchdog`.
