import { describe, expect, it, vi } from "vitest";
import type { ApplyHostOutcome } from "../../installer/apply";

// `host apply`'s success contract: exit 0 means the staged bytes COMMITTED,
// not that the host is running them. `activation` reports what happened to
// the service afterwards, without ever claiming health - see the naming note
// on `activationOf` in `../host-apply.ts`.

const mocks = vi.hoisted(() => ({
  outcome: null as ApplyHostOutcome | null,
}));

vi.mock("../../installer/apply", () => ({
  applyHost: async () => {
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

import { buildHostApplyCommand } from "../host-apply";
import type { CommandContext } from "../../runner/runner";
import type { HostInstallRecord } from "../../manifest/host-install";

function record(version: string): HostInstallRecord {
  return {
    installId: "install-test",
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

function runApply(outcome: ApplyHostOutcome): Promise<{
  readonly data: unknown;
  readonly human: string | null;
  readonly exitCode: number;
}> {
  mocks.outcome = outcome;
  return buildHostApplyCommand({
    force: false,
    noService: false,
    expectedStageFingerprint: null,
    attemptAdoption: null,
  })(fakeCtx());
}

describe("host apply - activation", () => {
  // "requested", not "converged": `runningActivated` only means the post-swap
  // start returned, and `launchctl kickstart` returns as soon as launchd
  // ACCEPTS the request - an unspawnable job answers success. Calling this
  // `converged: true` published a health claim nothing here ever checked.
  it("is 'requested' when the post-swap start was accepted - never a health claim", async () => {
    const result = await runApply({
      outcome: "applied",
      record: record("1.3.0"),
      previous: record("1.2.0"),
      runningActivated: true,
      installGeneration: "gen-1",
      serviceLifecycle: {
        priorServiceState: "running",
        stoppedBeforeSwap: true,
        postSwapAction: "restart",
      },
      postSwapError: null,
    });

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
    const result = await runApply({
      outcome: "applied",
      record: record("1.3.0"),
      previous: record("1.2.0"),
      runningActivated: false,
      installGeneration: "gen-1",
      serviceLifecycle: {
        priorServiceState: "running",
        stoppedBeforeSwap: true,
        postSwapAction: "restart",
      },
      postSwapError: "launchctl kickstart failed",
    });

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
    const result = await runApply({
      outcome: "applied",
      record: record("1.3.0"),
      previous: record("1.2.0"),
      runningActivated: false,
      installGeneration: "gen-1",
      serviceLifecycle: {
        priorServiceState: "externally-managed",
        stoppedBeforeSwap: false,
        postSwapAction: "none",
      },
      postSwapError: null,
    });

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
    const result = await runApply({
      outcome: "no-op",
      installedVersion: "1.3.0",
    });

    expect(result.data).toMatchObject({ outcome: "no-op", activation: null });
    expect(result.exitCode).toBe(0);
  });

  it("is null for a stage-fingerprint mismatch, which commits nothing", async () => {
    const result = await runApply({
      outcome: "stage-fingerprint-mismatch",
      installedVersion: "1.3.0",
      expectedStageFingerprint: "expected",
      actualStageFingerprint: "actual",
    });

    expect(result.data).toMatchObject({
      outcome: "stage-fingerprint-mismatch",
      activation: null,
    });
  });
});
