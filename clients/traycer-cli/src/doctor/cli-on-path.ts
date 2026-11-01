import { PACKAGE_MANAGER_UPGRADE_COMMAND } from "@traycer-clients/shared/cli-install/package-manager-upgrade-command";
import { isStrictlyNewerHostVersion } from "@traycer-clients/shared/host-version/compare-host-versions";
import { execFile } from "node:child_process";
import { access, constants, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { Environment } from "../runner/environment";
import { wellKnownCliBinaryPath } from "../store/well-known-cli";
import { DOCTOR_ISSUE_CODES, type DoctorIssue } from "./issues";

const execFileAsync = promisify(execFile);

// Generous for a cold ~100 MB binary. A binary that overruns reads as "version
// unknown", which reports nothing.
const CLI_VERSION_TIMEOUT_MS = 5_000;

// What this will repeat into a report: another binary's output is not trusted
// to be one short token.
const PRINTABLE_VERSION = /^[\w.+-]{1,64}$/u;

const DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS = ".COM;.EXE;.BAT;.CMD";

function pathEntryCandidates(entry: string): readonly string[] {
  if (process.platform !== "win32") return [join(entry, "traycer")];
  const extensions =
    process.env.PATHEXT ?? DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS;
  return extensions
    .split(";")
    .filter((extension) => extension !== "")
    .map((extension) => join(entry, `traycer${extension.toLowerCase()}`));
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const target = await stat(path);
    if (!target.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The file a bare `traycer` runs: the first executable in PATH order. */
async function firstTraycerOnPath(): Promise<string | null> {
  const entries = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
  for (const entry of entries) {
    for (const candidate of pathEntryCandidates(entry)) {
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

async function reportedVersion(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], {
      encoding: "utf8",
      timeout: CLI_VERSION_TIMEOUT_MS,
      // SIGKILL: a child that ignores SIGTERM holds this call for as long as it
      // lives, however short the timeout.
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    const version = stdout.trim();
    return PRINTABLE_VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Whether a bare `traycer` runs something other than the CLI this environment
 * manages, on the PATH of the process running the doctor.
 *
 * Silent unless the difference is proved: both binaries resolved, and both
 * named a version, and the versions differ. The same version at another path
 * is the same CLI (Homebrew may be how this machine installs it), and a binary
 * that cannot answer `--version` from here is not evidence: a Windows `.cmd`
 * shim cannot be run this way at all. Nothing is spawned without a managed CLI
 * to compare against, or when PATH already leads to it.
 */
export async function probeCliShadowedOnPath(
  environment: Environment,
): Promise<DoctorIssue | null> {
  try {
    const managedBinary = wellKnownCliBinaryPath(environment);
    const managedRealPath = await realpath(managedBinary);
    const pathBinary = await firstTraycerOnPath();
    if (pathBinary === null) return null;
    const pathBinaryRealPath = await realpath(pathBinary);
    if (pathBinaryRealPath === managedRealPath) return null;
    const [pathVersion, managedVersion] = await Promise.all([
      reportedVersion(pathBinary),
      reportedVersion(managedBinary),
    ]);
    if (pathVersion === null || managedVersion === null) return null;
    if (pathVersion === managedVersion) return null;
    const managedDir = dirname(managedBinary);
    // Upgrading only helps a Homebrew CLI that is behind.
    const upgradeHelps =
      pathBinaryRealPath.includes("/Cellar/") &&
      isStrictlyNewerHostVersion(managedVersion, pathVersion);
    const wayOut = upgradeHelps
      ? `Run '${PACKAGE_MANAGER_UPGRADE_COMMAND.homebrew}', or put ${managedDir} first on PATH.`
      : `Put ${managedDir} first on PATH.`;
    return {
      code: DOCTOR_ISSUE_CODES.CLI_SHADOWED_ON_PATH,
      severity: "warning",
      title: "Another Traycer CLI comes first on PATH",
      message: `'traycer' runs ${pathBinary} (${pathVersion}), not the CLI Traycer installed at ${managedBinary} (${managedVersion}). ${wayOut}`,
      fixAction: null,
      terminalCommand: null,
      details: { pathBinary, pathVersion, managedBinary, managedVersion },
    };
  } catch {
    return null;
  }
}
