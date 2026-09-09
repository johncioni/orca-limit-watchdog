# Contributing to Orca Watchdog

Thanks for your interest! This is a small, dependency-free macOS daemon, and the
goal is to keep it that way: easy to read, easy to audit, and safe by default.

## Ground rules

- **Plain Node, no dependencies.** There is intentionally no `package.json` and
  no third-party packages — the daemon must run with only the system Node. Please
  don't add dependencies or a build step to the runtime.
- **Safety first.** The watchdog's only outward action is sending text into live
  Orca terminals. Never test send/start/stop against your real Orca terminals or
  your real `HOME`. Use `--dry-run` and the fakes in `e2e/` (a fake TUI and a
  loopback status stub). The test suite runs entirely against isolated temp homes
  and fake `launchctl`/`orca` executables.
- **Don't change detection or retry behavior casually.** The banner patterns,
  reset-time parsing, retry counts, and status-page gating are deliberate. Changes
  there need a clear rationale and tests.

## Development setup

Requires **macOS** and **Node.js 22 or newer**. No install step is needed.

```bash
git clone https://github.com/johncioni/orca-limit-watchdog
cd orca-limit-watchdog
node --test                   # unit tests (patterns, time parsing, lifecycle, packaging)
bash scripts/orca-setup.sh    # full local gate: Node floor + syntax checks + node --test
node watchdog.mjs --dry-run   # observe one tick without sending anything
```

## Making a change

1. Open an issue describing the bug or proposal first, so we can agree on the
   approach before you invest time.
2. Work on a branch off `main`.
3. Follow test-driven development: for any behavior change, add a test that fails
   first, then make it pass. Match the style of the existing `*.test.mjs` files.
4. Keep `node --test` green and the diff focused.
5. Open a pull request against `main`. CI runs the test suite on macOS across the
   supported Node versions.

## Building a release (maintainers)

```bash
node scripts/build-release.mjs        # writes dist/orca-limit-watchdog-<version>.tar.gz + .sha256
```

The archive is deterministic: the same tree always produces the same bytes and
checksum, which is what the Homebrew formula pins.

## A note on this repository's maintenance workflow

The `CLAUDE.md` / `AGENTS.md` files and the `review-evidence` pull-request check
describe the maintainer's personal, agent-assisted workflow. **Contributors do
not need to follow it** — maintainers complete the review-evidence line when a
change is merged. Your job is just the code and its tests.

By contributing, you agree that your contributions are licensed under the
project's [MIT license](LICENSE).
