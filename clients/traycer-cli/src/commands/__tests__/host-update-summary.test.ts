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
  startedStoppedHost: boolean,
): HostUpdateRunOutcome {
  return {
    legacy: { ...BASE_LEGACY, previousVersion, serviceLifecycle },
    releasedReason: null,
    foreignRuntimeVersion: null,
    runningVersion: "2.0.0",
    startedStoppedHost,
  };
}

beforeEach(() => {
  mocks.runHostUpdateMock.mockReset();
});

const RESTART: LegacyHostUpdateServiceLifecycle = {
  priorServiceState: "stopped",
  stoppedBeforeSwap: false,
  postSwapAction: "restart",
  postSwapError: null,
};

describe("buildHostUpdateCommand — humanSummary", () => {
  it("a run that started a stopped host reports that, not a no-op", async () => {
    mocks.runHostUpdateMock.mockResolvedValue(outcome("2.0.0", RESTART, true));
    const command = buildHostUpdateCommand(baseArgs());

    const result = await command(fakeCtx());

    expect(result.human).toBe(
      "started host 2.0.0; it was installed but not running",
    );
  });

  it("the same run with a postSwapError says the start was ATTEMPTED - a failed restart may have left no host running", async () => {
    mocks.runHostUpdateMock.mockResolvedValue(
      outcome("2.0.0", { ...RESTART, postSwapError: "boom" }, true),
    );
    const command = buildHostUpdateCommand(baseArgs());

    const result = await command(fakeCtx());

    expect(result.human).toBe(
      "attempted to start host 2.0.0 (it was installed but not running); service did not converge: boom",
    );
  });

  // The discriminator is the run's own fact, not `previousVersion === version`:
  // a live host publishing the catalog version under a record whose runtime
  // stamp differs is debt with equal versions too, and that run REPLACED a
  // running host (traycer#2208 review).
  it("a restart of a LIVE host onto the same version string is reported as a restart, never as a start", async () => {
    mocks.runHostUpdateMock.mockResolvedValue(outcome("2.0.0", RESTART, false));
    const command = buildHostUpdateCommand(baseArgs());

    const result = await command(fakeCtx());

    expect(result.human).toBe("restarted host 2.0.0 onto the installed build");
  });

  it("the same live-host restart with a postSwapError reports the attempt and the error", async () => {
    mocks.runHostUpdateMock.mockResolvedValue(
      outcome("2.0.0", { ...RESTART, postSwapError: "boom" }, false),
    );
    const command = buildHostUpdateCommand(baseArgs());

    const result = await command(fakeCtx());

    expect(result.human).toBe(
      "attempted to restart host 2.0.0 onto the installed build; service did not converge: boom",
    );
  });

  it("postSwapAction: none with equal versions stays the plain no-op sentence (unchanged)", async () => {
    mocks.runHostUpdateMock.mockResolvedValue(
      outcome("2.0.0", { ...RESTART, postSwapAction: "none" }, false),
    );
    const command = buildHostUpdateCommand(baseArgs());

    const result = await command(fakeCtx());

    expect(result.human).toBe("host already at 2.0.0 (no-op)");
  });

  it("a restart with a genuine version change reports the ordinary update sentence", async () => {
    mocks.runHostUpdateMock.mockResolvedValue(outcome("1.9.0", RESTART, false));
    const command = buildHostUpdateCommand(baseArgs());

    const result = await command(fakeCtx());

    expect(result.human).toBe("updated host 1.9.0 → 2.0.0");
  });

  it("logs 'Host update command completed' with postSwapAction and startedStoppedHost", async () => {
    mocks.runHostUpdateMock.mockResolvedValue(outcome("2.0.0", RESTART, true));
    const command = buildHostUpdateCommand(baseArgs());
    const ctx = fakeCtx();

    await command(ctx);

    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update command completed",
      expect.objectContaining({
        postSwapAction: "restart",
        startedStoppedHost: true,
      }),
    );
  });
});
