import { afterEach, describe, expect, it, vi } from "vitest";

// Ticket 07 §5.2.8 — `buildHostUpdateCommand` installs the dispatch-ack
// stamper via `installDispatchAckStamper(hostHomeDir(environment),
// args.ackNonce)` as its first action. `host-update-dispatch-ack-guard.test.ts`
// proves the REAL validator refuses an illegal nonce before anything is
// written; this suite proves the WIRING itself — that the command actually
// calls the installer, with the nonce it was given (or `null` when it was
// not) — with the module mocked so the assertion is on the call, not on the
// validator's own behaviour.
//
// Must go RED if the call to `installDispatchAckStamper` is removed from
// `buildHostUpdateCommand`.

const mocks = vi.hoisted(() => ({
  downloadAndStageHostMock: vi.fn(),
  installDispatchAckStamperMock: vi.fn(),
}));

vi.mock("../../installer/download-stage", () => ({
  downloadAndStageHost: mocks.downloadAndStageHostMock,
}));

vi.mock("../../host/update-dispatch-ack", () => ({
  installDispatchAckStamper: mocks.installDispatchAckStamperMock,
}));

import { buildHostUpdateCommand } from "../host-update";
import { hostHomeDir } from "../../store/paths";
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

describe("buildHostUpdateCommand — dispatch ACK stamper is installed as the FIRST action", () => {
  it("is called with the caller's nonce", async () => {
    mocks.installDispatchAckStamperMock.mockReturnValue(null);
    mocks.downloadAndStageHostMock.mockRejectedValue(
      new Error("stopped after the stamper install was observed"),
    );
    const command = buildHostUpdateCommand({
      force: false,
      versionRequest: null,
      ackNonce: "nonce-abcdefgh",
    });

    await expect(command(fakeCtx())).rejects.toThrow(
      "stopped after the stamper install was observed",
    );
    expect(mocks.installDispatchAckStamperMock).toHaveBeenCalledWith(
      hostHomeDir("production"),
      "nonce-abcdefgh",
    );
  });

  // Negative control, load-bearing rather than decorative: a command hard-
  // coded to always pass some fixed nonce (or to never forward `null`) would
  // satisfy the assertion above while breaking every ordinary un-dispatched
  // run.
  it("is called with null when no nonce was passed", async () => {
    mocks.installDispatchAckStamperMock.mockReturnValue(null);
    mocks.downloadAndStageHostMock.mockRejectedValue(
      new Error("stopped after the stamper install was observed"),
    );
    const command = buildHostUpdateCommand({
      force: false,
      versionRequest: null,
      ackNonce: null,
    });

    await expect(command(fakeCtx())).rejects.toThrow(
      "stopped after the stamper install was observed",
    );
    expect(mocks.installDispatchAckStamperMock).toHaveBeenCalledWith(
      hostHomeDir("production"),
      null,
    );
  });
});
