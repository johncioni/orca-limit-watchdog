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
  url "https://github.com/johncioni/orca-watchdog/releases/download/v1.0.0/orca-watchdog-1.0.0.tar.gz"
  sha256 "31737e1db6686efb5683b3cd6b6fd2002df5ba5bacc533de96c5374da278ddc8"
  license "MIT"

  depends_on :macos
  depends_on "node"

  def install
    libexec.install Dir["*"]
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
