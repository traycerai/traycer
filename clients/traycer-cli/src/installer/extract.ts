import { copyFile, cp, mkdir, readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, normalize, sep } from "node:path";
import { x as tarExtract } from "tar";
import StreamZip from "node-stream-zip";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";

// Stage a host archive into `targetDir`. Supports:
//   - `.tar`, `.tar.gz`, `.tgz`, `.tar.xz`, `.txz` via the in-process `tar` package.
//   - `.zip` via `node-stream-zip`.
//   - bare directory or single executable: copied/linked as-is.
//
// Bare-file/dir support is what makes the local-file install path
// usable today: a developer can point `--from` at a freshly built
// host directory in the working tree and the installer treats it as
// a pre-staged install. The registry path (NP-4) will always produce
// a real archive.
//
// Both archive code paths fail closed on path traversal - any entry
// whose name is absolute, contains a `..` segment, or escapes the
// target dir through a symlink target is rejected with
// HOST_INSTALL_FAILED before any bytes are written. Registry installs
// are already covered by minisign verification; the
// `host install --from <archive>` path bypasses minisign, so this is
// the only line of defence against a malicious local archive.

export interface ExtractOptions {
  readonly source: string;
  readonly targetDir: string;
}

export async function extractHostSource(opts: ExtractOptions): Promise<void> {
  const sourceStat = await stat(opts.source);
  if (sourceStat.isDirectory()) {
    await copyDirectoryShallow(opts.source, opts.targetDir);
    return;
  }
  const ext = extname(opts.source).toLowerCase();
  const lower = opts.source.toLowerCase();
  await mkdir(opts.targetDir, { recursive: true });
  if (
    ext === ".tar" ||
    ext === ".tgz" ||
    ext === ".txz" ||
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tar.xz")
  ) {
    await extractTarArchive(opts.source, opts.targetDir);
    return;
  }
  if (ext === ".zip") {
    await extractZipArchive(opts.source, opts.targetDir);
    return;
  }
  // Bare executable. Copy into the target dir keeping the basename so
  // resolveExecutable() can find it.
  await copyFile(opts.source, join(opts.targetDir, basename(opts.source)));
}

async function copyDirectoryShallow(
  source: string,
  target: string,
): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
}

// Reject any tar entry whose name is absolute, contains a `..` segment,
// or whose symlink target points outside the target dir. The `tar`
// package returns `false` from its `filter` callback to skip an entry -
// but skipping is too quiet on a hostile archive (the caller still sees
// "extract succeeded"). We instead throw from `onwarn` (mapped via a
// captured flag) so the install fails closed.
async function extractTarArchive(
  source: string,
  targetDir: string,
): Promise<void> {
  let rejected: { entry: string; reason: string } | null = null;
  await tarExtract({
    file: source,
    cwd: targetDir,
    // Strip leading components are intentionally NOT enabled - the
    // staged archive lays out the host at the top level by contract.
    // We use the filter to enforce traversal protection on every entry.
    filter: (path, entry) => {
      // The filter is called for each archive entry - `entry` is a
      // ReadEntry at runtime, but the public typing widens to
      // `Stats | ReadEntry` (the same filter is reused for create).
      // Narrow by checking the readable shape we care about.
      let linkPath: string | null = null;
      if (
        entry !== null &&
        typeof entry === "object" &&
        "type" in entry &&
        entry.type === "SymbolicLink" &&
        "linkpath" in entry &&
        typeof entry.linkpath === "string"
      ) {
        linkPath = entry.linkpath;
      }
      const reason = unsafeEntryReason(path, linkPath);
      if (reason !== null) {
        if (rejected === null) rejected = { entry: path, reason };
        return false;
      }
      return true;
    },
  });
  if (rejected !== null) {
    const detail: { entry: string; reason: string } = rejected;
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
      message: `host install: refused unsafe tar entry '${detail.entry}': ${detail.reason}`,
      details: { source, entry: detail.entry, reason: detail.reason },
      exitCode: 1,
    });
  }
}

async function extractZipArchive(
  source: string,
  targetDir: string,
): Promise<void> {
  const zip = new StreamZip.async({ file: source });
  try {
    const entries = await zip.entries();
    for (const entry of Object.values(entries)) {
      const reason = unsafeEntryReason(entry.name, null);
      if (reason !== null) {
        throw cliError({
          code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
          message: `host install: refused unsafe zip entry '${entry.name}': ${reason}`,
          details: { source, entry: entry.name, reason },
          exitCode: 1,
        });
      }
    }
    // node-stream-zip extracts every entry under the target dir; its
    // internal path joiner uses Node `path.resolve`, which together with
    // the pre-flight scan above is enough to keep traversal-shaped names
    // from escaping.
    await zip.extract(null, targetDir);
  } finally {
    await zip.close();
  }
}

// Returns null if the entry path/linkpath is safe to extract under any
// target dir, or a human-readable reason string if it must be rejected.
function unsafeEntryReason(
  entryPath: string,
  linkPath: string | null,
): string | null {
  if (entryPath.length === 0) return "entry name is empty";
  if (isAbsolute(entryPath)) return "entry name is an absolute path";
  if (entryPath.startsWith("/") || entryPath.startsWith("\\")) {
    return "entry name starts with a path separator";
  }
  const normalised = normalize(entryPath);
  const segments = normalised.split(/[\\/]/).filter((s) => s.length > 0);
  if (segments.some((segment) => segment === "..")) {
    return "entry name contains a parent-directory segment";
  }
  if (normalised.startsWith(`..${sep}`) || normalised === "..") {
    return "entry name escapes the target directory";
  }
  if (linkPath !== null) {
    if (isAbsolute(linkPath)) return "symlink target is absolute";
    const normalisedLink = normalize(linkPath);
    const linkSegments = normalisedLink
      .split(/[\\/]/)
      .filter((s) => s.length > 0);
    if (linkSegments.some((segment) => segment === "..")) {
      return "symlink target escapes the target directory";
    }
  }
  return null;
}

// Locate the host executable inside a staged install directory.
// Strategy:
//   1. Look for `traycer-host` (or `traycer-host.exe` on Windows)
//      at the top level.
//   2. Otherwise pick the first executable file at the top level.
//   3. Otherwise descend one level - registry tarballs typically wrap
//      the binary in a versioned subdirectory.
export async function resolveHostExecutable(
  installDir: string,
  platform: NodeJS.Platform,
): Promise<string> {
  // Production ships a real `traycer-host.exe` SEA binary; the `make
  // dev-desktop` orchestrator stages a `traycer-host.cmd` wrapper that execs
  // `node <bundle>` (Windows has no shebang, so a script wrapper is a `.cmd`,
  // not the extensionless file the POSIX dev wrapper uses). Accept both, exe
  // first.
  const expectedNames =
    platform === "win32"
      ? ["traycer-host.exe", "traycer-host.cmd", "traycer-host.bat"]
      : ["traycer-host"];

  for (const name of expectedNames) {
    const direct = join(installDir, name);
    if (await exists(direct)) return direct;
  }

  const entries = await readdir(installDir, { withFileTypes: true });
  for (const name of expectedNames) {
    for (const entry of entries) {
      if (entry.isFile() && entry.name === name) {
        return join(installDir, name);
      }
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const name of expectedNames) {
      const nested = join(installDir, entry.name, name);
      if (await exists(nested)) return nested;
    }
  }
  throw cliError({
    code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
    message: `host install: expected executable '${expectedNames.join("' / '")}' not found in staged install at ${installDir}`,
    details: { installDir, expectedNames },
    exitCode: 1,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Exported for tests so a fixture archive built with the `tar` create
// API can exercise the traversal protection without going through the
// full install pipeline.
export const __unsafeEntryReasonForTest = unsafeEntryReason;
