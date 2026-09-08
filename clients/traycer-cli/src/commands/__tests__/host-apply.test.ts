import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyHostOutcome } from "../../installer/apply";

// `host apply`'s success contract: exit 0 means the staged bytes COMMITTED,
// not that the host is running them. `activation` reports what happened to
// the service afterwards, without ever claiming health - see the naming note
// on `activationOf` in `../host-apply.ts`.

const mocks = vi.hoisted(() => ({
  outcome: null as ApplyHostOutcome | null,
  applyHostCalls: 0,
  readHostHeldVersionMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
}));

vi.mock("../../installer/apply", () => ({
  applyHost: async () => {
    mocks.applyHostCalls += 1;
    if (mocks.outcome === null) throw new Error("test outcome not set");
    return mocks.outcome;
  },
}));

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(_opts: unknown, fn: () => Promise<T>): Promise<T> =>
      fn(),
  };
});

// Finding 3 (cold review): the `respectHold` gate reads the held/installed
// versions itself, under the CLI mutation lock - mocked directly here rather
// than through a real-fs fixture, since this suite is about the COMMAND's
// wiring of that check, not the readers' own tolerance (that's
// `held-host-version.test.ts`).
vi.mock("@traycer/protocol/config/installation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@traycer/protocol/config/installation")
    >();
  return {
    ...actual,
    readHostHeldVersion: (
      ...callArgs: Parameters<typeof mocks.readHostHeldVersionMock>
    ) => mocks.readHostHeldVersionMock(...callArgs),
  };
});

vi.mock("../../manifest/host-install", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../manifest/host-install")>();
  return {
    ...actual,
    readHostInstallRecord: (
      ...callArgs: Parameters<typeof mocks.readHostInstallRecordMock>
    ) => mocks.readHostInstallRecordMock(...callArgs),
  };
});

import { buildHostApplyCommand } from "../host-apply";
import type { CommandContext } from "../../runner/runner";
import type { HostInstallRecord } from "../../manifest/host-install";

function record(version: string, installId: string): HostInstallRecord {
  return {
    installId,
    version,
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: "/tmp/traycer-host",
    executableSha256: null,
  };
}

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: true,
      environment: "production",
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    },
    output: {
      progress: () => undefined,
      human: () => undefined,
      humanRequired: () => undefined,
      emitResult: () => undefined,
      emitError: () => undefined,
    },
    progress: () => undefined,
  };
}

function runApply(
  outcome: ApplyHostOutcome,
  overrides: { readonly respectHold?: boolean },
): Promise<{
  readonly data: unknown;
  readonly human: string | null;
  readonly exitCode: number;
}> {
  mocks.outcome = outcome;
  return buildHostApplyCommand({
    force: false,
    noService: false,
    expectedStageFingerprint: null,
    respectHold: overrides.respectHold ?? false,
    attemptAdoption: null,
  })(fakeCtx());
}

beforeEach(() => {
  mocks.applyHostCalls = 0;
  mocks.readHostHeldVersionMock.mockReset().mockResolvedValue(null);
  mocks.readHostInstallRecordMock.mockReset().mockResolvedValue(null);
});

describe("host apply - activation", () => {
  // "requested", not "converged": `runningActivated` only means the post-swap
  // start returned, and `launchctl kickstart` returns as soon as launchd
  // ACCEPTS the request - an unspawnable job answers success. Calling this
  // `converged: true` published a health claim nothing here ever checked.
  it("is 'requested' when the post-swap start was accepted - never a health claim", async () => {
    const result = await runApply(
      {
        outcome: "applied",
        record: record("1.3.0", "install-test"),
        previous: record("1.2.0", "install-test"),
        runningActivated: true,
        installGeneration: "gen-1",
        serviceLifecycle: {
          priorServiceState: "running",
          stoppedBeforeSwap: true,
          postSwapAction: "restart",
        },
        postSwapError: null,
      },
      {},
    );

    expect(result.data).toMatchObject({
      outcome: "applied",
      activation: "requested",
    });
    expect(result.exitCode).toBe(0);
  });

  // The whole reason this command stays exit 0: a post-swap service failure is
  // a committed apply that did not converge, and Desktop reads exactly this
  // envelope. The field - and the human line - have to say so unmistakably,
  // because the exit code cannot.
  it("is 'failed', at exit 0, when the swap committed but the service did not come back", async () => {
    const result = await runApply(
      {
        outcome: "applied",
        record: record("1.3.0", "install-test"),
        previous: record("1.2.0", "install-test"),
        runningActivated: false,
        installGeneration: "gen-1",
        serviceLifecycle: {
          priorServiceState: "running",
          stoppedBeforeSwap: true,
          postSwapAction: "restart",
        },
        postSwapError: "launchctl kickstart failed",
      },
      {},
    );

    expect(result.data).toMatchObject({
      outcome: "applied",
      activation: "failed",
    });
    expect(result.exitCode).toBe(0);
    // Reports the ACTIVATION, never liveness. "the host is NOT running" was
    // the prose making the claim `activation` had just stopped making - and it
    // can be flatly wrong, since a host nobody managed to stop keeps serving
    // the old bytes.
    expect(result.human ?? "").toContain("start/restart request failed");
    expect(result.human ?? "").toContain("liveness was not checked");
    expect(result.human ?? "").toContain("traycer host status");
    expect(result.human ?? "").toContain("traycer host doctor");
    expect(result.human ?? "").not.toContain("NOT running");
  });

  // Committed, but nothing was started: `--no-service`, or the Desktop-managed
  // macOS path whose `afterSwap` deliberately sets `postSwapAction: "none"` and
  // leaves activation to Desktop's next SMAppService register cycle. Distinct
  // from "failed" - nothing went wrong, the start simply belongs to someone
  // else - and an operator who cannot tell them apart will go looking for a
  // fault that does not exist.
  it("is 'not-attempted' when the swap committed but no start was run", async () => {
    const result = await runApply(
      {
        outcome: "applied",
        record: record("1.3.0", "install-test"),
        previous: record("1.2.0", "install-test"),
        runningActivated: false,
        installGeneration: "gen-1",
        serviceLifecycle: {
          priorServiceState: "externally-managed",
          stoppedBeforeSwap: false,
          postSwapAction: "none",
        },
        postSwapError: null,
      },
      {},
    );

    expect(result.data).toMatchObject({
      outcome: "applied",
      activation: "not-attempted",
    });
    expect(result.exitCode).toBe(0);
    // Same rule: no start ran, which says nothing about what is serving. A
    // bytes-only swap under a host nobody stopped leaves that host alive.
    expect(result.human ?? "").toContain("no start was run");
    expect(result.human ?? "").toContain("traycer host status");
    expect(result.human ?? "").not.toContain("NOT running");
  });

  // A no-op commits nothing and never probes the running host, so `failed`
  // here would report a healthy, already-running install as broken on
  // evidence the command does not have.
  it("is null for a no-op, which never probes the running host", async () => {
    const result = await runApply(
      {
        outcome: "no-op",
        installedVersion: "1.3.0",
      },
      {},
    );

    expect(result.data).toMatchObject({ outcome: "no-op", activation: null });
    expect(result.exitCode).toBe(0);
  });

  it("is null for a stage-fingerprint mismatch, which commits nothing", async () => {
    const result = await runApply(
      {
        outcome: "stage-fingerprint-mismatch",
        installedVersion: "1.3.0",
        expectedStageFingerprint: "expected",
        actualStageFingerprint: "actual",
      },
      {},
    );

    expect(result.data).toMatchObject({
      outcome: "stage-fingerprint-mismatch",
      activation: null,
    });
  });
});

// Finding 3 (cold review): the authoritative `respectHold` check made HERE,
// under the CLI mutation lock, rather than trusting the desktop's earlier
// preflight - a terminal downgrade that set the hold while a launch apply
// was staging is serialized behind this same lock, so the read below always
// reflects the freshest committed state. installId-bound: the gate matches
// on the install INSTANCE, not the version string, so a reinstall of the
// same version (a fresh `installId`) is never mistaken for the held one.
describe("host apply - respectHold", () => {
  it("respectHold:true + installed.installId===held.installId short-circuits to a no-op without ever calling applyHost", async () => {
    mocks.readHostHeldVersionMock.mockResolvedValue({
      version: "1.2.0",
      installId: "install-held",
    });
    mocks.readHostInstallRecordMock.mockResolvedValue(
      record("1.2.0", "install-held"),
    );

    const result = await runApply(
      { outcome: "no-op", installedVersion: "1.2.0" },
      { respectHold: true },
    );

    expect(result.data).toMatchObject({
      outcome: "no-op",
      installedVersion: "1.2.0",
    });
    expect(mocks.applyHostCalls).toBe(0);
  });

  it("respectHold:true + same version but a DIFFERENT installId (a reinstall of the held version) applies normally", async () => {
    mocks.readHostHeldVersionMock.mockResolvedValue({
      version: "1.2.0",
      installId: "install-held",
    });
    mocks.readHostInstallRecordMock.mockResolvedValue(
      record("1.2.0", "install-fresh"),
    );

    const result = await runApply(
      {
        outcome: "applied",
        record: record("1.3.0", "install-test"),
        previous: record("1.2.0", "install-test"),
        runningActivated: true,
        installGeneration: "gen-1",
        serviceLifecycle: {
          priorServiceState: "running",
          stoppedBeforeSwap: true,
          postSwapAction: "restart",
        },
        postSwapError: null,
      },
      { respectHold: true },
    );

    expect(result.data).toMatchObject({ outcome: "applied" });
    expect(mocks.applyHostCalls).toBe(1);
  });

  it("respectHold:true + installed!==held (different version and installId) applies normally", async () => {
    mocks.readHostHeldVersionMock.mockResolvedValue({
      version: "1.0.0",
      installId: "install-old",
    });
    mocks.readHostInstallRecordMock.mockResolvedValue(
      record("1.2.0", "install-current"),
    );

    const result = await runApply(
      {
        outcome: "applied",
        record: record("1.3.0", "install-test"),
        previous: record("1.2.0", "install-test"),
        runningActivated: true,
        installGeneration: "gen-1",
        serviceLifecycle: {
          priorServiceState: "running",
          stoppedBeforeSwap: true,
          postSwapAction: "restart",
        },
        postSwapError: null,
      },
      { respectHold: true },
    );

    expect(result.data).toMatchObject({ outcome: "applied" });
    expect(mocks.applyHostCalls).toBe(1);
  });

  it("respectHold:true + nothing held applies normally (never reads the install record)", async () => {
    mocks.readHostHeldVersionMock.mockResolvedValue(null);

    const result = await runApply(
      {
        outcome: "applied",
        record: record("1.3.0", "install-test"),
        previous: record("1.2.0", "install-test"),
        runningActivated: true,
        installGeneration: "gen-1",
        serviceLifecycle: {
          priorServiceState: "running",
          stoppedBeforeSwap: true,
          postSwapAction: "restart",
        },
        postSwapError: null,
      },
      { respectHold: true },
    );

    expect(result.data).toMatchObject({ outcome: "applied" });
    expect(mocks.applyHostCalls).toBe(1);
    expect(mocks.readHostInstallRecordMock).not.toHaveBeenCalled();
  });

  it("respectHold:false applies normally even though the installed version is held (explicit apply always wins)", async () => {
    mocks.readHostHeldVersionMock.mockResolvedValue({
      version: "1.2.0",
      installId: "install-held",
    });
    mocks.readHostInstallRecordMock.mockResolvedValue(
      record("1.2.0", "install-held"),
    );

    const result = await runApply(
      {
        outcome: "applied",
        record: record("1.3.0", "install-test"),
        previous: record("1.2.0", "install-test"),
        runningActivated: true,
        installGeneration: "gen-1",
        serviceLifecycle: {
          priorServiceState: "running",
          stoppedBeforeSwap: true,
          postSwapAction: "restart",
        },
        postSwapError: null,
      },
      { respectHold: false },
    );

    expect(result.data).toMatchObject({ outcome: "applied" });
    expect(mocks.applyHostCalls).toBe(1);
    // `respectHold: false` never consults the hold at all - not even to read it.
    expect(mocks.readHostHeldVersionMock).not.toHaveBeenCalled();
  });

  // Final hold model: an apply never writes the hold record at all - it is
  // always a FORWARD move (the stage is only ever newer than the install),
  // which the write-once/no-delete design treats as inert purely via the
  // consulting gate (`held !== installed`) once the install moves forward.
  // There is nothing to clear, so `respectHold` above is this command's
  // ONLY hold interaction; no test here asserts a write/clear side effect.
});
