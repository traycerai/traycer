import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The cohort ships static shadow (`update-executor-cohort.ts`), so the
// executor is unreachable in production. Forced past that gate here with
// the same `vi.importActual` + `mockImplementation` pattern the CLI's own
// executor suite uses (`traycer-cli/src/host/__tests__/update-executor-cohort.test.ts`
// and `update-executor.test.ts:31-38`) - never a shipped bypass.
const cohortMock = vi.hoisted(() => ({ decide: vi.fn() }));
vi.mock("../update-executor-cohort", async () => {
  const actual = await vi.importActual<
    typeof import("../update-executor-cohort")
  >("../update-executor-cohort");
  cohortMock.decide.mockImplementation(
    actual.decideDesktopUpdateExecutorCohort,
  );
  return { ...actual, decideDesktopUpdateExecutorCohort: cohortMock.decide };
});

import { hostStopIntentPath } from "@traycer/protocol/config/host-stop-intent";
import {
  commitAttemptMutationWithCapability,
  readUpdateAttemptRecord,
  withUpdateContender,
  type HostUpdateAttemptIdentity,
  type HostUpdateAttemptRecord,
  type PublicAttemptMutationIntent,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import type { HostFsLayout } from "../host-paths";
import {
  clearRestartTombstoneWithAttempt,
  publishRestartTombstoneWithAttempt,
} from "../update-mutation";
import { freshHostFsLayout } from "./host-fs-layout-test-support";
import type {
  DesktopActivationCycleOutcome,
  DesktopActivationDeps,
  DesktopActivationRequest,
  DesktopDrainVerdict,
  DesktopExecutorFaultPoint,
} from "../update-executor";
import {
  NO_DESKTOP_EXECUTOR_FAULTS,
  runDesktopActivationSegment,
} from "../update-executor";

const roots: string[] = [];

afterEach(async () => {
  cohortMock.decide.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function freshLayout(): Promise<HostFsLayout> {
  return freshHostFsLayout(roots, "desktop-update-executor-test-");
}

function eligibleCohort(): void {
  cohortMock.decide.mockReturnValue({
    kind: "eligible",
    substrate: "smappservice",
  });
}

async function currentRecord(
  layout: HostFsLayout,
): Promise<HostUpdateAttemptRecord> {
  const read = await readUpdateAttemptRecord(layout.rootDir);
  if (read.kind !== "valid") {
    throw new Error(`expected a valid record, got ${read.kind}`);
  }
  return read.value;
}

function realCommit(layout: HostFsLayout): DesktopActivationDeps["commit"] {
  return (
    capability: UpdateMutationCapability,
    intent: PublicAttemptMutationIntent,
  ) => commitAttemptMutationWithCapability(capability, layout.rootDir, intent);
}

interface DepsOverrides {
  readonly drain?: () => Promise<DesktopDrainVerdict>;
  readonly publishTombstone?: DesktopActivationDeps["publishTombstone"];
  readonly withActuatorLock?: DesktopActivationDeps["withActuatorLock"];
  readonly registerActuator?: (
    capability: UpdateMutationCapability,
  ) => Promise<DesktopActivationCycleOutcome>;
  readonly clearTombstone?: DesktopActivationDeps["clearTombstone"];
  readonly faults?: DesktopActivationDeps["faults"];
}

function baseDeps(
  layout: HostFsLayout,
  lockPath: string,
  overrides: DepsOverrides,
): DesktopActivationDeps {
  return {
    layout,
    substrate: "smappservice",
    contender: {
      hostHomeDir: layout.rootDir,
      lockPath,
      reason: "desktop-executor-test",
      waitMs: 0,
      pollIntervalMs: 10,
    },
    nowIso: () => "2026-01-01T00:00:00.000Z",
    drain: overrides.drain ?? (async () => "idle"),
    commit: realCommit(layout),
    publishTombstone:
      overrides.publishTombstone ?? (async () => ({ kind: "published" })),
    // Default span: acquires nothing, runs the body. Tests that care about the
    // inner lock override it with a `busy` verdict.
    withActuatorLock:
      overrides.withActuatorLock ??
      (async (_capability, run) => ({ kind: "ran", value: await run() })),
    registerActuator:
      overrides.registerActuator ?? (async () => ({ kind: "activated" })),
    clearTombstone: overrides.clearTombstone ?? (async () => {}),
    acknowledge: async () => {},
    dispatchVerification: async () => ({ kind: "complete" }),
    faults: overrides.faults ?? NO_DESKTOP_EXECUTOR_FAULTS,
  };
}

/**
 * `action: "activate"` is now the only claim action this executor's type
 * accepts - `start` was made unrepresentable at the type level after the
 * `DesktopActivationRequest.action` narrowing (a fresh `create` lands with
 * `continuation: null`, which can never satisfy the active-target rule any
 * advance here requires). Every test therefore seeds a genuinely parked
 * attempt first and resumes it - the one path the transition core allows.
 */
async function seedParkedAttempt(
  layout: HostFsLayout,
  overrides: { readonly targetVersion?: string; readonly attemptId?: string },
): Promise<HostUpdateAttemptIdentity> {
  const targetVersion = overrides.targetVersion ?? "2.0.0";
  const attemptId = overrides.attemptId ?? "desktop-exec-attempt-1";
  const outer = await withUpdateContender(
    {
      hostHomeDir: layout.rootDir,
      reason: "seed-parked-attempt",
      waitMs: 0,
      pollIntervalMs: 10,
      admission: "attempt-executor",
    },
    async (capability) => {
      const created = await commitAttemptMutationWithCapability(
        capability,
        layout.rootDir,
        {
          kind: "create",
          request: {
            targetVersion,
            trigger: "manual",
            action: "start",
            expected: null,
            newAttemptId: attemptId,
            initialPhase: "applying",
            nowIso: "2025-12-31T00:00:00.000Z",
          },
        },
      );
      if (created.kind !== "committed") {
        throw new Error(`seed create failed: ${JSON.stringify(created)}`);
      }
      const parked = await commitAttemptMutationWithCapability(
        capability,
        layout.rootDir,
        {
          kind: "advance",
          held: created.identity,
          advance: {
            phase: "waiting-to-activate",
            continuation: "activate",
            progress: null,
            error: null,
            nowIso: "2025-12-31T00:01:00.000Z",
          },
        },
      );
      if (parked.kind !== "committed") {
        throw new Error(`seed park failed: ${JSON.stringify(parked)}`);
      }
      return parked.identity;
    },
  );
  if (outer.kind !== "ran") {
    throw new Error(`seed segment failed: ${outer.kind}`);
  }
  return outer.result;
}

/**
 * Seeds an ACTIVE (not parked) record - as if a prior executor died
 * mid-`applying` without ever settling it. Used both for the
 * `requires-recovery` test and to give the cohort-gate/refused-segment tests
 * a syntactically legal `expected` identity they never actually reach.
 */
async function seedOrphanedActiveAttempt(
  layout: HostFsLayout,
  overrides: { readonly targetVersion?: string; readonly attemptId?: string },
): Promise<HostUpdateAttemptIdentity> {
  const targetVersion = overrides.targetVersion ?? "1.9.0";
  const attemptId = overrides.attemptId ?? "orphaned-attempt";
  const outer = await withUpdateContender(
    {
      hostHomeDir: layout.rootDir,
      reason: "seed-orphaned-active-record",
      waitMs: 0,
      pollIntervalMs: 10,
      admission: "attempt-executor",
    },
    async (capability) =>
      commitAttemptMutationWithCapability(capability, layout.rootDir, {
        kind: "create",
        request: {
          targetVersion,
          trigger: "manual",
          action: "start",
          expected: null,
          newAttemptId: attemptId,
          initialPhase: "applying",
          nowIso: "2025-12-31T00:00:00.000Z",
        },
      }),
  );
  if (outer.kind !== "ran" || outer.result.kind !== "committed") {
    throw new Error(`seed orphaned attempt failed: ${JSON.stringify(outer)}`);
  }
  return outer.result.identity;
}

function activateRequest(
  identity: HostUpdateAttemptIdentity,
  overrides: Partial<DesktopActivationRequest>,
): DesktopActivationRequest {
  return {
    targetVersion: "2.0.0",
    trigger: "manual",
    action: "activate",
    expected: identity,
    newAttemptId: identity.attemptId,
    overrideDrain: false,
    ...overrides,
  };
}

describe("runDesktopActivationSegment - cohort gate", () => {
  /** Install the REAL shipped verdict for one test, not a mock default. */
  async function useShippedCohort(): Promise<void> {
    cohortMock.decide.mockReset();
    const actual = await vi.importActual<
      typeof import("../update-executor-cohort")
    >("../update-executor-cohort");
    cohortMock.decide.mockImplementation(
      actual.decideDesktopUpdateExecutorCohort,
    );
  }

  // RETARGETED by Ticket 07 Finding 2, and the retarget is the point rather
  // than a repair - read this before assuming the old assertion was simply
  // re-baselined.
  //
  // This test used to seed a PARKED attempt and assert `cohort-disabled`,
  // under the claim "the executor is unreachable under the shipped verdict".
  // That claim is deliberately no longer true for a parked attempt: a parked
  // `activate` record IS an adopted continuation, and the ruled kill-switch
  // semantics are "stops admitting NEW attempts; never abandons an ADOPTED
  // one". Leaving the old fixture would have pinned the stranding as correct.
  //
  // So the assertion is preserved exactly, and the FIXTURE moves to the case
  // where the original claim still holds: nothing adopted on disk. The pair
  // below pins both halves of that sentence, and each half is what makes the
  // other non-vacuous.
  it("rejects with cohort-disabled under the shipped cohort when NOTHING is adopted", async () => {
    await useShippedCohort();

    const layout = await freshLayout();
    // No seed: an empty host home has no adopted continuation, so the gate is
    // the thing that decides. `cohort-disabled` is reachable from nowhere else
    // in this function, which is what makes it a gate assertion rather than a
    // "something refused" assertion.
    const outcome = await runDesktopActivationSegment(
      activateRequest(
        { attemptId: "no-such-attempt", generation: 1, sequence: 1 },
        {},
      ),
      baseDeps(layout, join(layout.rootDir, "cli-lock"), {}),
    );
    expect(outcome).toEqual({ kind: "rejected", reason: "cohort-disabled" });
  });

  it("does NOT reject an already-ADOPTED activation continuation, even under the shipped disabled cohort", async () => {
    await useShippedCohort();

    const layout = await freshLayout();
    const identity = await seedParkedAttempt(layout, {});
    const outcome = await runDesktopActivationSegment(
      activateRequest(identity, {}),
      baseDeps(layout, join(layout.rootDir, "cli-lock"), {}),
    );
    // The specific negative matters more than the positive here: whatever the
    // segment goes on to do, it must not be refused BY THE GATE. Asserting a
    // concrete success shape instead would couple this to the drain/actuator
    // defaults and start failing for reasons unrelated to the gate.
    expect(outcome).not.toEqual({
      kind: "rejected",
      reason: "cohort-disabled",
    });
  });
});

describe("runDesktopActivationSegment - the claimed trace (cohort forced eligible)", () => {
  it("resumes a parked attempt, drains idle, advances to restarting, publishes the tombstone, activates, releases, and dispatches verification", async () => {
    eligibleCohort();
    const layout = await freshLayout();
    const lockPath = join(layout.rootDir, "cli-lock");
    const identity = await seedParkedAttempt(layout, {});
    const seenPhasesAtTombstone: string[] = [];
    const acknowledged: unknown[] = [];
    let verificationIdentity: unknown = null;

    const outcome = await runDesktopActivationSegment(
      activateRequest(identity, {}),
      {
        ...baseDeps(layout, lockPath, {
          publishTombstone: async (capability) => {
            seenPhasesAtTombstone.push((await currentRecord(layout)).phase);
            void capability;
            return { kind: "published" };
          },
        }),
        acknowledge: async (ackIdentity) => {
          acknowledged.push(ackIdentity);
        },
        dispatchVerification: async (dispatchIdentity) => {
          verificationIdentity = dispatchIdentity;
          // The segment's own lock must already be released by the time
          // verification is dispatched - a fresh contender must be able to
          // acquire immediately.
          const reacquired = await withUpdateContender(
            {
              hostHomeDir: layout.rootDir,
              reason: "post-release-probe",
              waitMs: 0,
              pollIntervalMs: 10,
              admission: "legacy-update-shadow",
            },
            async () => "probed",
          );
          expect(reacquired.kind).not.toBe("busy");
          expect(reacquired.kind).not.toBe("held-in-process");
          return { kind: "complete" };
        },
      },
    );

    expect(outcome).toMatchObject({
      kind: "verified",
      verification: { kind: "complete" },
    });
    // `restarting` must be committed BEFORE the tombstone publish is even
    // attempted - the whole ordering contract (design §3.4).
    expect(seenPhasesAtTombstone).toEqual(["restarting"]);
    expect(acknowledged).toHaveLength(1);
    expect(verificationIdentity).not.toBeNull();
    if (outcome.kind === "verified") {
      expect(outcome.identity).toEqual(verificationIdentity);
    }
    // Desktop itself never advances past `restarting` - `dispatchVerification`
    // is a pure dispatcher to the CLI's own first-class claim (design §6.2);
    // nothing in this segment commits `verifying`.
    const record = await currentRecord(layout);
    expect(record.phase).toBe("restarting");
  });
});

describe("runDesktopActivationSegment - drain busy", () => {
  it("without overrideDrain, re-parks waiting-to-activate/activate and never reaches the tombstone - the ONLY park this segment can still reach", async () => {
    eligibleCohort();
    const layout = await freshLayout();
    const lockPath = join(layout.rootDir, "cli-lock");
    const identity = await seedParkedAttempt(layout, {});
    let tombstoneCalled = false;

    const outcome = await runDesktopActivationSegment(
      activateRequest(identity, {}),
      {
        ...baseDeps(layout, lockPath, {
          drain: async () => "busy",
          publishTombstone: async () => {
            tombstoneCalled = true;
            return { kind: "published" };
          },
        }),
      },
    );

    expect(outcome).toEqual({ kind: "parked", reason: "drain-busy" });
    expect(tombstoneCalled).toBe(false);
    const record = await currentRecord(layout);
    // The drain runs while the record is still `preparing`, whose legal
    // successors include `waiting-to-activate` - this park is reachable
    // precisely because it happens before `restarting` is ever committed.
    expect(record.phase).toBe("waiting-to-activate");
    expect(record.continuation).toBe("activate");
    expect(record.execution).not.toBe("terminal");
  });

  it("with overrideDrain, proceeds straight through past the busy drain to a real activation", async () => {
    eligibleCohort();
    const layout = await freshLayout();
    const lockPath = join(layout.rootDir, "cli-lock");
    const identity = await seedParkedAttempt(layout, {});

    const outcome = await runDesktopActivationSegment(
      activateRequest(identity, { overrideDrain: true }),
      baseDeps(layout, lockPath, { drain: async () => "busy" }),
    );

    expect(outcome.kind).toBe("verified");
    const record = await currentRecord(layout);
    expect(record.phase).toBe("restarting");
  });
});

describe("runDesktopActivationSegment - tombstone publish failure terminalizes (no park is reachable from restarting)", () => {
  it("terminalizes failed with a diagnostic, never boots out, and commits no false promise back to the record", async () => {
    eligibleCohort();
    const layout = await freshLayout();
    const lockPath = join(layout.rootDir, "cli-lock");
    const identity = await seedParkedAttempt(layout, {});
    let activateCalled = false;
    let clearTombstoneCalled = false;

    const outcome = await runDesktopActivationSegment(
      activateRequest(identity, {}),
      {
        ...baseDeps(layout, lockPath, {
          publishTombstone: async () => ({
            kind: "not-published",
            cause: "test-injected-flush-failure",
          }),
          registerActuator: async () => {
            activateCalled = true;
            return { kind: "activated" };
          },
          clearTombstone: async () => {
            clearTombstoneCalled = true;
          },
        }),
      },
    );

    expect(outcome).toEqual({
      kind: "failed",
      reason: "tombstone-not-published",
      cause: "test-injected-flush-failure",
    });
    expect(activateCalled).toBe(false);
    // Nothing was ever published in the first place - withdrawing it is only
    // the activation-declined branch's job.
    expect(clearTombstoneCalled).toBe(false);

    const record = await currentRecord(layout);
    expect(record.phase).toBe("failed");
    expect(record.execution).toBe("terminal");
    expect(record.continuation).toBeNull();
    expect(record.error).toMatchObject({
      code: "tombstone-not-published",
      message: "test-injected-flush-failure",
      phase: "restarting",
    });
  });

  it("a fresh fixture with a working flush still activates fully - the terminalize path is specific to the failure, not a permanent regression of the happy path", async () => {
    eligibleCohort();
    const layout = await freshLayout();
    const lockPath = join(layout.rootDir, "cli-lock");
    const identity = await seedParkedAttempt(layout, {});

    const outcome = await runDesktopActivationSegment(
      activateRequest(identity, {}),
      baseDeps(layout, lockPath, {}),
    );
    expect(outcome.kind).toBe("verified");
    const record = await currentRecord(layout);
    expect(record.phase).toBe("restarting");
  });
});

describe("runDesktopActivationSegment - activation (SMAppService cycle) failure terminalizes, withdrawing the tombstone first", () => {
  it("withdraws the published tombstone BEFORE terminalizing - ordering matters, not just that both happened", async () => {
    eligibleCohort();
    const layout = await freshLayout();
    const lockPath = join(layout.rootDir, "cli-lock");
    const identity = await seedParkedAttempt(layout, {});
    const tombstonePath = hostStopIntentPath(layout.rootDir);
    let phaseWhenTombstoneCleared: string | null = null;

    // Real tombstone publish/withdraw (not mocked) so the on-disk file's
    // presence/absence can be asserted directly, not merely inferred from a
    // spy call count.
    const outcome = await runDesktopActivationSegment(
      activateRequest(identity, {}),
      {
        ...baseDeps(layout, lockPath, {
          publishTombstone: (capability) =>
            publishRestartTombstoneWithAttempt(capability, layout),
          registerActuator: async () => ({
            kind: "deferred",
            message: "not yet",
          }),
          clearTombstone: async (capability) => {
            // The record must still say `restarting` at the moment the
            // withdrawal runs - proving withdrawal happens BEFORE the
            // terminalizing commit, not merely somewhere in the same call.
            phaseWhenTombstoneCleared = (await currentRecord(layout)).phase;
            await expect(stat(tombstonePath)).resolves.toBeDefined();
            await clearRestartTombstoneWithAttempt(capability, layout);
          },
        }),
      },
    );

    expect(outcome).toEqual({
      kind: "failed",
      reason: "activation-not-performed",
      cause: "not yet",
    });
    expect(phaseWhenTombstoneCleared).toBe("restarting");
    // Gone for good - no client is left holding an expected-restart episode
    // for a restart that never happened.
    await expect(stat(tombstonePath)).rejects.toThrow();

    const record = await currentRecord(layout);
    expect(record.phase).toBe("failed");
    expect(record.execution).toBe("terminal");
    expect(record.error).toMatchObject({
      code: "activation-not-performed",
      message: "not yet",
      phase: "restarting",
    });
  });
});

describe("runDesktopActivationSegment - requires-recovery is not Desktop's to answer", () => {
  it("rejects a resume attempt on an orphaned still-active record rather than silently completing it, and writes nothing", async () => {
    eligibleCohort();
    const layout = await freshLayout();
    const lockPath = join(layout.rootDir, "cli-lock");

    // Seed an orphaned ACTIVE record, as if a prior executor died
    // mid-`applying`. A subsequent claim naming exactly THIS attempt still
    // finds it active (lock free), which is `requires-recovery` by design
    // (`transition.ts` checks recovery before target comparison, for EVERY
    // active record).
    const identity = await seedOrphanedActiveAttempt(layout, {
      targetVersion: "1.9.0",
    });
    const before = await currentRecord(layout);
    expect(before.execution).toBe("active");

    const outcome = await runDesktopActivationSegment(
      activateRequest(identity, { targetVersion: "1.9.0" }),
      baseDeps(layout, lockPath, {}),
    );

    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "requires-recovery",
    });
    const after = await currentRecord(layout);
    expect(after).toEqual(before);
  });
});

describe("runDesktopActivationSegment - fault injection before restarting (resumed claim)", () => {
  const points: readonly DesktopExecutorFaultPoint[] = [
    "before-claim-write",
    "after-claim-write-before-ack",
    "after-private-ack-before-drain",
    "after-drain-before-restarting",
  ];

  it.each(points)(
    "crashing at %s leaves the update-attempt lock released and the record in a legible, non-corrupt state",
    async (point) => {
      eligibleCohort();
      const layout = await freshLayout();
      const lockPath = join(layout.rootDir, "cli-lock");
      const identity = await seedParkedAttempt(layout, {});
      const before = await currentRecord(layout);
      const injected = new Error(`injected fault at ${point}`);

      await expect(
        runDesktopActivationSegment(activateRequest(identity, {}), {
          ...baseDeps(layout, lockPath, {
            faults: {
              async hit(hitPoint) {
                if (hitPoint === point) throw injected;
              },
            },
          }),
        }),
      ).rejects.toBe(injected);

      // The lock is never left stuck behind a crashed segment - a fresh
      // contender must be able to acquire it immediately.
      const reacquired = await withUpdateContender(
        {
          hostHomeDir: layout.rootDir,
          reason: `post-crash-probe-${point}`,
          waitMs: 0,
          pollIntervalMs: 10,
          admission: "legacy-update-shadow",
        },
        async () => "probed",
      );
      expect(reacquired.kind).not.toBe("busy");
      expect(reacquired.kind).not.toBe("held-in-process");

      const record = await currentRecord(layout);
      if (point === "before-claim-write") {
        // Nothing was written yet - still exactly the seeded park.
        expect(record).toEqual(before);
        return;
      }
      // Claimed (resumed to `preparing`), but no further than the drain -
      // never skips ahead of what was actually committed.
      expect(record.phase).toBe("preparing");
      expect(record.execution).toBe("active");
    },
  );
});

describe("runDesktopActivationSegment - fault injection at and after restarting (resumed claim)", () => {
  const points: readonly DesktopExecutorFaultPoint[] = [
    "after-restarting-before-tombstone",
    "after-tombstone-before-bootout",
    "after-bootout-before-release",
  ];

  it.each(points)(
    "crashing at %s leaves the update-attempt lock released and the record legitimately at restarting - the shape post-restart recovery reconciles",
    async (point) => {
      eligibleCohort();
      const layout = await freshLayout();
      const lockPath = join(layout.rootDir, "cli-lock");
      const identity = await seedParkedAttempt(layout, {});
      const injected = new Error(`injected fault at ${point}`);

      await expect(
        runDesktopActivationSegment(activateRequest(identity, {}), {
          ...baseDeps(layout, lockPath, {
            faults: {
              async hit(hitPoint) {
                if (hitPoint === point) throw injected;
              },
            },
          }),
        }),
      ).rejects.toBe(injected);

      const reacquired = await withUpdateContender(
        {
          hostHomeDir: layout.rootDir,
          reason: `post-crash-probe-${point}`,
          waitMs: 0,
          pollIntervalMs: 10,
          admission: "legacy-update-shadow",
        },
        async () => "probed",
      );
      expect(reacquired.kind).not.toBe("busy");
      expect(reacquired.kind).not.toBe("held-in-process");

      const record = await currentRecord(layout);
      expect(record.phase).toBe("restarting");
      expect(record.execution).toBe("active");
    },
  );

  it("crashing after release but before dispatching verification leaves the lock free (the segment had already released it)", async () => {
    eligibleCohort();
    const layout = await freshLayout();
    const lockPath = join(layout.rootDir, "cli-lock");
    const identity = await seedParkedAttempt(layout, {});
    const injected = new Error(
      "injected fault after release, before verification",
    );

    await expect(
      runDesktopActivationSegment(activateRequest(identity, {}), {
        ...baseDeps(layout, lockPath, {
          faults: {
            async hit(hitPoint) {
              if (hitPoint === "after-release-before-verification") {
                throw injected;
              }
            },
          },
        }),
      }),
    ).rejects.toBe(injected);

    const reacquired = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "post-release-crash-probe",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "legacy-update-shadow",
      },
      async () => "probed",
    );
    expect(reacquired.kind).not.toBe("busy");
    const record = await currentRecord(layout);
    // Bootout already happened by this point - the record is `restarting`,
    // durably promising a comeback, exactly what makes it safe to have
    // already released the lock before the crash.
    expect(record.phase).toBe("restarting");
  });
});

describe("runDesktopActivationSegment - refused segment (outer contention)", () => {
  it("reports refused with the raw contender outcome when the attempt lock is genuinely busy", async () => {
    eligibleCohort();
    const layout = await freshLayout();
    const lockPath = join(layout.rootDir, "cli-lock");

    const outer = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "hold-for-refusal-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async () => {
        // The lock is held by this very callback, so `seedParkedAttempt`
        // (which acquires the same lock) cannot run here - a syntactically
        // legal but never-consulted identity is enough, since the outer
        // contention refuses before any claim is attempted.
        const dummyIdentity: HostUpdateAttemptIdentity = {
          attemptId: "never-reached",
          generation: 1,
          sequence: 1,
        };
        const outcome = await runDesktopActivationSegment(
          activateRequest(dummyIdentity, {}),
          baseDeps(layout, lockPath, {}),
        );
        expect(outcome.kind).toBe("refused");
        if (outcome.kind === "refused") {
          expect(outcome.outcome.kind).toBe("busy");
        }
        return "outer-ok";
      },
    );
    expect(outer).toMatchObject({ kind: "ran", result: "outer-ok" });
  });
});
