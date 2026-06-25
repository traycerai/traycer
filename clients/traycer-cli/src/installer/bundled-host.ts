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
// The filenames mirror host release packaging: macOS/Linux use tarballs,
// while Windows uses a zip. Windows arm64 resolves to the x64 host runtime
// because there is no native Windows arm64 host.
export async function resolveBundledHostArchive(): Promise<string | null> {
  const platform = osPlatform();
  const arch = platform === "win32" && osArch() === "arm64" ? "x64" : osArch();
  const baseName = `host-runtime-${platform}-${arch}`;
  const extension = platform === "win32" ? ".zip" : ".tar.gz";
  const candidate = join(dirname(process.execPath), `${baseName}${extension}`);
  try {
    await access(candidate, constants.R_OK);
    return candidate;
  } catch {
    return null;
  }
}
