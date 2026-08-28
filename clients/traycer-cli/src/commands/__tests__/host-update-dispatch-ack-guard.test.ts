import { afterEach, describe, expect, it, vi } from "vitest";

// Ticket 07 §5.2.8 — `buildHostUpdateCommand` calls `installDispatchAckStamper`
// as its FIRST action, before `downloadAndStageHost` writes anything. A run
// dispatched with a nonce this build cannot honour has already lost the
// correlation its caller is waiting on, and discovering that after staging
// bytes would mean doing destructive work for a dispatch that can only ever
// report indeterminate.
//
// This suite uses the REAL `../host/update-dispatch-ack` module (unmocked) —
// the claim under test is that an illegal nonce is refused by the actual
// validator before any destructive work runs, not merely that some mock was
// called. `host-update-dispatch-ack-wiring.test.ts` covers the wiring itself
// (that the nonce reaches the installer at all) with the module mocked.

const mocks = vi.hoisted(() => ({
  downloadAndStageHostMock: vi.fn(),
}));

vi.mock("../../installer/download-stage", () => ({
  downloadAndStageHost: mocks.downloadAndStageHostMock,
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
  it("rejects on an illegal nonce and never calls downloadAndStageHost", async () => {
    const command = buildHostUpdateCommand({
      force: false,
      versionRequest: null,
      // Too short and outside the legal charset for
      // `isValidUpdateDispatchAckNonce` (`^[A-Za-z0-9_-]{8,128}$`).
      ackNonce: "bad",
    });

    await expect(command(fakeCtx())).rejects.toThrow(
      "update dispatch ack nonce is not a legal nonce",
    );
    // BOTH halves matter: rejecting after staging would mean destructive work
    // for a dispatch that can only ever report indeterminate.
    expect(mocks.downloadAndStageHostMock).not.toHaveBeenCalled();
  });

  it("positive control — a legal nonce proceeds to downloadAndStageHost", async () => {
    // Proves the guard above is discriminating on the nonce's legality and
    // not on some other property of the run (e.g. it would fail regardless).
    mocks.downloadAndStageHostMock.mockRejectedValue(
      new Error("stopped after the download call was observed"),
    );
    const command = buildHostUpdateCommand({
      force: false,
      versionRequest: null,
      ackNonce: "nonce-abcdefgh",
    });

    await expect(command(fakeCtx())).rejects.toThrow(
      "stopped after the download call was observed",
    );
    expect(mocks.downloadAndStageHostMock).toHaveBeenCalledTimes(1);
  });
});
