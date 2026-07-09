import { describe, expect, it, vi } from "vitest";
import { reconcileCli, runLaunchTimeCliReconciliation } from "../cli-reconcile";
import {
  isNpmCliPackagePath,
  type CliDiscoveryResult,
  type CliInstallManifest,
} from "../cli-discovery";

// Launch-time CLI reconciliation contract (Core Flow 2). The
// reconciler is pure with respect to its injected dependencies, so the
// suite exercises every branch without touching the real filesystem
// or running an Electron process.

function makeDeps(overrides: {
  manifest?: CliInstallManifest | null;
  bundledPath?: string | null;
  bundledVersion?: string;
  discovery?: CliDiscoveryResult;
  probeCliVersion?: (binaryPath: string) => string | null;
  installBundledCli?: (opts: {
    bundledCliPath: string;
    version: string;
    source: CliInstallManifest["source"];
  }) => string;
  stableCliBinaryPath?: () => string;
  stageBundledCliForUpgrade?: (opts: {
    bundledCliPath: string;
    version: string;
  }) => string;
  stagedFileExists?: (path: string) => boolean;
  writeCliManifestPendingUpgrade?: (
    pending: NonNullable<CliInstallManifest["pendingUpgrade"]>,
  ) => CliInstallManifest | null;
  writeDesktopReconcileState?: (state: {
    packageManagerUpgrade: {
      source: "homebrew" | "npm" | "winget" | "scoop" | "apt" | "rpm";
      installedVersion: string;
      bundledVersion: string;
      upgradeCommand: string;
      recordedAt: string;
    } | null;
  }) => void;
  cliBinariesDiffer?: (installedPath: string, bundledPath: string) => boolean;
  now?: () => Date;
}) {
  const install = overrides.installBundledCli ?? vi.fn(() => "/stable/traycer");
  const writePending = vi.fn(
    overrides.writeCliManifestPendingUpgrade ??
      ((_pending: NonNullable<CliInstallManifest["pendingUpgrade"]>) =>
        ({
          version: "1.0.0",
          installedAt: "2026-04-01T00:00:00Z",
          binaryPath: "/old/traycer",
          source: "desktop",
          pendingUpgrade: _pending,
        }) as CliInstallManifest),
  );
  const writeState = vi.fn(overrides.writeDesktopReconcileState ?? (() => {}));
  const stage = vi.fn(
    overrides.stageBundledCliForUpgrade ??
      (() => "/home/.traycer/cli/staging/traycer-1.4.2"),
  );
  const stagedFileExists = vi.fn(
    overrides.stagedFileExists ?? ((_path: string) => true),
  );
  return {
    deps: {
      readCliManifest: async () => overrides.manifest ?? null,
      resolveBundledCliPath: async () => overrides.bundledPath ?? null,
      readBundledCliVersion: async () => overrides.bundledVersion ?? "1.0.0",
      discoverCli: async () =>
        overrides.discovery ?? ({ kind: "none" } as const),
      probeCliVersion: async (binaryPath: string) =>
        overrides.probeCliVersion?.(binaryPath) ?? null,
      installBundledCli: (async (opts: {
        bundledCliPath: string;
        version: string;
        source: CliInstallManifest["source"];
      }) => install(opts)) as never,
      stableCliBinaryPath:
        overrides.stableCliBinaryPath ?? (() => "/stable/traycer"),
      stageBundledCliForUpgrade: (async (opts: {
        bundledCliPath: string;
        version: string;
      }) => stage(opts)) as never,
      stagedFileExists: async (path: string) => stagedFileExists(path),
      cliBinariesDiffer: async (installedPath: string, bundledPath: string) =>
        overrides.cliBinariesDiffer?.(installedPath, bundledPath) ?? false,
      writeCliManifestPendingUpgrade: (async (
        pending: NonNullable<CliInstallManifest["pendingUpgrade"]>,
      ) => writePending(pending)) as never,
      writeDesktopReconcileState: async (
        state: Parameters<typeof writeState>[0],
      ) => writeState(state),
      now: overrides.now ?? (() => new Date("2026-05-15T00:00:00Z")),
      logger: { info: vi.fn(), warn: vi.fn() },
    },
    install,
    writePending,
    writeState,
    stage,
    stagedFileExists,
  };
}

describe("reconcileCli - newest-wins", () => {
  it("upgrades a desktop-owned manifest CLI that is older than the bundled CLI", async () => {
    const { deps, install } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/old/traycer",
        source: "desktop",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
    });
    const result = await reconcileCli(deps);
    expect(result.kind).toBe("upgraded");
    expect(install).toHaveBeenCalledWith({
      bundledCliPath: "/bundled/traycer",
      version: "1.4.2",
      source: "desktop",
    });
    if (result.kind === "upgraded") {
      expect(result.previousVersion).toBe("1.0.0");
      expect(result.newVersion).toBe("1.4.2");
    }
  });

  it("uses the actual desktop-owned binary version when the manifest is stale", async () => {
    const { deps, install } = makeDeps({
      manifest: {
        version: "1.4.2",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/stable/traycer",
        source: "desktop",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
      probeCliVersion: (binaryPath: string) =>
        binaryPath === "/stable/traycer" ? "0.0.0-local" : null,
    });
    const result = await reconcileCli(deps);
    expect(install).toHaveBeenCalledWith({
      bundledCliPath: "/bundled/traycer",
      version: "1.4.2",
      source: "desktop",
    });
    expect(result.kind).toBe("upgraded");
    if (result.kind === "upgraded") {
      expect(result.previousVersion).toBe("0.0.0-local");
      expect(result.newVersion).toBe("1.4.2");
    }
  });

  it("leaves a package-manager-owned older CLI alone and returns the platform-specific upgrade hint", async () => {
    const { deps, install } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/usr/local/Cellar/traycer/1.0.0/bin/traycer",
        source: "homebrew",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
    });
    const result = await reconcileCli(deps);
    expect(install).not.toHaveBeenCalled();
    expect(result.kind).toBe("package-manager-older");
    if (result.kind === "package-manager-older") {
      expect(result.source).toBe("homebrew");
      expect(result.upgradeHint).toBe("brew upgrade traycer");
      expect(result.installedVersion).toBe("1.0.0");
      expect(result.bundledVersion).toBe("1.4.2");
    }
  });

  it("returns npm upgrade instructions for npm-owned CLI", async () => {
    const { deps, install } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/usr/local/bin/traycer",
        source: "npm",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
    });
    const result = await reconcileCli(deps);
    expect(install).not.toHaveBeenCalled();
    expect(result.kind).toBe("package-manager-older");
    if (result.kind === "package-manager-older") {
      expect(result.source).toBe("npm");
      expect(result.upgradeHint).toBe("npm install -g @traycerai/cli@latest");
    }
  });

  it("returns winget upgrade instructions for winget-owned CLI", async () => {
    const { deps } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "C:\\Users\\me\\AppData\\Local\\traycer.exe",
        source: "winget",
        pendingUpgrade: null,
      },
      bundledPath:
        "C:\\Program Files\\Traycer\\resources\\cli\\win32-x64\\traycer.exe",
      bundledVersion: "1.4.2",
    });
    const result = await reconcileCli(deps);
    expect(result.kind).toBe("package-manager-older");
    if (result.kind === "package-manager-older") {
      expect(result.source).toBe("winget");
      expect(result.upgradeHint).toContain("winget upgrade");
    }
  });

  it("returns scoop upgrade instructions for scoop-owned CLI", async () => {
    const { deps, install, writeState } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath:
          "C:\\Users\\me\\scoop\\apps\\traycer-cli\\current\\traycer.exe",
        source: "scoop",
        pendingUpgrade: null,
      },
      bundledPath:
        "C:\\Program Files\\Traycer\\resources\\cli\\win32-x64\\traycer.exe",
      bundledVersion: "1.4.2",
    });
    const result = await reconcileCli(deps);
    expect(install).not.toHaveBeenCalled();
    expect(result.kind).toBe("package-manager-older");
    if (result.kind === "package-manager-older") {
      expect(result.source).toBe("scoop");
      expect(result.upgradeHint).toBe("scoop update traycer-cli");
      expect(result.installedVersion).toBe("1.0.0");
      expect(result.bundledVersion).toBe("1.4.2");
    }
    const [state] = writeState.mock.calls[0];
    expect(state.packageManagerUpgrade).toMatchObject({
      source: "scoop",
      upgradeCommand: "scoop update traycer-cli",
    });
  });

  it("returns apt upgrade instructions for apt-owned CLI", async () => {
    const { deps, install, writeState } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/usr/bin/traycer",
        source: "apt",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
    });
    const result = await reconcileCli(deps);
    expect(install).not.toHaveBeenCalled();
    expect(result.kind).toBe("package-manager-older");
    if (result.kind === "package-manager-older") {
      expect(result.source).toBe("apt");
      expect(result.upgradeHint).toBe(
        "sudo apt update && sudo apt install --only-upgrade traycer-cli",
      );
      expect(result.installedVersion).toBe("1.0.0");
      expect(result.bundledVersion).toBe("1.4.2");
    }
    const [state] = writeState.mock.calls[0];
    expect(state.packageManagerUpgrade).toMatchObject({
      source: "apt",
      upgradeCommand:
        "sudo apt update && sudo apt install --only-upgrade traycer-cli",
    });
  });

  it("returns rpm upgrade instructions for rpm-owned CLI", async () => {
    const { deps, install, writeState } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/usr/bin/traycer",
        source: "rpm",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
    });
    const result = await reconcileCli(deps);
    expect(install).not.toHaveBeenCalled();
    expect(result.kind).toBe("package-manager-older");
    if (result.kind === "package-manager-older") {
      expect(result.source).toBe("rpm");
      expect(result.upgradeHint).toBe("sudo dnf upgrade traycer-cli");
      expect(result.installedVersion).toBe("1.0.0");
      expect(result.bundledVersion).toBe("1.4.2");
    }
    const [state] = writeState.mock.calls[0];
    expect(state.packageManagerUpgrade).toMatchObject({
      source: "rpm",
      upgradeCommand: "sudo dnf upgrade traycer-cli",
    });
  });

  it("trusts a newer manifest CLI silently", async () => {
    const { deps, install } = makeDeps({
      manifest: {
        version: "2.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/new/traycer",
        source: "desktop",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
    });
    const result = await reconcileCli(deps);
    expect(install).not.toHaveBeenCalled();
    expect(result.kind).toBe("trusted-equal");
    if (result.kind === "trusted-equal") {
      expect(result.installedVersion).toBe("2.0.0");
      expect(result.binaryPath).toBe("/new/traycer");
    }
  });

  it("stages the bundled CLI into the slot when only the bundled CLI is available", async () => {
    const { deps, install } = makeDeps({
      manifest: null,
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
      discovery: { kind: "bundled", binaryPath: "/bundled/traycer" } as const,
    });
    const result = await reconcileCli(deps);
    expect(install).toHaveBeenCalledWith({
      bundledCliPath: "/bundled/traycer",
      version: "1.4.2",
      source: "desktop",
    });
    expect(result.kind).toBe("installed-bundled");
    if (result.kind === "installed-bundled") {
      expect(result.version).toBe("1.4.2");
      expect(result.binaryPath).toBe("/stable/traycer");
    }
  });

  it("returns no-cli-anywhere when nothing is discoverable", async () => {
    const { deps } = makeDeps({
      manifest: null,
      bundledPath: null,
      discovery: { kind: "none" } as const,
    });
    const result = await reconcileCli(deps);
    expect(result.kind).toBe("no-cli-anywhere");
  });

  it("trusts a PATH CLI silently when no manifest exists", async () => {
    const { deps, install } = makeDeps({
      manifest: null,
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
      discovery: {
        kind: "path",
        binaryPath: "/usr/local/bin/traycer",
        version: null,
      } as const,
    });
    const result = await reconcileCli(deps);
    expect(install).not.toHaveBeenCalled();
    expect(result.kind).toBe("trusted-newer");
    if (result.kind === "trusted-newer") {
      expect(result.source).toBe("path");
      expect(result.binaryPath).toBe("/usr/local/bin/traycer");
      expect(result.installedVersion).toBeNull();
    }
  });

  it("surfaces npm upgrade instructions for an older npm-owned PATH CLI without a manifest", async () => {
    const { deps, install, writeState } = makeDeps({
      manifest: null,
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
      discovery: {
        kind: "path",
        binaryPath: "/usr/local/bin/traycer",
        version: "1.0.0",
        source: "npm",
      } as const,
    });
    const result = await reconcileCli(deps);
    expect(install).not.toHaveBeenCalled();
    expect(result.kind).toBe("package-manager-older");
    if (result.kind === "package-manager-older") {
      expect(result.source).toBe("npm");
      expect(result.installedVersion).toBe("1.0.0");
      expect(result.bundledVersion).toBe("1.4.2");
      expect(result.upgradeHint).toBe("npm install -g @traycerai/cli@latest");
    }
    const [state] = writeState.mock.calls[0];
    expect(state.packageManagerUpgrade).toMatchObject({
      source: "npm",
      upgradeCommand: "npm install -g @traycerai/cli@latest",
    });
  });

  it("recognizes npm package paths across POSIX and Windows separators", () => {
    expect(
      isNpmCliPackagePath("/usr/local/lib/node_modules/@traycerai/cli/traycer"),
    ).toBe(true);
    expect(
      isNpmCliPackagePath(
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@traycerai\\cli\\traycer",
      ),
    ).toBe(true);
    expect(isNpmCliPackagePath("/usr/local/bin/traycer")).toBe(false);
  });

  // POSIX counterpart to the Windows EBUSY test: on Linux/macOS,
  // EACCES/EPERM are real permission problems, NOT transient locks, so
  // the reconciler must surface them as `manifest-rewrite-failed` (a
  // real error the operator has to resolve) and never the
  // `binary-locked` recovery path. Skipped on win32, where the platform-
  // gated lock detection deliberately treats those codes as locks.
  it.skipIf(process.platform === "win32")(
    "routes POSIX EACCES to manifest-rewrite-failed (not binary-locked)",
    async () => {
      const eaccesInstaller = () => {
        throw new Error("EACCES: permission denied, rename '/old/traycer'");
      };
      const { deps } = makeDeps({
        manifest: {
          version: "1.0.0",
          installedAt: "2026-04-01T00:00:00Z",
          binaryPath: "/old/traycer",
          source: "desktop",
          pendingUpgrade: null,
        },
        bundledPath: "/bundled/traycer",
        bundledVersion: "1.4.2",
        installBundledCli: eaccesInstaller,
      });
      const result = await reconcileCli(deps);
      expect(result.kind).toBe("upgrade-blocked");
      if (result.kind === "upgrade-blocked") {
        expect(result.reason).toBe("manifest-rewrite-failed");
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "routes POSIX EPERM to manifest-rewrite-failed (not binary-locked)",
    async () => {
      const epermInstaller = () => {
        throw new Error(
          "EPERM: operation not permitted, rename '/old/traycer'",
        );
      };
      const { deps } = makeDeps({
        manifest: {
          version: "1.0.0",
          installedAt: "2026-04-01T00:00:00Z",
          binaryPath: "/old/traycer",
          source: "desktop",
          pendingUpgrade: null,
        },
        bundledPath: "/bundled/traycer",
        bundledVersion: "1.4.2",
        installBundledCli: epermInstaller,
      });
      const result = await reconcileCli(deps);
      expect(result.kind).toBe("upgrade-blocked");
      if (result.kind === "upgrade-blocked") {
        expect(result.reason).toBe("manifest-rewrite-failed");
      }
    },
  );

  it("records pendingUpgrade when the desktop-owned binary is locked (Windows EBUSY)", async () => {
    const lockedInstaller = () => {
      const err = new Error("EBUSY: resource busy or locked");
      throw err;
    };
    const { deps } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "C:\\Users\\me\\.traycer\\cli\\bin\\traycer.exe",
        source: "desktop",
        pendingUpgrade: null,
      },
      bundledPath:
        "C:\\Program Files\\Traycer\\resources\\cli\\win32-x64\\traycer.exe",
      bundledVersion: "1.4.2",
      installBundledCli: lockedInstaller,
    });
    const result = await reconcileCli(deps);
    expect(result.kind).toBe("upgrade-blocked");
    if (result.kind === "upgrade-blocked") {
      expect(result.reason).toBe("binary-locked");
      expect(result.stagedVersion).toBe("1.4.2");
      expect(result.installedVersion).toBe("1.0.0");
    }
  });

  it("returns upgrade-blocked manifest-rewrite-failed when bundled CLI is unreachable", async () => {
    const { deps } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/old/traycer",
        source: "desktop",
        pendingUpgrade: null,
      },
      bundledPath: null,
      bundledVersion: "1.4.2",
    });
    const result = await reconcileCli(deps);
    expect(result.kind).toBe("upgrade-blocked");
    if (result.kind === "upgrade-blocked") {
      expect(result.reason).toBe("manifest-rewrite-failed");
    }
  });

  it("supports the Windows .exe binary path through the same upgrade flow", async () => {
    const { deps, install } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "C:\\Users\\me\\.traycer\\cli\\bin\\traycer.exe",
        source: "desktop",
        pendingUpgrade: null,
      },
      bundledPath:
        "C:\\Program Files\\Traycer\\resources\\cli\\win32-x64\\traycer.exe",
      bundledVersion: "1.4.2",
    });
    const result = await reconcileCli(deps);
    expect(install).toHaveBeenCalledOnce();
    expect(result.kind).toBe("upgraded");
  });

  it("trusts when installed and bundled are equal (no-op)", async () => {
    const { deps, install } = makeDeps({
      manifest: {
        version: "1.4.2",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/stable/traycer",
        source: "desktop",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
    });
    const result = await reconcileCli(deps);
    expect(install).not.toHaveBeenCalled();
    expect(result.kind).toBe("trusted-equal");
  });

  it("re-stages the bundled CLI when the manifest points at a missing slot symlink (heals after uninstall)", async () => {
    // An uninstall removed `~/.traycer/cli/<slot>/bin/traycer` but left a
    // stale manifest behind (same version as bundled, so the version compare
    // would short-circuit to trusted-equal at a dead path). The reconciler
    // must notice the slot symlink is gone and recreate it.
    const { deps, install } = makeDeps({
      manifest: {
        version: "1.4.2",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/stable/traycer",
        source: "desktop",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
      stableCliBinaryPath: () => "/stable/traycer",
      stagedFileExists: (path: string) => path !== "/stable/traycer",
    });
    const result = await reconcileCli(deps);
    expect(install).toHaveBeenCalledWith({
      bundledCliPath: "/bundled/traycer",
      version: "1.4.2",
      source: "desktop",
    });
    expect(result.kind).toBe("installed-bundled");
    if (result.kind === "installed-bundled") {
      expect(result.binaryPath).toBe("/stable/traycer");
      expect(result.version).toBe("1.4.2");
    }
  });

  it("does NOT heal when the manifest binary lives outside our slot (PATH / package-manager owned)", async () => {
    // A package-manager manifest points at the PM's own path, not our slot.
    // Even if that path were momentarily unreadable, reconcile must not hijack
    // it into our slot - it keeps the package-manager-older semantics.
    const { deps, install } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/usr/local/Cellar/traycer/1.0.0/bin/traycer",
        source: "homebrew",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
      stableCliBinaryPath: () => "/stable/traycer",
      stagedFileExists: () => false,
    });
    const result = await reconcileCli(deps);
    expect(install).not.toHaveBeenCalled();
    expect(result.kind).toBe("package-manager-older");
  });

  it("stages bundled CLI into a real writable copy and persists pendingUpgrade when desktop-owned upgrade is blocked", async () => {
    const lockedInstaller = () => {
      throw new Error("EBUSY: resource busy or locked");
    };
    const stagedPath = "/home/.traycer/cli/staging/traycer-1.4.2";
    const stage = vi.fn(() => stagedPath);
    const { deps, writePending } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "C:\\Users\\me\\.traycer\\cli\\bin\\traycer.exe",
        source: "desktop",
        pendingUpgrade: null,
      },
      bundledPath:
        "C:\\Program Files\\Traycer\\resources\\cli\\win32-x64\\traycer.exe",
      bundledVersion: "1.4.2",
      installBundledCli: lockedInstaller,
      stageBundledCliForUpgrade: stage,
      stagedFileExists: () => true,
    });
    const result = await reconcileCli(deps);
    expect(result.kind).toBe("upgrade-blocked");
    expect(stage).toHaveBeenCalledWith({
      bundledCliPath:
        "C:\\Program Files\\Traycer\\resources\\cli\\win32-x64\\traycer.exe",
      version: "1.4.2",
    });
    expect(writePending).toHaveBeenCalledTimes(1);
    const [pending] = writePending.mock.calls[0];
    expect(pending).toMatchObject({
      version: "1.4.2",
      reason: "binary-locked",
      stagedBinaryPath: stagedPath,
    });
    expect(typeof pending.stagedAt).toBe("string");
    // stagedBinaryPath must NOT point at process.resourcesPath or the live
    // manifest binary path - both would cause renames/unlinks to clobber
    // packaged app resources or the running binary.
    expect(pending.stagedBinaryPath).not.toBe(
      "C:\\Program Files\\Traycer\\resources\\cli\\win32-x64\\traycer.exe",
    );
    expect(pending.stagedBinaryPath).not.toBe(
      "C:\\Users\\me\\.traycer\\cli\\bin\\traycer.exe",
    );
  });

  it("does NOT persist pendingUpgrade when bundled binary is unreachable (avoids bogus staging path)", async () => {
    const { deps, writePending, stage } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/old/traycer",
        source: "desktop",
        pendingUpgrade: null,
      },
      bundledPath: null,
      bundledVersion: "1.4.2",
    });
    const result = await reconcileCli(deps);
    expect(result.kind).toBe("upgrade-blocked");
    if (result.kind === "upgrade-blocked") {
      expect(result.reason).toBe("manifest-rewrite-failed");
    }
    expect(stage).not.toHaveBeenCalled();
    expect(writePending).not.toHaveBeenCalled();
  });

  it("does NOT persist pendingUpgrade when staging itself fails", async () => {
    const lockedInstaller = () => {
      throw new Error("EBUSY: resource busy or locked");
    };
    const failingStage = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    const { deps, writePending } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/old/traycer",
        source: "desktop",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
      installBundledCli: lockedInstaller,
      stageBundledCliForUpgrade: failingStage,
    });
    const result = await reconcileCli(deps);
    expect(result.kind).toBe("upgrade-blocked");
    expect(writePending).not.toHaveBeenCalled();
  });

  it("writes a package-manager upgrade hint sidecar for older homebrew installs", async () => {
    const { deps, writeState } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/usr/local/Cellar/traycer/1.0.0/bin/traycer",
        source: "homebrew",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
    });
    const result = await reconcileCli(deps);
    expect(result.kind).toBe("package-manager-older");
    expect(writeState).toHaveBeenCalledTimes(1);
    const [state] = writeState.mock.calls[0];
    expect(state.packageManagerUpgrade).toMatchObject({
      source: "homebrew",
      installedVersion: "1.0.0",
      bundledVersion: "1.4.2",
      upgradeCommand: "brew upgrade traycer",
    });
    expect(typeof state.packageManagerUpgrade?.recordedAt).toBe("string");
  });

  it("clears a stale package-manager hint when reconcile observes a newer manifest", async () => {
    const { deps, writeState } = makeDeps({
      manifest: {
        version: "1.5.0",
        installedAt: "2026-05-01T00:00:00Z",
        binaryPath: "/usr/local/Cellar/traycer/1.5.0/bin/traycer",
        source: "homebrew",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
    });
    await reconcileCli(deps);
    expect(writeState).toHaveBeenCalledWith({ packageManagerUpgrade: null });
  });

  // Dogfood builds all stamp the `0.0.0-local` sentinel, so two different
  // local builds tie on version. The reconciler must fall back to binary
  // content for the desktop-owned slot - and ONLY there.
  describe("local-sentinel dogfood refresh", () => {
    const localDesktopManifest: CliInstallManifest = {
      version: "0.0.0-local",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath: "/stable/traycer",
      source: "desktop",
      pendingUpgrade: null,
    };

    it("refreshes a desktop-owned slot when sentinel versions tie but binaries differ", async () => {
      const { deps, install } = makeDeps({
        manifest: localDesktopManifest,
        bundledPath: "/bundled/traycer",
        bundledVersion: "0.0.0-local",
        probeCliVersion: () => "0.0.0-local",
        cliBinariesDiffer: () => true,
      });
      const result = await reconcileCli(deps);
      expect(result.kind).toBe("upgraded");
      expect(install).toHaveBeenCalledWith({
        bundledCliPath: "/bundled/traycer",
        version: "0.0.0-local",
        source: "desktop",
      });
    });

    it("trusts the slot when sentinel versions tie and binaries are identical", async () => {
      const { deps, install } = makeDeps({
        manifest: localDesktopManifest,
        bundledPath: "/bundled/traycer",
        bundledVersion: "0.0.0-local",
        probeCliVersion: () => "0.0.0-local",
        cliBinariesDiffer: () => false,
      });
      const result = await reconcileCli(deps);
      expect(result.kind).toBe("trusted-equal");
      expect(install).not.toHaveBeenCalled();
    });

    it("never overwrites a package-manager-owned CLI on a sentinel tie", async () => {
      const { deps, install } = makeDeps({
        manifest: { ...localDesktopManifest, source: "npm" },
        bundledPath: "/bundled/traycer",
        bundledVersion: "0.0.0-local",
        cliBinariesDiffer: () => true,
      });
      const result = await reconcileCli(deps);
      expect(result.kind).toBe("trusted-equal");
      expect(install).not.toHaveBeenCalled();
    });

    it("keeps trusting the slot when the binary comparison fails", async () => {
      const { deps, install } = makeDeps({
        manifest: localDesktopManifest,
        bundledPath: "/bundled/traycer",
        bundledVersion: "0.0.0-local",
        probeCliVersion: () => "0.0.0-local",
        cliBinariesDiffer: () => {
          throw new Error("EACCES: unreadable");
        },
      });
      const result = await reconcileCli(deps);
      expect(result.kind).toBe("trusted-equal");
      expect(install).not.toHaveBeenCalled();
    });

    it("does not fall back to binary comparison when a real release version is involved", async () => {
      const differ = vi.fn(() => true);
      const { deps } = makeDeps({
        manifest: { ...localDesktopManifest, version: "1.5.0" },
        bundledPath: "/bundled/traycer",
        bundledVersion: "1.4.2",
        probeCliVersion: () => "1.5.0",
        cliBinariesDiffer: differ,
      });
      const result = await reconcileCli(deps);
      expect(result.kind).toBe("trusted-equal");
      expect(differ).not.toHaveBeenCalled();
    });
  });
});

// Launch-time gate around reconcileCli. Dev / unpackaged Desktop
// (`make dev-desktop`, unpackaged Electron) must not read, write,
// clear, or stage state under `~/.traycer/cli/` at boot - the dev
// orchestrator stages its own dev CLI wrapper. Production packaged
// Desktop must continue to reconcile against production state.
describe("runLaunchTimeCliReconciliation - dev isolation", () => {
  // Production-mode args: the reconciler is allowed to touch production
  // state, so we plant a desktop-owned older manifest and observe writes.
  function makeOlderDesktopManifestDeps() {
    return makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/old/traycer",
        source: "desktop",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
    });
  }

  it("skips reconciliation entirely when isDevDesktop is true (no reads, no writes against production ~/.traycer/cli)", async () => {
    // Build a fully-mocked deps so every read/write surface is a vi.fn
    // and we can assert nothing on the production CLI tree is touched.
    const readManifest = vi.fn();
    const resolveBundled = vi.fn();
    const readBundledVersion = vi.fn();
    const discover = vi.fn();
    const install = vi.fn();
    const stableBin = vi.fn();
    const stage = vi.fn();
    const stagedFileExists = vi.fn();
    const writePending = vi.fn();
    const writeState = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const deps = {
      readCliManifest: readManifest as never,
      resolveBundledCliPath: resolveBundled as never,
      readBundledCliVersion: readBundledVersion as never,
      discoverCli: discover as never,
      probeCliVersion: vi.fn() as never,
      installBundledCli: install as never,
      stableCliBinaryPath: stableBin as never,
      stageBundledCliForUpgrade: stage as never,
      stagedFileExists: stagedFileExists as never,
      cliBinariesDiffer: vi.fn() as never,
      writeCliManifestPendingUpgrade: writePending as never,
      writeDesktopReconcileState: writeState as never,
      now: () => new Date("2026-05-15T00:00:00Z"),
      logger: { info, warn },
    };

    const outcome = await runLaunchTimeCliReconciliation({
      isDevDesktop: true,
      deps,
    });

    expect(outcome).toEqual({ kind: "skipped-dev-desktop" });
    // Read-side: dev Desktop must not probe production manifest/
    // bundled paths or run discovery - preserves the "no production
    // ~/.traycer/cli reads" half of the acceptance criteria.
    expect(readManifest).not.toHaveBeenCalled();
    expect(resolveBundled).not.toHaveBeenCalled();
    expect(readBundledVersion).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(stableBin).not.toHaveBeenCalled();
    // Write-side: no upgrade, no staging, no manifest pendingUpgrade,
    // no Desktop reconcile-state sidecar.
    expect(install).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    expect(stagedFileExists).not.toHaveBeenCalled();
    expect(writePending).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
  });

  it("invokes the production reconciler when isDevDesktop is false (packaged Desktop unchanged)", async () => {
    const { deps, install } = makeOlderDesktopManifestDeps();
    const outcome = await runLaunchTimeCliReconciliation({
      isDevDesktop: false,
      deps,
    });
    expect(outcome.kind).toBe("upgraded");
    expect(install).toHaveBeenCalledWith({
      bundledCliPath: "/bundled/traycer",
      version: "1.4.2",
      source: "desktop",
    });
  });

  it("production-mode runs all reconcile branches identically - package-manager-older hint is still persisted", async () => {
    const { deps, writeState, install } = makeDeps({
      manifest: {
        version: "1.0.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: "/usr/local/Cellar/traycer/1.0.0/bin/traycer",
        source: "homebrew",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
    });
    const outcome = await runLaunchTimeCliReconciliation({
      isDevDesktop: false,
      deps,
    });
    expect(outcome.kind).toBe("package-manager-older");
    expect(install).not.toHaveBeenCalled();
    expect(writeState).toHaveBeenCalledTimes(1);
  });

  it("dev-mode does not clear a stale package-manager hint (preserves all production sidecar state untouched)", async () => {
    const { deps, writeState } = makeDeps({
      manifest: {
        version: "1.5.0",
        installedAt: "2026-05-01T00:00:00Z",
        binaryPath: "/usr/local/Cellar/traycer/1.5.0/bin/traycer",
        source: "homebrew",
        pendingUpgrade: null,
      },
      bundledPath: "/bundled/traycer",
      bundledVersion: "1.4.2",
    });
    await runLaunchTimeCliReconciliation({ isDevDesktop: true, deps });
    expect(writeState).not.toHaveBeenCalled();
  });

  it("logs a dev-skip message via the injected logger so the support bundle captures the skip reason", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const deps = {
      readCliManifest: vi.fn() as never,
      resolveBundledCliPath: vi.fn() as never,
      readBundledCliVersion: vi.fn() as never,
      discoverCli: vi.fn() as never,
      probeCliVersion: vi.fn() as never,
      installBundledCli: vi.fn() as never,
      stableCliBinaryPath: vi.fn() as never,
      stageBundledCliForUpgrade: vi.fn() as never,
      stagedFileExists: vi.fn() as never,
      cliBinariesDiffer: vi.fn() as never,
      writeCliManifestPendingUpgrade: vi.fn() as never,
      writeDesktopReconcileState: vi.fn() as never,
      now: () => new Date("2026-05-15T00:00:00Z"),
      logger: { info, warn },
    };
    await runLaunchTimeCliReconciliation({ isDevDesktop: true, deps });
    expect(info).toHaveBeenCalled();
    const [message] = info.mock.calls[0];
    expect(String(message)).toMatch(/dev desktop/i);
    expect(String(message)).toMatch(/skipping/i);
  });
});
