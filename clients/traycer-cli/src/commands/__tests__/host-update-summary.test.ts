import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type {
  HostUpdateRunOutcome,
  LegacyHostUpdateResult,
  LegacyHostUpdateServiceLifecycle,
} from "../../host/update-run";

// `buildHostUpdateCommand`'s `humanSummary` (host-update.ts): the
// 2026-09-27 staging outage produced a run that RESTARTED a stopped host
// onto bytes already installed (`previousVersion === version`, because no
// running version existed to compare against) while the command printed
// "host already at ... (no-op)" - true of the bytes, false of the machine,
// and read by the operator as "nothing happened" while the host it had just
// started was still booting. This file mocks `runHostUpdate` directly (kept
// real via `importOriginal` for everything else) so it can drive
// `humanSummary` with crafted outcomes without touching the advisory plan,
// the dispatch-ACK stamper, or any real host-home I/O - those are covered by
// the other `host-update-*.test.ts` files.

const mocks = vi.hoisted(() => ({
  runHostUpdateMock: vi.fn(),
}));

vi.mock("../../host/update-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../host/update-run")>();
  return { ...actual, runHostUpdate: mocks.runHostUpdateMock };
});

import { buildHostUpdateCommand, type HostUpdateArgs } from "../host-update";

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

function baseArgs(): HostUpdateArgs {
  return {
    force: false,
    allowDowngrade: false,
    acceptStoreFormatLoss: false,
    versionRequest: null,
    ackNonce: null,
    intent: null,
    expectAttempt: null,
    expectGeneration: null,
    expectSequence: null,
  };
}

const BASE_LEGACY: LegacyHostUpdateResult = {
  version: "2.0.0",
  installedAt: "2026-01-01T00:00:00.000Z",
  executablePath: "/tmp/traycer-host/host",
  source: { kind: "registry", value: "2.0.0" },
  archiveSha256: null,
  signatureKeyId: "test-key",
  sizeBytes: 1,
  previousVersion: "2.0.0",
  serviceLifecycle: {
    priorServiceState: "stopped",
    stoppedBeforeSwap: false,
    postSwapAction: "none",
    postSwapError: null,
  },
};

function outcome(
  previousVersion: string | null,
  serviceLifecycle: LegacyHostUpdateServiceLifecycle,
): HostUpdateRunOutcome {
  return {
    legacy: { ...BASE_LEGACY, previousVersion, serviceLifecycle },
    releasedReason: null,
    foreignRuntimeVersion: null,
    runningVersion: "2.0.0",
  };
}

beforeEach(() => {
  mocks.runHostUpdateMock.mockReset();
});

describe("buildHostUpdateCommand — humanSummary", () => {
  it("a restart with previousVersion === version and no postSwapError reports the host as started, not a no-op", async () => {
    mocks.runHostUpdateMock.mockResolvedValue(
      outcome("2.0.0", {
        priorServiceState: "stopped",
        stoppedBeforeSwap: false,
        postSwapAction: "restart",
        postSwapError: null,
      }),
    );
    const command = buildHostUpdateCommand(baseArgs());

    const result = await command(fakeCtx());

    expect(result.human).toBe(
      "started host 2.0.0; it was installed but not running",
    );
  });

  it("the same restart with a postSwapError reports the converge-failure variant", async () => {
    mocks.runHostUpdateMock.mockResolvedValue(
      outcome("2.0.0", {
        priorServiceState: "stopped",
        stoppedBeforeSwap: false,
        postSwapAction: "restart",
        postSwapError: "boom",
      }),
    );
    const command = buildHostUpdateCommand(baseArgs());

    const result = await command(fakeCtx());

    expect(result.human).toBe(
      "started host 2.0.0 (it was installed but not running); service did not converge: boom",
    );
  });

  it("postSwapAction: none with equal versions stays the plain no-op sentence (unchanged)", async () => {
    mocks.runHostUpdateMock.mockResolvedValue(
      outcome("2.0.0", {
        priorServiceState: "stopped",
        stoppedBeforeSwap: false,
        postSwapAction: "none",
        postSwapError: null,
      }),
    );
    const command = buildHostUpdateCommand(baseArgs());

    const result = await command(fakeCtx());

    expect(result.human).toBe("host already at 2.0.0 (no-op)");
  });

  it("a restart with a genuine version change reports the ordinary update sentence", async () => {
    mocks.runHostUpdateMock.mockResolvedValue(
      outcome("1.9.0", {
        priorServiceState: "stopped",
        stoppedBeforeSwap: false,
        postSwapAction: "restart",
        postSwapError: null,
      }),
    );
    const command = buildHostUpdateCommand(baseArgs());

    const result = await command(fakeCtx());

    expect(result.human).toBe("updated host 1.9.0 → 2.0.0");
  });

  it("logs 'Host update command completed' with postSwapAction", async () => {
    mocks.runHostUpdateMock.mockResolvedValue(
      outcome("2.0.0", {
        priorServiceState: "stopped",
        stoppedBeforeSwap: false,
        postSwapAction: "restart",
        postSwapError: null,
      }),
    );
    const command = buildHostUpdateCommand(baseArgs());
    const ctx = fakeCtx();

    await command(ctx);

    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update command completed",
      expect.objectContaining({ postSwapAction: "restart" }),
    );
  });
});
