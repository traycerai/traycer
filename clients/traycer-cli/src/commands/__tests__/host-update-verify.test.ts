import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `buildHostUpdateVerifyCommand` is deliberately thin (see host-update-verify.ts's
// module comment) - the executor-facing claim lives entirely in
// `host/update-verify.ts` (covered exhaustively by
// `host/__tests__/update-verify.test.ts`, which drives the REAL executor
// machinery). This file's only job is the wrapper: does it forward
// ctx.runtime.environment + args to `verifyHostUpdateAttempt`, and does it
// build the right `CommandResult` (data / human / exitCode) from whatever
// report comes back. Mocking `verifyHostUpdateAttempt` here (while keeping
// the real `humanForVerifyReport`) is the correct boundary for that - this
// suite is not re-proving the executor arms, only the plumbing on top of
// them.
const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("../../host/update-verify", async () => {
  const actual = await vi.importActual<
    typeof import("../../host/update-verify")
  >("../../host/update-verify");
  return { ...actual, verifyHostUpdateAttempt: mocks.verify };
});

import { buildHostUpdateVerifyCommand } from "../host-update-verify";
import {
  humanForVerifyReport,
  type HostUpdateVerifyArgs,
  type HostUpdateVerifyReport,
} from "../../host/update-verify";
import type { CommandContext } from "../../runner/runner";

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

const args: HostUpdateVerifyArgs = {
  attemptId: "attempt-1",
  generation: 1,
  sequence: 1,
  targetVersion: "1.2.3",
};

// One representative of each of the four `HostUpdateVerifyReport` arms - the
// same four the underlying executor's `ExecutorSegmentOutcome` collapses
// onto in `host/update-verify.ts`'s `reportFor`.
const reports: readonly [string, HostUpdateVerifyReport][] = [
  [
    "resumed",
    {
      outcome: "resumed",
      continuation: "activate",
      // The PARKED identity recovery handed back, not the one this call
      // was invoked with - see `HostUpdateVerifyReport`.
      attemptId: "attempt-1",
      generation: 2,
      sequence: 5,
    },
  ],
  ["complete", { outcome: "complete" }],
  ["failed", { outcome: "failed", reason: "recovery-evidence-contradiction" }],
  ["indeterminate", { outcome: "indeterminate", reason: "cohort-disabled" }],
];

describe("buildHostUpdateVerifyCommand", () => {
  beforeEach(() => {
    mocks.verify.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(reports)(
    // The source comment is explicit about WHY: a non-zero exit would let a
    // status-only reader conflate `failed` (a real terminal verdict) with
    // `indeterminate` (no verdict at all). Pinned per-arm, not just for the
    // happy path, since that is exactly the distinction a single
    // happy-path-only test would miss.
    "exitCode stays 0 for the %s arm - a non-zero exit would let a status-only reader conflate failed with indeterminate",
    async (_name, report) => {
      mocks.verify.mockResolvedValue(report);
      const result = await buildHostUpdateVerifyCommand(args)(fakeCtx());
      expect(result.exitCode).toBe(0);
    },
  );

  it.each(reports)(
    "data is the exact report object and human is exactly humanForVerifyReport's output for the %s arm",
    async (_name, report) => {
      mocks.verify.mockResolvedValue(report);
      const result = await buildHostUpdateVerifyCommand(args)(fakeCtx());
      expect(result.data).toBe(report);
      expect(result.human).toBe(humanForVerifyReport(report));
    },
  );

  it("forwards ctx.runtime.environment and the command's args to verifyHostUpdateAttempt unchanged", async () => {
    mocks.verify.mockResolvedValue({ outcome: "complete" });
    const ctx = fakeCtx();
    await buildHostUpdateVerifyCommand(args)(ctx);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(mocks.verify).toHaveBeenCalledWith(ctx.runtime.environment, args);
  });

  it("logs start and completion through ctx.runtime.logger, including the resolved outcome", async () => {
    mocks.verify.mockResolvedValue({ outcome: "failed", reason: "some-code" });
    const ctx = fakeCtx();
    await buildHostUpdateVerifyCommand(args)(ctx);
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update-verify command started",
      expect.objectContaining({ attemptId: args.attemptId }),
    );
    expect(ctx.runtime.logger.info).toHaveBeenCalledWith(
      "Host update-verify command completed",
      expect.objectContaining({ outcome: "failed" }),
    );
  });
});
