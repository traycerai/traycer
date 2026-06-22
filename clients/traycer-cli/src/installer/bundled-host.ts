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
// The filename mirrors the build output in
// scripts/desktop-install-cloud.js (`hostArchivePath`):
// `host-runtime-<process.platform>-<process.arch>.tar.gz`.
export async function resolveBundledHostArchive(): Promise<string | null> {
  const fileName = `host-runtime-${osPlatform()}-${osArch()}.tar.gz`;
  const candidate = join(dirname(process.execPath), fileName);
  try {
    await access(candidate, constants.R_OK);
    return candidate;
  } catch {
    return null;
  }
}
