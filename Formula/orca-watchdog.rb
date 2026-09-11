# Canonical source for the Homebrew formula. Published to the personal tap
# johncioni/homebrew-tap (as Formula/orca-watchdog.rb) so users can
# `brew install johncioni/tap/orca-watchdog`.
#
# On release: build the archive (`node scripts/build-release.mjs`), upload
# dist/orca-watchdog-<version>.tar.gz to the GitHub release for the tag,
# then copy this file to the tap. Set the sha256 below to the uploaded asset's
# checksum (`shasum -a 256 dist/orca-watchdog-<version>.tar.gz`).
class OrcaWatchdog < Formula
  desc "Watchdog that auto-resumes rate-limited or stalled Orca terminals"
  homepage "https://github.com/johncioni/orca-watchdog"
  url "https://github.com/johncioni/orca-watchdog/releases/download/v1.1.0/orca-watchdog-1.1.0.tar.gz"
  sha256 "cc57e2039e2d9a40cba6da11bd1c1235b16572ac2559ef7a6571a36340e472c8"
  license "MIT"

  depends_on :macos
  depends_on "node"

  def install
    # Shell completions and the man page go to their standard locations.
    bash_completion.install "completions/orca-watchdog.bash"
    zsh_completion.install "completions/_orca-watchdog"
    fish_completion.install "completions/orca-watchdog.fish"
    man1.install "man/orca-watchdog.1"
    # Everything else (the runtime) lives under libexec.
    libexec.install Dir["*"] - ["completions", "man"]
    # Wrap the bundled launcher so it always runs on Homebrew's Node.
    (bin/"orca-watchdog").write_env_script libexec/"bin/orca-watchdog",
      ORCA_WATCHDOG_NODE: formula_opt_bin("node")/"node"
  end

  def caveats
    <<~EOS
      orca-watchdog is installed but NOT running. Nothing is registered
      with launchd and no terminal is touched until you start it:

        orca-watchdog doctor
        orca-watchdog start

      It needs the Orca CLI (`orca`) on your PATH, or set ORCA_CLI to its path.
      Before `brew upgrade`, run `orca-watchdog stop`, then `start` again.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/orca-watchdog --version")
    assert_match "Usage: orca-watchdog", shell_output("#{bin}/orca-watchdog --help")
  end
end
