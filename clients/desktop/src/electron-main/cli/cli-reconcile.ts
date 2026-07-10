import { access } from "node:fs/promises";
import {
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
  type CliDiscoveryResult,
  type CliInstallManifest,
} from "./cli-discovery";
import { log } from "../app/logger";

type PackageManagerSource =
  "homebrew" | "npm" | "winget" | "scoop" | "apt" | "rpm";

/**
 * Launch-time CLI reconciliation (Core Flow 2, "newest-wins"):
 *
 *   - If a Desktop-owned manifest CLI (`source: "desktop"`) is **older** than
 *     the bundled CLI, silently upgrade it: copy bundled → stable per-user
 *     path and rewrite the manifest. If the live binary is locked (typical
 *     on Windows), surface a `pendingUpgrade` instead of erroring.
 *
 *   - If a **package-manager**-owned CLI (homebrew/npm/winget/scoop/apt/rpm) is
 *     older than the bundled CLI, **do not** overwrite it. Return a
 *     reconciliation outcome with platform/source-specific upgrade
 *     instructions so the UI can surface the right hint.
 *
 *   - If the installed manifest/PATH CLI is **newer** than (or equal to)
 *     the bundled CLI, trust it silently for the session.
 *
 *   - If no installed CLI exists, leave staging to the first-launch
 *     setup flow (it already calls `installBundledCli`).
 *
 *   - If the manifest is malformed but a binary is reachable on PATH,
 *     fall back to the PATH binary. If neither exists, the function
 *     returns `kind: "none"`.
 *
 * The reconciliation must run **before** host-dependent setup or
 * Settings actions pick which CLI to invoke - `discoverCli()` is
 * deterministic so as long as the manifest is up-to-date when those
 * code paths run, the right CLI is chosen.
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

// Windows: EBUSY, EACCES, EPERM are all common when a process holds the
// live binary open. POSIX: only EBUSY (and a textual "locked" tag) are
// real transient locks; EACCES/EPERM mean a permission problem the
// operator must resolve, so they route to `manifest-rewrite-failed`.
const WINDOWS_LOCK_RE = /EBUSY|EACCES|EPERM|locked/i;
const POSIX_LOCK_RE = /EBUSY|locked/i;

function isPackageManagerSource(
  source: CliInstallManifest["source"],
): source is PackageManagerSource {
  return PACKAGE_MANAGER_SOURCES.has(source);
}

function packageManagerUpgradeHint(source: PackageManagerSource): string {
  switch (source) {
    case "homebrew":
      // Must match the Homebrew formula name shipped via
      // scripts/native-packaging/publish-cli-package-managers.cjs
      // (`Formula/traycer.rb`) and the CLI self-upgrade guidance in
      // traycer-cli/src/commands/cli-upgrade.ts.
      return "brew upgrade traycer";
    case "npm":
      return "npm install -g @traycerai/cli@latest";
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
  }) => Promise<string>;
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
    discoverCli,
    probeCliVersion,
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
      await clearPackageManagerHint(deps);
      // PATH binary present but no manifest. Trust it silently -
      // package managers that don't run our `cli mark-source` post-
      // install hook still surface here. We can't compare versions
      // without probing, so the conservative call is "trust newer-
      // or-equal" by default.
      return {
        kind: "trusted-newer",
        source: "path",
        installedVersion: null,
        bundledVersion,
        binaryPath: discovery.binaryPath,
      };
    }
    await clearPackageManagerHint(deps);
    if (discovery.kind === "bundled" && bundledPath !== null) {
      // Fresh install: no manifest and no `traycer` on PATH, but the app ships
      // a bundled CLI. Stage it into the Desktop-owned slot (a symlink on
      // POSIX) so the bundle-blind host has a deterministic, space-free
      // `~/.traycer/cli[/<slot>]/bin/traycer` to put on PATH for the monitor /
      // title hooks / terminal agents. Nothing else self-heals this slot.
      const installedPath = await deps.installBundledCli({
        bundledCliPath: bundledPath,
        version: bundledVersion,
        source: "desktop",
      });
      deps.logger.info(
        "[cli-reconcile] fresh install - staged bundled CLI into Desktop slot",
        { binaryPath: installedPath, version: bundledVersion },
      );
      return {
        kind: "installed-bundled",
        version: bundledVersion,
        binaryPath: installedPath,
      };
    }
    if (discovery.kind === "bundled") {
      return { kind: "no-installed-cli" };
    }
    return { kind: "no-cli-anywhere" };
  }

  // Case 2a: manifest outlived its binary. An uninstall (or manual cleanup)
  // can remove the slot symlink while `manifest.json` lingers - its recorded
  // version still "trusts equal/newer" in the compare below, so without this
  // guard reconcile hands back a dead `binaryPath` and the bundle-blind host
  // never gets a `traycer` on PATH (monitor / title hooks / terminal agents
  // all exit 127). When the manifest points at our own slot symlink and that
  // symlink is gone, re-stage the bundled CLI to recreate it before trusting
  // the manifest. PATH / package-manager manifests point outside our slot, so
  // they never match here and keep their existing semantics.
  if (
    manifest.binaryPath === deps.stableCliBinaryPath() &&
    bundledPath !== null &&
    !(await deps.stagedFileExists(manifest.binaryPath))
  ) {
    const installedPath = await deps.installBundledCli({
      bundledCliPath: bundledPath,
      version: bundledVersion,
      source: "desktop",
    });
    deps.logger.info(
      "[cli-reconcile] slot symlink missing - re-staged bundled CLI to heal it",
      { binaryPath: installedPath, version: bundledVersion },
    );
    return {
      kind: "installed-bundled",
      version: bundledVersion,
      binaryPath: installedPath,
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

  // Case 2: manifest present. Compare versions.
  const cmp = compareSemver(installedVersion, bundledVersion);
  if (cmp >= 0) {
    // Version comparison is blind between two dogfood builds: every local
    // build stamps the same `0.0.0-local` sentinel, so a stale slot CLI
    // reads "equal" forever and keeps running host installs/stops with old
    // code. When BOTH sides are the sentinel - a state release bundles
    // cannot produce (they stamp real semvers) - and the slot is
    // desktop-owned, settle it by comparing the binaries themselves and
    // route a differing slot through the normal upgrade path below.
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
    // No bundled binary to copy from - `pendingUpgrade.stagedBinaryPath`
    // would have nowhere safe to point at (the live binary at
    // `manifest.binaryPath` is not a real staged copy, and the missing
    // bundled binary can't be staged). Surface a blocked outcome and let
    // the caller route to support/diagnostic state.
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
    const installedPath = await deps.installBundledCli({
      bundledCliPath: bundledPath,
      version: bundledVersion,
      source: manifest.source === "desktop" ? "desktop" : manifest.source,
    });
    deps.logger.info("[cli-reconcile] upgraded desktop-owned CLI", {
      from: installedVersion,
      to: bundledVersion,
      path: installedPath,
    });
    return {
      kind: "upgraded",
      previousVersion: installedVersion,
      newVersion: bundledVersion,
      binaryPath: installedPath,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Platform-gated lock detection (review item 8). On Windows, EBUSY,
    // EACCES, and EPERM are all routinely produced when a process holds
    // the live binary open and we try to rename onto it - they all map
    // to `binary-locked` so the renderer surfaces the "restart service
    // to finalize upgrade" recovery. On POSIX, EACCES/EPERM mean
    // permission denied (not a transient lock), so they should route to
    // `manifest-rewrite-failed` and surface as a real error; only EBUSY
    // (and the human-readable "locked" suffix some node errors carry)
    // remain `binary-locked`.
    const isLocked =
      process.platform === "win32"
        ? WINDOWS_LOCK_RE.test(errorMessage)
        : POSIX_LOCK_RE.test(errorMessage);
    const reason = isLocked ? "binary-locked" : "manifest-rewrite-failed";
    deps.logger.warn("[cli-reconcile] CLI upgrade blocked", {
      reason,
      errorMessage,
    });
    // Stage the bundled CLI into a writable Desktop-owned path before
    // recording `pendingUpgrade`. The staged copy is the artifact that
    // `traycer cli upgrade` will rename onto the live binary path once the
    // service restarts and releases the lock. We deliberately do NOT point
    // `stagedBinaryPath` at `process.resourcesPath` (packaged app
    // resources) or at the live `manifest.binaryPath` (renaming a file
    // onto itself is a no-op and risks blowing away the running binary).
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
  const upgradeHint = packageManagerUpgradeHint(args.source);
  // Persist the hint to a Desktop-owned sidecar so the renderer's
  // `cliManifest()` IPC can surface "your homebrew traycer is N
  // versions behind - `brew upgrade traycer`" without Desktop ever
  // writing into the package-manager-owned manifest file.
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
      deps.logger.warn(
        "[cli-reconcile] cannot record pendingUpgrade - manifest unreadable",
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

/**
 * Launch-time gate around `reconcileCli`. The dev slot's CLI lifecycle is
 * owned by the `make dev-desktop` orchestrator: it stages the dev wrapper at
 * `~/.traycer/cli/dev/bin/traycer`, which the desktop resolves via the
 * bundled-CLI path (see `resolveBundledCliPath`). The desktop's
 * reconcile/upgrade machinery (version probes, pending-upgrade staging,
 * package-manager hints) only applies to shipped builds, so it is skipped on
 * the dev slot - there is nothing for it to reconcile that the orchestrator
 * has not already set up. Shipped builds (staging/production) reconcile
 * unchanged. With the env-scoped CLI paths this is a lifecycle-ownership
 * boundary, no longer a guard against touching the prod tree.
 *
 * The gate is intentionally a thin wrapper rather than a branch inside
 * `reconcileCli` so the per-branch reconciler stays pure and so the
 * "skip on the dev slot" rule is unit-testable without an Electron process.
 */
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
