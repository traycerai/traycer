import { afterEach, describe, expect, it, vi } from "vitest";

// `host update` calls `installDispatchAckStamper` as its FIRST action, before
// the advisory plan reads anything and long before any transfer. A run
// dispatched with a nonce this build cannot honour has already lost the
// correlation its caller is waiting on, and discovering that after staging
// bytes would mean doing destructive work for a dispatch that can only ever
// report indeterminate.
//
// Post-cutover the run is `host/update-run.ts` and the first thing after the
// stamper is `resolveUpdatePlan`, so that is the call these two suites stop
// at - the same boundary `downloadAndStageHost` marked before the cutover.
//
// This suite uses the REAL `../host/update-dispatch-ack` module (unmocked) —
// the claim under test is that an illegal nonce is refused by the actual
// validator before any destructive work runs, not merely that some mock was
// called. `host-update-dispatch-ack-wiring.test.ts` covers the wiring itself
// (that the nonce reaches the installer at all) with the module mocked.

const mocks = vi.hoisted(() => ({
  resolveUpdatePlanMock: vi.fn(),
}));

vi.mock("../../installer/download-stage", () => ({
  resolveUpdatePlan: mocks.resolveUpdatePlanMock,
  downloadAndStageHostInSegment: vi.fn(),
}));

// SAFETY: `host update` probes the REAL `~/.traycer/host/pid.json` for
// activation debt, and an unmocked read on a developer machine could classify
// the developer's live host as debt and restart it. Every test that invokes
// the command mocks the probe to "no running host".
vi.mock("../../host/pid-metadata", () => ({
  readHostPidMetadata: vi.fn(async () => null),
}));

import { buildHostUpdateCommand } from "../host-update";
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

afterEach(() => {
  vi.resetAllMocks();
});

describe("buildHostUpdateCommand — illegal ack nonce refuses before anything is written", () => {
  it("rejects on an illegal nonce and never resolves an update plan", async () => {
    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: null,
      // Too short and outside the legal charset for
      // `isValidUpdateDispatchAckNonce` (`^[A-Za-z0-9_-]{8,128}$`).
      ackNonce: "bad",
      intent: null,
      expectAttempt: null,
    });

    await expect(command(fakeCtx())).rejects.toThrow(
      "update dispatch ack nonce is not a legal nonce",
    );
    // BOTH halves matter: rejecting after staging would mean destructive work
    // for a dispatch that can only ever report indeterminate.
    expect(mocks.resolveUpdatePlanMock).not.toHaveBeenCalled();
  });

  it("positive control — a legal nonce proceeds to the advisory plan", async () => {
    // Proves the guard above is discriminating on the nonce's legality and
    // not on some other property of the run (e.g. it would fail regardless).
    mocks.resolveUpdatePlanMock.mockRejectedValue(
      new Error("stopped after the plan call was observed"),
    );
    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: null,
      ackNonce: "nonce-abcdefgh",
      intent: null,
      expectAttempt: null,
    });

    await expect(command(fakeCtx())).rejects.toThrow(
      "stopped after the plan call was observed",
    );
    expect(mocks.resolveUpdatePlanMock).toHaveBeenCalledTimes(1);
  });
});

// The `--intent` / `--expect-attempt` PAIRING (Plan D16). Commander rejects
// UNKNOWN options - which is the whole point of putting the intent on argv,
// so a pre-cutover parser exits before any body runs (pinned in
// `src/__tests__/cli-host-update-bound-intent.test.ts`) - but it has nothing
// to say about two options that are only meaningful together. That rule, and
// the legal-value check, therefore live in this command body, which is the
// only place that can report them as a CLI error a caller can read.
describe("buildHostUpdateCommand — the bound-intent pairing is refused in the body", () => {
  it("refuses an --intent value outside the bound-intent union, before the plan", async () => {
    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: null,
      ackNonce: null,
      // `install` is a real intent inside `update-run.ts`, but it is not a
      // BOUND one: it is what the absence of the option means.
      intent: "install",
      expectAttempt: "attempt-1",
    });

    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_INVALID_ARGUMENT",
    });
    expect(mocks.resolveUpdatePlanMock).not.toHaveBeenCalled();
  });

  it("refuses --intent with no --expect-attempt: an authorization with no subject", async () => {
    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: null,
      ackNonce: null,
      intent: "activate",
      expectAttempt: null,
    });

    // Running it as a plain install would be exactly the broader
    // authorization the argv contract exists to prevent.
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_INVALID_ARGUMENT",
    });
    expect(mocks.resolveUpdatePlanMock).not.toHaveBeenCalled();
  });

  it("refuses --expect-attempt with no --intent", async () => {
    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: null,
      ackNonce: null,
      intent: null,
      expectAttempt: "attempt-1",
    });

    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_INVALID_ARGUMENT",
    });
    expect(mocks.resolveUpdatePlanMock).not.toHaveBeenCalled();
  });

  it("positive control — a legal pair proceeds to the advisory plan", async () => {
    mocks.resolveUpdatePlanMock.mockRejectedValue(
      new Error("stopped after the plan call was observed"),
    );
    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: "2.0.0",
      ackNonce: null,
      intent: "continue",
      expectAttempt: "attempt-1",
    });

    await expect(command(fakeCtx())).rejects.toThrow(
      "stopped after the plan call was observed",
    );
    expect(mocks.resolveUpdatePlanMock).toHaveBeenCalledTimes(1);
  });
});
