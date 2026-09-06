import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// SANDBOXED HOST HOME. This suite keeps the REAL ACK module - that is its
// whole point - and the cutover gave `host update` a failure-ACK path, so its
// intentional plan error now reaches the real writer. Unsandboxed, the
// positive control below wrote the developer's own
// `~/.traycer/host/update-dispatch-ack.json` (observed once, with nonce
// `nonce-abcdefgh` and reason `refused-unexpected`). The pid-metadata mock
// does not isolate a WRITE; only the paths do.
const currentHome = { value: "" };
vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  const nodePath = await import("node:path");
  const { mkdirSync, mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const fallbackRoot = mkdtempSync(nodePath.join(os.tmpdir(), "ack-guard-"));
  const home = (): string =>
    currentHome.value === "" ? fallbackRoot : currentHome.value;
  return {
    ...actual,
    hostHomeDir: (): string => home(),
    hostInstallDir: (): string => nodePath.join(home(), "install"),
    hostInstallRecordPath: (): string =>
      nodePath.join(home(), "install", "install.json"),
    hostStagedDir: (): string => nodePath.join(home(), "staged"),
    hostPidMetadataPath: (): string => nodePath.join(home(), "pid.json"),
    hostUpdateProgressMarkerPath: (): string =>
      nodePath.join(home(), "update-progress.json"),
    cliLogPath: (): string => {
      const dir = nodePath.join(home(), "logs");
      mkdirSync(dir, { recursive: true });
      return nodePath.join(dir, "cli.log");
    },
    cliLockPath: (): string => {
      const dir = nodePath.join(home(), "cli");
      mkdirSync(dir, { recursive: true });
      return nodePath.join(dir, ".lock");
    },
  };
});

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

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeUpdateDispatchAck,
  updateDispatchAckPath,
} from "@traycer/protocol/config/host-update-ack";
import { buildHostUpdateCommand } from "../host-update";
import type { CommandContext } from "../../runner/runner";

const roots: string[] = [];

/** The ACK this run published, read back through the shared decoder. */
async function ackResult(): Promise<unknown> {
  const decoded = decodeUpdateDispatchAck(
    await readFile(updateDispatchAckPath(currentHome.value), "utf8"),
  );
  expect(decoded.kind).toBe("valid");
  if (decoded.kind !== "valid") throw new Error("unreachable");
  return decoded.ack.result;
}

/** Nothing at all was published - the path is empty. */
async function ackIsAbsent(): Promise<boolean> {
  return readFile(updateDispatchAckPath(currentHome.value), "utf8").then(
    () => false,
    () => true,
  );
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

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "ack-guard-test-"));
  roots.push(root);
  currentHome.value = join(root, "host-home");
  await mkdir(currentHome.value, { recursive: true });
});

afterEach(async () => {
  vi.resetAllMocks();
  currentHome.value = "";
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
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
    // And nothing was published: a nonce this build rejects cannot be one the
    // resolver minted, so there is no correlation left to answer.
    expect(await ackIsAbsent()).toBe(true);
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
    // The failure ACK lands IN THE SANDBOX. Before the paths were sandboxed
    // this exact assertion's write went to the operator's real host home.
    expect(await ackResult()).toEqual({
      kind: "no-attempt",
      reason: "refused-unexpected",
    });
  });
});

// The `--intent` / `--expect-attempt` PAIRING (Plan D16). Commander rejects
// UNKNOWN options - which is the whole point of putting the intent on argv,
// so a pre-cutover parser exits before any body runs (pinned in
// `src/__tests__/cli-host-update-bound-intent.test.ts`) - but it has nothing
// to say about two options that are only meaningful together. That rule, and
// the legal-value check, therefore live in this command body, which is the
// only place that can report them as a CLI error a caller can read.
describe("buildHostUpdateCommand — the bound-intent pairing is refused, and still answers its dispatcher", () => {
  it("refuses an --intent value outside the bound-intent union, before the plan", async () => {
    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: null,
      ackNonce: "nonce-abcdefgh",
      // `install` is a real intent inside `update-run.ts`, but it is not a
      // BOUND one: it is what the absence of the option means.
      intent: "install",
      expectAttempt: "attempt-1",
    });

    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_INVALID_ARGUMENT",
    });
    expect(mocks.resolveUpdatePlanMock).not.toHaveBeenCalled();
    // A run dispatched with a nonce must ANSWER, even when what it was asked
    // to do is unusable. The refusal used to be thrown before the stamper
    // existed, leaving the dispatching host to time out for no reason.
    expect(await ackResult()).toEqual({
      kind: "no-attempt",
      reason: "refused-e-invalid-argument",
    });
  });

  it("refuses --intent with no --expect-attempt: an authorization with no subject", async () => {
    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: null,
      ackNonce: "nonce-abcdefgh",
      intent: "activate",
      expectAttempt: null,
    });

    // Running it as a plain install would be exactly the broader
    // authorization the argv contract exists to prevent.
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_INVALID_ARGUMENT",
    });
    expect(mocks.resolveUpdatePlanMock).not.toHaveBeenCalled();
    // A run dispatched with a nonce must ANSWER, even when what it was asked
    // to do is unusable. The refusal used to be thrown before the stamper
    // existed, leaving the dispatching host to time out for no reason.
    expect(await ackResult()).toEqual({
      kind: "no-attempt",
      reason: "refused-e-invalid-argument",
    });
  });

  it("refuses --expect-attempt with no --intent", async () => {
    const command = buildHostUpdateCommand({
      force: false,
      allowDowngrade: false,
      versionRequest: null,
      ackNonce: "nonce-abcdefgh",
      intent: null,
      expectAttempt: "attempt-1",
    });

    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_INVALID_ARGUMENT",
    });
    expect(mocks.resolveUpdatePlanMock).not.toHaveBeenCalled();
    // A run dispatched with a nonce must ANSWER, even when what it was asked
    // to do is unusable. The refusal used to be thrown before the stamper
    // existed, leaving the dispatching host to time out for no reason.
    expect(await ackResult()).toEqual({
      kind: "no-attempt",
      reason: "refused-e-invalid-argument",
    });
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
