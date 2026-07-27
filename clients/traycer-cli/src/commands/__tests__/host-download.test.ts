import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  downloadAndStageHostMock: vi.fn(),
}));

vi.mock("../../installer/download-stage", () => ({
  downloadAndStageHost: mocks.downloadAndStageHostMock,
}));

import { buildHostDownloadCommand } from "../host-download";
import type { CommandContext } from "../../runner/runner";
import type { HostDownloadOutcome } from "../../installer/download-stage";

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

describe("buildHostDownloadCommand", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("forwards the version request and automatic flag", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "promoted",
      stagedVersion: "1.5.0",
      installedVersion: "1.0.0",
    } satisfies HostDownloadOutcome);
    const command = buildHostDownloadCommand({
      versionRequest: "1.5.0",
      automatic: true,
    });
    await command(fakeCtx());
    expect(mocks.downloadAndStageHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: "production",
        versionRequest: "1.5.0",
        automatic: true,
        registryClient: null,
      }),
    );
  });

  it("defaults versionRequest to null (latest) when omitted", async () => {
    mocks.downloadAndStageHostMock.mockResolvedValue({
      outcome: "short-circuit",
      reason: "installed-up-to-date",
      targetVersion: "1.0.0",
      installedVersion: "1.0.0",
      stagedVersion: null,
    } satisfies HostDownloadOutcome);
    const command = buildHostDownloadCommand({
      versionRequest: null,
      automatic: false,
    });
    await command(fakeCtx());
    expect(mocks.downloadAndStageHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ versionRequest: null, automatic: false }),
    );
  });

  const humanCases: Array<{
    readonly outcome: HostDownloadOutcome;
    readonly expected: string;
  }> = [
    {
      outcome: {
        outcome: "short-circuit",
        reason: "installed-up-to-date",
        targetVersion: "1.0.0",
        installedVersion: "1.0.0",
        stagedVersion: null,
      },
      expected: "host already at 1.0.0 (no-op)",
    },
    {
      outcome: {
        outcome: "short-circuit",
        reason: "already-staged",
        targetVersion: "1.5.0",
        installedVersion: "1.0.0",
        stagedVersion: "1.5.0",
      },
      expected: "host 1.5.0 already staged (no-op)",
    },
    {
      outcome: {
        outcome: "short-circuit",
        reason: "automatic-refused-incomparable-installed",
        targetVersion: "1.5.0",
        installedVersion: "local-abc",
        stagedVersion: null,
      },
      expected:
        "automatic download refused: installed version local-abc is not comparable to the registry",
    },
    {
      outcome: {
        outcome: "discarded",
        reason: "install-record-vanished",
        targetVersion: "1.5.0",
      },
      expected:
        "discarded download 1.5.0: host was uninstalled during download",
    },
    {
      outcome: {
        outcome: "discarded",
        reason: "not-strictly-newer",
        targetVersion: "1.2.0",
      },
      expected:
        "discarded download 1.2.0: no longer newer than the current install/stage",
    },
    {
      outcome: {
        outcome: "promoted",
        stagedVersion: "1.5.0",
        installedVersion: "1.0.0",
      },
      expected: "staged host 1.5.0 (installed: 1.0.0)",
    },
  ];

  it.each(humanCases)(
    "renders human summary for $outcome.outcome/$outcome.reason",
    async ({ outcome, expected }) => {
      mocks.downloadAndStageHostMock.mockResolvedValue(outcome);
      const command = buildHostDownloadCommand({
        versionRequest: null,
        automatic: false,
      });
      const result = await command(fakeCtx());
      expect(result.human).toBe(expected);
      expect(result.data).toEqual(outcome);
      expect(result.exitCode).toBe(0);
    },
  );
});
