# Plan: make orca-limit-watchdog a first-class Orca project

## Context

The watchdog began as a one-off launchd daemon and has since grown two
specs, a 1400-line plan, an 80-case test suite, and a second feature
(outage resume, merged today as #11). John wants it structured like
codefm, codefm-website, flipguides, and GlamBook so it can keep being
developed inside Orca with the same orchestrator / implementer / reviewer
loop.

A survey of the four siblings (2026-09-07) established the shared
baseline. The watchdog already has most of it: `CLAUDE.md` delegating to
`~/.agents/MODELS.md`, `AGENTS.md -> CLAUDE.md`, the byte-identical
`review-evidence.yml` and `gitleaks.yml`, `ci.yml`, the standard PR
template, `review-invariants.txt` in the standard format, `renovate.json5`,
`docs/superpowers/{specs,plans}`, `.orca/` gitignored, strict branch
protection matching CLAUDE.md, Linear team **Orca Watchdog** (key `DOG`,
DOG-1 Done), and an Orca repo registration.

What is missing, relative to every sibling:

| Gap | Siblings |
|---|---|
| `scripts/orca-setup.sh` + Orca setup hook pointing at it | 4/4 (watchdog hook is `""`) |
| CLAUDE.md "Orca (the ADE this project lives in)" section | 4/4 |
| CLAUDE.md autonomy rule with the four stop conditions (MODELS.md calls it "the repo's autonomy rule") | 2/4 explicit, but MODELS.md depends on it |
| CLAUDE.md Linear section naming the team/key | 2/4 explicit |
| CLAUDE.md snapshot mentions only rate limits + the July spec | stale since #11 |
| README "Design:" line links only the July spec | stale since #11 |
| `.gitleaks.toml` (declarative extend-default) | 2/4, John opted in |
| `.claude/settings.local.json` plugin trim | 1/4, John opted in |
| Docfix pointer line | 1/4, John opted in |

Deliberately **not** conventions (0/4): `.config/wt.toml`, `.codex/`,
`.editorconfig`, `LICENSE`, `CODEOWNERS`, `dependabot.yml`. None will be
added. `orca.yaml` is also 0/4 in the siblings, but only because their hooks
predate it (see §8): here it replaces the manual app step, so it is added.

Decisions from John (2026-09-07): leave the GitHub name
`orca-limit-watchdog`; rename the Orca repo card from "Orca ADE Watchdog"
to **"Orca Watchdog"** to match the Linear team; include all three
optional extras.

## Deliverables

### 1. `scripts/orca-setup.sh` (new, executable)

Modelled on `/Users/john/Projects/codefm-website/scripts/orca-setup.sh`
(header comment naming the Orca policy, `set -euo pipefail`,
`cd "$(dirname "$0")/.."`, readiness summary). This repo has zero
dependencies, so the script is a verification warm-up, not an install:

- Header: runs on `orca worktree create` (repo hookSettings
  `setupRunPolicy=run-by-default`, `setupAgentStartupPolicy=wait-for-setup`);
  idempotent; safe by hand; **never touches `~/Library/LaunchAgents` or
  `~/.local/state/orca-limit-watchdog`** (that is `install.sh`, post-merge,
  main checkout only).
- Steps: assert `node` ≥ 20 (same check `install.sh` does; reuse its
  version test verbatim), `node --check watchdog.mjs`, one `bash -n` per
  script (`bash -n a b` checks only `a`; `b` becomes `$1`), `node --test`.
- Readiness summary: node version, test result, and a one-line reminder:
  "Do NOT run install.sh from this worktree; deploy from the main checkout
  after merge."
- No network access (the status-page fetch is exercised only via the
  loopback stub inside `node --test`).

### 2. `CLAUDE.md` (invariant file, restructure + update)

Keep the existing headings that other files point at (`## Review loop` is
referenced by `.github/review-invariants.txt` line 3, so keep that name).
New layout:

1. **Intro** (unchanged AGENTS.md symlink sentence).
2. **Project snapshot**: rewrite to cover both behaviours (rate-limit
   resume and API-outage resume), link both specs
   (`docs/superpowers/specs/2026-07-23-…-design.md`,
   `docs/superpowers/specs/2026-09-07-outage-resume-design.md`) and the
   plan dir. Add the name mapping: GitHub `orca-limit-watchdog`, Orca
   card "Orca Watchdog", Linear team "Orca Watchdog" (`DOG`), workspace
   `johncioni`.
3. **Working agreement** (new): the MODELS.md delegation sentence (moved up
   from Review loop, identical wording), then the "Proceed autonomously on
   clear next steps" paragraph adapted from GlamBook/codefm-website with
   this repo's four stop conditions:
   (a) only John can act: Orca app repo settings, launchd on his machine,
   credentials;
   (b) destructive: `uninstall.sh`, deleting or rewriting
   `~/.local/state/orca-limit-watchdog/*`, `launchctl bootout`;
   (c) outward-facing: any `orca terminal send` to a live agent terminal
   (the watchdog's whole blast radius);
   (d) genuine scope/design decision.
   Plus the docfix pointer line (copy codefm-website's wording: not ported
   here yet, port from GlamBook when first needed).
4. **Build / run / test**: unchanged commands, plus
   `bash scripts/orca-setup.sh` as the "full local gate" line.
5. **Review loop**: unchanged content (required checks, invariants, strict
   protection) minus the delegation sentence moved to §3.
6. **Orca (the ADE this project lives in)** (new): copy the sibling
   bullets: main worktree = orchestration hub; each plan gets its own
   child worktree (`orca worktree create --name <plan> --parent-worktree
   active --agent codex --prompt "<brief>" --linear-issue DOG-<n>`);
   new worktrees run `scripts/orca-setup.sh`; card-state checkpoints
   (`orca worktree set --comment` / `--workspace-status`); terminal
   hygiene; credential guardrail. Drop the "built-in browser" bullet
   (no UI). Add one watchdog-specific bullet: implementers verify with
   `--dry-run` and `e2e/fake-tui.mjs` only; never against live terminals.
7. **Linear** (new, short): team Orca Watchdog / key `DOG` / workspace
   `johncioni`; `orca linear create --team DOG …`; link worktrees with
   `--linear-issue DOG-n`; status at the gates (In Progress on dispatch,
   comment with PR at review, Done after merge + `install.sh` deploy when
   the daemon changed).
8. **Safety**: unchanged.

### 3. `README.md`

- "Design:" line → list both specs.
- Add a short **Develop** section: `bash scripts/orca-setup.sh` runs the
  full local gate; agent workflow lives in `CLAUDE.md`.

### 4. `.gitleaks.toml` (new)

GlamBook's header comment (the AND/OR gotcha) + `[extend] useDefault =
true`. No allowlists: CI is green on defaults today.

### 5. `.github/workflows/ci.yml` + invariant lists (invariant files)

Add `&& bash -n scripts/orca-setup.sh` to the syntax-check step (one
invocation per file). Also add `orca.yaml` and `scripts/orca-setup.sh` to
`.github/review-invariants.txt` and the CLAUDE.md invariant list: both
execute on every `orca worktree create` (review round 1 finding).

### 6. `docs/superpowers/plans/2026-09-07-orca-project-scaffolding.md`

Commit this plan there (sibling convention: every plan lives in the repo).

### 7. `.claude/settings.local.json` (local only, not in the PR)

Globally gitignored. FlipGuides-style trim for this no-UI, no-Swift,
Orca-managed repo, overriding the global list for this project only:

```json
{
  "//": "Project-scoped plugin trims for orca-limit-watchdog token efficiency. Overrides ~/.claude/settings.json enabledPlugins for THIS project only. Flip any false->true (or delete this file) to restore. Chosen 2026-09-07.",
  "enabledPlugins": {
    "frontend-design@claude-plugins-official": false,
    "impeccable@impeccable": false,
    "worktrunk@worktrunk": false
  }
}
```

Keeps claude-hud, claude-security, codex, context-mode, superpowers.

### 8. `orca.yaml` (new) and the one manual step for John

Discovered during implementation (Orca settings UI strings): Orca reads a
committed `orca.yaml` at the repo root with keys `scripts.setup`,
`scripts.archive`, `issueCommand`. The repo's `commandSourcePolicy`
decides which commands run: `shared-only` ("orca.yaml only"),
`local-only` ("ignore orca.yaml; run only local commands"), or `run-both`
(orca.yaml first, then local). When the policy is unset, Orca picks
`local-only` if a local script exists and `shared-only` otherwise. The
watchdog has no local script, so a committed `orca.yaml` is picked up with
no settings change; codefm and flipguides are `local-only` because their
hooks were typed into the app before `orca.yaml` existed.

`orca.yaml` carries `setup: bash scripts/orca-setup.sh`, the sibling
archive echo, and `issueCommand: Complete {{artifact_url}}` (currently a
local `.orca/issue-command` override). Orca shows a one-time
"trust this hook" confirmation per script content hash.

Manual, only-John-can-act (Orca app):
1. Rename the repo card "Orca ADE Watchdog" → **Orca Watchdog**.
2. Accept the trust prompt for the `orca.yaml` setup script the first time
   a worktree is created after merge. Leave command source at its default.

## Process (per MODELS.md)

- These are orchestrator-authored docs/config changes → the **spec/plan
  reviewer (Codex, `codex --profile reviewer`, effort high)** reviews.
  `CLAUDE.md` and `.github/*` are invariant, so no skip applies: one review
  round minimum. PR body: `Reviewed by Codex, N rounds`.
- Work on a branch `chore/orca-project-scaffolding` in an Orca child
  worktree (`orca worktree create --name project-scaffolding --agent
  claude`), not in the main checkout.
- Create Linear **DOG-2** ("Structure repo as a first-class Orca project")
  before starting; attach the PR; comment on completion; Done after merge.
- Merge: strict protection → `gh pr update-branch` if BEHIND; never
  `--admin`. **No `install.sh` after merge**: `watchdog.mjs` and the plist
  are untouched, so the live daemon needs no redeploy.

## Verification

1. `bash -n scripts/orca-setup.sh && bash scripts/orca-setup.sh` from the
   feature worktree: exits 0, prints the readiness summary, `node --test`
   80/80.
2. `node --test`, `node --check watchdog.mjs` unchanged (no code touched).
3. `ls -l AGENTS.md` still a symlink; `git diff --stat` shows no
   `watchdog.mjs`/plist changes.
4. After merge: `orca worktree create --name setup-smoke --setup run` (no
   agent), accept the trust prompt, confirm the setup log shows the
   readiness summary; `orca worktree rm` it. `orca repo show` should show
   `displayName: Orca Watchdog` once John renames the card.
5. CI: `ci`, `gitleaks` (now reading `.gitleaks.toml`), `review-evidence`
   all green on the PR.
6. `orca linear issue DOG-2` shows the PR attached.
