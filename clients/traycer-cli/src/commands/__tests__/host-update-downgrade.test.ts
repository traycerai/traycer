import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostInstallRecord } from "../../manifest/host-install";
import type { Environment } from "../../runner/environment";
import type { ServiceInstallLifecycleState } from "../../service/install-lifecycle";

const mocks = vi.hoisted(() => ({
  sandboxHome: "",
  createDefaultRegistryClientMock: vi.fn(),
  busy: false,
  beforeSwapError: false,
  lifecycleCalls: [] as Array<{ readonly force: boolean }>,
}));

// Keep the real staging and commit primitives, but route their host paths to a
// disposable tree. The downgrade helper must therefore replace real bytes and
// records, not merely pass a version through a mocked apply function.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mocks.sandboxHome || actual.tmpdir(),
  };
});

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    hostHomeDir: (environment: Environment) =>
      join(mocks.sandboxHome, "host", environment),
    hostInstallDir: (environment: Environment) =>
      join(mocks.sandboxHome, "host", environment, "install"),
    hostInstallRecordPath: (environment: Environment) =>
      join(mocks.sandboxHome, "host", environment, "install", "install.json"),
    hostStagingRoot: (environment: Environment) =>
      join(mocks.sandboxHome, "host", environment, "install-staging"),
    hostStagedDir: (environment: Environment) =>
      join(mocks.sandboxHome, "host", environment, "staged"),
    hostStagedRecordPath: (environment: Environment) =>
      join(mocks.sandboxHome, "host", environment, "staged", "staged.json"),
    hostDownloadCacheDir: (environment: Environment) =>
      join(mocks.sandboxHome, "host", environment, "download-cache"),
    ensureHostHomeDir: async (environment: Environment) => {
      mkdirSync(join(mocks.sandboxHome, "host", environment), {
        recursive: true,
      });
    },
    ensureHostInstallDir: async (environment: Environment) => {
      mkdirSync(join(mocks.sandboxHome, "host", environment, "install"), {
        recursive: true,
      });
    },
    ensureHostStagingRoot: async (environment: Environment) => {
      mkdirSync(
        join(mocks.sandboxHome, "host", environment, "install-staging"),
        { recursive: true },
      );
    },
  };
});

vi.mock("../../registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../registry")>();
  return {
    ...actual,
    createDefaultRegistryClient: mocks.createDefaultRegistryClientMock,
  };
});

// The helper's real stage/commit primitives still run, while the contender
// facade is reduced to a live capability callback so this suite focuses on
// staging, the busy gate, swap, and cleanup rather than lock-process setup.
vi.mock("../../host/update-contender", () => ({
  withCliUpdateExecutionSegment: async (
    _options: unknown,
    run: (capability: { readonly hostHomeDir: string }) => Promise<unknown>,
  ) => run({ hostHomeDir: mocks.sandboxHome }),
  withCliAttemptMutation: async (
    _capability: unknown,
    _options: unknown,
    run: () => Promise<unknown>,
  ) => run(),
  requireCliUpdateMutationCapability: async () => undefined,
}));

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: async () => {
    if (mocks.busy) throw new Error("host is busy");
  },
}));

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: (options: { readonly force: boolean }) => {
    mocks.lifecycleCalls.push({ force: options.force });
    const state = {
      priorState: "running" as ServiceInstallLifecycleState["priorState"],
      stoppedBeforeSwap: false,
      postSwapAction: "none" as ServiceInstallLifecycleState["postSwapAction"],
      postSwapError: null as ServiceInstallLifecycleState["postSwapError"],
    };
    return {
      state,
      lifecycle: {
        beforeSwap: async () => {
          if (mocks.beforeSwapError) throw new Error("precommit failed");
          state.stoppedBeforeSwap = true;
        },
        afterSwap: async () => {
          state.postSwapAction = "install";
        },
        swapLockRecovery: null,
      },
    };
  },
}));

import {
  readHostInstallRecord,
  writeHostInstallRecord,
} from "../../manifest/host-install";
import { installHostDowngrade } from "../host-update-downgrade";

const ENV: Environment = "production";

function installDir(): string {
  return join(mocks.sandboxHome, "host", ENV, "install");
}

function stagingRoot(): string {
  return join(mocks.sandboxHome, "host", ENV, "install-staging");
}

function downloadCache(): string {
  return join(mocks.sandboxHome, "host", ENV, "download-cache");
}

function record(version: string): HostInstallRecord {
  return {
    installId: `install-${version}`,
    version,
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 3,
    executablePath: join(installDir(), "traycer-host"),
    executableSha256: null,
  };
}

function configureRegistry(version: string, bytes: string): void {
  mkdirSync(downloadCache(), { recursive: true });
  const archivePath = join(downloadCache(), "traycer-host");
  writeFileSync(archivePath, bytes);
  writeFileSync(
    `${archivePath}.owner`,
    JSON.stringify({ pid: process.pid, startedAtMs: null }),
  );
  mocks.createDefaultRegistryClientMock.mockResolvedValue({
    resolveAsset: async () => ({
      entry: { version },
      asset: { sizeBytes: Buffer.byteLength(bytes) },
    }),
    downloadAndVerify: async (
      _entry: unknown,
      _asset: unknown,
      onProgress: (progress: {
        readonly downloadedBytes: number;
        readonly totalBytes: number;
      }) => void,
    ) => {
      onProgress({
        downloadedBytes: Buffer.byteLength(bytes),
        totalBytes: Buffer.byteLength(bytes),
      });
      return {
        archivePath,
        archiveSha256: "b".repeat(64),
        signatureKeyId: "test-key",
        signatureVerifiedAt: "2026-01-02T00:00:00.000Z",
      };
    },
  });
}

async function writeInstalled(version: string, bytes: string): Promise<void> {
  mkdirSync(installDir(), { recursive: true });
  writeFileSync(join(installDir(), "traycer-host"), bytes);
  await writeHostInstallRecord(ENV, record(version));
}

const noopProgress = (): void => undefined;

describe("installHostDowngrade", () => {
  beforeEach(() => {
    mocks.sandboxHome = mkdtempSync(join(tmpdir(), "traycer-host-downgrade-"));
    mocks.busy = false;
    mocks.beforeSwapError = false;
    mocks.lifecycleCalls = [];
  });

  afterEach(() => {
    rmSync(mocks.sandboxHome, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it("stages and commits lower-version bytes over the current install, preserving force", async () => {
    await writeInstalled("1.3.0-rc.1", "old");
    configureRegistry("1.2.0", "new");

    const outcome = await installHostDowngrade({
      environment: ENV,
      version: "1.2.0",
      force: true,
      onProgress: noopProgress,
      onBeforeCommit: async () => undefined,
    });

    expect(outcome.outcome).toBe("applied");
    expect(outcome.previous?.version).toBe("1.3.0-rc.1");
    expect(outcome.record.version).toBe("1.2.0");
    expect(readFileSync(join(installDir(), "traycer-host"), "utf8")).toBe(
      "new",
    );
    expect(mocks.lifecycleCalls).toEqual([{ force: true }]);
    expect(await readHostInstallRecord(ENV)).toMatchObject({
      version: "1.2.0",
    });
  });

  it("checks busy before commit and discards the owned staged tree without replacing the install", async () => {
    await writeInstalled("1.3.0-rc.1", "old");
    configureRegistry("1.2.0", "new");
    mocks.busy = true;

    await expect(
      installHostDowngrade({
        environment: ENV,
        version: "1.2.0",
        force: false,
        onProgress: noopProgress,
        onBeforeCommit: async () => undefined,
      }),
    ).rejects.toThrow("host is busy");

    expect(readFileSync(join(installDir(), "traycer-host"), "utf8")).toBe(
      "old",
    );
    expect(await readHostInstallRecord(ENV)).toMatchObject({
      version: "1.3.0-rc.1",
    });
    expect(readdirSync(stagingRoot())).toEqual([]);
  });

  it("cleans the owned staged tree when the precommit lifecycle fails", async () => {
    await writeInstalled("1.3.0-rc.1", "old");
    configureRegistry("1.2.0", "new");
    mocks.beforeSwapError = true;

    await expect(
      installHostDowngrade({
        environment: ENV,
        version: "1.2.0",
        force: false,
        onProgress: noopProgress,
        onBeforeCommit: async () => undefined,
      }),
    ).rejects.toThrow("precommit failed");

    expect(readFileSync(join(installDir(), "traycer-host"), "utf8")).toBe(
      "old",
    );
    expect(existsSync(join(stagingRoot(), "install-"))).toBe(false);
    expect(readdirSync(stagingRoot())).toEqual([]);
  });

  it("invokes onBeforeCommit exactly once, after the busy gate and before the commit lands", async () => {
    // `onBeforeCommit` is `host update`'s marker-takeover hook, run under
    // the mutation lock AFTER the busy gate and immediately before the
    // commit - the first point at which this command is the only updater
    // acting AND has committed to acting (a busy refusal must come first,
    // so a parked run never seizes a marker for work it then does not do).
    // Observing the install record from INSIDE the callback (rather than
    // just counting calls) pins the "before the commit" half: a call that
    // ran after the swap would see the NEW version already committed.
    await writeInstalled("1.3.0-rc.1", "old");
    configureRegistry("1.2.0", "new");
    mocks.busy = false;
    let beforeCommitCalls = 0;
    let installedVersionAtCallTime: string | undefined;

    await installHostDowngrade({
      environment: ENV,
      version: "1.2.0",
      force: false,
      onProgress: noopProgress,
      onBeforeCommit: async () => {
        beforeCommitCalls += 1;
        const installed = await readHostInstallRecord(ENV);
        installedVersionAtCallTime = installed?.version;
      },
    });

    expect(beforeCommitCalls).toBe(1);
    expect(installedVersionAtCallTime).toBe("1.3.0-rc.1");
    expect(readFileSync(join(installDir(), "traycer-host"), "utf8")).toBe(
      "new",
    );
  });

  it("is NOT called when the busy gate throws - a parked run never seizes the marker for work it then does not do", async () => {
    // Falsification: move the `onBeforeCommit()` call in
    // `installHostDowngrade` to before `assertHostNotBusy` and
    // `beforeCommitCalls` below goes to 1 even though the run is busy.
    await writeInstalled("1.3.0-rc.1", "old");
    configureRegistry("1.2.0", "new");
    mocks.busy = true;
    let beforeCommitCalls = 0;

    await expect(
      installHostDowngrade({
        environment: ENV,
        version: "1.2.0",
        force: false,
        onProgress: noopProgress,
        onBeforeCommit: async () => {
          beforeCommitCalls += 1;
        },
      }),
    ).rejects.toThrow("host is busy");

    expect(beforeCommitCalls).toBe(0);
    expect(readFileSync(join(installDir(), "traycer-host"), "utf8")).toBe(
      "old",
    );
  });
});
