import { describe, expect, it, vi } from "vitest";
import type { ApplyHostOutcome } from "../../installer/apply";

// `host apply`'s success contract: exit 0 means the staged bytes COMMITTED,
// not that the host is running them. `converged` is the flag that separates
// the two without re-deriving it from three fields - see `../host-apply.ts`.

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
  })(fakeCtx());
}

describe("host apply - converged", () => {
  it("is true only when the committed bytes are confirmed running", async () => {
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

    expect(result.data).toMatchObject({ outcome: "applied", converged: true });
    expect(result.exitCode).toBe(0);
  });

  // The whole reason this command stays exit 0: a post-swap service failure is
  // a committed apply that did not converge, and Desktop reads exactly this
  // envelope. The flag - and the human line - have to say so unmistakably,
  // because the exit code cannot.
  it("is false, at exit 0, when the swap committed but the service did not come back", async () => {
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

    expect(result.data).toMatchObject({ outcome: "applied", converged: false });
    expect(result.exitCode).toBe(0);
    expect(result.human ?? "").toContain("NOT running");
    expect(result.human ?? "").toContain("traycer host doctor");
  });

  // A no-op commits nothing and never probes the running host, so `false`
  // here would report a healthy, already-running install as unconverged on
  // evidence the command does not have. Three states, because there are three.
  it("is null for a no-op, which never probes the running host", async () => {
    const result = await runApply({
      outcome: "no-op",
      installedVersion: "1.3.0",
    });

    expect(result.data).toMatchObject({ outcome: "no-op", converged: null });
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
      converged: null,
    });
  });
});
