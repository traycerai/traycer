import { afterEach, describe, expect, it, vi } from "vitest";

// `host update` installs the dispatch-ack stamper via
// `installDispatchAckStamper(hostHomeDir(environment), args.ackNonce)` as its
// first action. `host-update-dispatch-ack-guard.test.ts`
// proves the REAL validator refuses an illegal nonce before anything is
// written; this suite proves the WIRING itself — that the command actually
// calls the installer, with the nonce it was given (or `null` when it was
// not) — with the module mocked so the assertion is on the call, not on the
// validator's own behaviour.
//
// Must go RED if the call to `installDispatchAckStamper` is removed from
// `buildHostUpdateCommand`.

// SANDBOXED HOST HOME. The stamper module is mocked here, so nothing in the
// happy path writes - but the plan mock is what stops the run, and a future
// edit that lets it return instead of throwing would put a real attempt lock
// and a real attempt record in the operator's own host home. The paths, not
// the module mocks, are what decide where a write lands, and `hostHomeDir` is
// also the value this suite ASSERTS the stamper was called with - so it must
// be the sandboxed one on both sides.
vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  const nodePath = await import("node:path");
  const { mkdirSync, mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const home = mkdtempSync(nodePath.join(os.tmpdir(), "ack-wiring-"));
  const under = (...parts: readonly string[]): string => {
    const path = nodePath.join(home, ...parts);
    mkdirSync(nodePath.dirname(path), { recursive: true });
    return path;
  };
  return {
    ...actual,
    hostHomeDir: (): string => home,
    hostInstallDir: (): string => nodePath.join(home, "install"),
    hostInstallRecordPath: (): string =>
      nodePath.join(home, "install", "install.json"),
    hostStagedDir: (): string => nodePath.join(home, "staged"),
    hostPidMetadataPath: (): string => nodePath.join(home, "pid.json"),
    hostUpdateProgressMarkerPath: (): string =>
      nodePath.join(home, "update-progress.json"),
    cliLogPath: (): string => under("logs", "cli.log"),
    cliLockPath: (): string => under("cli", ".lock"),
  };
});

const mocks = vi.hoisted(() => ({
  resolveUpdatePlanMock: vi.fn(),
  installDispatchAckStamperMock: vi.fn(),
}));

vi.mock("../../installer/download-stage", () => ({
  resolveUpdatePlan: mocks.resolveUpdatePlanMock,
  downloadAndStageHostInSegment: vi.fn(),
}));

vi.mock("../../host/update-dispatch-ack", () => ({
  installDispatchAckStamper: mocks.installDispatchAckStamperMock,
}));

// SAFETY: `host update` probes the REAL `~/.traycer/host/pid.json` for
// activation debt, and an unmocked read on a developer machine could classify
// the developer's live host as debt and restart it. Every test that invokes
// the command mocks the probe to "no running host".
vi.mock("../../host/pid-metadata", () => ({
  readHostPidMetadata: vi.fn(async () => null),
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
    mocks.resolveUpdatePlanMock.mockRejectedValue(
      new Error("stopped after the stamper install was observed"),
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
    mocks.resolveUpdatePlanMock.mockRejectedValue(
      new Error("stopped after the stamper install was observed"),
    );
    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: null,
      ackNonce: null,
      intent: null,
      expectAttempt: null,
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
