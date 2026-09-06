import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { HostInstallRecord } from "../../manifest/host-install";
import type { HostUpdateProgress } from "../../host/update-progress-marker";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";

const mocks = vi.hoisted(() => ({
  installHostDowngradeMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
  writeUpdateProgressMarkerMock: vi.fn(),
  deleteUpdateProgressMarkerMock: vi.fn(),
  deleteUpdateProgressMarkerIfUnchangedMock: vi.fn(),
  replaceUpdateProgressMarkerMock: vi.fn(),
  probeHostHealthMock: vi.fn(),
  installDispatchAckStamperMock: vi.fn(),
}));

vi.mock("../host-update-downgrade", () => ({
  installHostDowngrade: mocks.installHostDowngradeMock,
}));

vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

vi.mock("../../host/update-progress-marker", () => ({
  writeUpdateProgressMarker: mocks.writeUpdateProgressMarkerMock,
  deleteUpdateProgressMarker: mocks.deleteUpdateProgressMarkerMock,
  readUpdateProgressMarker: async () => null,
  deleteUpdateProgressMarkerIfUnchanged:
    mocks.deleteUpdateProgressMarkerIfUnchangedMock,
  replaceUpdateProgressMarkerIfUnchanged: mocks.replaceUpdateProgressMarkerMock,
  progressRecord: (fields: {
    state: "updating" | "failed";
    error: string | null;
    targetVersion: string;
  }): HostUpdateProgress => ({
    ...fields,
    updatedAt: new Date().toISOString(),
    writerId: "test-writer",
  }),
  sameProgress: () => true,
}));

vi.mock("../../service/health-probe", () => ({
  probeHostHealth: mocks.probeHostHealthMock,
}));

vi.mock("../../host/update-dispatch-ack", () => ({
  installDispatchAckStamper: mocks.installDispatchAckStamperMock,
}));

vi.mock("../../installer/download-stage", () => ({
  downloadAndStageHost: vi.fn(),
}));

// SAFETY: `buildHostUpdateCommand` now probes the REAL `~/.traycer/host/
// pid.json` for activation debt, and an unmocked read on a developer machine
// could classify the developer's live host as debt and restart it. Every test
// that invokes the command mocks the probe to "no running host".
vi.mock("../../host/pid-metadata", () => ({
  readHostPidMetadata: vi.fn(async () => null),
}));

import { buildHostUpdateCommand } from "../host-update";

const installedRecord: HostInstallRecord = {
  installId: "install-1.3.0-rc.1",
  version: "1.3.0-rc.1",
  runtimeVersion: null,
  platform: "darwin",
  arch: "arm64",
  installedAt: "2026-01-01T00:00:00.000Z",
  source: { kind: "registry", value: "1.3.0-rc.1" },
  archiveSha256: "a".repeat(64),
  signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
  signatureKeyId: "test-key",
  sizeBytes: 1,
  executablePath: "/tmp/traycer-host",
  executableSha256: null,
};

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

describe("host update explicit downgrade failure", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("leaves a failed marker for the downgrade target and never claims host health", async () => {
    mocks.installDispatchAckStamperMock.mockReturnValue(null);
    mocks.readHostInstallRecordMock.mockResolvedValue(installedRecord);
    mocks.installHostDowngradeMock.mockRejectedValue(
      new Error("downgrade commit failed"),
    );
    mocks.replaceUpdateProgressMarkerMock.mockResolvedValue("replaced");

    await expect(
      buildHostUpdateCommand({
        allowDowngrade: true,
        force: false,
        versionRequest: "1.2.0",
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toThrow("downgrade commit failed");

    // Only the initial `updating` write happens unconditionally; the
    // `failed` stamp goes through the compare-and-swap against it.
    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenCalledTimes(1);
    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenNthCalledWith(
      1,
      "production",
      expect.objectContaining({
        state: "updating",
        targetVersion: "1.2.0",
      }),
    );
    expect(mocks.replaceUpdateProgressMarkerMock).toHaveBeenCalledWith(
      "production",
      expect.objectContaining({
        state: "updating",
        targetVersion: "1.2.0",
      }),
      expect.objectContaining({
        state: "failed",
        targetVersion: "1.2.0",
        error: "downgrade commit failed",
      }),
    );
    expect(mocks.probeHostHealthMock).not.toHaveBeenCalled();
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
  });

  it("HOST_BUSY from installHostDowngrade parks: deletes the written updating marker and never stamps failed", async () => {
    mocks.installDispatchAckStamperMock.mockReturnValue(null);
    mocks.readHostInstallRecordMock.mockResolvedValue(installedRecord);
    mocks.installHostDowngradeMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "The running host has work in progress",
        details: null,
        exitCode: 1,
      }),
    );
    mocks.deleteUpdateProgressMarkerIfUnchangedMock.mockResolvedValue(
      "cleared",
    );

    await expect(
      buildHostUpdateCommand({
        allowDowngrade: true,
        force: false,
        versionRequest: "1.2.0",
        ackNonce: null,
      })(fakeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });

    // Only the initial `updating` write happens - the park withdraws it
    // rather than stamping a second, `failed` one.
    expect(mocks.writeUpdateProgressMarkerMock).toHaveBeenCalledTimes(1);
    const written = mocks.writeUpdateProgressMarkerMock.mock
      .calls[0][1] as HostUpdateProgress;
    expect(written.state).toBe("updating");
    expect(written.targetVersion).toBe("1.2.0");
    expect(
      mocks.deleteUpdateProgressMarkerIfUnchangedMock,
    ).toHaveBeenCalledWith("production", written);
    // Falsification: drop the HOST_BUSY arm in the catch (fall through to
    // the generic failure branch) and this goes red - `replace…` would be
    // called with a `failed` record instead.
    expect(mocks.replaceUpdateProgressMarkerMock).not.toHaveBeenCalled();
    expect(mocks.probeHostHealthMock).not.toHaveBeenCalled();
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
  });
});
