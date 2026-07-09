import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { arch as osArch, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";

// Resolve a host-runtime archive packaged alongside the running CLI
// binary. Production desktop bundles ship the host archive next to the
// staged CLI under `resources/cli/<platform>-<arch>/` (see
// scripts/desktop-install-cloud.js), so a CLI-managed install can run
// fully offline and self-contained - the desktop just calls
// `traycer host ensure` with no archive path and the CLI finds its own
// bundled host.
//
// Returns null when no packaged archive is present: Homebrew / winget /
// apt installs that ship only the CLI, or the dev `bun src/index.ts`
// wrapper where `process.execPath` is the bun runtime rather than a
// staged CLI binary. In those cases callers fall back to the registry
// (or an explicit `--from`).
//
// Candidate host-runtime archive filenames for a platform/arch, most-preferred
// first. The filenames mirror host release packaging: every platform now ships
// a `.tar.gz` (the SEA toolchain emits one via bundled tar.exe on Windows too),
// but Windows also tolerates a `.zip` from any release tooling that wraps the
// runtime dir as a zip. Windows arm64 resolves to the x64 host runtime because
// there is no native Windows arm64 host. Pure + exported for unit tests.
export function bundledHostArchiveNames(
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const resolvedArch = platform === "win32" && arch === "arm64" ? "x64" : arch;
  const baseName = `host-runtime-${platform}-${resolvedArch}`;
  const extensions = platform === "win32" ? [".tar.gz", ".zip"] : [".tar.gz"];
  return extensions.map((extension) => `${baseName}${extension}`);
}

// Returns null when no packaged archive is present: Homebrew / winget / apt
// installs that ship only the CLI, or the dev `bun src/index.ts` wrapper where
// `process.execPath` is the bun runtime rather than a staged CLI binary. In
// those cases callers fall back to the registry (or an explicit `--from`).
//
// NOTE: this resolves relative to `process.execPath`, which only sits beside
// the bundled archive when the running CLI is the bundle's binary (or a symlink
// into it, as on POSIX desktop installs). On Windows the desktop's per-user CLI
// is a COPY outside the bundle, so the desktop passes `--from <archive>`
// explicitly (see host-ensure-ipc.ts) rather than relying on this resolver.
export async function resolveBundledHostArchive(): Promise<string | null> {
  const dir = dirname(process.execPath);
  for (const name of bundledHostArchiveNames(osPlatform(), osArch())) {
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
