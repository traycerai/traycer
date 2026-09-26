import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __resetHeldInProcessForTest } from "../lock";
import { updateAttemptRecordPath } from "../paths";
import type {
  HostUpdateAttemptClaimBaseline,
  HostUpdateAttemptRecord,
} from "../record";
import {
  withSupervisorRelaunchContender,
  withUpdateContender,
  withUpdateExecutorCompletionSegment,
  type SupervisorRelaunchInstalledIdentity,
  type UpdateContenderAdmission,
  type UpdateContenderExecutionContext,
  type UpdateContenderOutcome,
} from "../contender";

// Admission x record-shape table. Every cell is a LITERAL, written out by
// hand and never derived from a production helper: the point is that any
// change to what an existing admission does over any record shape reddens a
// named cell. `lifecycle-teardown-maintenance` was added additively; its rows
// live in their own describe so the existing rows can be run alone against the
// pre-change `contender.ts`.

type Cell = "ran" | "yield" | "refuse" | "record-fail-closed";

type ShapeName =
  | "absent"
  | "complete"
  | "failed"
  | "superseded"
  | "downloading"
  | "preparing-null"
  | "preparing-resume-apply"
  | "preparing-activate"
  | "applying"
  | "waiting-for-work"
  | "waiting-to-activate-claim"
  | "waiting-to-activate-claimless"
  | "restarting"
  | "verifying"
  | "faulted";

type ShapeTable = { readonly [shape in ShapeName]: Cell };

type ExistingAdmission = Exclude<
  UpdateContenderAdmission,
  "lifecycle-teardown-maintenance"
>;

const SHAPE_NAMES: readonly ShapeName[] = [
  "absent",
  "complete",
  "failed",
  "superseded",
  "downloading",
  "preparing-null",
  "preparing-resume-apply",
  "preparing-activate",
  "applying",
  "waiting-for-work",
  "waiting-to-activate-claim",
  "waiting-to-activate-claimless",
  "restarting",
  "verifying",
  "faulted",
];

const INSTALL_GENERATION = "install-7|2026-01-01T00:00:00.000Z|abc123|1.2.3";

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "contender-admission-table-"));
  roots.push(root);
  return join(root, "host-home");
}

afterEach(async () => {
  __resetHeldInProcessForTest();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function record(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRecord {
  return {
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
    ...overrides,
  };
}

const CLAIM: HostUpdateAttemptClaimBaseline = {
  installedVersion: "1.2.3",
  installGeneration: INSTALL_GENERATION,
  stageFingerprint: null,
  allowDowngrade: false,
  acceptStoreFormatLoss: false,
};

const INSTALLED: SupervisorRelaunchInstalledIdentity = {
  installedVersion: "1.2.3",
  installGeneration: INSTALL_GENERATION,
};

/** The on-disk content for a shape: a record, raw text, or nothing at all. */
function contentFor(shape: ShapeName): HostUpdateAttemptRecord | string | null {
  switch (shape) {
    case "absent":
      return null;
    case "complete":
      return record({
        phase: "complete",
        execution: "terminal",
        completedAt: "2026-01-01T00:10:00.000Z",
      });
    case "failed":
      return record({
        phase: "failed",
        execution: "terminal",
        completedAt: "2026-01-01T00:10:00.000Z",
        error: {
          code: "HOST_UPDATE_FAILED",
          message: "test failure",
          phase: "failed",
        },
      });
    case "superseded":
      return record({
        phase: "superseded",
        execution: "terminal",
        completedAt: "2026-01-01T00:10:00.000Z",
      });
    case "downloading":
      return record({ phase: "downloading", execution: "active" });
    case "preparing-null":
      return record({ phase: "preparing", execution: "active" });
    case "preparing-resume-apply":
      return record({
        phase: "preparing",
        execution: "active",
        continuation: "resume-apply",
      });
    case "preparing-activate":
      return record({
        phase: "preparing",
        execution: "active",
        continuation: "activate",
      });
    case "applying":
      return record({ phase: "applying", execution: "active" });
    case "waiting-for-work":
      return record({
        phase: "waiting-for-work",
        execution: "parked",
        continuation: "resume-apply",
        claim: CLAIM,
      });
    case "waiting-to-activate-claim":
      return record({
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
        claim: CLAIM,
      });
    case "waiting-to-activate-claimless":
      return record({
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
      });
    case "restarting":
      return record({
        phase: "restarting",
        execution: "active",
        continuation: "resume-apply",
      });
    case "verifying":
      return record({
        phase: "verifying",
        execution: "active",
        continuation: "resume-apply",
      });
    case "faulted":
      return "{ this is not a v2 attempt record";
  }
}

async function seed(hostHomeDir: string, shape: ShapeName): Promise<void> {
  const content = contentFor(shape);
  if (content === null) return;
  await mkdir(hostHomeDir, { recursive: true });
  await writeFile(
    updateAttemptRecordPath(hostHomeDir),
    typeof content === "string" ? content : `${JSON.stringify(content)}\n`,
  );
}

function cellOf(outcome: UpdateContenderOutcome<string>): Cell {
  switch (outcome.kind) {
    case "ran":
      return "ran";
    case "nonterminal-attempt":
      return outcome.disposition;
    case "record-fail-closed":
      return "record-fail-closed";
    case "busy":
    case "held-in-process":
    case "lock-not-live":
      throw new Error(`unexpected outcome ${outcome.kind}`);
  }
}

/**
 * Enters each admission by the public door that reaches it: the executor
 * through its completion segment, the relaunch through its entry point with
 * ONE fixed identity reader (installed version = the target, generation =
 * the claim fixture's), everything else through `withUpdateContender`.
 */
async function enter(
  hostHomeDir: string,
  admission: UpdateContenderAdmission,
  onContext: (context: UpdateContenderExecutionContext) => void,
): Promise<UpdateContenderOutcome<string>> {
  const base = {
    hostHomeDir,
    reason: "admission-table",
    waitMs: 0,
    pollIntervalMs: 10,
  };
  const run = async (
    _capability: unknown,
    context: UpdateContenderExecutionContext,
  ): Promise<string> => {
    onContext(context);
    return "ran";
  };
  if (admission === "attempt-executor") {
    return withUpdateExecutorCompletionSegment(base, run);
  }
  if (admission === "supervisor-relaunch-maintenance") {
    return withSupervisorRelaunchContender(
      { ...base, readInstalledIdentity: async () => INSTALLED },
      run,
    );
  }
  return withUpdateContender({ ...base, admission }, run);
}

const EXISTING_ADMISSION_TABLE: {
  readonly [admission in ExistingAdmission]: ShapeTable;
} = {
  "legacy-update-shadow": {
    absent: "ran",
    complete: "ran",
    failed: "ran",
    superseded: "ran",
    downloading: "yield",
    "preparing-null": "yield",
    "preparing-resume-apply": "yield",
    "preparing-activate": "yield",
    applying: "yield",
    "waiting-for-work": "yield",
    "waiting-to-activate-claim": "yield",
    "waiting-to-activate-claimless": "yield",
    restarting: "yield",
    verifying: "yield",
    faulted: "record-fail-closed",
  },
  "stage-maintenance": {
    absent: "ran",
    complete: "ran",
    failed: "ran",
    superseded: "ran",
    downloading: "yield",
    "preparing-null": "yield",
    "preparing-resume-apply": "yield",
    "preparing-activate": "yield",
    applying: "yield",
    "waiting-for-work": "yield",
    "waiting-to-activate-claim": "yield",
    "waiting-to-activate-claimless": "yield",
    restarting: "yield",
    verifying: "yield",
    faulted: "record-fail-closed",
  },
  "service-maintenance": {
    absent: "ran",
    complete: "ran",
    failed: "ran",
    superseded: "ran",
    downloading: "refuse",
    "preparing-null": "refuse",
    "preparing-resume-apply": "refuse",
    "preparing-activate": "refuse",
    applying: "refuse",
    "waiting-for-work": "refuse",
    "waiting-to-activate-claim": "refuse",
    "waiting-to-activate-claimless": "refuse",
    restarting: "refuse",
    verifying: "refuse",
    faulted: "record-fail-closed",
  },
  "desktop-activation-maintenance": {
    absent: "ran",
    complete: "ran",
    failed: "ran",
    superseded: "ran",
    downloading: "refuse",
    "preparing-null": "refuse",
    "preparing-resume-apply": "refuse",
    "preparing-activate": "refuse",
    applying: "refuse",
    "waiting-for-work": "refuse",
    "waiting-to-activate-claim": "refuse",
    "waiting-to-activate-claimless": "refuse",
    restarting: "refuse",
    verifying: "refuse",
    faulted: "record-fail-closed",
  },
  "uninstall-maintenance": {
    absent: "ran",
    complete: "ran",
    failed: "ran",
    superseded: "ran",
    downloading: "refuse",
    "preparing-null": "refuse",
    "preparing-resume-apply": "refuse",
    "preparing-activate": "refuse",
    applying: "refuse",
    "waiting-for-work": "refuse",
    "waiting-to-activate-claim": "refuse",
    "waiting-to-activate-claimless": "refuse",
    restarting: "refuse",
    verifying: "refuse",
    faulted: "record-fail-closed",
  },
  "runtime-repair-maintenance": {
    absent: "ran",
    complete: "ran",
    failed: "ran",
    superseded: "ran",
    downloading: "refuse",
    "preparing-null": "refuse",
    "preparing-resume-apply": "refuse",
    "preparing-activate": "refuse",
    applying: "refuse",
    "waiting-for-work": "refuse",
    "waiting-to-activate-claim": "refuse",
    "waiting-to-activate-claimless": "refuse",
    restarting: "refuse",
    verifying: "refuse",
    faulted: "record-fail-closed",
  },
  "host-uninstall-maintenance": {
    absent: "ran",
    complete: "ran",
    failed: "ran",
    superseded: "ran",
    downloading: "ran",
    "preparing-null": "ran",
    "preparing-resume-apply": "ran",
    "preparing-activate": "ran",
    applying: "ran",
    "waiting-for-work": "ran",
    "waiting-to-activate-claim": "ran",
    "waiting-to-activate-claimless": "ran",
    restarting: "ran",
    verifying: "ran",
    faulted: "record-fail-closed",
  },
  "desktop-install-maintenance": {
    absent: "ran",
    complete: "ran",
    failed: "ran",
    superseded: "ran",
    downloading: "ran",
    "preparing-null": "ran",
    "preparing-resume-apply": "ran",
    "preparing-activate": "ran",
    applying: "ran",
    "waiting-for-work": "ran",
    "waiting-to-activate-claim": "ran",
    "waiting-to-activate-claimless": "ran",
    restarting: "ran",
    verifying: "ran",
    faulted: "record-fail-closed",
  },
  "recovery-maintenance": {
    absent: "ran",
    complete: "ran",
    failed: "ran",
    superseded: "ran",
    downloading: "ran",
    "preparing-null": "ran",
    "preparing-resume-apply": "ran",
    "preparing-activate": "ran",
    applying: "ran",
    "waiting-for-work": "ran",
    "waiting-to-activate-claim": "ran",
    "waiting-to-activate-claimless": "ran",
    restarting: "ran",
    verifying: "ran",
    faulted: "record-fail-closed",
  },
  "attempt-executor": {
    absent: "ran",
    complete: "ran",
    failed: "ran",
    superseded: "ran",
    downloading: "ran",
    "preparing-null": "ran",
    "preparing-resume-apply": "ran",
    "preparing-activate": "ran",
    applying: "ran",
    "waiting-for-work": "ran",
    "waiting-to-activate-claim": "ran",
    "waiting-to-activate-claimless": "ran",
    restarting: "ran",
    verifying: "ran",
    faulted: "record-fail-closed",
  },
  "supervisor-relaunch-maintenance": {
    absent: "ran",
    complete: "ran",
    failed: "ran",
    superseded: "ran",
    downloading: "refuse",
    "preparing-null": "refuse",
    "preparing-resume-apply": "refuse",
    "preparing-activate": "ran",
    applying: "refuse",
    "waiting-for-work": "ran",
    "waiting-to-activate-claim": "ran",
    "waiting-to-activate-claimless": "refuse",
    restarting: "ran",
    verifying: "ran",
    faulted: "record-fail-closed",
  },
};

describe("existing admissions x record shapes (pinned to the pre-lifecycle-teardown outputs)", () => {
  for (const admission of Object.keys(
    EXISTING_ADMISSION_TABLE,
  ) as ExistingAdmission[]) {
    for (const shape of SHAPE_NAMES) {
      it(`${admission} over ${shape}`, async () => {
        const hostHomeDir = await freshHome();
        await seed(hostHomeDir, shape);
        const outcome = await enter(hostHomeDir, admission, () => undefined);
        expect(cellOf(outcome)).toBe(
          EXISTING_ADMISSION_TABLE[admission][shape],
        );
      });
    }
  }
});

const LIFECYCLE_TEARDOWN_TABLE: ShapeTable = {
  absent: "ran",
  complete: "ran",
  failed: "ran",
  superseded: "ran",
  downloading: "refuse",
  "preparing-null": "refuse",
  "preparing-resume-apply": "refuse",
  "preparing-activate": "refuse",
  applying: "refuse",
  "waiting-for-work": "ran",
  "waiting-to-activate-claim": "ran",
  "waiting-to-activate-claimless": "ran",
  restarting: "refuse",
  verifying: "refuse",
  faulted: "record-fail-closed",
};

describe("lifecycle-teardown-maintenance x record shapes", () => {
  for (const shape of SHAPE_NAMES) {
    it(`over ${shape}`, async () => {
      const hostHomeDir = await freshHome();
      await seed(hostHomeDir, shape);
      const outcome = await enter(
        hostHomeDir,
        "lifecycle-teardown-maintenance",
        () => undefined,
      );
      expect(cellOf(outcome)).toBe(LIFECYCLE_TEARDOWN_TABLE[shape]);
    });
  }

  it.each([
    "waiting-for-work",
    "waiting-to-activate-claim",
    "waiting-to-activate-claimless",
  ] as const)(
    "over the %s park the callback sees that record as activeAttempt and the file is untouched",
    async (shape) => {
      const hostHomeDir = await freshHome();
      await seed(hostHomeDir, shape);
      const path = updateAttemptRecordPath(hostHomeDir);
      const before = await readFile(path, "utf8");
      const seen: UpdateContenderExecutionContext[] = [];
      const outcome = await enter(
        hostHomeDir,
        "lifecycle-teardown-maintenance",
        (context) => {
          seen.push(context);
        },
      );
      expect(outcome.kind).toBe("ran");
      expect(seen).toHaveLength(1);
      expect(seen[0].activeAttempt).toEqual(contentFor(shape));
      expect(await readFile(path, "utf8")).toBe(before);
    },
  );
});
