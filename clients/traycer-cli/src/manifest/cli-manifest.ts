import { readFile, rename, writeFile } from "node:fs/promises";
import { readStoredCliInstallManifestAtPath } from "@traycer/protocol/config/installation";
import { ZodError } from "zod";
import { createCliLogger } from "../logger";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { Environment } from "../runner/environment";
import { cliManifestPath, ensureCliInstallHomeDir } from "../store/paths";

// CLI install manifest schema, per the Native Packaging tech plan. Lives at
// ~/.traycer/cli/manifest.json for prod, ~/.traycer/cli/dev/manifest.json for
// legacy/no-slot dev, and ~/.traycer/cli/dev-runs/<slot>/manifest.json for
// multi-run dev. Read by the CLI itself on every install/update/uninstall to
// know what state it's already in; written atomically via rename so a crash
// mid-install can't leave a partially-written file.
//
// `pendingUpgrade` records that a newer CLI binary has been downloaded
// and staged, but the live binary is still the old one. The next CLI
// process is expected to detect a pending upgrade, finalise it (swap
// binaries + update top-level fields), and clear the field.
//
// Absence of a manifest file means "no recorded install on this environment
// yet" - readCliManifest() returns null for that state rather than
// fabricating a half-populated manifest, since the persisted contract
// requires every top-level field to be present.

export type CliInstallSource =
  | "desktop"
  | "homebrew"
  | "npm"
  | "winget"
  | "scoop"
  | "apt"
  | "rpm"
  | "manual";

export type CliPendingUpgradeReason =
  | "binary-locked"
  | "awaiting-service-restart";

export interface CliPendingUpgrade {
  readonly version: string;
  readonly stagedBinaryPath: string;
  readonly stagedAt: string;
  readonly reason: CliPendingUpgradeReason;
}

export interface CliInstallManifest {
  readonly version: string;
  readonly installedAt: string;
  readonly binaryPath: string;
  readonly source: CliInstallSource;
  readonly pendingUpgrade: CliPendingUpgrade | null;
}

export const VALID_CLI_INSTALL_SOURCES: ReadonlySet<CliInstallSource> =
  new Set<CliInstallSource>([
    "desktop",
    "homebrew",
    "npm",
    "winget",
    "scoop",
    "apt",
    "rpm",
    "manual",
  ]);

// Package-manager-owned sources for the upgrade-ownership contract.
// `cli upgrade` refuses to self-replace these binaries; `cli mark-source`
// is the only entrypoint a PM hook should call. The dedicated
// `cli re-anchor` command lives next to `cli mark-source` and is the
// user-facing way to record a manual install - see `cli-re-anchor.ts`.
export const PACKAGE_MANAGER_CLI_SOURCES: ReadonlySet<CliInstallSource> =
  new Set<CliInstallSource>([
    "homebrew",
    "npm",
    "winget",
    "scoop",
    "apt",
    "rpm",
  ]);

// Canonical per-package-manager upgrade hint, written ONCE and shared by the
// `cli upgrade` package-manager-owned refusal (cli-upgrade.ts) and the
// protocol-incompatibility recovery hint (compat-recovery.ts). The desktop and
// manual vectors are phrased differently per caller and are supplied by each
// map, not here - so a package-manager command (e.g. the formula name) changes
// in exactly one place instead of drifting between the two surfaces.
export const PACKAGE_MANAGER_UPGRADE_HINT: Record<
  Exclude<CliInstallSource, "desktop" | "manual">,
  string
> = {
  homebrew: "Run 'brew upgrade traycer'.",
  npm: "Run 'npm install -g @traycerai/cli@latest'.",
  winget: "Run 'winget upgrade Traycer.CLI'.",
  scoop: "Run 'scoop update traycer-cli'.",
  apt: "Run 'sudo apt update && sudo apt install --only-upgrade traycer-cli'.",
  rpm: "Run 'sudo dnf upgrade traycer-cli' (or 'yum upgrade').",
};

function currentProcessBinaryPath(): string {
  const argv1 = process.argv[1];
  return typeof argv1 === "string" && argv1.length > 0
    ? argv1
    : process.execPath;
}

function readDistributionInstallSourceFromEnv(): CliInstallSource | null {
  const value = process.env.TRAYCER_CLI_DISTRIBUTION;
  if (value === "npm") return "npm";
  return null;
}

// System-wide install-source markers written by .deb / .rpm post-install
// scripts (see release-cli-linux.yml). These let the CLI know it was
// installed through a system package manager even when the per-user
// manifest at ~/.traycer/cli/manifest.json hasn't been written yet
// (e.g. first invocation after an unattended apt install).
const DEFAULT_SYSTEM_SOURCE_MARKER_DIR = "/var/lib/traycer";
const SYSTEM_SOURCE_MARKER_APT_BASENAME = "source.apt";
const SYSTEM_SOURCE_MARKER_RPM_BASENAME = "source.rpm";

// Mutable override for the marker directory, used exclusively by the
// system-marker test suite so it can point the reader at a tmp dir
// without touching `/var/lib/traycer`. Production code never calls
// `__setSystemSourceMarkerDirForTest`.
let systemSourceMarkerDir = DEFAULT_SYSTEM_SOURCE_MARKER_DIR;

// Test-only seam - pass `null` to restore the default. The function
// returns the previous value so tests can save / restore symmetrically.
export function __setSystemSourceMarkerDirForTest(next: string | null): string {
  const previous = systemSourceMarkerDir;
  systemSourceMarkerDir =
    next === null ? DEFAULT_SYSTEM_SOURCE_MARKER_DIR : next;
  return previous;
}

interface SystemSourceMarker {
  readonly source: CliInstallSource;
  readonly binaryPath: string;
  readonly version: string;
  readonly markerPath: string;
}

// Read /var/lib/traycer/source.{apt,rpm} if present. Best-effort:
// returns null on any parse failure (markers are advisory; the in-home
// manifest is still authoritative for everything else). Only called on
// Linux - other platforms return null without touching the filesystem.
async function readSystemSourceMarker(): Promise<SystemSourceMarker | null> {
  if (process.platform !== "linux") return null;
  const dir = systemSourceMarkerDir;
  const candidates: Array<{
    readonly path: string;
    readonly source: CliInstallSource;
  }> = [
    { path: `${dir}/${SYSTEM_SOURCE_MARKER_APT_BASENAME}`, source: "apt" },
    { path: `${dir}/${SYSTEM_SOURCE_MARKER_RPM_BASENAME}`, source: "rpm" },
  ];
  for (const { path, source } of candidates) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.binaryPath === "string" &&
      typeof obj.version === "string" &&
      obj.binaryPath.length > 0 &&
      obj.version.length > 0
    ) {
      return {
        source,
        binaryPath: obj.binaryPath,
        version: obj.version,
        markerPath: path,
      };
    }
  }
  return null;
}

// Read the persisted manifest for `environment`. Returns null when no
// manifest file exists yet (i.e. nothing has been installed on this
// environment). Throws CLI_MANIFEST_INVALID if the file is present but
// malformed - we refuse to silently overwrite a corrupt manifest
// because that state is often a sign of a half-completed install or
// foreign tampering, both of which deserve operator attention.
//
// On Linux, if no per-user prod manifest exists yet but a system marker
// (/var/lib/traycer/source.{apt,rpm}) is present, synthesize a manifest
// from the marker so `cli upgrade` correctly refuses self-replacement
// of a dpkg/rpm-owned binary. The fallback is **prod-only**: the system
// markers are written by the prod-environment .deb / .rpm post-install
// scripts only, so honouring them for a dev-environment read would
// mis-attribute a dev install to apt/rpm whenever a sibling prod
// package is present on the same host. Dev environment callers therefore
// see `null` when no dev manifest exists, regardless of marker state.
export async function readCliManifest(
  environment: Environment,
): Promise<CliInstallManifest | null> {
  const logger = createCliLogger(environment);
  logger.debug("CLI manifest read started", {
    environment,
  });
  const path = cliManifestPath(environment);
  try {
    // Retain the historic absence/fallback branch below. The shared reader is
    // then the sole parser of present persisted bytes.
    await readFile(path, "utf8");
  } catch (err) {
    // Only a missing file means "no manifest"; a real fault (EACCES/EIO)
    // must surface rather than be misread as an absent install.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    const distributionSource = readDistributionInstallSourceFromEnv();
    if (distributionSource !== null) {
      logger.info("CLI manifest synthesized from distribution environment", {
        environment,
        source: distributionSource,
        hasVersionEnv:
          typeof process.env.TRAYCER_CLI_VERSION === "string" &&
          process.env.TRAYCER_CLI_VERSION.length > 0,
      });
      return {
        version:
          typeof process.env.TRAYCER_CLI_VERSION === "string" &&
          process.env.TRAYCER_CLI_VERSION.length > 0
            ? process.env.TRAYCER_CLI_VERSION
            : "0.0.0-local",
        installedAt: new Date(0).toISOString(),
        binaryPath: currentProcessBinaryPath(),
        source: distributionSource,
        pendingUpgrade: null,
      };
    }
    if (environment !== "production") {
      logger.debug("CLI manifest missing for non-production environment", {
        environment,
      });
      return null;
    }
    const systemMarker = await readSystemSourceMarker();
    if (systemMarker === null) {
      logger.debug("CLI manifest missing and no system source marker found", {
        environment,
      });
      return null;
    }
    logger.info("CLI manifest synthesized from system source marker", {
      environment,
      source: systemMarker.source,
      hasVersion: systemMarker.version.length > 0,
    });
    return {
      version: systemMarker.version,
      installedAt: new Date(0).toISOString(),
      binaryPath: systemMarker.binaryPath,
      source: systemMarker.source,
      pendingUpgrade: null,
    };
  }
  let manifest: CliInstallManifest | null;
  try {
    manifest = await readStoredCliInstallManifestAtPath(path);
  } catch (err) {
    // Only a parse failure means "invalid". The reader already turns ENOENT
    // into null and rethrows every other I/O error, so swallowing those here
    // reported a permissions or disk fault as a corrupt manifest and told the
    // user to fix a file that is fine. Same narrowing as the sibling
    // host-install reader.
    if (!(err instanceof SyntaxError) && !(err instanceof ZodError)) throw err;
    throw cliError({
      code: CLI_ERROR_CODES.CLI_MANIFEST_INVALID,
      message: `CLI manifest ${path} is invalid; refusing to overwrite`,
      details: { path },
      exitCode: 1,
    });
  }
  if (manifest === null) {
    throw new Error(`CLI manifest ${path} disappeared while being read`);
  }
  logger.debug("CLI manifest read completed", {
    environment,
    hasVersion: manifest.version.length > 0,
    source: manifest.source,
    hasPendingUpgrade: manifest.pendingUpgrade !== null,
  });
  return manifest;
}

// Write a complete manifest atomically. Callers must supply every
// top-level field - there is no "empty install" manifest on disk.
export async function writeCliManifest(
  environment: Environment,
  manifest: CliInstallManifest,
): Promise<void> {
  const logger = createCliLogger(environment);
  logger.debug("CLI manifest write started", {
    environment,
    hasVersion: manifest.version.length > 0,
    source: manifest.source,
    hasPendingUpgrade: manifest.pendingUpgrade !== null,
  });
  await ensureCliInstallHomeDir(environment);
  const target = cliManifestPath(environment);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, target);
  logger.info("CLI manifest write completed", {
    environment,
    hasVersion: manifest.version.length > 0,
    source: manifest.source,
    hasPendingUpgrade: manifest.pendingUpgrade !== null,
  });
}

// Read-modify-write convenience. Requires an existing manifest -
// patching a non-existent install is a programming error, since the
// persisted contract has no representation for "partially installed".
// Callers performing an initial install should build a complete
// CliInstallManifest and pass it to writeCliManifest directly. The
// caller owns concurrency - wrap with the CLI lock if multiple
// processes might race.
export async function updateCliManifest(
  environment: Environment,
  patch: Partial<Omit<CliInstallManifest, never>>,
): Promise<CliInstallManifest> {
  const logger = createCliLogger(environment);
  logger.debug("CLI manifest update started", {
    environment,
    patchesVersion: patch.version !== undefined,
    patchesBinaryPath: patch.binaryPath !== undefined,
    patchesSource: patch.source !== undefined,
    patchesPendingUpgrade: patch.pendingUpgrade !== undefined,
  });
  const current = await readCliManifest(environment);
  if (current === null) {
    logger.warn("CLI manifest update refused missing manifest", {
      environment,
    });
    throw cliError({
      code: CLI_ERROR_CODES.CLI_MANIFEST_INVALID,
      message: `CLI manifest for environment=${environment} does not exist; cannot patch a missing install`,
      details: { environment },
      exitCode: 1,
    });
  }
  const next: CliInstallManifest = {
    version: patch.version === undefined ? current.version : patch.version,
    installedAt:
      patch.installedAt === undefined ? current.installedAt : patch.installedAt,
    binaryPath:
      patch.binaryPath === undefined ? current.binaryPath : patch.binaryPath,
    source: patch.source === undefined ? current.source : patch.source,
    pendingUpgrade:
      patch.pendingUpgrade === undefined
        ? current.pendingUpgrade
        : patch.pendingUpgrade,
  };
  await writeCliManifest(environment, next);
  logger.info("CLI manifest update completed", {
    environment,
    hasVersion: next.version.length > 0,
    source: next.source,
    hasPendingUpgrade: next.pendingUpgrade !== null,
  });
  return next;
}

// Clear `pendingUpgrade` after the swap is finalised, optionally
// recording the new installed version + binary path in the same write.
export async function clearPendingUpgrade(
  environment: Environment,
  promotedInstall: {
    readonly version: string;
    readonly binaryPath: string;
    readonly installedAt: string;
  } | null,
): Promise<CliInstallManifest> {
  createCliLogger(environment).debug("CLI manifest clearing pending upgrade", {
    environment,
    promoted: promotedInstall !== null,
    hasPromotedVersion:
      promotedInstall !== null && promotedInstall.version.length > 0,
  });
  if (promotedInstall === null) {
    return updateCliManifest(environment, { pendingUpgrade: null });
  }
  return updateCliManifest(environment, {
    pendingUpgrade: null,
    version: promotedInstall.version,
    binaryPath: promotedInstall.binaryPath,
    installedAt: promotedInstall.installedAt,
  });
}
