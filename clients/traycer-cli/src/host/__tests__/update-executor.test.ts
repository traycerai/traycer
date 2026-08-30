import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireUpdateAttemptLock,
  commitAttemptMutation,
  readUpdateAttemptRecord,
  updateAttemptRecordPath,
  type AttemptCommitOutcome,
  type AttemptRecoveryEvidence,
  type HostUpdateAttemptIdentity,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import { commitExecutorAttemptMutation } from "@traycer-clients/shared/host-update/contender";

// The CLI's rollout fence (`decideUpdateExecutorCohort`) is intentionally
// static release policy with NO shipped enable seam (see
// `update-executor-cohort.test.ts`). To exercise the real
// `dispatchAttemptExecutor`/`runAttemptExecutorSegment` control flow past
// that gate, this file mocks the cohort module at ITS OWN test-file
// boundary only - never a shipped setter, never an exported `__internal`
// bypass on the production module itself. The mock defaults to the REAL
// `decideUpdateExecutorCohort` (always shadow) so a dedicated,
// deliberately-unmocked-in-spirit describe block below can still assert the
// production default with zero side effects; individual tests override to
// `eligible` with `mockReturnValueOnce`/`mockImplementation` only where they
// need to reach past the gate.
const cohortMock = vi.hoisted(() => ({ decide: vi.fn() }));
vi.mock("../update-executor-cohort", async () => {
  const actual = await vi.importActual<
    typeof import("../update-executor-cohort")
  >("../update-executor-cohort");
  cohortMock.decide.mockImplementation(actual.decideUpdateExecutorCohort);
  return { ...actual, decideUpdateExecutorCohort: cohortMock.decide };
});

// The module-private terminal verifier (behind `completeLocalAttemptExecutorSegment`)
// calls the REAL `observeAttemptRecoveryEvidence`, which itself calls the
// real `store/paths.hostHomeDir` to enforce its foreign-home guard. Every
// OTHER test in this file passes an explicit `contender.hostHomeDir` and
// never reaches that guard, so this sandboxing is scoped to just the
// terminal-write tests below - same convention as
// `update-recovery-evidence.test.ts`, but pinned directly to each test's own
// `freshHome()` result (via `currentHome`) rather than derived from
// `os.homedir()`, since this file's fixture directories are ordinary tmpdirs
// with no fixed relationship to the real home.
const currentHome = { value: "" };
vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  // Imported inside the factory: `vi.mock` factories are hoisted above this
  // file's own top-level imports, so those bindings are not yet initialized.
  const nodePath = await import("node:path");
  const { mkdirSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const fallbackCliLockRoot = mkdtempSync(
    nodePath.join(tmpdir(), "traycer-cli-lock-"),
  );
  const hostHomeFor = (): string => currentHome.value;
  return {
    ...actual,
    hostHomeDir: () => hostHomeFor(),
    hostInstallDir: () => join(hostHomeFor(), "install"),
    hostInstallRecordPath: () => join(hostHomeFor(), "install", "install.json"),
    hostStagedDir: () => join(hostHomeFor(), "staged"),
    hostStagedRecordPath: () => join(hostHomeFor(), "staged", "staged.json"),
    hostPidMetadataPath: () => join(hostHomeFor(), "pid.json"),
    // The terminal-completion path takes the INNER CLI lock with `waitMs: 0`.
    // Left real, that is `~/.traycer/cli/.lock` - the operator's actual
    // product lock. The cold review hit exactly that: the suite failed
    // `CLI_LOCK_BUSY` against a live local `host-update-verify` holder, and
    // while it ran it blocked the user's own CLI.
    //
    // Sandboxing it is not merely de-flaking. A test that takes real machine
    // state can BREAK the machine - the same class as the stale suite that
    // once wrote under the operator's real host install path.
    //
    // Self-sufficient on purpose: most tests in this file never set
    // `currentHome`, so a naive `join(hostHomeFor(), ...)` yields the RELATIVE
    // path `cli/.lock` and fails ENOENT. The fallback root keeps every test
    // isolated whether or not it staged a home, and the directory is created
    // on demand because the lock opens with `wx` and will not mkdir for us.
    cliLockPath: (): string => {
      const root =
        currentHome.value === ""
          ? fallbackCliLockRoot
          : nodePath.join(currentHome.value, "cli");
      mkdirSync(root, { recursive: true });
      return nodePath.join(root, ".lock");
    },
  };
});
const rpcMocks = vi.hoisted(() => ({
  identityVerdict: vi.fn(),
  callHostRpc: vi.fn(),
}));
vi.mock("../../store/process-identity", () => ({
  getPublishedProcessIdentityVerdict: rpcMocks.identityVerdict,
}));
vi.mock("../../internal/host-rpc", () => ({
  callHostRpcAtEndpoint: rpcMocks.callHostRpc,
}));

import {
  NO_UPDATE_EXECUTOR_FAULTS,
  dispatchAttemptExecutor,
  runAttemptExecutorSegment,
  runLocalAttemptExecutorSegment,
  type DispatchAttemptExecutorOptions,
  type ExecutorClaimOutcome,
  type ExecutorPrivateAcknowledgement,
  type RunAttemptExecutorClaimOptions,
  type SpawnedAttemptExecutor,
  type UpdateExecutorFaults,
} from "../update-executor";
import {
  decodeUpdateDispatchAck,
  updateDispatchAckPath,
} from "@traycer/protocol/config/host-update-ack";
import { stampUpdateDispatchAck } from "../update-dispatch-ack";
import { writeHostInstallRecord } from "../../manifest/host-install";
import * as paths from "../../store/paths";
import type { AttemptRecoveryEvidenceObservation } from "../update-recovery-evidence";

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "update-executor-test-"));
  roots.push(root);
  return join(root, "host-home");
}

function observation(
  evidence: AttemptRecoveryEvidence,
): AttemptRecoveryEvidenceObservation {
  // A test-only surrogate fingerprint: it only needs to be a pure function
  // of the evidence content so `sameAttemptRecoveryEvidenceObservation`
  // (real fingerprint string equality) reacts correctly to a changed vs.
  // unchanged evidence object between two injected reads.
  return { evidence, fingerprint: JSON.stringify(evidence) };
}

beforeEach(async () => {
  // Reset the cohort mock back to the REAL implementation before every
  // test, not just clear call history - `mockClear()` alone would leak a
  // prior test's `mockCohortEligible("linux")` override forward, since that uses
  // `mockImplementation`, which `mockClear()` does not touch.
  const actualCohort = await vi.importActual<
    typeof import("../update-executor-cohort")
  >("../update-executor-cohort");
  cohortMock.decide.mockReset();
  cohortMock.decide.mockImplementation(actualCohort.decideUpdateExecutorCohort);
  rpcMocks.identityVerdict.mockReset();
  rpcMocks.callHostRpc.mockReset();
  currentHome.value = "";
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function mockCohortEligible(platform: "linux" | "win32"): void {
  cohortMock.decide.mockImplementation((requested: string) =>
    requested === platform
      ? { kind: "eligible", platform }
      : { kind: "shadow", reason: "disabled" },
  );
}

// ---- dispatchAttemptExecutor -------------------------------------------------
//
// The parent/child dispatch boundary: the parent reports "accepted" only
// after a private nonce-matched acknowledgement of the child's DURABLE claim.
// Every ambiguous outcome (spawn failure, missing ACK, wrong nonce, exit,
// timeout) reconciles canonical state exactly once and never spawns a
// second child.

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function dispatchOptions(
  overrides: Partial<DispatchAttemptExecutorOptions>,
): DispatchAttemptExecutorOptions {
  return {
    platform: "linux",
    nonce: "nonce-1",
    spawn: () => Promise.reject(new Error("spawn not configured")),
    reconcile: () => Promise.resolve(null),
    acknowledgementTimeoutMs: 30_000,
    waitForAcknowledgementTimeout: () => neverSettles<void>(),
    faults: NO_UPDATE_EXECUTOR_FAULTS,
    ...overrides,
  };
}

function claimedOutcome(): Extract<ExecutorClaimOutcome, { kind: "claimed" }> {
  return {
    kind: "claimed",
    identity: { attemptId: "attempt-1", generation: 1, sequence: 1 },
    record: {
      schemaVersion: 2,
      attemptId: "attempt-1",
      generation: 1,
      sequence: 1,
      trigger: "manual",
      targetVersion: "1.2.3",
      phase: "downloading",
      execution: "active",
      continuation: null,
      progress: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      error: null,
    },
    continuation: null,
  };
}

function childWithAck(
  ack: () => Promise<ExecutorPrivateAcknowledgement | null>,
): SpawnedAttemptExecutor {
  return {
    waitForPrivateAcknowledgement: ack,
    waitForExit: () => neverSettles<void>(),
  };
}

describe("dispatchAttemptExecutor - cohort gate is derived internally, never caller-supplied", () => {
  it("returns disabled without spawning while the cohort is shadow (the production default)", async () => {
    let spawnCalls = 0;
    const outcome = await dispatchAttemptExecutor(
      dispatchOptions({
        spawn: () => {
          spawnCalls += 1;
          return Promise.reject(new Error("must not be called"));
        },
      }),
    );
    expect(outcome).toEqual({ kind: "disabled" });
    expect(spawnCalls).toBe(0);
  });

  it("stays disabled for darwin even when linux/win32 are eligible - platform, not caller intent, decides eligibility", async () => {
    mockCohortEligible("linux");
    let spawnCalls = 0;
    const outcome = await dispatchAttemptExecutor(
      dispatchOptions({
        platform: "darwin",
        spawn: () => {
          spawnCalls += 1;
          return Promise.reject(new Error("must not be called"));
        },
      }),
    );
    expect(outcome).toEqual({ kind: "disabled" });
    expect(spawnCalls).toBe(0);
  });

  it("does not accept a caller-supplied eligibility object - only a HostInstallPlatform string", () => {
    // `DispatchAttemptExecutorOptions.platform` is typed as
    // `HostInstallPlatform`, not `UpdateExecutorCohortVerdict`: a caller
    // cannot hand in a pre-built `{ kind: "eligible", ... }` verdict to opt
    // around the internal `decideUpdateExecutorCohort` gate. Pinned as a
    // compile error rather than a runtime check, since there is no runtime
    // value to assert against once the parameter type disallows it.
    const attemptSelfIssuedEligibility = (): DispatchAttemptExecutorOptions =>
      dispatchOptions({
        // @ts-expect-error platform must be a HostInstallPlatform, not a verdict object
        platform: { kind: "eligible", platform: "linux" },
      });
    void attemptSelfIssuedEligibility;
    expect(true).toBe(true);
  });
});

describe("decideUpdateExecutorCohort - static shadow-only production default, unmocked in this describe block", () => {
  it.each(["darwin", "win32", "linux"] as const)(
    "dispatchAttemptExecutor stays disabled for %s with zero spawn/reconcile side effects against the real (beforeEach-reset) implementation",
    async (platform) => {
      let spawnCalls = 0;
      let reconcileCalls = 0;
      const outcome = await dispatchAttemptExecutor(
        dispatchOptions({
          platform,
          spawn: () => {
            spawnCalls += 1;
            return Promise.reject(new Error("must not be called"));
          },
          reconcile: () => {
            reconcileCalls += 1;
            return Promise.resolve(null);
          },
        }),
      );
      expect(outcome).toEqual({ kind: "disabled" });
      expect(spawnCalls).toBe(0);
      expect(reconcileCalls).toBe(0);
    },
  );
});

describe("dispatchAttemptExecutor - reconciles exactly once, never double-spawns", () => {
  it("reconciles when spawn itself throws", async () => {
    mockCohortEligible("linux");
    let spawnCalls = 0;
    let reconcileCalls = 0;
    const canonical = claimedOutcome().record;
    const outcome = await dispatchAttemptExecutor(
      dispatchOptions({
        spawn: () => {
          spawnCalls += 1;
          return Promise.reject(new Error("spawn failed"));
        },
        reconcile: () => {
          reconcileCalls += 1;
          return Promise.resolve(canonical);
        },
      }),
    );
    expect(outcome).toEqual({ kind: "indeterminate", canonical });
    expect(spawnCalls).toBe(1);
    expect(reconcileCalls).toBe(1);
  });

  it("reconciles when waiting for the private acknowledgement throws", async () => {
    mockCohortEligible("linux");
    let spawnCalls = 0;
    let reconcileCalls = 0;
    const child = childWithAck(() =>
      Promise.reject(new Error("ack channel broke")),
    );
    const outcome = await dispatchAttemptExecutor(
      dispatchOptions({
        spawn: () => {
          spawnCalls += 1;
          return Promise.resolve(child);
        },
        reconcile: () => {
          reconcileCalls += 1;
          return Promise.resolve(null);
        },
      }),
    );
    expect(outcome).toEqual({ kind: "indeterminate", canonical: null });
    expect(spawnCalls).toBe(1);
    expect(reconcileCalls).toBe(1);
  });

  it("reconciles when the acknowledgement is null (no private ACK received)", async () => {
    mockCohortEligible("linux");
    let reconcileCalls = 0;
    const child = childWithAck(() => Promise.resolve(null));
    const outcome = await dispatchAttemptExecutor(
      dispatchOptions({
        spawn: () => Promise.resolve(child),
        reconcile: () => {
          reconcileCalls += 1;
          return Promise.resolve(null);
        },
      }),
    );
    expect(outcome).toEqual({ kind: "indeterminate", canonical: null });
    expect(reconcileCalls).toBe(1);
  });

  it("reconciles when the acknowledgement carries the WRONG nonce - never trusts a mismatched proof", async () => {
    mockCohortEligible("linux");
    let reconcileCalls = 0;
    const ack: ExecutorPrivateAcknowledgement = {
      nonce: "someone-elses-nonce",
      outcome: claimedOutcome(),
    };
    const child = childWithAck(() => Promise.resolve(ack));
    const outcome = await dispatchAttemptExecutor(
      dispatchOptions({
        nonce: "expected-nonce",
        spawn: () => Promise.resolve(child),
        reconcile: () => {
          reconcileCalls += 1;
          return Promise.resolve(null);
        },
      }),
    );
    expect(outcome).toEqual({ kind: "indeterminate", canonical: null });
    expect(reconcileCalls).toBe(1);
  });

  it("hits the before-dispatch-spawn fault exactly once before spawning", async () => {
    mockCohortEligible("linux");
    const hits: string[] = [];
    const faults: UpdateExecutorFaults = {
      hit: async (point) => {
        hits.push(point);
      },
    };
    let spawnCalls = 0;
    await dispatchAttemptExecutor(
      dispatchOptions({
        faults,
        spawn: () => {
          spawnCalls += 1;
          expect(hits).toEqual(["before-dispatch-spawn"]);
          return Promise.reject(new Error("stop here"));
        },
        reconcile: () => Promise.resolve(null),
      }),
    );
    expect(spawnCalls).toBe(1);
    expect(hits).toEqual(["before-dispatch-spawn"]);
  });

  it("reconciles exactly once, without a second spawn, when a fault fires after spawn but before waiting for the ACK", async () => {
    mockCohortEligible("linux");
    let spawnCalls = 0;
    let waitForAckCalls = 0;
    let reconcileCalls = 0;
    const canonical = claimedOutcome().record;
    const faults: UpdateExecutorFaults = {
      hit: async (point) => {
        if (point === "after-dispatch-spawn-before-ack") {
          throw new Error("injected post-spawn fault");
        }
      },
    };
    const child = childWithAck(() => {
      waitForAckCalls += 1;
      return Promise.resolve({ nonce: "n1", outcome: claimedOutcome() });
    });

    const outcome = await dispatchAttemptExecutor(
      dispatchOptions({
        nonce: "n1",
        faults,
        spawn: () => {
          spawnCalls += 1;
          return Promise.resolve(child);
        },
        reconcile: () => {
          reconcileCalls += 1;
          return Promise.resolve(canonical);
        },
      }),
    );

    expect(outcome).toEqual({ kind: "indeterminate", canonical });
    expect(spawnCalls).toBe(1);
    // The fault fires before the child is ever asked to wait for its ACK -
    // the point is that a post-spawn crash reconciles rather than blocking
    // on (or trusting) a channel it never actually opened.
    expect(waitForAckCalls).toBe(0);
    expect(reconcileCalls).toBe(1);
  });
});

describe("dispatchAttemptExecutor - the ACK/exit/timeout race, exactly one reconcile, no second spawn", () => {
  it("reconciles once when the child EXITS before ever sending a private ACK", async () => {
    mockCohortEligible("linux");
    let reconcileCalls = 0;
    const canonical = claimedOutcome().record;
    const child: SpawnedAttemptExecutor = {
      waitForPrivateAcknowledgement: () => neverSettles(),
      waitForExit: () => Promise.resolve(),
    };
    const outcome = await dispatchAttemptExecutor(
      dispatchOptions({
        spawn: () => Promise.resolve(child),
        reconcile: () => {
          reconcileCalls += 1;
          return Promise.resolve(canonical);
        },
      }),
    );
    expect(outcome).toEqual({ kind: "indeterminate", canonical });
    expect(reconcileCalls).toBe(1);
  });

  it("reconciles once when the bounded ACK wait TIMES OUT before any ACK or exit", async () => {
    mockCohortEligible("linux");
    let reconcileCalls = 0;
    let timeoutCalls = 0;
    const canonical = claimedOutcome().record;
    const child: SpawnedAttemptExecutor = {
      waitForPrivateAcknowledgement: () => neverSettles(),
      waitForExit: () => neverSettles(),
    };
    const outcome = await dispatchAttemptExecutor(
      dispatchOptions({
        acknowledgementTimeoutMs: 5_000,
        waitForAcknowledgementTimeout: (ms) => {
          timeoutCalls += 1;
          expect(ms).toBe(5_000);
          return Promise.resolve();
        },
        spawn: () => Promise.resolve(child),
        reconcile: () => {
          reconcileCalls += 1;
          return Promise.resolve(canonical);
        },
      }),
    );
    expect(outcome).toEqual({ kind: "indeterminate", canonical });
    expect(timeoutCalls).toBe(1);
    expect(reconcileCalls).toBe(1);
  });

  it("never spawns a second child after an exit/timeout reconcile - dispatch itself is called exactly once per race", async () => {
    mockCohortEligible("linux");
    let spawnCalls = 0;
    let reconcileCalls = 0;
    const child: SpawnedAttemptExecutor = {
      waitForPrivateAcknowledgement: () => neverSettles(),
      waitForExit: () => Promise.resolve(),
    };
    await dispatchAttemptExecutor(
      dispatchOptions({
        spawn: () => {
          spawnCalls += 1;
          return Promise.resolve(child);
        },
        reconcile: () => {
          reconcileCalls += 1;
          return Promise.resolve(null);
        },
      }),
    );
    expect(spawnCalls).toBe(1);
    expect(reconcileCalls).toBe(1);
  });

  it("a positively matched private ACK wins the race even with exit/timeout still pending, and never reconciles", async () => {
    mockCohortEligible("linux");
    let reconcileCalls = 0;
    const claim = claimedOutcome();
    const ack: ExecutorPrivateAcknowledgement = { nonce: "n1", outcome: claim };
    const child: SpawnedAttemptExecutor = {
      waitForPrivateAcknowledgement: () => Promise.resolve(ack),
      // Left permanently pending - the ACK must win without waiting on these.
      waitForExit: () => neverSettles(),
    };
    const outcome = await dispatchAttemptExecutor(
      dispatchOptions({
        nonce: "n1",
        waitForAcknowledgementTimeout: () => neverSettles(),
        spawn: () => Promise.resolve(child),
        reconcile: () => {
          reconcileCalls += 1;
          return Promise.resolve(null);
        },
      }),
    );
    expect(outcome).toEqual({ kind: "accepted", claim });
    expect(reconcileCalls).toBe(0);
  });
});

describe("dispatchAttemptExecutor - a positively matched private ACK is trusted without reconciling", () => {
  it("reports accepted for a claimed outcome with the matching nonce, and never calls reconcile", async () => {
    mockCohortEligible("linux");
    let reconcileCalls = 0;
    const claim = claimedOutcome();
    const ack: ExecutorPrivateAcknowledgement = { nonce: "n1", outcome: claim };
    const child = childWithAck(() => Promise.resolve(ack));
    const outcome = await dispatchAttemptExecutor(
      dispatchOptions({
        nonce: "n1",
        spawn: () => Promise.resolve(child),
        reconcile: () => {
          reconcileCalls += 1;
          return Promise.resolve(null);
        },
      }),
    );
    expect(outcome).toEqual({ kind: "accepted", claim });
    expect(reconcileCalls).toBe(0);
  });

  it("reports terminalized for a matching-nonce terminal ACK, and never calls reconcile", async () => {
    mockCohortEligible("linux");
    let reconcileCalls = 0;
    const terminalOutcome: Extract<
      ExecutorClaimOutcome,
      { kind: "terminalized" }
    > = {
      kind: "terminalized",
      identity: { attemptId: "attempt-1", generation: 2, sequence: 4 },
      record: claimedOutcome().record,
      outcome: "failed",
    };
    const ack: ExecutorPrivateAcknowledgement = {
      nonce: "n1",
      outcome: terminalOutcome,
    };
    const child = childWithAck(() => Promise.resolve(ack));
    const outcome = await dispatchAttemptExecutor(
      dispatchOptions({
        nonce: "n1",
        spawn: () => Promise.resolve(child),
        reconcile: () => {
          reconcileCalls += 1;
          return Promise.resolve(null);
        },
      }),
    );
    expect(outcome).toEqual({ kind: "terminalized", outcome: terminalOutcome });
    expect(reconcileCalls).toBe(0);
  });

  it("reports rejected for a matching-nonce rejected ACK, and never calls reconcile", async () => {
    mockCohortEligible("linux");
    let reconcileCalls = 0;
    const rejectedOutcome: Extract<ExecutorClaimOutcome, { kind: "rejected" }> =
      { kind: "rejected", reason: "stale-expectation", observed: null };
    const ack: ExecutorPrivateAcknowledgement = {
      nonce: "n1",
      outcome: rejectedOutcome,
    };
    const child = childWithAck(() => Promise.resolve(ack));
    const outcome = await dispatchAttemptExecutor(
      dispatchOptions({
        nonce: "n1",
        spawn: () => Promise.resolve(child),
        reconcile: () => {
          reconcileCalls += 1;
          return Promise.resolve(null);
        },
      }),
    );
    expect(outcome).toEqual({ kind: "rejected", outcome: rejectedOutcome });
    expect(reconcileCalls).toBe(0);
  });
});

// ---- runAttemptExecutorSegment - private ACK ordering ------------------------
//
// The only API that hands a capability to execution work. `acknowledge` is
// the private positive-ACK boundary and MUST run only after the claim has
// durably committed, and `execute` must never run before `acknowledge` has
// completed. There is deliberately no claim-only exported API: the two
// removed functions below no longer exist, so any exported path that could
// hand back a "claimed" identity without also having run `acknowledge`
// synchronously inside this same held capability is gone at compile time.

describe("runAttemptExecutorSegment - no exported claim-only path exists; ACK cannot outlive the capability", () => {
  it("the removed runAttemptExecutorClaim/runLocalAttemptExecutorClaim exports are absent from the module - compile-time proof, not a runtime check", async () => {
    const moduleExports: Record<string, unknown> =
      await import("../update-executor");
    expect("runAttemptExecutorClaim" in moduleExports).toBe(false);
    expect("runLocalAttemptExecutorClaim" in moduleExports).toBe(false);
    // The raw terminal writer is also module-private. There is no exported
    // free function that performs a terminal write at all anymore - the
    // ONLY way to reach one is the zero-argument `complete` closure handed
    // to `execute()` inside `runAttemptExecutorSegment`/
    // `runLocalAttemptExecutorSegment` themselves.
    expect("completeAttemptExecutorSegment" in moduleExports).toBe(false);
    expect("completeLocalAttemptExecutorSegment" in moduleExports).toBe(false);
    expect("completeCliVerifiedExecutorSegment" in moduleExports).toBe(false);
  });
});

function claimOptions(
  hostHomeDir: string,
  overrides: Partial<RunAttemptExecutorClaimOptions>,
): RunAttemptExecutorClaimOptions {
  return {
    platform: "linux",
    contender: {
      environment: "production",
      hostHomeDir,
      reason: "update-executor-test",
      waitMs: 0,
      pollIntervalMs: 10,
    },
    request: {
      targetVersion: "1.2.3",
      trigger: "manual",
      action: "start",
      expected: null,
      newAttemptId: "attempt-1",
      initialPhase: "downloading",
    },
    readRecoveryEvidence: () =>
      Promise.reject(new Error("recovery evidence not configured")),
    nowIso: () => "2026-01-01T00:00:00.000Z",
    faults: NO_UPDATE_EXECUTOR_FAULTS,
    ...overrides,
  };
}

describe("runAttemptExecutorSegment - does not accept a caller-supplied eligibility object", () => {
  it("types `platform` as HostInstallPlatform, not a pre-built cohort verdict", () => {
    const attemptSelfIssuedEligibility = (): RunAttemptExecutorClaimOptions =>
      claimOptions("/tmp/does-not-matter", {
        // @ts-expect-error platform must be a HostInstallPlatform, not a verdict object
        platform: { kind: "eligible", platform: "linux" },
      });
    void attemptSelfIssuedEligibility;
    expect(true).toBe(true);
  });
});

describe("runAttemptExecutorSegment - acknowledge runs before execute, and only after a durable claim", () => {
  it("calls acknowledge before execute, in order, for a fresh claim", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    const calls: string[] = [];

    const outcome = await runAttemptExecutorSegment(
      claimOptions(hostHomeDir, {}),
      async (claim) => {
        expect(claim.kind).toBe("claimed");
        calls.push("acknowledge");
      },
      async (capability, claim) => {
        expect(calls).toEqual(["acknowledge"]);
        expect(claim.kind).toBe("claimed");
        calls.push("execute");
        return "execution-result";
      },
    );

    expect(calls).toEqual(["acknowledge", "execute"]);
    expect(outcome.kind).toBe("executed");
    if (outcome.kind === "executed") {
      expect(outcome.result).toBe("execution-result");
      expect(outcome.claim.kind).toBe("claimed");
    }
  });

  it("never calls acknowledge or execute when the cohort is shadow (the production default)", async () => {
    const hostHomeDir = await freshHome();
    let acknowledgeCalls = 0;
    let executeCalls = 0;

    const outcome = await runAttemptExecutorSegment(
      claimOptions(hostHomeDir, {}),
      async () => {
        acknowledgeCalls += 1;
      },
      async () => {
        executeCalls += 1;
        return "must-not-run";
      },
    );

    expect(outcome).toEqual({
      kind: "rejected",
      reason: "cohort-disabled",
      observed: null,
    });
    expect(acknowledgeCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it("never calls acknowledge or execute for darwin even when linux/win32 are eligible", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    let acknowledgeCalls = 0;
    let executeCalls = 0;

    const outcome = await runAttemptExecutorSegment(
      claimOptions(hostHomeDir, { platform: "darwin" }),
      async () => {
        acknowledgeCalls += 1;
      },
      async () => {
        executeCalls += 1;
        return "must-not-run";
      },
    );

    expect(outcome).toEqual({
      kind: "rejected",
      reason: "cohort-disabled",
      observed: null,
    });
    expect(acknowledgeCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it("never calls acknowledge or execute when the claim itself is rejected", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    let acknowledgeCalls = 0;
    let executeCalls = 0;

    // `action: "force"` with a non-null `expected` against an absent record
    // is refused before any write - a pre-claim rejection, not a fault.
    const outcome = await runAttemptExecutorSegment(
      claimOptions(hostHomeDir, {
        request: {
          targetVersion: "1.2.3",
          trigger: "manual",
          action: "force",
          expected: { attemptId: "gone", generation: 1, sequence: 1 },
          newAttemptId: "attempt-1",
          initialPhase: "downloading",
        },
      }),
      async () => {
        acknowledgeCalls += 1;
      },
      async () => {
        executeCalls += 1;
        return "must-not-run";
      },
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe("stale-expectation");
    }
    expect(acknowledgeCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it("never calls acknowledge or execute, and writes nothing, when a fault fires before the claim write", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    let acknowledgeCalls = 0;
    let executeCalls = 0;
    const faults: UpdateExecutorFaults = {
      hit: async (point) => {
        if (point === "before-claim-write") {
          throw new Error("injected pre-claim-write fault");
        }
      },
    };

    await expect(
      runAttemptExecutorSegment(
        claimOptions(hostHomeDir, { faults }),
        async () => {
          acknowledgeCalls += 1;
        },
        async () => {
          executeCalls += 1;
          return "must-not-run";
        },
      ),
    ).rejects.toThrow("injected pre-claim-write fault");

    expect(acknowledgeCalls).toBe(0);
    expect(executeCalls).toBe(0);
    // No record exists on disk at all - the fault fired before the very
    // first durable write, so there is nothing to roll back.
    const onDisk = await readUpdateAttemptRecord(hostHomeDir);
    expect(onDisk.kind).toBe("absent");
  });

  it("never calls acknowledge or execute when a fault fires after the claim write but before acknowledgement", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    let acknowledgeCalls = 0;
    let executeCalls = 0;
    const faults: UpdateExecutorFaults = {
      hit: async (point) => {
        if (point === "after-claim-write-before-ack") {
          throw new Error("injected pre-ack fault");
        }
      },
    };

    await expect(
      runAttemptExecutorSegment(
        claimOptions(hostHomeDir, { faults }),
        async () => {
          acknowledgeCalls += 1;
        },
        async () => {
          executeCalls += 1;
          return "must-not-run";
        },
      ),
    ).rejects.toThrow("injected pre-ack fault");

    expect(acknowledgeCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it("never calls execute when a fault fires after the private ACK but before the execute action - acknowledge has already run", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    let acknowledgeCalls = 0;
    let executeCalls = 0;
    const faults: UpdateExecutorFaults = {
      hit: async (point) => {
        if (point === "after-private-ack-before-action") {
          throw new Error("injected post-ack fault");
        }
      },
    };

    await expect(
      runAttemptExecutorSegment(
        claimOptions(hostHomeDir, { faults }),
        async () => {
          acknowledgeCalls += 1;
        },
        async () => {
          executeCalls += 1;
          return "must-not-run";
        },
      ),
    ).rejects.toThrow("injected post-ack fault");

    // Unlike the pre-ack fault above, acknowledge DID durably run here - the
    // claim was already committed and privately acknowledged. Only the
    // execute action itself is what a crash at this exact point must not
    // have started.
    expect(acknowledgeCalls).toBe(1);
    expect(executeCalls).toBe(0);
  });

  it("propagates an acknowledge failure without ever invoking execute", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    let executeCalls = 0;

    await expect(
      runAttemptExecutorSegment(
        claimOptions(hostHomeDir, {}),
        async () => {
          throw new Error("private ACK channel failed");
        },
        async () => {
          executeCalls += 1;
          return "must-not-run";
        },
      ),
    ).rejects.toThrow("private ACK channel failed");

    expect(executeCalls).toBe(0);
  });
});

describe("runAttemptExecutorSegment - the dispatch ACK is stamped AFTER the claim is durable (Ticket 07 §5.2.8)", () => {
  // The ordering IS the contract. An ACK written before the claim attests an
  // attempt that a crash one instant later un-makes, leaving the resolver
  // reporting `accepted` for something that never existed - a fabricated
  // identity, which is the precise failure the arm was introduced to remove.
  //
  // The seam is the executor's own `acknowledge` callback, which it documents
  // as "the private positive acknowledgement boundary" and invokes immediately
  // after the claim commits. Using it rather than a new call site is what makes
  // the ordering structural instead of a convention.

  it("the attempt record is already on disk when the ACK stamp runs", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    let recordExistedAtStampTime: boolean | null = null;
    let stampedIdentity: string | null = null;

    const outcome = await runAttemptExecutorSegment(
      claimOptions(hostHomeDir, {}),
      async (claim) => {
        // The REAL writer, at the real seam. Using a stand-in here would prove
        // the callback ran and nothing about what production actually stamps.
        recordExistedAtStampTime = existsSync(
          updateAttemptRecordPath(hostHomeDir),
        );
        if (claim.kind !== "claimed") return;
        stampedIdentity = claim.identity.attemptId;
        await stampUpdateDispatchAck({
          hostHomeDir,
          nonce: "nonce-abcdefgh",
          identity: claim.identity,
          claimedAtIso: "2026-01-01T00:00:00.000Z",
        });
      },
      async () => "ran",
    );

    expect(outcome.kind).toBe("executed");
    // Both halves. The identity alone would pass for a callback that ran at
    // any time with a claim in hand; the on-disk check is what pins WHEN.
    expect(stampedIdentity).not.toBeNull();
    expect(recordExistedAtStampTime).toBe(true);
    // And the stamp names the attempt the segment actually claimed - the
    // correlation is READ BACK from what production wrote, never assumed.
    const decoded = decodeUpdateDispatchAck(
      readFileSync(updateDispatchAckPath(hostHomeDir), "utf8"),
    );
    expect(decoded.kind).toBe("valid");
    if (decoded.kind !== "valid") return;
    expect(decoded.ack.attemptId).toBe(stampedIdentity);
    expect(decoded.ack.nonce).toBe("nonce-abcdefgh");
  });

  it("CONTROL: no record exists before the segment runs", async () => {
    // Without this, the assertion above could pass on a host that already had
    // a record from some earlier attempt - it would be true for the wrong
    // reason, and the ordering would be unwitnessed.
    const hostHomeDir = await freshHome();
    expect(existsSync(updateAttemptRecordPath(hostHomeDir))).toBe(false);
  });
});

describe("runAttemptExecutorSegment - the cohort gate is scoped to ADMISSION (Ticket 07 Finding 2)", () => {
  /**
   * A record parked at `waiting-to-activate` carrying `activate`: an ADOPTED
   * continuation, committed and then released so nothing holds the lock.
   */
  async function seedAdoptedActivationContinuation(
    hostHomeDir: string,
  ): Promise<HostUpdateAttemptIdentity> {
    await mkdir(hostHomeDir, { recursive: true });
    const acquired = await acquireUpdateAttemptLock({
      hostHomeDir,
      reason: "seed-adopted-continuation",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    if (acquired.kind !== "acquired") {
      throw new Error(`expected the seeding lock, got ${acquired.kind}`);
    }
    const created = await commitAttemptMutation({
      handle: acquired.handle,
      intent: {
        kind: "create",
        request: {
          targetVersion: "1.2.3",
          trigger: "manual",
          action: "start",
          expected: null,
          newAttemptId: "adopted-attempt-1",
          initialPhase: "applying",
          nowIso: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    if (created.kind !== "committed") {
      throw new Error(`seed create failed: ${created.kind}`);
    }
    const parked = await commitAttemptMutation({
      handle: acquired.handle,
      intent: {
        kind: "advance",
        held: created.identity,
        advance: {
          phase: "waiting-to-activate",
          continuation: "activate",
          progress: null,
          error: null,
          nowIso: "2026-01-01T00:01:00.000Z",
        },
      },
    });
    if (parked.kind !== "committed") {
      throw new Error(`seed park failed: ${parked.kind}`);
    }
    await acquired.handle.release();
    const seeded = await readUpdateAttemptRecord(hostHomeDir);
    if (
      seeded.kind !== "valid" ||
      seeded.value.continuation !== "activate" ||
      seeded.value.phase !== "waiting-to-activate"
    ) {
      throw new Error(`seed did not park: ${JSON.stringify(seeded)}`);
    }
    return parked.identity;
  }

  // The TRACE half. This gate is production-reachable today: Desktop dispatches
  // `host update-verify` after every packaged-mac restart, and that command
  // runs `runLocalAttemptExecutorSegment` -> here. Refusing an already-adopted
  // continuation on that path abandons the attempt the verification exists to
  // conclude - the Finding-2 stranding, on the verify route.
  it("does NOT reject an ADOPTED continuation under the shipped shadow cohort", async () => {
    const hostHomeDir = await freshHome();
    const identity = await seedAdoptedActivationContinuation(hostHomeDir);

    const outcome = await runAttemptExecutorSegment(
      claimOptions(hostHomeDir, {
        request: {
          targetVersion: "1.2.3",
          trigger: "manual",
          action: "activate",
          expected: identity,
          newAttemptId: "unused-for-resume",
          initialPhase: "applying",
        },
      }),
      async () => {},
      async () => "ran",
    );

    // The specific negative: whatever the segment goes on to do, it must not
    // be refused BY THE GATE. Asserting a concrete success shape would couple
    // this to claim/drain details and fail for unrelated reasons.
    expect(outcome).not.toEqual({
      kind: "rejected",
      reason: "cohort-disabled",
      observed: null,
    });
  });

  // The CONTROL half already exists above - "never calls acknowledge or
  // execute when the cohort is shadow (the production default)" runs against a
  // `freshHome()` with NOTHING adopted, and still expects
  // `{rejected, cohort-disabled}`. Named here so the pair is discoverable
  // together: that test is what stops "skip the gate whenever a record exists"
  // - or deleting the gate - from satisfying the trace above.
});

describe("runAttemptExecutorSegment - recovery path runs the injected reader under the real capability/CLI-lock ordering", () => {
  async function seedInterruptedActiveRecord(
    hostHomeDir: string,
  ): Promise<void> {
    // Simulates a segment that died mid-execution: commit an active record,
    // then release the lock WITHOUT parking or terminalizing it, leaving
    // exactly the "active, unheld" evidence `decideAttemptClaim` refuses as
    // `requires-recovery`.
    await mkdir(hostHomeDir, { recursive: true });
    const acquired = await acquireUpdateAttemptLock({
      hostHomeDir,
      reason: "seed-interrupted-record",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    if (acquired.kind !== "acquired") {
      throw new Error(
        `expected to acquire the seeding lock, got ${acquired.kind}`,
      );
    }
    const committed = await commitAttemptMutation({
      handle: acquired.handle,
      intent: {
        kind: "create",
        request: {
          targetVersion: "1.2.3",
          trigger: "manual",
          action: "start",
          expected: null,
          newAttemptId: "attempt-1",
          initialPhase: "applying",
          nowIso: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    if (committed.kind !== "committed") {
      throw new Error(
        `expected the seed create to commit, got ${committed.kind}`,
      );
    }
    await acquired.handle.release();
  }

  it("calls the injected readRecoveryEvidence twice (initial read, then a final re-read under the write lock), under the capability, and commits the resulting recovery", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    await seedInterruptedActiveRecord(hostHomeDir);

    let readRecoveryEvidenceCalls = 0;
    const evidence: AttemptRecoveryEvidence = {
      installed: { kind: "verified", version: "1.2.3" },
      staged: { kind: "absent" },
      running: { kind: "absent" },
    };
    const calls: string[] = [];

    const outcome = await runAttemptExecutorSegment(
      claimOptions(hostHomeDir, {
        // Evidence offers only an `activate` continuation - only `activate`
        // may resume it (§ actionMayResume).
        // `action: "start"` can never resume - only terminalize/supersede
        // (`actionMayResume` never authorizes "start"). Reaching
        // `resume-new-generation` needs an identity-bound resume-class
        // request, matching the seeded record's identity.
        request: {
          targetVersion: "1.2.3",
          trigger: "manual",
          action: "activate",
          expected: { attemptId: "attempt-1", generation: 1, sequence: 1 },
          newAttemptId: "attempt-1",
          initialPhase: "downloading",
        },
        readRecoveryEvidence: () => {
          readRecoveryEvidenceCalls += 1;
          calls.push("read-recovery-evidence");
          return Promise.resolve(observation(evidence));
        },
      }),
      async (claim) => {
        expect(claim.kind).toBe("claimed");
        calls.push("acknowledge");
      },
      async (_capability, claim) => {
        calls.push("execute");
        return claim;
      },
    );

    // `recoverInterruptedAttempt` reads once for the advisory initial
    // observation and a SECOND time for the final observation compared
    // against it under the write lock (the flap-detection boundary) - both
    // reads run strictly before acknowledge/execute, since recovery is part
    // of establishing the claim, not part of the execution segment.
    expect(readRecoveryEvidenceCalls).toBe(2);
    expect(calls).toEqual([
      "read-recovery-evidence",
      "read-recovery-evidence",
      "acknowledge",
      "execute",
    ]);
    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") return;
    // RETARGETED by the Ticket 07 orphan-recovery ruling. The assertion's
    // meaning is preserved - installed-verified-only evidence still resumes the
    // `activate` continuation at a bumped generation, via the recovery arm's
    // `resume-new-generation` path - but the POST-STATE is now stronger.
    //
    // Recovery used to leave the record ACTIVE at `preparing/activate` and then
    // release, which is the orphaned shape `decideAttemptClaim` refuses as
    // `requires-recovery`; the next recovery would land the same state again,
    // a stranding LOOP rather than a resolution. The segment now performs the
    // already-legal `preparing/activate -> waiting-to-activate` re-park BEFORE
    // releasing, so what it hands back is a record an ordinary claim can
    // resume with no recovery evidence of its own.
    expect(outcome.claim.record.phase).toBe("waiting-to-activate");
    expect(outcome.claim.record.continuation).toBe("activate");
    // The generation bump is recovery's, and the re-park rides the same
    // generation (an advance bumps only `sequence`).
    expect(outcome.claim.record.generation).toBe(2);
  });

  it("terminalizes (rather than claims) when recovery evidence proves the interrupted attempt already completed", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    await seedInterruptedActiveRecord(hostHomeDir);

    let acknowledgeCalls = 0;
    let executeCalls = 0;
    const evidence: AttemptRecoveryEvidence = {
      installed: { kind: "verified", version: "1.2.3" },
      staged: { kind: "absent" },
      running: {
        kind: "verified",
        version: "1.2.3",
        owner: "host-home-bound",
      },
    };

    const outcome = await runAttemptExecutorSegment(
      claimOptions(hostHomeDir, {
        readRecoveryEvidence: () => Promise.resolve(observation(evidence)),
      }),
      async () => {
        acknowledgeCalls += 1;
      },
      async () => {
        executeCalls += 1;
        return "must-not-run";
      },
    );

    // A terminalized outcome is not a `claimed` one - the private
    // acknowledgement and execution callbacks are for a claimed segment
    // only, and must not run for an attempt that recovery already ended.
    expect(outcome.kind).toBe("terminalized");
    if (outcome.kind === "terminalized") {
      expect(outcome.outcome).toBe("complete");
    }
    expect(acknowledgeCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it("refuses recovery-evidence-flapped when the initial and final observations disagree, and never claims or executes", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    await seedInterruptedActiveRecord(hostHomeDir);

    let acknowledgeCalls = 0;
    let executeCalls = 0;
    let readCalls = 0;
    const initialEvidence: AttemptRecoveryEvidence = {
      installed: { kind: "verified", version: "1.2.3" },
      staged: { kind: "absent" },
      running: { kind: "absent" },
    };
    const flappedEvidence: AttemptRecoveryEvidence = {
      // Same continuation-worthy shape but a different concrete evidence
      // object - `recoverInterruptedAttempt` compares by fingerprint, not by
      // recomputed continuation, so even a still-plausible-looking second
      // read must refuse rather than silently trusting whichever read is
      // more convenient.
      installed: { kind: "verified", version: "1.2.3" },
      staged: { kind: "verified", version: "1.2.3" },
      running: { kind: "absent" },
    };

    const outcome = await runAttemptExecutorSegment(
      claimOptions(hostHomeDir, {
        readRecoveryEvidence: () => {
          readCalls += 1;
          const evidence = readCalls === 1 ? initialEvidence : flappedEvidence;
          return Promise.resolve(observation(evidence));
        },
      }),
      async () => {
        acknowledgeCalls += 1;
      },
      async () => {
        executeCalls += 1;
        return "must-not-run";
      },
    );

    expect(readCalls).toBe(2);
    expect(outcome).toEqual({
      kind: "rejected",
      reason: "recovery-evidence-flapped",
      observed: expect.objectContaining({ attemptId: "attempt-1" }),
    });
    expect(acknowledgeCalls).toBe(0);
    expect(executeCalls).toBe(0);

    // The flap refusal must not have written anything - the record is
    // exactly what the seed left it as.
    const onDisk = await readUpdateAttemptRecord(hostHomeDir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") {
      expect(onDisk.value.phase).toBe("applying");
      expect(onDisk.value.execution).toBe("active");
    }
  });

  it("does not flap when the two injected observations report the identical evidence object", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    await seedInterruptedActiveRecord(hostHomeDir);

    const evidence: AttemptRecoveryEvidence = {
      installed: { kind: "verified", version: "1.2.3" },
      staged: { kind: "absent" },
      running: { kind: "absent" },
    };

    const outcome = await runAttemptExecutorSegment(
      claimOptions(hostHomeDir, {
        // `action: "start"` can never resume - only terminalize/supersede
        // (`actionMayResume` never authorizes "start"). Reaching
        // `resume-new-generation` needs an identity-bound resume-class
        // request, matching the seeded record's identity.
        request: {
          targetVersion: "1.2.3",
          trigger: "manual",
          action: "activate",
          expected: { attemptId: "attempt-1", generation: 1, sequence: 1 },
          newAttemptId: "attempt-1",
          initialPhase: "downloading",
        },
        readRecoveryEvidence: () => Promise.resolve(observation(evidence)),
      }),
      async () => {},
      async (_capability, claim) => claim,
    );

    expect(outcome.kind).toBe("executed");
  });

  it("hits before-recovery-evidence before ever calling the injected reader, and writes nothing", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    await seedInterruptedActiveRecord(hostHomeDir);

    let readCalls = 0;
    let acknowledgeCalls = 0;
    let executeCalls = 0;
    const faults: UpdateExecutorFaults = {
      hit: async (point) => {
        if (point === "before-recovery-evidence") {
          throw new Error("injected before-recovery-evidence fault");
        }
      },
    };

    await expect(
      runAttemptExecutorSegment(
        claimOptions(hostHomeDir, {
          faults,
          readRecoveryEvidence: () => {
            readCalls += 1;
            return Promise.resolve(
              observation({
                installed: { kind: "verified", version: "1.2.3" },
                staged: { kind: "absent" },
                running: { kind: "absent" },
              }),
            );
          },
        }),
        async () => {
          acknowledgeCalls += 1;
        },
        async () => {
          executeCalls += 1;
          return "must-not-run";
        },
      ),
    ).rejects.toThrow("injected before-recovery-evidence fault");

    expect(readCalls).toBe(0);
    expect(acknowledgeCalls).toBe(0);
    expect(executeCalls).toBe(0);

    const onDisk = await readUpdateAttemptRecord(hostHomeDir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") {
      // Unchanged from the seed - a crash here has nothing to reconcile.
      expect(onDisk.value.phase).toBe("applying");
      expect(onDisk.value.execution).toBe("active");
      expect(onDisk.value.sequence).toBe(1);
    }
  });

  it("hits after-recovery-evidence-before-write after the initial read but before the final re-read/write, and commits nothing", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    await seedInterruptedActiveRecord(hostHomeDir);

    let readCalls = 0;
    let acknowledgeCalls = 0;
    let executeCalls = 0;
    const faults: UpdateExecutorFaults = {
      hit: async (point) => {
        if (point === "after-recovery-evidence-before-write") {
          throw new Error(
            "injected after-recovery-evidence-before-write fault",
          );
        }
      },
    };

    await expect(
      runAttemptExecutorSegment(
        claimOptions(hostHomeDir, {
          faults,
          readRecoveryEvidence: () => {
            readCalls += 1;
            return Promise.resolve(
              observation({
                installed: { kind: "verified", version: "1.2.3" },
                staged: { kind: "absent" },
                running: { kind: "absent" },
              }),
            );
          },
        }),
        async () => {
          acknowledgeCalls += 1;
        },
        async () => {
          executeCalls += 1;
          return "must-not-run";
        },
      ),
    ).rejects.toThrow("injected after-recovery-evidence-before-write fault");

    // Only the initial (advisory) read ran - the fault fired before the
    // final re-read under the write lock, so the flap-comparison read and
    // the recovery write itself never happened.
    expect(readCalls).toBe(1);
    expect(acknowledgeCalls).toBe(0);
    expect(executeCalls).toBe(0);

    const onDisk = await readUpdateAttemptRecord(hostHomeDir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") {
      expect(onDisk.value.phase).toBe("applying");
      expect(onDisk.value.execution).toBe("active");
      expect(onDisk.value.sequence).toBe(1);
    }
  });

  it("hits after-recovery-write-before-action AFTER the recovery terminalization has durably committed, and a retry never terminalizes a second time", async () => {
    mockCohortEligible("linux");
    const hostHomeDir = await freshHome();
    await seedInterruptedActiveRecord(hostHomeDir);

    const evidence: AttemptRecoveryEvidence = {
      installed: { kind: "verified", version: "1.2.3" },
      staged: { kind: "absent" },
      running: {
        kind: "verified",
        version: "1.2.3",
        owner: "host-home-bound",
      },
    };
    let acknowledgeCalls = 0;
    let executeCalls = 0;
    const faults: UpdateExecutorFaults = {
      hit: async (point) => {
        if (point === "after-recovery-write-before-action") {
          throw new Error("injected after-recovery-write-before-action fault");
        }
      },
    };

    await expect(
      runAttemptExecutorSegment(
        claimOptions(hostHomeDir, {
          faults,
          readRecoveryEvidence: () => Promise.resolve(observation(evidence)),
        }),
        async () => {
          acknowledgeCalls += 1;
        },
        async () => {
          executeCalls += 1;
          return "must-not-run";
        },
      ),
    ).rejects.toThrow("injected after-recovery-write-before-action fault");

    expect(acknowledgeCalls).toBe(0);
    expect(executeCalls).toBe(0);

    // The recovery terminalization write already committed durably before
    // the fault fired - a crash here must not lose that write.
    const afterFault = await readUpdateAttemptRecord(hostHomeDir);
    expect(afterFault.kind).toBe("valid");
    if (afterFault.kind !== "valid") return;
    expect(afterFault.value.attemptId).toBe("attempt-1");
    expect(afterFault.value.phase).toBe("complete");
    expect(afterFault.value.execution).toBe("terminal");

    // A retry against the now-terminal record must not repeat the recovery
    // arm: `decideAttemptClaim` only enters `requires-recovery` for an
    // active, unheld record, so a second segment over the same home takes
    // the ordinary create path for a NEW attempt identity and never writes a
    // second terminal transition onto attempt-1.
    let retryAcknowledgeCalls = 0;
    let retryExecuteCalls = 0;
    const retryOutcome = await runAttemptExecutorSegment(
      claimOptions(hostHomeDir, {
        request: {
          targetVersion: "1.2.3",
          trigger: "manual",
          action: "start",
          expected: null,
          newAttemptId: "attempt-2",
          initialPhase: "downloading",
        },
      }),
      async () => {
        retryAcknowledgeCalls += 1;
      },
      async () => {
        retryExecuteCalls += 1;
        return "retry-result";
      },
    );

    expect(retryOutcome.kind).toBe("executed");
    expect(retryAcknowledgeCalls).toBe(1);
    expect(retryExecuteCalls).toBe(1);

    const afterRetry = await readUpdateAttemptRecord(hostHomeDir);
    expect(afterRetry.kind).toBe("valid");
    if (afterRetry.kind === "valid") {
      // A brand new attempt identity, not a second terminal write onto the
      // original attempt-1.
      expect(afterRetry.value.attemptId).toBe("attempt-2");
      expect(afterRetry.value.generation).toBe(1);
      expect(afterRetry.value.execution).toBe("active");
    }
  });
});

function contenderOptionsFor(
  hostHomeDir: string,
  reason: string,
): {
  readonly environment: "production";
  readonly hostHomeDir: string;
  readonly reason: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
} {
  return {
    environment: "production",
    hostHomeDir,
    reason,
    waitMs: 0,
    pollIntervalMs: 10,
  };
}

describe("execute()'s complete() closure - fault points around the terminal write, driven through the real live observation path", () => {
  /**
   * Advances the just-claimed attempt through to `verifying` under the SAME
   * capability `execute()` was handed - the real sequence of record
   * mutations a genuine executor performs before it ever calls `complete()`.
   * There is no standalone "jump straight to verifying" writer to call
   * instead: reaching `complete()` at all requires going through
   * `runLocalAttemptExecutorSegment`'s claim + `execute()` callback.
   */
  async function advanceToVerifying(
    capability: UpdateMutationCapability,
    claim: Extract<ExecutorClaimOutcome, { kind: "claimed" }>,
    hostHomeDir: string,
    reason: string,
  ): Promise<void> {
    const contenderOptions = contenderOptionsFor(hostHomeDir, reason);
    let current: Extract<AttemptCommitOutcome, { kind: "committed" }> = {
      kind: "committed",
      record: claim.record,
      identity: claim.identity,
    };
    for (const phase of [
      "preparing",
      "applying",
      "restarting",
      "verifying",
    ] as const) {
      const advanced = await commitExecutorAttemptMutation(
        capability,
        contenderOptions.hostHomeDir,
        {
          kind: "advance",
          held: current.identity,
          advance: {
            phase,
            continuation: null,
            progress: null,
            error: null,
            nowIso: "2026-01-01T00:05:00.000Z",
          },
        },
      );
      if (advanced.kind !== "committed") {
        throw new Error(
          `expected committed advance to ${phase}, got ${advanced.kind}`,
        );
      }
      current = advanced;
    }
  }

  async function runToVerifyingThenComplete(
    hostHomeDir: string,
    reason: string,
    faults: UpdateExecutorFaults,
  ) {
    mockCohortEligible("linux");
    return runLocalAttemptExecutorSegment(
      claimOptions(hostHomeDir, { faults }),
      async () => {},
      async (capability, claim, complete) => {
        await advanceToVerifying(capability, claim, hostHomeDir, reason);
        return complete();
      },
    );
  }

  /**
   * The private terminal writer behind `completeLocalAttemptExecutorSegment`
   * takes no testimonial evidence object - it calls the REAL
   * `observeAttemptRecoveryEvidence` itself. To reach the write at all, this
   * sets up a genuine installed-executable fixture and a genuine healthy
   * pid/RPC snapshot at the exact target version, through the same
   * sandboxed `store/paths` + process-identity + host-rpc module-boundary
   * mocks `update-recovery-evidence.test.ts` uses - not a hand-built proof
   * object passed into the function under test.
   */
  async function seedGenuineVerifiedProofAt(
    hostHomeDir: string,
    version: string,
  ): Promise<void> {
    currentHome.value = hostHomeDir;
    const installDir = paths.hostInstallDir("production");
    await mkdir(installDir, { recursive: true });
    const executablePath = join(installDir, "traycer-host");
    writeFileSync(executablePath, "binary-bytes");
    await writeHostInstallRecord("production", {
      installId: "install-1",
      version,
      runtimeVersion: null,
      platform: "linux",
      arch: "x64",
      installedAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "registry", value: version },
      archiveSha256: "a".repeat(64),
      // Ties this genuine fixture's install record to the exact bytes
      // written above, mirroring the real materialization attestation
      // `observeAttemptRecoveryEvidence` now requires before it will call
      // the installed leg `verified`.
      executableSha256: createHash("sha256")
        .update("binary-bytes")
        .digest("hex"),
      signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
      signatureKeyId: "test-key",
      sizeBytes: 1234,
      executablePath,
    });
    writeFileSync(
      paths.hostPidMetadataPath("production"),
      JSON.stringify({
        pid: 4242,
        hostId: "host-1",
        version,
        websocketUrl: "ws://127.0.0.1:58036/rpc",
        startedAt: "2026-01-01T00:00:00.000Z",
        processStartIdentity: "linux:boot-a 4242",
      }),
      "utf8",
    );
    rpcMocks.identityVerdict.mockResolvedValue("current");
    rpcMocks.callHostRpc.mockResolvedValue({
      ready: true,
      hostVersion: version,
      protocolVersion: { major: 1, minor: 2 },
      busy: false,
      busySessionCount: null,
      updateProgress: null,
      busyBreakdown: null,
    });
  }

  it("commits complete through the real live observation path when installed + running genuinely verify the exact target - proves the terminal write cannot be fabricated by a caller-supplied object, since complete() takes no evidence parameter at all", async () => {
    const hostHomeDir = await freshHome();
    await seedGenuineVerifiedProofAt(hostHomeDir, "1.2.3");

    const outcome = await runToVerifyingThenComplete(
      hostHomeDir,
      "complete-genuine",
      NO_UPDATE_EXECUTOR_FAULTS,
    );

    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") return;
    expect(outcome.result.kind).toBe("committed");
    if (outcome.result.kind === "committed") {
      expect(outcome.result.record.phase).toBe("complete");
    }
  });

  it("the legal preparing/applying/restarting/verifying advances bump sequence past the claimed identity, yet zero-argument complete() still commits - it re-derives the current verifying identity from the canonical read rather than reusing the stale claim", async () => {
    const hostHomeDir = await freshHome();
    await seedGenuineVerifiedProofAt(hostHomeDir, "1.2.3");
    mockCohortEligible("linux");
    const claimed: { identity: HostUpdateAttemptIdentity | null } = {
      identity: null,
    };
    const verifyingBeforeComplete: { sequence: number } = { sequence: -1 };

    const outcome = await runLocalAttemptExecutorSegment(
      claimOptions(hostHomeDir, { faults: NO_UPDATE_EXECUTOR_FAULTS }),
      async () => {},
      async (capability, claim, complete) => {
        claimed.identity = claim.identity;
        await advanceToVerifying(
          capability,
          claim,
          hostHomeDir,
          "complete-sequence-drift",
        );
        const verifying = await readUpdateAttemptRecord(hostHomeDir);
        if (verifying.kind === "valid") {
          verifyingBeforeComplete.sequence = verifying.value.sequence;
        }
        return complete();
      },
    );

    // The four legal advances (preparing/applying/restarting/verifying) each
    // bump sequence once past the claim's sequence 1 - proving this test
    // actually exercises drift, not an accidental no-op.
    expect(claimed.identity).not.toBeNull();
    expect(claimed.identity?.sequence).toBe(1);
    expect(verifyingBeforeComplete.sequence).toBe(5);

    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") return;
    expect(outcome.result.kind).toBe("committed");
    if (outcome.result.kind === "committed") {
      expect(outcome.result.record.phase).toBe("complete");
      // Same generation as the claim, but a newer sequence than both the
      // claim AND the pre-complete verifying read - the terminal write is
      // its own additional commit on top of the drifted identity.
      expect(outcome.result.identity.generation).toBe(
        claimed.identity?.generation,
      );
      expect(outcome.result.identity.attemptId).toBe(
        claimed.identity?.attemptId,
      );
      expect(outcome.result.identity.sequence).toBeGreaterThan(
        verifyingBeforeComplete.sequence,
      );
    }
  });

  it("rejects intent-not-legal when the canonical record's generation no longer matches the one claimed, even though phase reads verifying - sequence drift within a generation is tolerated, but a different generation never completes", async () => {
    const hostHomeDir = await freshHome();
    await seedGenuineVerifiedProofAt(hostHomeDir, "1.2.3");
    mockCohortEligible("linux");

    const outcome = await runLocalAttemptExecutorSegment(
      claimOptions(hostHomeDir, { faults: NO_UPDATE_EXECUTOR_FAULTS }),
      async () => {},
      async (capability, claim, complete) => {
        await advanceToVerifying(
          capability,
          claim,
          hostHomeDir,
          "complete-wrong-generation",
        );
        // Simulate a different generation having been recorded out from
        // under this held capability (e.g. a concurrent recovery/supersede)
        // between the last advance and complete() - written directly to
        // disk since driving a genuine competing generation from inside the
        // same held capability/lock isn't reachable in-process.
        const recordPath = updateAttemptRecordPath(hostHomeDir);
        const onDisk = JSON.parse(readFileSync(recordPath, "utf8")) as {
          readonly generation: number;
        };
        writeFileSync(
          recordPath,
          `${JSON.stringify({ ...onDisk, generation: onDisk.generation + 1 })}\n`,
        );
        return complete();
      },
    );

    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") return;
    expect(outcome.result.kind).toBe("rejected");
    if (outcome.result.kind === "rejected") {
      expect(outcome.result.reason).toBe("intent-not-legal");
    }
  });

  it("rejects intent-not-legal (never writes) when the live observation does NOT verify the exact target - there is no caller-supplied evidence to override it with", async () => {
    const hostHomeDir = await freshHome();
    // Genuinely verified at the WRONG version - the real observation proves
    // 9.9.9, not the record's actual target 1.2.3.
    await seedGenuineVerifiedProofAt(hostHomeDir, "9.9.9");

    const outcome = await runToVerifyingThenComplete(
      hostHomeDir,
      "complete-wrong-version",
      NO_UPDATE_EXECUTOR_FAULTS,
    );

    expect(outcome.kind).toBe("executed");
    if (outcome.kind === "executed")
      expect(outcome.result.kind).toBe("rejected");

    const onDisk = await readUpdateAttemptRecord(hostHomeDir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") expect(onDisk.value.phase).toBe("verifying");
  });

  it("never writes when the fault fires at before-terminal-write", async () => {
    const hostHomeDir = await freshHome();
    await seedGenuineVerifiedProofAt(hostHomeDir, "1.2.3");

    const faults: UpdateExecutorFaults = {
      hit: async (point) => {
        if (point === "before-terminal-write") {
          throw new Error("injected before-terminal-write fault");
        }
      },
    };

    await expect(
      runToVerifyingThenComplete(hostHomeDir, "complete-fault-before", faults),
    ).rejects.toThrow("injected before-terminal-write fault");

    const onDisk = await readUpdateAttemptRecord(hostHomeDir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") {
      // Still verifying - the fault fired before the commit was even
      // attempted, so nothing was written.
      expect(onDisk.value.phase).toBe("verifying");
    }
  });

  it("never writes, and never seals a proof, when the fault fires at after-terminal-evidence-before-write - the proof-to-write boundary itself is fault-injectable", async () => {
    const hostHomeDir = await freshHome();
    await seedGenuineVerifiedProofAt(hostHomeDir, "1.2.3");

    const faults: UpdateExecutorFaults = {
      hit: async (point) => {
        if (point === "after-terminal-evidence-before-write") {
          throw new Error(
            "injected after-terminal-evidence-before-write fault",
          );
        }
      },
    };

    await expect(
      runToVerifyingThenComplete(
        hostHomeDir,
        "complete-fault-post-evidence",
        faults,
      ),
    ).rejects.toThrow("injected after-terminal-evidence-before-write fault");

    const onDisk = await readUpdateAttemptRecord(hostHomeDir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") {
      // The fault fires strictly after the exact-version evidence was
      // observed and validated, but strictly before the proof is ever
      // sealed - a crash here must leave the record exactly as it was, not
      // a half-sealed or half-committed completion.
      expect(onDisk.value.phase).toBe("verifying");
      expect(onDisk.value.execution).toBe("active");
    }
  });

  it("has already durably written complete when the fault fires at after-terminal-write, and still propagates the fault", async () => {
    const hostHomeDir = await freshHome();
    await seedGenuineVerifiedProofAt(hostHomeDir, "1.2.3");

    const faults: UpdateExecutorFaults = {
      hit: async (point) => {
        if (point === "after-terminal-write") {
          throw new Error("injected after-terminal-write fault");
        }
      },
    };

    await expect(
      runToVerifyingThenComplete(hostHomeDir, "complete-fault-after", faults),
    ).rejects.toThrow("injected after-terminal-write fault");

    const onDisk = await readUpdateAttemptRecord(hostHomeDir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") {
      // The write already committed BEFORE the fault fired - the fault
      // signals a crash after the durable side effect, not before it.
      expect(onDisk.value.phase).toBe("complete");
      expect(onDisk.value.execution).toBe("terminal");
    }
  });

  // Named separately from `CompleteExecutorSegment` (the real, zero-argument
  // production type) so the test below can express "a caller that ignores
  // the real signature and passes an evidence-shaped argument anyway"
  // without a cast.
  type CompleteWithIgnoredEvidence = (evidence: {
    readonly expected: HostUpdateAttemptIdentity;
    readonly targetVersion: string;
    readonly runningVersion: string;
    readonly runningOwner: "host-home-bound";
    readonly nowIso: string;
  }) => Promise<AttemptCommitOutcome>;

  it("passing extra caller-supplied arguments to complete() has no effect - it is a zero-argument closure, so a matching literal cannot be smuggled in even under a type-erasing cast", async () => {
    const hostHomeDir = await freshHome();
    // Deliberately NOT seeding a genuine installed/running fixture - if
    // caller testimony could reach the write, this literal would make it
    // succeed. Since it cannot, the real (absent) live observation must
    // reject it instead.
    mockCohortEligible("linux");

    const outcome = await runLocalAttemptExecutorSegment(
      claimOptions(hostHomeDir, { faults: NO_UPDATE_EXECUTOR_FAULTS }),
      async () => {},
      async (capability, claim, complete) => {
        await advanceToVerifying(
          capability,
          claim,
          hostHomeDir,
          "complete-ignored-literal",
        );
        const fakeEvidence = {
          expected: claim.identity,
          targetVersion: "1.2.3",
          runningVersion: "1.2.3",
          runningOwner: "host-home-bound" as const,
          nowIso: "2026-01-01T00:06:00.000Z",
        };
        // A niladic function is a valid substitute wherever a one-argument
        // function is expected - TS accepts the assignment directly, no cast
        // needed. This models a caller that ignores `complete`'s real
        // (zero-argument) type and smuggles an evidence-shaped argument in
        // anyway; the closure itself still ignores it at runtime.
        const completeIgnoringArgument: CompleteWithIgnoredEvidence = complete;
        return completeIgnoringArgument(fakeEvidence);
      },
    );

    expect(outcome.kind).toBe("executed");
    if (outcome.kind === "executed")
      expect(outcome.result.kind).toBe("rejected");
    const onDisk = await readUpdateAttemptRecord(hostHomeDir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") expect(onDisk.value.phase).toBe("verifying");
  });

  it("a detached async child created inside execute() that calls complete() after execute() has already returned is rejected - the CLI's own single-use guard closes the escape independent of the shared session's own revoke()", async () => {
    const hostHomeDir = await freshHome();
    await seedGenuineVerifiedProofAt(hostHomeDir, "1.2.3");
    mockCohortEligible("linux");
    const detached: { promise: Promise<unknown> | null } = { promise: null };

    const outcome = await runLocalAttemptExecutorSegment(
      claimOptions(hostHomeDir, { faults: NO_UPDATE_EXECUTOR_FAULTS }),
      async () => {},
      async (capability, claim, complete) => {
        await advanceToVerifying(
          capability,
          claim,
          hostHomeDir,
          "complete-detached-child",
        );
        // Not awaited: schedules a macrotask from inside the still-live
        // callback, then returns immediately - the same shape as the prior
        // AsyncLocalStorage escape, but through an ordinary closure now.
        detached.promise = new Promise((resolve) => {
          setImmediate(() => {
            resolve(complete().catch((err: unknown) => err));
          });
        });
        return "returned-before-detached-child-ran";
      },
    );

    expect(outcome.kind).toBe("executed");
    const detachedResult = await detached.promise;
    if (!(detachedResult instanceof Error)) {
      throw new Error("expected the detached complete() call to reject");
    }
    expect(detachedResult.message).toContain(
      "executor terminal completion was called outside its session",
    );
    const onDisk = await readUpdateAttemptRecord(hostHomeDir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") expect(onDisk.value.phase).toBe("verifying");
  });

  it("a complete() closure captured from execute() cannot be used after runLocalAttemptExecutorSegment has fully returned", async () => {
    const hostHomeDir = await freshHome();
    await seedGenuineVerifiedProofAt(hostHomeDir, "1.2.3");
    mockCohortEligible("linux");
    const escaped: { complete: (() => Promise<AttemptCommitOutcome>) | null } =
      { complete: null };

    const outcome = await runLocalAttemptExecutorSegment(
      claimOptions(hostHomeDir, { faults: NO_UPDATE_EXECUTOR_FAULTS }),
      async () => {},
      async (capability, claim, complete) => {
        await advanceToVerifying(
          capability,
          claim,
          hostHomeDir,
          "complete-escaped-closure",
        );
        escaped.complete = complete;
        return "done-without-completing";
      },
    );

    expect(outcome.kind).toBe("executed");
    if (escaped.complete === null) {
      throw new Error("complete() was not captured by the callback");
    }
    await expect(escaped.complete()).rejects.toThrow(
      "executor terminal completion was called outside its session",
    );
    const onDisk = await readUpdateAttemptRecord(hostHomeDir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") expect(onDisk.value.phase).toBe("verifying");
  });
});

// ---- Shadow-fence provenance walker -------------------------------------
//
// Baseline attribution: the T3 author, whose ruling amended this gate. The
// original assertion demanded ZERO production importers; the author has since
// clarified that the empty set was "a rollout snapshot, not an invariant
// stronger than 'only the dedicated host-layer executor owner may import it;
// no released/legacy command may reach it.'" Ticket 05 introduces exactly one
// such owner - `host/update-verify.ts`, the post-restart verification claim -
// so the authorized set is now an exact singleton rather than empty.
//
// Three invariants, deliberately three separate loud failures:
//
//   1. `host/update-verify.ts` is the ONLY module that may import the executor
//      directly. Against every other module this is exactly as strong as the
//      empty set was.
//   2. No command surface may REACH it, even transitively, except the thin
//      dispatch caller `commands/host-update-verify.ts`. In particular the
//      released `commands/host-update.ts` must have no path - that is the case
//      this fence exists to stop.
//   3. Rollout eligibility is NOT this gate's business. It belongs exclusively
//      to `decideUpdateExecutorCohort` and Ticket 07's cutover. An authorized
//      importer is reachable-but-INERT until then, because
//      `runLocalAttemptExecutorSegment` refuses with `cohort-disabled` before
//      performing any work. Do not re-encode rollout policy here.
//
// Mechanics are the shared architecture gate's, reused rather than reinvented:
// a stat-based walker that deliberately follows repo-committed symlinks, and
// specifier matching folded over static imports, `export *` / named
// re-exports, `import("...")` type nodes, `require(...)` and DYNAMIC `import()`
// calls. Specifiers are RESOLVED to real paths rather than substring-matched,
// so `update-executor-cohort.ts` no longer needs an exclusion to avoid being a
// false positive. A dynamic specifier that is not a plain literal cannot be
// proven safe, so it is itself a violation (#3 below) - that is what closes
// the split-string/template bypass rather than merely documenting it.

const CLI_SRC_ROOT = join(__dirname, "..", "..");
const FENCE_SOURCE_EXTENSIONS = new Set([".ts", ".js", ".cjs", ".mjs"]);
const EXECUTOR_MODULE = join(CLI_SRC_ROOT, "host", "update-executor.ts");
const AUTHORIZED_EXECUTOR_OWNER = "host/update-verify.ts";
const AUTHORIZED_DISPATCH_COMMAND = "commands/host-update-verify.ts";
const RELEASED_UPDATE_COMMAND = "commands/host-update.ts";

interface ExecutorProvenance {
  /** Modules importing the executor directly, repo-relative and sorted. */
  readonly directImporters: readonly string[];
  /** Modules that reach it through any number of hops. */
  readonly reachers: readonly string[];
  /** Modules whose dynamic specifier this gate cannot statically prove. */
  readonly unprovable: readonly string[];
}

async function fenceSourceFiles(
  root: string,
  visitedDirectories: Set<string>,
): Promise<string[]> {
  const canonicalRoot = await realpath(root).catch(() => null);
  if (canonicalRoot === null || visitedDirectories.has(canonicalRoot))
    return [];
  const ancestry = new Set(visitedDirectories);
  ancestry.add(canonicalRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === "node_modules") return [];
      const path = join(root, entry.name);
      // Follow symlinks deliberately: a repo-committed symlinked source file
      // stays in coverage. Broken links and special files are skipped, and
      // realpath-based ancestry prevents symlink cycles.
      const info = await stat(path).catch(() => null);
      if (info === null) return [];
      if (info.isDirectory()) return fenceSourceFiles(path, ancestry);
      if (!info.isFile()) return [];
      const extension = entry.name.slice(entry.name.lastIndexOf("."));
      return FENCE_SOURCE_EXTENSIONS.has(extension) &&
        !entry.name.endsWith(".d.ts")
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}

interface ModuleReferences {
  readonly specifiers: readonly string[];
  readonly hasUnprovableSpecifier: boolean;
}

function moduleReferences(source: string, fileName: string): ModuleReferences {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  let hasUnprovableSpecifier = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      // Covers `export *` and named re-exports as well as plain imports.
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node)) {
      const dynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const cjsRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamicImport || cjsRequire) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isStringLiteral(argument)) {
          specifiers.push(argument.text);
        } else {
          // A concatenation, template or variable. Unprovable, so refused.
          hasUnprovableSpecifier = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return { specifiers, hasUnprovableSpecifier };
}

function resolveLocalSpecifier(
  specifier: string,
  fromFile: string,
  known: ReadonlySet<string>,
): string | null {
  // A bare package specifier cannot name a CLI-internal module.
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of specifierCandidatePaths(base)) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Every absolute path a module specifier could actually name.
 *
 * The `.js` remap is not a nicety - it closes a live bypass. TypeScript's own
 * guidance is to write `import "./update-executor.js"` for an
 * `update-executor.ts` source, and Bun resolves that happily. This resolver
 * previously tried only the literal path, `+ ".ts"`, and `/index.ts`, so a
 * `.js` specifier produced `update-executor.js.ts` - a file that does not
 * exist - and the edge was silently dropped. The protected module executed
 * while this fence stayed green. Appending four characters was enough to walk
 * past it.
 *
 * Fail-closed: this over-generates candidates on purpose. A false positive is
 * a loud test failure; a false negative is an executable route past the gate.
 */
function specifierCandidatePaths(base: string): readonly string[] {
  const candidates: string[] = [base];
  const remaps: ReadonlyArray<readonly [string, readonly string[]]> = [
    [".js", [".ts", ".tsx"]],
    [".jsx", [".tsx"]],
    [".mjs", [".mts"]],
    [".cjs", [".cts"]],
  ];
  for (const [written, actual] of remaps) {
    if (base.endsWith(written)) {
      const stem = base.slice(0, -written.length);
      for (const extension of actual) candidates.push(`${stem}${extension}`);
    }
  }
  if (!/\.[cm]?[jt]sx?$/.test(base)) {
    for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
      candidates.push(`${base}${extension}`);
    }
    candidates.push(join(base, "index.ts"), join(base, "index.tsx"));
  }
  return candidates;
}

async function executorProvenance(): Promise<ExecutorProvenance> {
  const all = await fenceSourceFiles(CLI_SRC_ROOT, new Set());
  const production = all.filter(
    (file) => !file.split(sep).includes("__tests__"),
  );
  // ---- CANONICALIZE before comparing anything.
  //
  // The walker deliberately FOLLOWS symlinks but recorded LEXICAL paths, and
  // every comparison below - resolver and reverse-reachability alike - matched
  // those lexical strings against a lexical `EXECUTOR_MODULE`. So a committed
  // alias (`host/executor-alias.ts -> update-executor.ts`) imported as
  // `../host/executor-alias.js` executed the protected module while the fence
  // recorded a different module and stayed green. Following symlinks without
  // canonicalizing is strictly worse than not following them: it puts the
  // alias in coverage and then fails to recognize it.
  const canonical = new Map<string, string>();
  for (const file of production) {
    canonical.set(file, await realpath(file).catch(() => file));
  }
  const canonicalOf = (file: string): string => canonical.get(file) ?? file;
  const executorModule = await realpath(EXECUTOR_MODULE).catch(
    () => EXECUTOR_MODULE,
  );
  const known = new Set(production);
  const relativeTo = (file: string): string =>
    file
      .slice(CLI_SRC_ROOT.length + 1)
      .split(sep)
      .join("/");

  const directImporters: string[] = [];
  const unprovable: string[] = [];
  const dependencies = new Map<string, string[]>();

  for (const file of production) {
    const source = await readFile(file, "utf8");
    const references = moduleReferences(source, file);
    if (references.hasUnprovableSpecifier) unprovable.push(relativeTo(file));
    const resolved: string[] = [];
    for (const specifier of references.specifiers) {
      const target = resolveLocalSpecifier(specifier, file, known);
      if (target === null) continue;
      resolved.push(target);
      if (
        canonicalOf(target) === executorModule &&
        canonicalOf(file) !== executorModule
      ) {
        directImporters.push(relativeTo(file));
      }
    }
    dependencies.set(file, resolved);
  }

  // Reverse reachability: who can get to the executor by any number of hops.
  const reachers = new Set<string>();
  // Seed with every walked path whose canonical identity is the executor, so
  // an alias cannot start the graph somewhere the traversal never visits.
  const frontier = production.filter(
    (file) => canonicalOf(file) === executorModule,
  );
  if (frontier.length === 0) frontier.push(EXECUTOR_MODULE);
  while (frontier.length > 0) {
    const current = frontier.pop();
    if (current === undefined) break;
    for (const [file, resolved] of dependencies) {
      const currentCanonical = canonicalOf(current);
      if (
        !resolved.some((dep) => canonicalOf(dep) === currentCanonical) ||
        reachers.has(file)
      )
        continue;
      reachers.add(file);
      frontier.push(file);
    }
  }

  return {
    directImporters: [...new Set(directImporters)].sort(),
    reachers: [...reachers].map(relativeTo).sort(),
    unprovable: [...new Set(unprovable)].sort(),
  };
}

describe("update-executor.ts - shadow fence source boundary (structural)", () => {
  it("only the dedicated host-layer owner imports update-executor directly - folded over static, re-export, type, require and dynamic specifiers", async () => {
    const provenance = await executorProvenance();
    expect(provenance.directImporters).toEqual([AUTHORIZED_EXECUTOR_OWNER]);
  });

  it("no command surface reaches update-executor except the thin dispatch caller - the RELEASED host-update command has no path, direct or transitive", async () => {
    const provenance = await executorProvenance();
    expect(
      provenance.reachers.filter((file) => file.startsWith("commands/")),
    ).toEqual([AUTHORIZED_DISPATCH_COMMAND]);
    // Stated separately from the set equality above so that the case this
    // fence exists to stop names itself in the failure output.
    expect(provenance.reachers).not.toContain(RELEASED_UPDATE_COMMAND);
  });

  // F9: the specifier-extension bypass, pinned per written form.
  //
  // TypeScript's own guidance is to write `./x.js` for an `x.ts` source, and
  // Bun resolves it. The old resolver tried only the literal path, `+ ".ts"`
  // and `/index.ts`, so `./update-executor.js` became
  // `update-executor.js.ts` - nonexistent - and the dependency edge was
  // dropped while the protected module still executed.
  it.each([
    ["./update-executor.js", "update-executor.ts"],
    ["./update-executor.jsx", "update-executor.tsx"],
    ["./update-executor.mjs", "update-executor.mts"],
    ["./update-executor.cjs", "update-executor.cts"],
    ["./update-executor", "update-executor.ts"],
  ])(
    "a %s specifier is a candidate for the real %s source",
    (written, actual) => {
      const base = resolve(join(CLI_SRC_ROOT, "host"), written);
      expect(specifierCandidatePaths(base)).toContain(
        join(CLI_SRC_ROOT, "host", actual),
      );
    },
  );

  it("no production module hides a specifier from this gate behind a computed import() or require()", async () => {
    const provenance = await executorProvenance();
    expect(provenance.unprovable).toEqual([]);
  });

  it("no production `__setUpdateExecutorCohortEnabledForTest`/enable seam remains anywhere in the CLI source tree", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const cliSrcDir = join(__dirname, "..", "..");
    try {
      await execFileAsync(
        "git",
        [
          "grep",
          "-l",
          "--untracked",
          "__setUpdateExecutorCohortEnabledForTest",
          "--",
          ":(exclude)*/__tests__/*",
        ],
        { cwd: cliSrcDir },
      );
      throw new Error(
        "found a reference to the removed __setUpdateExecutorCohortEnabledForTest seam",
      );
    } catch (error) {
      const execError = error as { code?: number };
      // Exit 1 with no matches is success - the seam is gone.
      if (execError.code !== 1) throw error;
    }
  });

  it("the shared raw sealer/writer are not exported from the host-update barrel, and no CLI production source references them by name", async () => {
    const barrel: Record<string, unknown> =
      await import("@traycer-clients/shared/host-update");
    expect("sealVerifiedExecutorCompletion" in barrel).toBe(false);
    expect("commitVerifiedExecutorCompletion" in barrel).toBe(false);

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const cliSrcDir = join(__dirname, "..", "..");
    for (const removedSymbol of [
      "sealVerifiedExecutorCompletion",
      "commitVerifiedExecutorCompletion",
    ]) {
      try {
        await execFileAsync(
          "git",
          [
            "grep",
            "-l",
            "--untracked",
            removedSymbol,
            "--",
            ":(exclude)*/__tests__/*",
          ],
          { cwd: cliSrcDir },
        );
        throw new Error(`found a CLI reference to private "${removedSymbol}"`);
      } catch (error) {
        const execError = error as { code?: number };
        // Exit 1 with no matches is success - the symbol is unreachable.
        if (execError.code !== 1) throw error;
      }
    }
  });

  it("`withCliAttemptExecutorCompletion` is module-private and appears only inside update-executor.ts", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const cliSrcDir = join(__dirname, "..", "..");
    const { stdout } = await execFileAsync(
      "git",
      [
        "grep",
        "-l",
        "--untracked",
        "withCliAttemptExecutorCompletion",
        "--",
        ":(exclude)*/__tests__/*",
      ],
      { cwd: cliSrcDir },
    );
    const importers = stdout.trim().split("\n").filter(Boolean);
    expect(new Set(importers)).toEqual(new Set(["host/update-executor.ts"]));
  });

  it("no production file re-exports or references the removed observation-driven completers (`completeLocalAttemptExecutorSegment`, `completeCliVerifiedExecutorSegment`) - the terminal write is reachable only through the zero-argument `complete` closure", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const cliSrcDir = join(__dirname, "..", "..");
    for (const removedSymbol of [
      "completeLocalAttemptExecutorSegment",
      "completeCliVerifiedExecutorSegment",
    ]) {
      try {
        await execFileAsync(
          "git",
          [
            "grep",
            "-l",
            "--untracked",
            removedSymbol,
            "--",
            ":(exclude)*/__tests__/*",
          ],
          { cwd: cliSrcDir },
        );
        throw new Error(`found a CLI reference to removed "${removedSymbol}"`);
      } catch (error) {
        const execError = error as { code?: number };
        if (execError.code !== 1) throw error;
      }
    }
  });
});
