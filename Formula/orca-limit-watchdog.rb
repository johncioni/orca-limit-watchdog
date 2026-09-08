# Canonical source for the Homebrew formula. Published to the personal tap
# johncioni/homebrew-tap (as Formula/orca-limit-watchdog.rb) so users can
# `brew install johncioni/tap/orca-limit-watchdog`.
#
# On release: build the archive (`node scripts/build-release.mjs`), upload
# dist/orca-limit-watchdog-<version>.tar.gz to the GitHub release for the tag,
# then copy this file to the tap. The sha256 below is the deterministic archive
# checksum; the build-release test keeps it in sync with the shipped tree.
class OrcaLimitWatchdog < Formula
  desc "Watchdog that auto-resumes rate-limited or stalled Orca terminals"
  homepage "https://github.com/johncioni/orca-limit-watchdog"
  url "https://github.com/johncioni/orca-limit-watchdog/releases/download/v0.1.0/orca-limit-watchdog-0.1.0.tar.gz"
  sha256 "2fbaa3a6de3c6d5d5ac17a15aaee19d493684fd3aea0e2c6c0e11e9e81a1250b"
  license "MIT"

  depends_on :macos
  depends_on "node"

  def install
    libexec.install Dir["*"]
    # Wrap the bundled launcher so it always runs on Homebrew's Node.
    (bin/"orca-limit-watchdog").write_env_script libexec/"bin/orca-limit-watchdog",
      ORCA_WATCHDOG_NODE: formula_opt_bin("node")/"node"
  end

  def caveats
    <<~EOS
      orca-limit-watchdog is installed but NOT running. Nothing is registered
      with launchd and no terminal is touched until you start it:

        orca-limit-watchdog doctor
        orca-limit-watchdog start

      It needs the Orca CLI (`orca`) on your PATH, or set ORCA_CLI to its path.
      Before `brew upgrade`, run `orca-limit-watchdog stop`, then `start` again.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/orca-limit-watchdog --version")
    assert_match "Usage: orca-limit-watchdog", shell_output("#{bin}/orca-limit-watchdog --help")
  end
end
