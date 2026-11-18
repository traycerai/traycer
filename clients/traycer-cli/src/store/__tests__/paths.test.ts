import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapLogPath,
  cliHomeDir,
  cliInstallHomeDir,
  cliLockPath,
  cliLogPath,
  cliManifestPath,
  cliPostFinalizeMarkerPath,
  cliSharedHomeDir,
  ensureCliInvocationStateDir,
  hostCliInvocationLifecyclePath,
  hostCliInvocationRecordPath,
  hostCliInvocationRecordStaleMarkerPath,
  hostCliInvocationStateDir,
  hostHomeDir,
  hostInstallDir,
  hostInstallRecordPath,
  hostLogPath,
  hostPidMetadataPath,
  hostStagingRoot,
  hostUpdateProgressMarkerPath,
  inspectCliInvocationStateDir,
  traycerHomeDir,
} from "../paths";
import { withDevDesktopSlot } from "@traycer-clients/shared/test-fixtures/dev-desktop-slot";

/**
 * Named `import { open }` in `paths.ts` does not see `vi.spyOn(fsPromises,
 * "open")`. The mock rebinds the export so a Windows-branch test that still
 * takes the POSIX descriptor path fails instead of going false-green on
 * macOS, where `open(directory)` succeeds.
 */
const windowsStateDir = vi.hoisted(() => ({
  rejectOpen: false,
  lstatOverride: null as
    | null
    | (() => Promise<
        Pick<Stats, "isSymbolicLink" | "isDirectory" | "dev" | "ino">
      >),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (windowsStateDir.rejectOpen) {
        throw new Error(
          "open must not be called on the Windows state-dir branch",
        );
      }
      return actual.open(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (windowsStateDir.lstatOverride !== null) {
        return (await windowsStateDir.lstatOverride()) as Stats;
      }
      return actual.lstat(...args);
    },
  };
});

function stubPlatformWin32(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) {
    throw new Error("process.platform descriptor missing");
  }
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  return () => {
    Object.defineProperty(process, "platform", descriptor);
  };
}

const TRAYCER_HOME = join(homedir(), ".traycer");
const CLI_HOME = join(TRAYCER_HOME, "cli");
const HOST_HOME = join(TRAYCER_HOME, "host");

describe("store/paths host helpers", () => {
  it("anchors all paths under the single ~/.traycer root", () => {
    expect(traycerHomeDir()).toBe(TRAYCER_HOME);
    expect(cliSharedHomeDir()).toBe(CLI_HOME);
    expect(hostHomeDir(undefined)).toBe(HOST_HOME);
    expect(hostHomeDir("production")).toBe(HOST_HOME);
    expect(hostHomeDir("dev")).toBe(join(HOST_HOME, "dev"));
  });

  it("uses a per-run host root for dev-desktop slots", () => {
    withDevDesktopSlot("My Slot", () => {
      expect(hostHomeDir("production")).toBe(HOST_HOME);
      expect(hostHomeDir("dev")).toBe(join(HOST_HOME, "dev-runs", "my-slot"));
      expect(hostPidMetadataPath("dev")).toBe(
        join(HOST_HOME, "dev-runs", "my-slot", "pid.json"),
      );
      expect(hostLogPath("dev")).toBe(
        join(HOST_HOME, "dev-runs", "my-slot", "host.log"),
      );
      expect(hostCliInvocationRecordPath("dev")).toBe(
        join(
          HOST_HOME,
          "dev-runs",
          "my-slot",
          "cli-invocation",
          "cli-invocation.json",
        ),
      );
    });
  });

  it("resolves the CLI invocation record under the environment host home", () => {
    expect(hostCliInvocationStateDir("production")).toBe(
      join(HOST_HOME, "cli-invocation"),
    );
    expect(hostCliInvocationRecordPath("production")).toBe(
      join(HOST_HOME, "cli-invocation", "cli-invocation.json"),
    );
    expect(hostCliInvocationRecordStaleMarkerPath("production")).toBe(
      join(HOST_HOME, "cli-invocation", "cli-invocation.stale"),
    );
    expect(hostCliInvocationLifecyclePath("production")).toBe(
      join(HOST_HOME, "cli-invocation", "cli-invocation.lifecycle"),
    );
    expect(hostCliInvocationRecordPath("dev")).toBe(
      join(HOST_HOME, "dev", "cli-invocation", "cli-invocation.json"),
    );
  });

  it("resolves host runtime files to the environment root", () => {
    expect(hostPidMetadataPath("production")).toBe(join(HOST_HOME, "pid.json"));
    expect(hostPidMetadataPath("dev")).toBe(join(HOST_HOME, "dev", "pid.json"));
    expect(hostLogPath("production")).toBe(join(HOST_HOME, "host.log"));
    expect(hostLogPath("dev")).toBe(join(HOST_HOME, "dev", "host.log"));
    // bootstrap markers share the host log file by design.
    expect(bootstrapLogPath("production")).toBe(hostLogPath("production"));
    expect(bootstrapLogPath("dev")).toBe(hostLogPath("dev"));
    // Legacy non-environment callers (bootstrap-log, pid-metadata) resolve
    // to the prod root.
    expect(bootstrapLogPath(undefined)).toBe(hostLogPath("production"));
    expect(hostPidMetadataPath(undefined)).toBe(
      hostPidMetadataPath("production"),
    );
    expect(hostLogPath(undefined)).toBe(hostLogPath("production"));
  });

  it("resolves host install/staging dirs per environment", () => {
    expect(hostInstallDir("production")).toBe(join(HOST_HOME, "install"));
    expect(hostInstallDir("dev")).toBe(join(HOST_HOME, "dev", "install"));
    // "install-staging" is the host install temp/extract area, kept distinct
    // from the host root.
    expect(hostStagingRoot("production")).toBe(
      join(HOST_HOME, "install-staging"),
    );
    expect(hostStagingRoot("dev")).toBe(
      join(HOST_HOME, "dev", "install-staging"),
    );
  });

  it("constructs the install-record path under the environment install dir", () => {
    expect(hostInstallRecordPath("production")).toBe(
      join(HOST_HOME, "install", "install.json"),
    );
    expect(hostInstallRecordPath("dev")).toBe(
      join(HOST_HOME, "dev", "install", "install.json"),
    );
    // The record always sits directly inside the environment install dir.
    expect(hostInstallRecordPath("production")).toBe(
      join(hostInstallDir("production"), "install.json"),
    );
    expect(hostInstallRecordPath("dev")).toBe(
      join(hostInstallDir("dev"), "install.json"),
    );
  });

  it("resolves the update-progress marker directly under the environment host root", () => {
    expect(hostUpdateProgressMarkerPath("production")).toBe(
      join(HOST_HOME, "update-progress.json"),
    );
    expect(hostUpdateProgressMarkerPath("dev")).toBe(
      join(HOST_HOME, "dev", "update-progress.json"),
    );
  });

  it("keeps prod and dev host trees disjoint under the shared root", () => {
    const prod = hostInstallRecordPath("production");
    const dev = hostInstallRecordPath("dev");
    expect(prod).not.toBe(dev);
    // Dev paths always nest under prod-root/dev - never a sibling like
    // ~/.traycer-dev/ - so a single ~/.traycer/ rm purges both.
    expect(dev.startsWith(HOST_HOME + "/")).toBe(true);
    expect(prod.startsWith(HOST_HOME + "/")).toBe(true);
  });
});

describe("store/paths CLI helpers", () => {
  it("treats the CLI home as shared without a environment and per-environment with one", () => {
    expect(cliHomeDir(undefined)).toBe(CLI_HOME);
    expect(cliHomeDir("production")).toBe(CLI_HOME);
    expect(cliHomeDir("dev")).toBe(join(CLI_HOME, "dev"));
    expect(cliInstallHomeDir("dev")).toBe(join(CLI_HOME, "dev"));
  });

  it("places per-environment manifest/lock/post-finalize markers under the environment CLI dir", () => {
    expect(cliManifestPath("production")).toBe(join(CLI_HOME, "manifest.json"));
    expect(cliManifestPath("dev")).toBe(join(CLI_HOME, "dev", "manifest.json"));
    expect(cliLockPath("production")).toBe(join(CLI_HOME, ".lock"));
    expect(cliLockPath("dev")).toBe(join(CLI_HOME, "dev", ".lock"));
    expect(cliPostFinalizeMarkerPath("production")).toBe(
      join(CLI_HOME, "post-finalize.json"),
    );
    expect(cliPostFinalizeMarkerPath("dev")).toBe(
      join(CLI_HOME, "dev", "post-finalize.json"),
    );
  });

  it("moves only dev CLI install surfaces into the dev-desktop run slot", () => {
    withDevDesktopSlot("Example Slot", () => {
      const slotRoot = join(CLI_HOME, "dev-runs", "example-slot");
      expect(cliHomeDir("dev")).toBe(join(CLI_HOME, "dev"));
      expect(cliInstallHomeDir("dev")).toBe(slotRoot);
      expect(cliManifestPath("dev")).toBe(join(slotRoot, "manifest.json"));
      expect(cliLockPath("dev")).toBe(join(slotRoot, ".lock"));
      expect(cliLogPath("dev")).toBe(join(slotRoot, "cli.log"));
      expect(cliPostFinalizeMarkerPath("dev")).toBe(
        join(slotRoot, "post-finalize.json"),
      );
    });
  });
});

describe("inspectCliInvocationStateDir Windows branch", () => {
  afterEach(() => {
    windowsStateDir.rejectOpen = false;
    windowsStateDir.lstatOverride = null;
  });

  it("uses lstat and does not open the directory when process.platform is win32", async () => {
    const hostHome = await mkdtemp(join(tmpdir(), "traycer-win-state-"));
    const restore = stubPlatformWin32();
    windowsStateDir.rejectOpen = true;
    try {
      await mkdir(join(hostHome, "cli-invocation"));
      const identity = await inspectCliInvocationStateDir(hostHome, true);
      const stats = await lstat(join(hostHome, "cli-invocation"));
      expect(identity).toEqual({ dev: stats.dev, ino: stats.ino });
    } finally {
      restore();
      await rm(hostHome, { recursive: true, force: true });
    }
  });

  it("ensureCliInvocationStateDir on the Windows branch creates without opening the child", async () => {
    const hostHome = await mkdtemp(join(tmpdir(), "traycer-win-ensure-"));
    const restore = stubPlatformWin32();
    windowsStateDir.rejectOpen = true;
    try {
      const identity = await ensureCliInvocationStateDir(hostHome);
      const stats = await lstat(join(hostHome, "cli-invocation"));
      expect(stats.isDirectory()).toBe(true);
      expect(identity).toEqual({ dev: stats.dev, ino: stats.ino });
    } finally {
      restore();
      await rm(hostHome, { recursive: true, force: true });
    }
  });

  it("rejects a symlink child on the Windows lstat path", async () => {
    const restore = stubPlatformWin32();
    windowsStateDir.rejectOpen = true;
    windowsStateDir.lstatOverride = async () => ({
      isSymbolicLink: () => true,
      isDirectory: () => false,
      dev: 1,
      ino: 2,
    });
    try {
      await expect(
        inspectCliInvocationStateDir("/fake-host-home", false),
      ).rejects.toMatchObject({ code: "ELOOP" });
    } finally {
      restore();
    }
  });

  it("rejects a non-directory child on the Windows lstat path", async () => {
    const restore = stubPlatformWin32();
    windowsStateDir.rejectOpen = true;
    windowsStateDir.lstatOverride = async () => ({
      isSymbolicLink: () => false,
      isDirectory: () => false,
      dev: 1,
      ino: 2,
    });
    try {
      await expect(
        inspectCliInvocationStateDir("/fake-host-home", false),
      ).rejects.toMatchObject({ code: "ENOTDIR" });
    } finally {
      restore();
    }
  });

  it("rejects a directory reporting ino: 0 (no verifiable filesystem identity)", async () => {
    const restore = stubPlatformWin32();
    windowsStateDir.rejectOpen = true;
    windowsStateDir.lstatOverride = async () => ({
      isSymbolicLink: () => false,
      isDirectory: () => true,
      dev: 7,
      ino: 0,
    });
    try {
      await expect(
        inspectCliInvocationStateDir("/fake-host-home", false),
      ).rejects.toMatchObject({ code: "EINVAL" });
    } finally {
      restore();
    }
  });
});

describe.skipIf(process.platform === "win32")(
  "inspectCliInvocationStateDir POSIX negative cases",
  () => {
    let hostHome = "";

    afterEach(async () => {
      if (hostHome !== "") {
        await rm(hostHome, { recursive: true, force: true });
        hostHome = "";
      }
    });

    it("rejects a child directory with mode 0750 as EACCES", async () => {
      hostHome = await mkdtemp(join(tmpdir(), "traycer-posix-state-"));
      const child = join(hostHome, "cli-invocation");
      await mkdir(child, { mode: 0o750 });
      await chmod(child, 0o750);
      await expect(
        inspectCliInvocationStateDir(hostHome, false),
      ).rejects.toMatchObject({ code: "EACCES" });
    });

    it("rejects a child that is a regular file as ENOTDIR", async () => {
      hostHome = await mkdtemp(join(tmpdir(), "traycer-posix-state-"));
      const child = join(hostHome, "cli-invocation");
      await writeFile(child, "not-a-directory\n", { mode: 0o600 });
      await expect(
        inspectCliInvocationStateDir(hostHome, false),
      ).rejects.toMatchObject({ code: "ENOTDIR" });
    });

    it("rejects a child that is a symlink to a real private directory", async () => {
      hostHome = await mkdtemp(join(tmpdir(), "traycer-posix-state-"));
      const target = join(hostHome, "real-target");
      await mkdir(target, { mode: 0o700 });
      await chmod(target, 0o700);
      const child = join(hostHome, "cli-invocation");
      await symlink(target, child);
      await expect(
        inspectCliInvocationStateDir(hostHome, false),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^(ELOOP|ENOTDIR)$/),
      });
    });
  },
);
