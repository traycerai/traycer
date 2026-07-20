import { afterEach, describe, expect, it, vi } from "vitest";

// `host update` must refuse to restart a busy host unless `--force` is
// passed - matching the same `assertHostNotBusy` gate `provisionHost`
// already applies to install/uninstall/service-cycle. Before this change
// `host-update.ts` skipped the gate entirely.

const mocks = vi.hoisted(() => ({
  assertHostNotBusyMock: vi.fn(),
  installHostMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
}));

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: mocks.assertHostNotBusyMock,
}));

vi.mock("../../installer", () => ({
  installHost: mocks.installHostMock,
}));

vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

vi.mock("../../store/cli-lock", () => ({
  withCliLock: (
    _opts: unknown,
    fn: (handle: {
      path: string;
      metadata: Record<string, unknown>;
      release: () => Promise<void>;
    }) => Promise<unknown>,
  ) =>
    fn({
      path: "/tmp/.lock",
      metadata: {},
      release: async () => {},
    }),
}));

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: () => ({
    lifecycle: {
      beforeSwap: async () => {},
      afterSwap: async () => {},
    },
    state: {
      priorState: "stopped",
      stoppedBeforeSwap: false,
      postSwapAction: "none",
      postSwapError: null,
    },
  }),
}));

import { buildHostUpdateCommand } from "../host-update";
import { CLI_ERROR_CODES } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { HostInstallRecord } from "../../manifest/host-install";

function sampleRecord(version: string): HostInstallRecord {
  return {
    version,
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: "/tmp/traycer-host",
  };
}

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

describe("buildHostUpdateCommand busy-check gating", () => {
  afterEach(() => {
    // resetAllMocks (not clearAllMocks) so a mockResolvedValue/
    // mockRejectedValue configured in one test can't leak into the next.
    vi.resetAllMocks();
  });

  it("rejects with E_HOST_BUSY without --force, and never calls installHost", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.assertHostNotBusyMock.mockRejectedValue(
      Object.assign(new Error("busy"), { code: CLI_ERROR_CODES.HOST_BUSY }),
    );
    const command = buildHostUpdateCommand({
      versionRequest: "latest",
      force: false,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    expect(mocks.assertHostNotBusyMock).toHaveBeenCalledWith("production");
    expect(mocks.installHostMock).not.toHaveBeenCalled();
  });

  it("skips the busy check and proceeds when --force is passed", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.installHostMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: sampleRecord("1.0.0"),
    });
    const command = buildHostUpdateCommand({
      versionRequest: "latest",
      force: true,
    });
    const result = await command(fakeCtx());
    expect(mocks.assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(mocks.installHostMock).toHaveBeenCalled();
    expect(result.data).toMatchObject({ version: "2.0.0" });
  });

  it("proceeds past the busy check when the host is idle", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
    mocks.installHostMock.mockResolvedValue({
      record: sampleRecord("1.0.0"),
      previous: sampleRecord("1.0.0"),
    });
    const command = buildHostUpdateCommand({
      versionRequest: "latest",
      force: false,
    });
    const result = await command(fakeCtx());
    expect(mocks.assertHostNotBusyMock).toHaveBeenCalledWith("production");
    expect(mocks.installHostMock).toHaveBeenCalled();
    expect(result.human).toContain("no-op");
  });

  it("installs the exact release selected by Desktop", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
    mocks.installHostMock.mockResolvedValue({
      record: sampleRecord("1.1.0-rc.2"),
      previous: sampleRecord("1.0.0"),
    });

    const command = buildHostUpdateCommand({
      versionRequest: "1.1.0-rc.2",
      force: false,
    });
    await command(fakeCtx());

    expect(mocks.installHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          kind: "registry",
          versionRequest: "1.1.0-rc.2",
        },
      }),
    );
  });
});

// Final Host admission hardening: `host update --release` refuses a lower
// target and treats equal as an explicit no-op without install/lifecycle.
// Direct `host install` remains the deliberate operator downgrade surface
// and is intentionally not covered here.
describe("buildHostUpdateCommand --release lower/equal guards", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("rejects a lower --release target without calling installHost or busy-check", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.6.0"));
    const command = buildHostUpdateCommand({
      versionRequest: "1.5.0",
      force: false,
    });

    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
      message: expect.stringMatching(
        /refusing to downgrade 1\.6\.0 to 1\.5\.0/i,
      ),
    });
    expect(mocks.assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(mocks.installHostMock).not.toHaveBeenCalled();
  });

  it("returns an explicit no-op for equal --release without installHost or busy-check", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.6.0"));
    const command = buildHostUpdateCommand({
      versionRequest: "1.6.0",
      force: false,
    });

    const result = await command(fakeCtx());
    expect(result.exitCode).toBe(0);
    expect(result.human).toContain("host already at 1.6.0 (no-op)");
    expect(result.data).toMatchObject({
      version: "1.6.0",
      previousVersion: "1.6.0",
    });
    expect(result.data).not.toHaveProperty("serviceLifecycle");
    expect(mocks.assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(mocks.installHostMock).not.toHaveBeenCalled();
  });

  it("still installs when --release is newer than the installed host", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.5.0"));
    mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
    mocks.installHostMock.mockResolvedValue({
      record: sampleRecord("1.6.0"),
      previous: sampleRecord("1.5.0"),
    });
    const command = buildHostUpdateCommand({
      versionRequest: "1.6.0",
      force: false,
    });

    const result = await command(fakeCtx());
    expect(mocks.installHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          kind: "registry",
          versionRequest: "1.6.0",
        },
      }),
    );
    expect(result.data).toMatchObject({ version: "1.6.0" });
  });
});
