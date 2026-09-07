import { access } from "node:fs/promises";
import {
  CLI_RECONCILE_PROBE_TIMEOUT_MS,
  cliBinariesDiffer,
  compareSemver,
  discoverCli,
  installBundledCli,
  isLocalSentinelVersion,
  probeCliVersion,
  readBundledCliVersion,
  readCliManifest,
  resolveBundledCliPath,
  stableCliBinaryPath,
  stageBundledCliForUpgrade,
  writeCliManifestPendingUpgrade,
  writeDesktopReconcileState,
  type BundledCliInstallResult,
  type CliDiscoveryResult,
  type CliInstallManifest,
} from "./cli-discovery";
import { log } from "../app/logger";

type PackageManagerSource =
  | "homebrew"
  | "npm"
  | "winget"
  | "scoop"
  | "apt"
  | "rpm";

/**
 * - If the Desktop-owned slot binary is present but cannot report its version (failed probe: corrupt file, ENOEXEC, hang), never let the manifest's recorded version stand in for it.
 * - If a package-manager-owned CLI (homebrew/npm/winget/scoop/apt/rpm) is older than the bundled CLI, do not overwrite it.
 */

export type CliReconcileOutcome =
  | {
      readonly kind: "skipped-dev-desktop";
    }
  | {
      readonly kind: "trusted-newer";
      readonly source: "path" | "manifest";
      readonly installedVersion: string | null;
      readonly bundledVersion: string;
      readonly binaryPath: string;
    }
  | {
      readonly kind: "trusted-equal";
      readonly source: "path" | "manifest";
      readonly installedVersion: string;
      readonly bundledVersion: string;
      readonly binaryPath: string;
    }
  | {
      readonly kind: "upgraded";
      readonly previousVersion: string;
      readonly newVersion: string;
      readonly binaryPath: string;
    }
  | {
      readonly kind: "upgrade-blocked";
      readonly reason: "binary-locked" | "manifest-rewrite-failed";
      readonly stagedVersion: string;
      readonly installedVersion: string;
      readonly errorMessage: string;
    }
  | {
      readonly kind: "package-manager-older";
      readonly source: PackageManagerSource;
      readonly installedVersion: string;
      readonly bundledVersion: string;
      readonly upgradeHint: string;
    }
  | {
      readonly kind: "installed-bundled";
      readonly version: string;
      readonly binaryPath: string;
    }
  | {
      readonly kind: "no-installed-cli";
    }
  | {
      readonly kind: "no-cli-anywhere";
    };

const PACKAGE_MANAGER_SOURCES: ReadonlySet<CliInstallManifest["source"]> =
  new Set(["homebrew", "npm", "winget", "scoop", "apt", "rpm"]);

const WINDOWS_LOCK_RE = /EBUSY|EACCES|EPERM|locked/i;
const POSIX_LOCK_RE = /EBUSY|locked/i;

function isPackageManagerSource(
  source: CliInstallManifest["source"],
): source is PackageManagerSource {
  return PACKAGE_MANAGER_SOURCES.has(source);
}

function packageManagerUpgradeHint(
  source: PackageManagerSource,
  bundledVersion: string,
): string {
  switch (source) {
    case "homebrew":
      return "brew upgrade traycer";
    case "npm":
      // `latest` names stable builds, so it can be older than an installed RC.
      // Name the version this reconciliation actually offered to upgrade to.
      return `npm install -g @traycerai/cli@${bundledVersion}`;
    case "winget":
      return "winget upgrade Traycer.CLI";
    case "scoop":
      return "scoop update traycer-cli";
    case "apt":
      return "sudo apt update && sudo apt install --only-upgrade traycer-cli";
    case "rpm":
      return "sudo dnf upgrade traycer-cli";
  }
}

export interface ReconcileCliDeps {
  readonly readCliManifest: () => Promise<CliInstallManifest | null>;
  readonly resolveBundledCliPath: () => Promise<string | null>;
  readonly readBundledCliVersion: () => Promise<string>;
  readonly discoverCli: () => Promise<CliDiscoveryResult>;
  readonly probeCliVersion: (binaryPath: string) => Promise<string | null>;
  readonly installBundledCli: (opts: {
    readonly bundledCliPath: string;
    readonly version: string;
    readonly source: CliInstallManifest["source"];
  }) => Promise<BundledCliInstallResult>;
  readonly stableCliBinaryPath: () => string;
  readonly stageBundledCliForUpgrade: (opts: {
    readonly bundledCliPath: string;
    readonly version: string;
  }) => Promise<string>;
  readonly stagedFileExists: (path: string) => Promise<boolean>;
  readonly cliBinariesDiffer: (
    installedPath: string,
    bundledPath: string,
  ) => Promise<boolean>;
  readonly writeCliManifestPendingUpgrade: (
    pending: NonNullable<CliInstallManifest["pendingUpgrade"]>,
    existing: CliInstallManifest | null,
  ) => Promise<CliInstallManifest | null>;
  readonly writeDesktopReconcileState: (state: {
    readonly packageManagerUpgrade: {
      readonly source: PackageManagerSource;
      readonly installedVersion: string;
      readonly bundledVersion: string;
      readonly upgradeCommand: string;
      readonly recordedAt: string;
    } | null;
  }) => Promise<void>;
  readonly now: () => Date;
  readonly logger: Pick<typeof log, "info" | "warn">;
}

export function defaultReconcileCliDeps(): ReconcileCliDeps {
  return {
    readCliManifest,
    resolveBundledCliPath,
    readBundledCliVersion,
    // A real CLI busy copying ~100 MB into the well-known slot is precisely the binary this pass must not misread, and each killed probe abandons that copy for the next one to start.
    discoverCli: () => discoverCli(CLI_RECONCILE_PROBE_TIMEOUT_MS),
    // Both reconcile call sites treat null as "could not determine", never as "not a CLI".
    probeCliVersion: async (binaryPath: string): Promise<string | null> => {
      const probed = await probeCliVersion(
        binaryPath,
        CLI_RECONCILE_PROBE_TIMEOUT_MS,
      );
      return probed.kind === "version" ? probed.version : null;
    },
    installBundledCli,
    stableCliBinaryPath,
    stageBundledCliForUpgrade,
    stagedFileExists: async (path: string) =>
      access(path).then(
        () => true,
        () => false,
      ),
    cliBinariesDiffer,
    writeCliManifestPendingUpgrade,
    writeDesktopReconcileState,
    now: () => new Date(),
    logger: log,
  };
}

export async function reconcileCli(
  deps: ReconcileCliDeps,
): Promise<CliReconcileOutcome> {
  const manifest = await deps.readCliManifest();
  const bundledPath = await deps.resolveBundledCliPath();
  const bundledVersion = await deps.readBundledCliVersion();

  // Case 1: no manifest at all. PATH-only or nothing.
  if (manifest === null) {
    const discovery = await deps.discoverCli();
    if (discovery.kind === "path") {
      if (discovery.source === "npm" && discovery.version !== null) {
        const cmp = compareSemver(discovery.version, bundledVersion);
        if (cmp < 0) {
          const upgradeHint = await persistPackageManagerUpgradeHint(deps, {
            source: "npm",
            installedVersion: discovery.version,
            bundledVersion,
          });
          deps.logger.info(
            "[cli-reconcile] npm-owned PATH CLI is older than bundled",
            {
              installed: discovery.version,
              bundled: bundledVersion,
              upgradeHint,
            },
          );
          return {
            kind: "package-manager-older",
            source: "npm",
            installedVersion: discovery.version,
            bundledVersion,
            upgradeHint,
          };
        }
        await clearPackageManagerHint(deps);
        return {
          kind: cmp === 0 ? "trusted-equal" : "trusted-newer",
          source: "path",
          installedVersion: discovery.version,
          bundledVersion,
          binaryPath: discovery.binaryPath,
        };
      }
      // Package managers that don't run our `cli mark-source` post-install hook surface here, so a binary that can answer `--version` is trusted whatever its version.
      // Production discovery has usually probed already (`vetPathCliCandidate`); probe here otherwise so trust is never extended on the strength of the file name alone.
      const probedVersion =
        discovery.version ?? (await deps.probeCliVersion(discovery.binaryPath));
      if (probedVersion !== null) {
        await clearPackageManagerHint(deps);
        return {
          kind:
            compareSemver(probedVersion, bundledVersion) === 0
              ? "trusted-equal"
              : "trusted-newer",
          source: "path",
          installedVersion: probedVersion,
          bundledVersion,
          binaryPath: discovery.binaryPath,
        };
      }
      // A `traycer` on PATH that cannot print its version is not a usable CLI.
      deps.logger.warn(
        "[cli-reconcile] PATH `traycer` failed the version probe - treating it as not-a-CLI and staging the bundled CLI",
        { binaryPath: discovery.binaryPath, bundledVersion },
      );
    }
    await clearPackageManagerHint(deps);
    if (
      (discovery.kind === "bundled" || discovery.kind === "path") &&
      bundledPath !== null
    ) {
      // "Probe-failed" here includes a candidate that answered nothing at all within `CLI_RECONCILE_PROBE_TIMEOUT_MS`, and that arm is a deliberate policy call rather than an oversight.
      // A binary that cannot say what it is inside fifteen seconds is not serving the host either.
      const installed = await deps.installBundledCli({
        bundledCliPath: bundledPath,
        version: bundledVersion,
        source: "desktop",
      });
      if (!installed.published) {
        // Reporting `installed-bundled` here would claim a version that was never written, so say nothing was installed and let the next reconcile try again.
        deps.logger.warn(
          "[cli-reconcile] fresh install deferred - the CLI lock is held by another writer",
          { binaryPath: installed.path, version: bundledVersion },
        );
        return { kind: "no-installed-cli" };
      }
      deps.logger.info(
        "[cli-reconcile] fresh install - staged bundled CLI into Desktop slot",
        { binaryPath: installed.path, version: bundledVersion },
      );
      return {
        kind: "installed-bundled",
        version: bundledVersion,
        binaryPath: installed.path,
      };
    }
    if (discovery.kind === "bundled") {
      return { kind: "no-installed-cli" };
    }
    return { kind: "no-cli-anywhere" };
  }

  // An uninstall (or manual cleanup) can remove the slot symlink while `manifest.json` lingers.
  // PATH / package-manager manifests point outside our slot, so they never match here and keep their existing semantics.
  if (
    manifest.binaryPath === deps.stableCliBinaryPath() &&
    bundledPath !== null &&
    !(await deps.stagedFileExists(manifest.binaryPath))
  ) {
    const installed = await deps.installBundledCli({
      bundledCliPath: bundledPath,
      version: bundledVersion,
      source: "desktop",
    });
    if (!installed.published) {
      // The heal did not run. Claiming `installed-bundled` would record a
      // version behind a slot this call never wrote; the next reconcile
      // re-enters this same branch and heals then.
      deps.logger.warn(
        "[cli-reconcile] slot heal deferred - the CLI lock is held by another writer",
        { binaryPath: installed.path, version: bundledVersion },
      );
      return { kind: "no-installed-cli" };
    }
    deps.logger.info(
      "[cli-reconcile] slot symlink missing - re-staged bundled CLI to heal it",
      { binaryPath: installed.path, version: bundledVersion },
    );
    return {
      kind: "installed-bundled",
      version: bundledVersion,
      binaryPath: installed.path,
    };
  }

  const probedManifestVersion =
    manifest.source === "desktop"
      ? await deps.probeCliVersion(manifest.binaryPath)
      : null;
  const installedVersion = probedManifestVersion ?? manifest.version;

  if (
    probedManifestVersion !== null &&
    probedManifestVersion !== manifest.version
  ) {
    deps.logger.warn("[cli-reconcile] manifest version disagrees with binary", {
      manifestVersion: manifest.version,
      binaryVersion: probedManifestVersion,
      binaryPath: manifest.binaryPath,
    });
  }

  // Case 2b: the desktop-owned slot binary is present (case 2a saw it) but cannot report its version.
  // The manifest's recorded version is exactly what must NOT stand in for it then: a broken slot plus a record claiming >= bundled reads "trusted-equal" on every launch, and the CLI.
  const slotBinaryUnresponsive =
    manifest.source === "desktop" && probedManifestVersion === null;

  // Case 2: manifest present. Compare versions.
  const cmp = compareSemver(installedVersion, bundledVersion);
  if (slotBinaryUnresponsive) {
    deps.logger.warn(
      "[cli-reconcile] desktop-owned slot binary failed the version probe - re-staging the bundled CLI over it instead of trusting the manifest record",
      {
        binaryPath: manifest.binaryPath,
        manifestVersion: manifest.version,
        bundledVersion,
      },
    );
  } else if (cmp >= 0) {
    // When BOTH sides are the sentinel - a state release bundles cannot produce (they stamp real semvers).
    const dogfoodRefresh =
      isLocalSentinelVersion(installedVersion) &&
      isLocalSentinelVersion(bundledVersion) &&
      manifest.source === "desktop" &&
      bundledPath !== null &&
      (await deps
        .cliBinariesDiffer(manifest.binaryPath, bundledPath)
        // An unreadable binary must not fail reconciliation - keep
        // trusting the slot, exactly as before this dogfood path existed.
        .catch(() => false));
    if (!dogfoodRefresh) {
      await clearPackageManagerHint(deps);
      return {
        kind: "trusted-equal",
        source: "manifest",
        installedVersion,
        bundledVersion,
        binaryPath: manifest.binaryPath,
      };
    }
    deps.logger.info(
      "[cli-reconcile] local-sentinel versions tie but slot binary differs from bundled - refreshing dogfood slot",
      { binaryPath: manifest.binaryPath, bundledPath },
    );
  }

  // Case 3: installed is older than bundled. Branch on source.
  if (isPackageManagerSource(manifest.source)) {
    const upgradeHint = await persistPackageManagerUpgradeHint(deps, {
      source: manifest.source,
      installedVersion,
      bundledVersion,
    });
    deps.logger.info(
      "[cli-reconcile] package-manager-owned CLI is older than bundled",
      {
        source: manifest.source,
        installed: installedVersion,
        bundled: bundledVersion,
        upgradeHint,
      },
    );
    return {
      kind: "package-manager-older",
      source: manifest.source,
      installedVersion,
      bundledVersion,
      upgradeHint,
    };
  }

  // Desktop-owned or manual install - Desktop is allowed to upgrade.
  await clearPackageManagerHint(deps);
  if (bundledPath === null) {
    // Surface a blocked outcome and let the caller route to support/diagnostic state.
    deps.logger.warn(
      "[cli-reconcile] desktop-owned CLI is older than bundled but no bundled binary is reachable - skipping pendingUpgrade",
      { installed: installedVersion, bundled: bundledVersion },
    );
    return {
      kind: "upgrade-blocked",
      reason: "manifest-rewrite-failed",
      stagedVersion: bundledVersion,
      installedVersion,
      errorMessage:
        "bundled CLI binary is not reachable from process.resourcesPath",
    };
  }

  try {
    const installed = await deps.installBundledCli({
      bundledCliPath: bundledPath,
      version: bundledVersion,
      source: manifest.source === "desktop" ? "desktop" : manifest.source,
    });
    if (!installed.published) {
      deps.logger.warn(
        "[cli-reconcile] upgrade deferred - the CLI lock is held by another writer",
        { from: installedVersion, to: bundledVersion, path: installed.path },
      );
      return {
        kind: "upgrade-blocked",
        reason: "binary-locked",
        stagedVersion: bundledVersion,
        installedVersion,
        errorMessage:
          "another writer holds the CLI lock; the upgrade will be retried",
      };
    }
    deps.logger.info("[cli-reconcile] upgraded desktop-owned CLI", {
      from: installedVersion,
      to: bundledVersion,
      path: installed.path,
    });
    return {
      kind: "upgraded",
      previousVersion: installedVersion,
      newVersion: bundledVersion,
      binaryPath: installed.path,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isLocked =
      process.platform === "win32"
        ? WINDOWS_LOCK_RE.test(errorMessage)
        : POSIX_LOCK_RE.test(errorMessage);
    const reason = isLocked ? "binary-locked" : "manifest-rewrite-failed";
    deps.logger.warn("[cli-reconcile] CLI upgrade blocked", {
      reason,
      errorMessage,
    });
    // We deliberately do NOT point `stagedBinaryPath` at `process.resourcesPath` (packaged app resources) or at the live `manifest.binaryPath` (renaming a file onto itself is a no-op.
    let stagedBinaryPath: string | null = null;
    try {
      stagedBinaryPath = await deps.stageBundledCliForUpgrade({
        bundledCliPath: bundledPath,
        version: bundledVersion,
      });
      if (!(await deps.stagedFileExists(stagedBinaryPath))) {
        deps.logger.warn(
          "[cli-reconcile] staged binary missing after copy - skipping pendingUpgrade",
          { stagedBinaryPath },
        );
        stagedBinaryPath = null;
      }
    } catch (stageErr) {
      deps.logger.warn("[cli-reconcile] failed to stage bundled CLI", stageErr);
      stagedBinaryPath = null;
    }
    if (stagedBinaryPath !== null) {
      await persistPendingUpgrade(
        deps,
        {
          version: bundledVersion,
          stagedBinaryPath,
          stagedAt: deps.now().toISOString(),
          reason: "binary-locked",
        },
        manifest,
      );
    }
    return {
      kind: "upgrade-blocked",
      reason,
      stagedVersion: bundledVersion,
      installedVersion,
      errorMessage,
    };
  }
}

async function persistPackageManagerUpgradeHint(
  deps: ReconcileCliDeps,
  args: {
    readonly source: PackageManagerSource;
    readonly installedVersion: string;
    readonly bundledVersion: string;
  },
): Promise<string> {
  const upgradeHint = packageManagerUpgradeHint(
    args.source,
    args.bundledVersion,
  );
  try {
    await deps.writeDesktopReconcileState({
      packageManagerUpgrade: {
        source: args.source,
        installedVersion: args.installedVersion,
        bundledVersion: args.bundledVersion,
        upgradeCommand: upgradeHint,
        recordedAt: deps.now().toISOString(),
      },
    });
  } catch (err) {
    deps.logger.warn(
      "[cli-reconcile] failed to persist package-manager upgrade hint",
      err,
    );
  }
  return upgradeHint;
}

async function persistPendingUpgrade(
  deps: ReconcileCliDeps,
  pending: NonNullable<CliInstallManifest["pendingUpgrade"]>,
  existing: CliInstallManifest | null,
): Promise<void> {
  try {
    const written = await deps.writeCliManifestPendingUpgrade(
      pending,
      existing,
    );
    if (written === null) {
      // Kept deliberately cause-neutral here so this line cannot assert the wrong one.
      deps.logger.warn(
        "[cli-reconcile] pendingUpgrade not recorded - see the cli log line above for the cause",
        { pending },
      );
    } else {
      deps.logger.info("[cli-reconcile] recorded pendingUpgrade on manifest", {
        version: pending.version,
        reason: pending.reason,
      });
    }
  } catch (err) {
    deps.logger.warn("[cli-reconcile] failed to record pendingUpgrade", err);
  }
}

export async function runLaunchTimeCliReconciliation(args: {
  readonly isDevDesktop: boolean;
  readonly deps: ReconcileCliDeps;
}): Promise<CliReconcileOutcome> {
  if (args.isDevDesktop) {
    args.deps.logger.info(
      "[cli-reconcile] dev desktop detected - skipping launch-time reconciliation against production ~/.traycer/cli (dev CLI wrapper is staged by make dev-desktop)",
    );
    return { kind: "skipped-dev-desktop" };
  }
  return reconcileCli(args.deps);
}

async function clearPackageManagerHint(deps: ReconcileCliDeps): Promise<void> {
  // Clear stale hints so the renderer never shows "upgrade your homebrew
  // traycer" once the user has upgraded (next reconcile sees the new
  // version and lands here).
  try {
    await deps.writeDesktopReconcileState({ packageManagerUpgrade: null });
  } catch {
    // best-effort
  }
}
