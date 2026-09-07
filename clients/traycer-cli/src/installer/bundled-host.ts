import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { arch as osArch, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";

// Resolve a host-runtime archive packaged beside the CLI. Null when absent (Homebrew/winget/dev). Windows arm64 uses the x64 host.
export function bundledHostArchiveNames(
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const resolvedArch = platform === "win32" && arch === "arm64" ? "x64" : arch;
  const baseName = `host-runtime-${platform}-${resolvedArch}`;
  const extensions = platform === "win32" ? [".tar.gz", ".zip"] : [".tar.gz"];
  return extensions.map((extension) => `${baseName}${extension}`);
}

// Returns null when no packaged archive is present: Homebrew / winget / apt installs that ship only the CLI, or the dev `bun src/index.ts` wrapper where `process.execPath` is the bun runtime rather than a staged CLI binary.
// In those cases callers fall back to the registry (or an explicit `--from`).
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
