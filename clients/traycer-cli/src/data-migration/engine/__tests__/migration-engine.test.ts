import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireMigrationCoordinatorLock } from "@traycer/protocol/config/data-migration-admission";
import {
  sessionImpactDigest,
  storeManifestDigest,
  type MaintenanceOperation,
  type SessionImpact,
  type Sha256Digest,
} from "@traycer/protocol/config/data-migration-contracts";
import { loadContentInventory, underRoot } from "../content-inventory";
import type { MigrationEngineDeps } from "../engine-deps";
import {
  diagnoseMigration,
  inspectMigrationReadonly,
  pointerState,
  presentImpact,
  resumeMigration,
  rollbackMigration,
  startMigration,
} from "../migration-engine";
import type { EngineResult } from "../engine-types";
import {
  assertDone,
  assertStopped,
  blockerCodes,
  contentTree,
  CrashError,
  crashAtCheckpoint,
  DEFAULT_STORES,
  expectCompleted,
  expectRolledBack,
  factTree,
  freshContextImpact,
  harnessScope,
  nativeFallbackImpact,
  PROVIDER_FILE,
  readActiveJournal,
  readLocation,
  recordingCheckpoint,
  snapshotIfPresent,
  STATE_DISABLED,
  STATE_ENABLED,
  type EngineHarness,
} from "./engine-fixtures";

const PARTICIPANT_PID = 424242;
const WRONG_DIGEST: Sha256Digest = `sha256:${"0".repeat(64)}`;
const PROVIDER_ROOT = "host/harness-accounts/claude/p1";

function start(
  harness: EngineHarness,
  overrides: Partial<MigrationEngineDeps>,
): Promise<EngineResult> {
  return startMigration(harness.makeDeps(overrides), {
    destination: harness.destinationRoot,
    acceptedSessionImpactDigest: null,
    reviewImpact: false,
  });
}

function resume(
  harness: EngineHarness,
  accepted: Sha256Digest | null,
  overrides: Partial<MigrationEngineDeps>,
): Promise<EngineResult> {
  return resumeMigration(harness.makeDeps(overrides), {
    acceptedSessionImpactDigest: accepted,
    reviewImpact: false,
  });
}

function startReviewed(
  harness: EngineHarness,
  overrides: Partial<MigrationEngineDeps>,
): Promise<EngineResult> {
  return startMigration(harness.makeDeps(overrides), {
    destination: harness.destinationRoot,
    acceptedSessionImpactDigest: null,
    reviewImpact: true,
  });
}

function resumeReviewed(
  harness: EngineHarness,
  accepted: Sha256Digest | null,
  overrides: Partial<MigrationEngineDeps>,
): Promise<EngineResult> {
  return resumeMigration(harness.makeDeps(overrides), {
    acceptedSessionImpactDigest: accepted,
    reviewImpact: true,
  });
}

const NATIVE_HOLD = (sessionId: string): SessionImpact => ({
  ...freshContextImpact(sessionId),
  route: { primary: "native-resume", onFailure: "hold" },
});

function digestOf(
  impact: SessionImpact[] | null,
  harness: EngineHarness,
): Sha256Digest {
  return sessionImpactDigest({
    version: 1,
    sourceRoot: harness.sourceRoot,
    destinationRoot: harness.destinationRoot,
    sessions: impact ?? [],
  });
}

describe.skipIf(process.platform === "win32")(
  "migration engine",
  { timeout: 120_000 },
  () => {
    const scope = harnessScope();

    describe("the happy path", () => {
      it("moves the data folder: journal complete, pointer switched, every byte equal, source untouched", async () => {
        const h = await scope.create();
        const recording = recordingCheckpoint(h.normalizeCheckpoint);
        const journal = assertDone(
          await start(h, { checkpoint: recording.checkpoint }),
        );

        await expectCompleted(h, journal, h.initial);
        expect(journal.previousLocation).toBeNull();
        expect(journal.nextGeneration).toBe(1);
        expect(journal.rollbackFromPhase).toBeNull();
        expect(journal.coordinatorBuild.build).toBe("test-cli");
        expect(journal.maintenanceBuild).toEqual({
          component: "maintenance",
          build: "test-host",
          dataMigrationProtocol: 1,
        });
        expect(journal.inventoryDigest).toBe(
          storeManifestDigest(DEFAULT_STORES),
        );
        expect(journal.sourceIdentityDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(journal.sessionImpactDigest).toBe(digestOf([], h));
        expect(journal.acceptedSessionImpactDigest).toBeNull();
        expect(journal.destination.volumeId).not.toBeNull();
        expect(journal.destination.directoryId).not.toBeNull();
        expect((await lstat(h.destinationRoot)).mode & 0o077).toBe(0);
        expect(journal.copyManifest).toMatchObject({
          byteCount: h.tree.byteCount,
          verifiedCount: h.tree.fileCount,
        });
        expect(readActiveJournal(h.bootstrapDir)).toEqual(journal);

        const inventory = await loadContentInventory({
          destinationRoot: h.destinationRoot,
          migrationId: journal.id,
          digest: journal.copyManifest?.digest ?? WRONG_DIGEST,
        });
        expect(inventory.header.providerRoots).toEqual([PROVIDER_ROOT]);
        expect(inventory.header.fileCount).toBe(h.tree.fileCount);
      });

      it("walks the phases in order and drives the ledger's quiesce, prepare and activate actions in that order", async () => {
        const h = await scope.create();
        const recording = recordingCheckpoint(h.normalizeCheckpoint);
        const journal = assertDone(
          await start(h, { checkpoint: recording.checkpoint }),
        );

        const phases: string[] = [];
        for (const point of recording.sequence) {
          const match = /^after-journal:(.+)$/u.exec(point);
          const phase = match?.[1];
          if (phase !== undefined && !phases.includes(phase))
            phases.push(phase);
        }
        expect(phases).toEqual([
          "planned",
          "quiescing",
          "copying",
          "repairing",
          "preparing-external",
          "ready",
          "switching",
          "switched",
          "activated",
          "complete",
        ]);
        expect(
          recording.sequence.filter((point) =>
            point.startsWith("before-action:"),
          ),
        ).toEqual([
          "before-action:quiesce:state",
          "before-action:prepare:definition",
          "before-action:activate:state",
        ]);
        expect(
          journal.actions.map((action) => h.services.labels.get(action.id)),
        ).toEqual(["quiesce:state", "prepare:definition", "activate:state"]);
        expect(
          recording.sequence.indexOf("before-pointer-switch"),
        ).toBeGreaterThan(
          recording.sequence.indexOf("after-journal:switching"),
        );
        expect(recording.sequence.indexOf("after-pointer-switch")).toBeLessThan(
          recording.sequence.indexOf("after-journal:switched"),
        );
        // Activation is durable before the activate-stage registration is touched.
        expect(
          recording.sequence.indexOf("after-journal:activated"),
        ).toBeLessThan(
          recording.sequence.indexOf("before-action:activate:state"),
        );
      });

      it("asks the host's maintenance role for each step, in the phase that permits it, as this coordinator", async () => {
        const h = await scope.create();
        assertDone(await start(h, {}));
        expect(
          h.maintenance.calls.map((call) => `${call.operation}@${call.phase}`),
        ).toEqual([
          "inventory@planned",
          "verify-quiesced-source@quiescing",
          "repair-copy@repairing",
          "verify-copy@repairing",
          "verify-copy@preparing-external",
          "verify-copy@switched",
        ]);
        expect(
          new Set(h.maintenance.calls.map((call) => call.coordinatorPid)),
        ).toEqual(new Set([process.pid]));
        const revisions = h.maintenance.calls.map((call) => call.revision);
        expect(revisions).toEqual(
          [...revisions].sort((left, right) => left - right),
        );
        // The pinned inventory digest rides on every step after the quiesced verification.
        const pinned = storeManifestDigest(DEFAULT_STORES);
        expect(
          h.maintenance.calls
            .filter(
              (call) =>
                call.operation === "repair-copy" ||
                call.operation === "verify-copy",
            )
            .every((call) => call.inventoryDigest === pinned),
        ).toBe(true);
        expect(h.census.calls).toHaveLength(1);
        expect(h.census.calls[0]?.root).toBe(h.sourceRoot);
        expect(Object.keys(h.census.calls[0] ?? {})).toEqual(["root"]);
        expect(h.services.stopCalls).toBe(1);
      });

      it("reports phase, copy and maintenance progress", async () => {
        const h = await scope.create();
        assertDone(await start(h, {}));
        const kinds = new Set(h.progressEvents.map((event) => event.kind));
        expect(kinds).toEqual(new Set(["phase", "copy", "maintenance"]));
        const lastCopy = h.progressEvents
          .filter((event) => event.kind === "copy")
          .pop();
        expect(lastCopy).toMatchObject({
          files: h.tree.fileCount,
          totalFiles: h.tree.fileCount,
          bytes: h.tree.byteCount,
        });
      });

      it("a migration after a rolled-back one advances the generation past it", async () => {
        const h = await scope.create();
        const crash = crashAtCheckpoint({
          target: "after-journal:ready",
          occurrence: 1,
          normalize: h.normalizeCheckpoint,
        });
        await expect(
          start(h, { checkpoint: crash.checkpoint }),
        ).rejects.toBeInstanceOf(CrashError);
        const rolledBack = assertDone(await rollbackMigration(h.makeDeps({})));
        expect(rolledBack.phase).toBe("rolled-back");
        expect(rolledBack.nextGeneration).toBe(1);
        const second = assertDone(
          await startMigration(h.makeDeps({}), {
            destination: join(h.destinationParent, "second"),
            acceptedSessionImpactDigest: null,
            reviewImpact: false,
          }),
        );
        expect(second.phase).toBe("complete");
        expect(second.nextGeneration).toBe(2);
      });

      it("records the SHA-256 of the coordinator's executable in the journal, before any effect", async () => {
        const h = await scope.create();
        const journal = assertDone(await start(h, {}));
        expect(journal.coordinatorExecutableSha256).toBe(
          h.coordinatorExecutableSha256,
        );
      });

      it("records null when the coordinator is not a packaged executable", async () => {
        const h = await scope.create();
        const journal = assertDone(
          await start(h, {
            coordinatorExecutable: () => Promise.resolve(null),
          }),
        );
        expect(journal.coordinatorExecutableSha256).toBeNull();
      });

      it("stops blocked (coordinator-executable-unreadable), writing nothing, when the executable cannot be read", async () => {
        const h = await scope.create();
        const result = assertStopped(
          await start(h, {
            coordinatorExecutable: () =>
              Promise.resolve(join(h.base, "no-such-executable")),
          }),
        );
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual([
          "coordinator-executable-unreadable",
        ]);
        expect(result.journal).toBeNull();
        expect(existsSync(h.destinationRoot)).toBe(false);
        expect(h.services.stopCalls).toBe(0);
      });
    });

    describe("session impact acceptance", () => {
      it("stops acceptance-required with the report, copies nothing, then completes once the exact digest is presented", async () => {
        const h = await scope.create();
        h.maintenance.impacts = () => [freshContextImpact("s1")];

        const first = assertStopped(await start(h, {}));
        expect(first.reason).toBe("acceptance-required");
        expect(blockerCodes(first)).toEqual(["session-impact-acceptance"]);
        expect(first.journal?.phase).toBe("planned");
        const report = first.impact;
        if (report === null)
          throw new Error("the stop carries the impact report");
        expect(report.sessions.map((session) => session.sessionId)).toEqual([
          "s1",
        ]);
        const digest = presentImpact(report).digest;
        expect(digest).toBe(digestOf([freshContextImpact("s1")], h));
        expect(first.blockers[0]?.object).toBe(digest);
        expect(first.journal?.sessionImpactDigest).toBe(digest);
        expect(first.journal?.acceptedSessionImpactDigest).toBeNull();
        // Nothing happened beyond the planned journal and the empty destination.
        expect(await readdir(h.destinationRoot)).toEqual([]);
        expect(await h.readTaskState()).toBe(STATE_ENABLED);
        expect(await factTree(h.sourceRoot)).toEqual(h.initial.facts);
        expect(h.gate().kind).toBe("open");

        const wrong = assertStopped(await resume(h, WRONG_DIGEST, {}));
        expect(wrong.reason).toBe("acceptance-required");
        expect(await readdir(h.destinationRoot)).toEqual([]);

        const journal = assertDone(await resume(h, digest, {}));
        expect(journal.acceptedSessionImpactDigest).toBe(digest);
        expect(journal.sessionImpactDigest).toBe(digest);
        await expectCompleted(h, journal, h.initial);
      });

      it("a native-resume route that falls back to fresh context also needs acceptance", async () => {
        const h = await scope.create();
        h.maintenance.impacts = () => [nativeFallbackImpact("s9")];
        expect(assertStopped(await start(h, {})).reason).toBe(
          "acceptance-required",
        );
      });

      it("a fully native route that holds on failure needs none", async () => {
        const h = await scope.create();
        h.maintenance.impacts = () => [
          {
            ...freshContextImpact("s2"),
            route: { primary: "native-resume", onFailure: "hold" },
          },
        ];
        const journal = assertDone(await start(h, {}));
        expect(journal.acceptedSessionImpactDigest).toBeNull();
        await expectCompleted(h, journal, h.initial);
      });

      it("asks again, copying nothing, when the impact changes between planned and quiesced", async () => {
        const h = await scope.create();
        const planned = [freshContextImpact("s1")];
        const quiesced = [freshContextImpact("s1"), nativeFallbackImpact("s2")];
        h.maintenance.impacts = ({ phase }) =>
          phase === "planned" ? planned : quiesced;
        const digestA = digestOf(planned, h);
        const digestB = digestOf(quiesced, h);
        expect(digestB).not.toBe(digestA);

        expect(assertStopped(await start(h, {})).reason).toBe(
          "acceptance-required",
        );

        const second = assertStopped(await resume(h, digestA, {}));
        expect(second.reason).toBe("acceptance-required");
        expect(blockerCodes(second)).toEqual(["session-impact-changed"]);
        expect(
          second.impact?.sessions.map((session) => session.sessionId),
        ).toEqual(["s1", "s2"]);
        expect(second.journal?.phase).toBe("quiescing");
        expect(second.journal?.sessionImpactDigest).toBe(digestB);
        expect(second.journal?.acceptedSessionImpactDigest).toBeNull();
        // No source file was copied: the destination is still empty.
        expect(await readdir(h.destinationRoot)).toEqual([]);
        expect(h.gate().kind).toBe("blocked");

        // The first acknowledgement does not cover the new report.
        expect(assertStopped(await resume(h, digestA, {})).reason).toBe(
          "acceptance-required",
        );
        expect(await readdir(h.destinationRoot)).toEqual([]);

        const journal = assertDone(await resume(h, digestB, {}));
        expect(journal.acceptedSessionImpactDigest).toBe(digestB);
        await expectCompleted(h, journal, h.initial);
      });
    });

    describe("interactive impact review", () => {
      it("reviewImpact true stops a no-acceptance impact at planned (session-impact-review) until the exact digest is presented", async () => {
        const h = await scope.create();
        h.maintenance.impacts = () => [NATIVE_HOLD("s2")];

        const first = assertStopped(await startReviewed(h, {}));
        expect(first.reason).toBe("acceptance-required");
        expect(blockerCodes(first)).toEqual(["session-impact-review"]);
        expect(first.journal?.phase).toBe("planned");
        const report = first.impact;
        if (report === null)
          throw new Error("the stop carries the impact report");
        const digest = presentImpact(report).digest;
        expect(first.blockers[0]?.object).toBe(digest);
        expect(await readdir(h.destinationRoot)).toEqual([]);

        const wrong = assertStopped(await resumeReviewed(h, WRONG_DIGEST, {}));
        expect(wrong.reason).toBe("acceptance-required");
        expect(blockerCodes(wrong)).toEqual(["session-impact-review"]);
        expect(wrong.journal?.phase).toBe("planned");
        expect(await readdir(h.destinationRoot)).toEqual([]);

        const journal = assertDone(await resumeReviewed(h, digest, {}));
        expect(journal.acceptedSessionImpactDigest).toBe(digest);
        await expectCompleted(h, journal, h.initial);
      });

      it("reviewImpact false completes the same fixture with no stop", async () => {
        const h = await scope.create();
        h.maintenance.impacts = () => [NATIVE_HOLD("s2")];
        const journal = assertDone(await start(h, {}));
        expect(journal.acceptedSessionImpactDigest).toBeNull();
        await expectCompleted(h, journal, h.initial);
      });

      it("an impact that requires acceptance still stops session-impact-acceptance with reviewImpact false", async () => {
        const h = await scope.create();
        h.maintenance.impacts = () => [freshContextImpact("s1")];
        const first = assertStopped(await start(h, {}));
        expect(first.reason).toBe("acceptance-required");
        expect(blockerCodes(first)).toEqual(["session-impact-acceptance"]);
        expect(first.journal?.phase).toBe("planned");
      });

      it("a review accepted at planned still stops session-impact-changed at quiescing when the impact changes, copying nothing", async () => {
        const h = await scope.create();
        const planned = [NATIVE_HOLD("s2")];
        const quiesced = [NATIVE_HOLD("s2"), NATIVE_HOLD("s3")];
        h.maintenance.impacts = ({ phase }) =>
          phase === "planned" ? planned : quiesced;
        const digestA = digestOf(planned, h);
        const digestB = digestOf(quiesced, h);
        expect(digestB).not.toBe(digestA);

        assertStopped(await startReviewed(h, {}));
        const changed = assertStopped(await resumeReviewed(h, digestA, {}));
        expect(changed.reason).toBe("acceptance-required");
        expect(blockerCodes(changed)).toEqual(["session-impact-changed"]);
        expect(changed.blockers[0]?.object).toBe(digestB);
        expect(changed.journal?.phase).toBe("quiescing");
        expect(await readdir(h.destinationRoot)).toEqual([]);

        const journal = assertDone(await resumeReviewed(h, digestB, {}));
        expect(journal.acceptedSessionImpactDigest).toBe(digestB);
        await expectCompleted(h, journal, h.initial);
      });

      it("with reviewImpact false a changed no-acceptance impact proceeds without a stop", async () => {
        const h = await scope.create();
        const planned = [NATIVE_HOLD("s2")];
        const quiesced = [NATIVE_HOLD("s2"), NATIVE_HOLD("s3")];
        h.maintenance.impacts = ({ phase }) =>
          phase === "planned" ? planned : quiesced;
        const journal = assertDone(await start(h, {}));
        await expectCompleted(h, journal, h.initial);
      });

      it("a review request is durable: a non-interactive resume cannot bypass it, and the exact digest completes", async () => {
        const h = await scope.create();
        h.maintenance.impacts = () => [NATIVE_HOLD("s2")];
        const first = assertStopped(await startReviewed(h, {}));
        expect(blockerCodes(first)).toEqual(["session-impact-review"]);
        expect(first.journal?.impactReviewRequested).toBe(true);
        expect(readActiveJournal(h.bootstrapDir).impactReviewRequested).toBe(
          true,
        );
        if (first.impact === null)
          throw new Error("the stop carries the impact report");
        const digest = presentImpact(first.impact).digest;

        const bypass = assertStopped(await resume(h, null, {}));
        expect(bypass.reason).toBe("acceptance-required");
        expect(blockerCodes(bypass)).toEqual(["session-impact-review"]);
        expect(await readdir(h.destinationRoot)).toEqual([]);

        const journal = assertDone(await resume(h, digest, {}));
        expect(journal.acceptedSessionImpactDigest).toBe(digest);
        await expectCompleted(h, journal, h.initial);
      });

      it("a crash on the first planned journal of a reviewed start still stops for review on a non-interactive resume", async () => {
        const h = await scope.create();
        h.maintenance.impacts = () => [NATIVE_HOLD("s2")];
        // Occurrence 1 is the first durable journal: the request must already be in it.
        const crash = crashAtCheckpoint({
          target: "after-journal:planned",
          occurrence: 1,
          normalize: h.normalizeCheckpoint,
        });
        await expect(
          startReviewed(h, { checkpoint: crash.checkpoint }),
        ).rejects.toBeInstanceOf(CrashError);
        expect(readActiveJournal(h.bootstrapDir).impactReviewRequested).toBe(
          true,
        );

        const stopped = assertStopped(await resume(h, null, {}));
        expect(stopped.reason).toBe("acceptance-required");
        expect(blockerCodes(stopped)).toEqual(["session-impact-review"]);
        expect(await readdir(h.destinationRoot)).toEqual([]);
      });

      it("a review accepted then changed at quiescing still stops session-impact-changed when resumed non-interactively", async () => {
        const h = await scope.create();
        const planned = [NATIVE_HOLD("s2")];
        const quiesced = [NATIVE_HOLD("s2"), NATIVE_HOLD("s3")];
        h.maintenance.impacts = ({ phase }) =>
          phase === "planned" ? planned : quiesced;
        const digestA = digestOf(planned, h);
        const digestB = digestOf(quiesced, h);

        assertStopped(await startReviewed(h, {}));
        const changed = assertStopped(await resumeReviewed(h, digestA, {}));
        expect(blockerCodes(changed)).toEqual(["session-impact-changed"]);
        expect(changed.journal?.phase).toBe("quiescing");

        const again = assertStopped(await resume(h, null, {}));
        expect(blockerCodes(again)).toEqual(["session-impact-changed"]);
        expect(await readdir(h.destinationRoot)).toEqual([]);

        const journal = assertDone(await resume(h, digestB, {}));
        expect(journal.acceptedSessionImpactDigest).toBe(digestB);
        await expectCompleted(h, journal, h.initial);
      });

      it("the non-interactive path never sets impactReviewRequested, in any journal revision", async () => {
        const h = await scope.create();
        h.maintenance.impacts = () => [NATIVE_HOLD("s2")];
        const seen: boolean[] = [];
        const journal = assertDone(
          await start(h, {
            checkpoint: (point) => {
              if (point.startsWith("after-journal:"))
                seen.push(
                  readActiveJournal(h.bootstrapDir).impactReviewRequested,
                );
              return Promise.resolve();
            },
          }),
        );
        expect(seen.length).toBeGreaterThan(5);
        expect(seen.every((value) => !value)).toBe(true);
        expect(journal.impactReviewRequested).toBe(false);
        await expectCompleted(h, journal, h.initial);
      });

      it("rolling back a reviewed plan removes the empty destination folder (control)", async () => {
        const h = await scope.create();
        h.maintenance.impacts = () => [NATIVE_HOLD("s2")];
        const first = assertStopped(await startReviewed(h, {}));
        expect(blockerCodes(first)).toEqual(["session-impact-review"]);
        expect(await readdir(h.destinationRoot)).toEqual([]);

        const result = await rollbackMigration(h.makeDeps({}));

        expect(result.kind).toBe("done");
        expect(readActiveJournal(h.bootstrapDir).phase).toBe("rolled-back");
        expect(existsSync(h.destinationRoot)).toBe(false);
      });

      it.skipIf(
        process.platform === "win32" ||
          (typeof process.getuid === "function" && process.getuid() === 0),
      )(
        "rolling back a plan keeps the destination and still resolves done when the folder cannot be inspected (EACCES)",
        async () => {
          const h = await scope.create();
          h.maintenance.impacts = () => [NATIVE_HOLD("s2")];
          const first = assertStopped(await startReviewed(h, {}));
          expect(blockerCodes(first)).toEqual(["session-impact-review"]);
          expect(first.journal?.phase).toBe("planned");
          expect(await readdir(h.destinationRoot)).toEqual([]);

          const parent = dirname(h.destinationRoot);
          const originalMode = (await stat(parent)).mode & 0o7777;
          let result: EngineResult;
          try {
            await chmod(parent, 0o000);
            result = await rollbackMigration(h.makeDeps({}));
          } finally {
            await chmod(parent, originalMode);
          }

          expect(result.kind).toBe("done");
          expect(result.kind === "done" ? result.journal.phase : null).toBe(
            "rolled-back",
          );
          expect(readActiveJournal(h.bootstrapDir).phase).toBe("rolled-back");
          // The folder was not provably removable, so it is kept.
          expect(existsSync(h.destinationRoot)).toBe(true);
          expect(await readdir(h.destinationRoot)).toEqual([]);
        },
      );

      it("pointerState is previous for a fresh planned journal and migration after completion", async () => {
        const h = await scope.create();
        h.maintenance.impacts = () => [NATIVE_HOLD("s2")];
        const planned = assertStopped(await startReviewed(h, {}));
        if (planned.journal === null)
          throw new Error("the stop carries the planned journal");
        expect(planned.journal.phase).toBe("planned");
        expect(pointerState(h.bootstrapDir, planned.journal)).toBe("previous");

        if (planned.impact === null)
          throw new Error("the stop carries the impact report");
        const digest = presentImpact(planned.impact).digest;
        const journal = assertDone(await resumeReviewed(h, digest, {}));
        expect(pointerState(h.bootstrapDir, journal)).toBe("migration");
      });
    });

    describe("readonly advisory (inspectMigrationReadonly)", () => {
      it("refuses a missing data folder with source-absent and points at data init, writing nothing", async () => {
        const h = await scope.create();
        await rm(h.sourceRoot, { recursive: true, force: true });

        const advisory = await inspectMigrationReadonly(h.makeDeps({}), {
          destination: h.destinationRoot,
        });

        expect(advisory.blockers.map((blocker) => blocker.code)).toEqual([
          "source-absent",
        ]);
        expect(advisory.blockers[0]?.message).toContain(
          "traycer data init --to",
        );
        expect(advisory.sourceBytes).toBe(0);
        expect(existsSync(h.destinationRoot)).toBe(false);
        expect(existsSync(h.bootstrapDir)).toBe(false);

        const stopped = assertStopped(await start(h, {}));
        expect(blockerCodes(stopped)).toContain("source-absent");
        expect(existsSync(h.destinationRoot)).toBe(false);
      });

      it("reports sizes and no blockers for a clean source, and writes NOTHING anywhere", async () => {
        const h = await scope.create();
        const homeBefore = await snapshotIfPresent(h.home);
        const bootstrapBefore = await snapshotIfPresent(h.bootstrapDir);
        const parentBefore = await snapshotIfPresent(h.destinationParent);
        const externalBefore = await snapshotIfPresent(h.externalDir);

        const advisory = await inspectMigrationReadonly(h.makeDeps({}), {
          destination: h.destinationRoot,
        });

        expect(advisory.sourceRoot).toBe(h.sourceRoot);
        expect(advisory.destinationRoot).toBe(h.destinationRoot);
        expect(advisory.sourceBytes).toBe(h.tree.byteCount);
        expect(advisory.requiredBytes).toBeGreaterThan(advisory.sourceBytes);
        expect(advisory.destinationFreeBytes).toBe(1_000_000_000_000);
        expect(advisory.storeInspection).toBe("runs-at-start");
        expect(advisory.blockers).toEqual([]);

        expect(await snapshotIfPresent(h.home)).toEqual(homeBefore);
        expect(await snapshotIfPresent(h.bootstrapDir)).toEqual(
          bootstrapBefore,
        );
        expect(await snapshotIfPresent(h.destinationParent)).toEqual(
          parentBefore,
        );
        expect(await snapshotIfPresent(h.externalDir)).toEqual(externalBefore);
        // No lock file, no journal, no selector, no destination folder, no bootstrap folder.
        expect(existsSync(h.bootstrapDir)).toBe(false);
        expect(existsSync(h.destinationRoot)).toBe(false);
        expect(await readdir(h.destinationParent)).toEqual([]);
        expect(await factTree(h.sourceRoot)).toEqual(h.initial.facts);
        expect(await h.readTaskState()).toBe(STATE_ENABLED);
        // It starts no host, stops no service and asks no census or maintenance question.
        expect(h.maintenance.calls).toEqual([]);
        expect(h.services.stopCalls).toBe(0);
        expect(h.census.calls).toHaveLength(0);
      });

      it("lists every reason it would refuse: free space, service blockers and unsupported entries", async () => {
        const h = await scope.create();
        await symlink(
          join(h.sourceRoot, "notes"),
          join(h.sourceRoot, "a-link"),
        );
        h.services.quiesceBlockers = [
          {
            code: "service-registration-unsupported",
            object: "/launch/agent.plist",
            message: "unsupported",
          },
        ];
        const advisory = await inspectMigrationReadonly(
          h.makeDeps({ freeBytes: () => Promise.resolve(1024) }),
          { destination: h.destinationRoot },
        );
        expect(advisory.blockers.map((blocker) => blocker.code).sort()).toEqual(
          [
            "destination-capacity",
            "service-registration-unsupported",
            "unsupported-entry",
          ],
        );
        expect(existsSync(h.destinationRoot)).toBe(false);
        expect(h.maintenance.calls).toEqual([]);
      });

      it("refuses an invalid or overlapping destination without writing anything", async () => {
        const h = await scope.create();
        const relative = await inspectMigrationReadonly(h.makeDeps({}), {
          destination: "relative/path",
        });
        expect(relative.blockers.map((blocker) => blocker.code)).toEqual([
          "destination-invalid",
        ]);
        expect(relative.destinationRoot).toBeNull();
        const inside = await inspectMigrationReadonly(h.makeDeps({}), {
          destination: join(h.sourceRoot, "inside"),
        });
        expect(inside.blockers.map((blocker) => blocker.code)).toEqual([
          "destination-overlaps",
        ]);
        expect(existsSync(h.bootstrapDir)).toBe(false);
        expect(existsSync(join(h.sourceRoot, "inside"))).toBe(false);
      });

      it("refuses while another migration is in progress (migration-active)", async () => {
        const h = await scope.create();
        h.probe.alive.add(PARTICIPANT_PID);
        await h.writeAdmissionEntry({
          pid: PARTICIPANT_PID,
          dataMigrationProtocol: 1,
        });
        assertStopped(await start(h, {}));
        const before = await snapshotIfPresent(h.bootstrapDir);
        const advisory = await inspectMigrationReadonly(h.makeDeps({}), {
          destination: join(h.destinationParent, "other"),
        });
        expect(advisory.blockers.map((blocker) => blocker.code)).toEqual([
          "migration-active",
        ]);
        expect(await snapshotIfPresent(h.bootstrapDir)).toEqual(before);
      });

      it("reports installed-participant blockers (participant-*)", async () => {
        const h = await scope.create();
        await mkdir(join(h.sourceRoot, "host", "install"), { recursive: true });
        await writeFile(
          join(h.sourceRoot, "host", "install", "install.json"),
          "{ not json",
        );
        await mkdir(join(h.sourceRoot, "cli", "bin"), { recursive: true });
        await writeFile(
          join(h.sourceRoot, "cli", "bin", "traycer"),
          "an older cli",
        );
        const advisory = await inspectMigrationReadonly(h.makeDeps({}), {
          destination: h.destinationRoot,
        });
        expect(advisory.blockers.map((blocker) => blocker.code)).toEqual([
          "participant-unreadable",
          "participant-unsupported",
        ]);
      });

      it("passes a CLI slot byte-identical to the coordinator executable", async () => {
        const h = await scope.create();
        await mkdir(join(h.sourceRoot, "cli", "bin"), { recursive: true });
        await writeFile(
          join(h.sourceRoot, "cli", "bin", "traycer"),
          await readFile(h.coordinatorExecutable),
        );
        const advisory = await inspectMigrationReadonly(h.makeDeps({}), {
          destination: h.destinationRoot,
        });
        expect(advisory.blockers).toEqual([]);
      });
    });

    describe("installed participants gate the plan before any effect", () => {
      it("refuses at planned (blocked), with no actions, no quiesce applied, no host stopped and no maintenance call", async () => {
        const h = await scope.create();
        await mkdir(join(h.sourceRoot, "host", "install"), { recursive: true });
        await writeFile(
          join(h.sourceRoot, "host", "install", "install.json"),
          "{ not json",
        );
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["participant-unreadable"]);
        expect(result.journal?.phase).toBe("planned");
        expect(result.journal?.actions).toEqual([]);
        expect(await h.readTaskState()).toBe(STATE_ENABLED);
        expect(h.services.stopCalls).toBe(0);
        expect(h.maintenance.calls).toEqual([]);
        expect(h.gate()).toEqual({ kind: "open", generation: null });
      });

      it("a coordinator that is not a packaged executable cannot vouch for an installed CLI", async () => {
        const h = await scope.create();
        await mkdir(join(h.sourceRoot, "cli", "bin"), { recursive: true });
        await writeFile(
          join(h.sourceRoot, "cli", "bin", "traycer"),
          await readFile(h.coordinatorExecutable),
        );
        const result = assertStopped(
          await start(h, {
            coordinatorExecutable: () => Promise.resolve(null),
          }),
        );
        expect(blockerCodes(result)).toEqual(["participant-unsupported"]);
        expect(result.journal?.phase).toBe("planned");
      });
    });

    describe("a running source writer at planned", () => {
      const running = [
        {
          code: "running-source" as const,
          storeKey: null,
          message: "a host is running",
        },
      ];

      it("is deferred to quiescence: the host is stopped there, the quiesced verification is clean and the migration completes", async () => {
        const h = await scope.create();
        h.maintenance.blockers = {
          inventory: running,
          "verify-quiesced-source": running,
        };
        h.services.onStopRunningHosts = () => {
          h.maintenance.blockers = {};
        };
        const journal = assertDone(await start(h, {}));
        expect(journal.phase).toBe("complete");
        expect(h.progressEvents).toContainEqual({
          kind: "deferred-to-quiescence",
          running: 1,
        });
        expect(h.services.stopCalls).toBe(1);
        expect(
          h.maintenance.calls
            .map((call) => `${call.operation}@${call.phase}`)
            .slice(0, 2),
        ).toEqual(["inventory@planned", "verify-quiesced-source@quiescing"]);
      });

      it("still refuses (blocked, phase quiescing) when the quiesced verification reports running-source", async () => {
        const h = await scope.create();
        h.maintenance.blockers = {
          inventory: running,
          "verify-quiesced-source": running,
        };
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["running-source"]);
        expect(result.journal?.phase).toBe("quiescing");
        expect(h.progressEvents).toContainEqual({
          kind: "deferred-to-quiescence",
          running: 1,
        });
        expect(await readdir(h.destinationRoot)).toEqual([]);
      });

      it("busy-source at planned refuses at planned and does not defer", async () => {
        const h = await scope.create();
        h.maintenance.blockers = {
          inventory: [
            { code: "busy-source", storeKey: "host/db", message: "busy" },
          ],
        };
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["busy-source"]);
        expect(result.journal?.phase).toBe("planned");
        expect(h.services.stopCalls).toBe(0);
        expect(
          h.progressEvents.some(
            (event) => event.kind === "deferred-to-quiescence",
          ),
        ).toBe(false);
      });

      it("a hard blocker beside running-source refuses at planned, naming only the hard one", async () => {
        const h = await scope.create();
        h.maintenance.blockers = {
          inventory: [
            ...running,
            { code: "busy-source", storeKey: "host/db", message: "busy" },
          ],
        };
        const result = assertStopped(await start(h, {}));
        expect(blockerCodes(result)).toEqual(["busy-source"]);
        expect(result.journal?.phase).toBe("planned");
        expect(h.services.stopCalls).toBe(0);
      });
    });

    describe("caller preconditions", () => {
      it("start refuses (blocked, coordinator-admitted) when this process holds an admission, writing nothing", async () => {
        const h = await scope.create();
        await h.admitThisProcess();
        const before = await contentTree(h.bootstrapDir, () => false);
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["coordinator-admitted"]);
        expect(result.journal).toBeNull();
        expect(existsSync(h.destinationRoot)).toBe(false);
        expect(h.services.stopCalls).toBe(0);
        expect(h.maintenance.calls).toEqual([]);
        expect(
          (await readdir(h.bootstrapDir)).filter((name) =>
            /^(migration|location)/u.test(name),
          ),
        ).toEqual([]);
        expect(await contentTree(h.bootstrapDir, () => false)).toEqual(before);
      });

      it("resume, rollback and diagnose refuse the same way and change nothing", async () => {
        const h = await scope.create();
        h.probe.alive.add(PARTICIPANT_PID);
        await h.writeAdmissionEntry({
          pid: PARTICIPANT_PID,
          dataMigrationProtocol: 1,
        });
        assertStopped(await start(h, {}));
        const journalBefore = readActiveJournal(h.bootstrapDir);
        await h.admitThisProcess();
        const bootstrapBefore = await contentTree(h.bootstrapDir, () => false);
        const stateBefore = await h.readTaskState();

        const resumed = assertStopped(await resume(h, null, {}));
        expect(resumed.reason).toBe("blocked");
        expect(blockerCodes(resumed)).toEqual(["coordinator-admitted"]);
        const rolled = assertStopped(await rollbackMigration(h.makeDeps({})));
        expect(rolled.reason).toBe("blocked");
        expect(blockerCodes(rolled)).toEqual(["coordinator-admitted"]);
        const diagnosed = await diagnoseMigration(h.makeDeps({}));
        expect(diagnosed.kind).toBe("stopped");
        expect(
          diagnosed.kind === "stopped" ? blockerCodes(diagnosed) : [],
        ).toEqual(["coordinator-admitted"]);

        expect(readActiveJournal(h.bootstrapDir)).toEqual(journalBefore);
        expect(await contentTree(h.bootstrapDir, () => false)).toEqual(
          bootstrapBefore,
        );
        expect(await h.readTaskState()).toBe(stateBefore);
      });
    });

    describe("the coordinator in the process census", () => {
      it("is excluded by verified incarnation when its only use of the source is its image", async () => {
        const h = await scope.create();
        h.census.result = {
          kind: "users",
          users: [{ pid: process.pid, name: "traycer", evidence: "image" }],
        };
        const journal = assertDone(await start(h, {}));
        expect(journal.phase).toBe("complete");
        expect(h.census.calls).toHaveLength(1);
      });

      it("blocks (process-using-data-folder) when the coordinator holds a handle in the source", async () => {
        const h = await scope.create();
        h.census.result = {
          kind: "users",
          users: [{ pid: process.pid, name: "traycer", evidence: "handle" }],
        };
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["process-using-data-folder"]);
        expect(result.blockers[0]?.object).toBe(
          `traycer pid ${String(process.pid)} (handle)`,
        );
        expect(result.journal?.phase).toBe("quiescing");
        expect(await readdir(h.destinationRoot)).toEqual([]);
      });

      it("blocks when the coordinator's use is a working directory", async () => {
        const h = await scope.create();
        h.census.result = {
          kind: "users",
          users: [{ pid: process.pid, name: "traycer", evidence: "cwd" }],
        };
        const result = assertStopped(await start(h, {}));
        expect(blockerCodes(result)).toEqual(["process-using-data-folder"]);
      });

      it("keeps another process with image evidence as a user", async () => {
        const h = await scope.create();
        h.census.result = {
          kind: "users",
          users: [{ pid: 555, name: "old-traycer", evidence: "image" }],
        };
        const result = assertStopped(await start(h, {}));
        expect(blockerCodes(result)).toEqual(["process-using-data-folder"]);
      });
    });

    describe("participants that still run", () => {
      it("stops blocked in quiescing, names the process, keeps the barrier up and copies nothing", async () => {
        const h = await scope.create();
        h.probe.alive.add(PARTICIPANT_PID);
        await h.writeAdmissionEntry({
          pid: PARTICIPANT_PID,
          dataMigrationProtocol: 1,
        });
        h.services.stopBlockers = [
          {
            code: "host-stop-refused",
            object: "ai.traycer.host",
            message: "busy",
          },
        ];

        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual([
          "host-stop-refused",
          "participant-running",
        ]);
        expect(result.blockers[1]?.object).toBe(
          `desktop pid ${String(PARTICIPANT_PID)}`,
        );
        expect(result.journal?.phase).toBe("quiescing");
        expect(h.gate()).toMatchObject({
          kind: "blocked",
          code: "migration-in-progress",
        });
        expect(h.census.calls).toHaveLength(0);
        expect(h.services.stopCalls).toBe(1);
        expect(await readdir(h.destinationRoot)).toEqual([]);
        expect(await h.readTaskState()).toBe(STATE_DISABLED);
        expect(await factTree(h.sourceRoot)).toEqual(h.initial.facts);
      });

      it("refuses a second migration while one is blocked, then lets the blocked one be rolled back", async () => {
        const h = await scope.create();
        h.probe.alive.add(PARTICIPANT_PID);
        await h.writeAdmissionEntry({
          pid: PARTICIPANT_PID,
          dataMigrationProtocol: 1,
        });
        assertStopped(await start(h, {}));

        const second = assertStopped(await start(h, {}));
        expect(second.reason).toBe("blocked");
        expect(blockerCodes(second)).toEqual(["migration-active"]);

        const journal = assertDone(await rollbackMigration(h.makeDeps({})));
        await expectRolledBack(h, journal, h.initial);
      });

      it("completes on resume once the participant has exited, and reaps its entry", async () => {
        const h = await scope.create();
        h.probe.alive.add(PARTICIPANT_PID);
        await h.writeAdmissionEntry({
          pid: PARTICIPANT_PID,
          dataMigrationProtocol: 1,
        });
        assertStopped(await start(h, {}));
        h.probe.alive.delete(PARTICIPANT_PID);

        const journal = assertDone(await resume(h, null, {}));
        await expectCompleted(h, journal, h.initial);
        expect(
          (await readdir(h.bootstrapDir)).filter((name) =>
            name.startsWith("admission-"),
          ),
        ).toEqual([]);
      });

      it("reaps the entry of a process proven gone without waiting", async () => {
        const h = await scope.create();
        await h.writeAdmissionEntry({
          pid: PARTICIPANT_PID,
          dataMigrationProtocol: 1,
        });
        const journal = assertDone(await start(h, {}));
        await expectCompleted(h, journal, h.initial);
        expect(
          (await readdir(h.bootstrapDir)).filter((name) =>
            name.startsWith("admission-"),
          ),
        ).toEqual([]);
      });

      it("blocks a participant whose data-migration protocol this build cannot honour", async () => {
        const h = await scope.create();
        h.probe.alive.add(PARTICIPANT_PID);
        await h.writeAdmissionEntry({
          pid: PARTICIPANT_PID,
          dataMigrationProtocol: 2,
        });
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["participant-protocol-too-new"]);
      });

      it("blocks, without waiting, on a participant whose liveness cannot be proven", async () => {
        const h = await scope.create();
        h.probe.indeterminate.add(PARTICIPANT_PID);
        await h.writeAdmissionEntry({
          pid: PARTICIPANT_PID,
          dataMigrationProtocol: 1,
        });
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["participant-ambiguous"]);
      });

      it("blocks on an admission entry that cannot be read", async () => {
        const h = await scope.create();
        await mkdir(h.bootstrapDir, { recursive: true, mode: 0o700 });
        await writeFile(
          join(
            h.bootstrapDir,
            "admission-00000000-0000-4000-8000-000000000009.json",
          ),
          "{ not json",
          { mode: 0o600 },
        );
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["participant-unreadable"]);
      });
    });

    describe("processes using the data folder", () => {
      it("blocks on a process whose working directory or handle is inside, naming it, then completes once it is gone", async () => {
        const h = await scope.create();
        h.census.result = {
          kind: "users",
          users: [{ pid: 555, name: "zsh", evidence: "cwd" }],
        };
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["process-using-data-folder"]);
        expect(result.blockers[0]?.object).toBe("zsh pid 555 (cwd)");
        expect(result.journal?.phase).toBe("quiescing");
        expect(await readdir(h.destinationRoot)).toEqual([]);
        expect(h.gate().kind).toBe("blocked");

        h.census.result = { kind: "clear" };
        const journal = assertDone(await resume(h, null, {}));
        await expectCompleted(h, journal, h.initial);
      });

      it("blocks when the census cannot rule processes out", async () => {
        const h = await scope.create();
        h.census.result = {
          kind: "unprovable",
          reason: "lsof could not list open files",
        };
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["process-census-unprovable"]);
      });
    });

    describe("host maintenance refusals", () => {
      const rows: readonly {
        readonly name: string;
        readonly operation: MaintenanceOperation;
        readonly code: "busy-source" | "integrity-mismatch" | "unauthorized";
        readonly reason: "blocked" | "conflict" | "failed";
        readonly phase: string;
      }[] = [
        {
          name: "a busy store at the first inventory",
          operation: "inventory",
          code: "busy-source",
          reason: "blocked",
          phase: "planned",
        },
        {
          name: "a busy store after quiescence",
          operation: "verify-quiesced-source",
          code: "busy-source",
          reason: "blocked",
          phase: "quiescing",
        },
        {
          name: "an integrity mismatch after quiescence",
          operation: "verify-quiesced-source",
          code: "integrity-mismatch",
          reason: "conflict",
          phase: "quiescing",
        },
        {
          name: "an unauthorized request",
          operation: "verify-quiesced-source",
          code: "unauthorized",
          reason: "failed",
          phase: "quiescing",
        },
        {
          name: "a refused repair",
          operation: "repair-copy",
          code: "busy-source",
          reason: "blocked",
          phase: "repairing",
        },
        {
          name: "a copy that fails verification",
          operation: "verify-copy",
          code: "integrity-mismatch",
          reason: "conflict",
          phase: "repairing",
        },
      ];

      it.each(rows)(
        "stops $reason in $phase for $name, then converges once the host agrees",
        async ({ operation, code, reason, phase }) => {
          const h = await scope.create();
          h.maintenance.blockers = {
            [operation]: [{ code, storeKey: "host/db", message: "refused" }],
          };

          const result = assertStopped(await start(h, {}));
          expect(result.reason).toBe(reason);
          expect(blockerCodes(result)).toEqual([code]);
          expect(result.blockers[0]?.object).toBe("host/db");
          expect(result.journal?.phase).toBe(phase);

          h.maintenance.blockers = {};
          const journal = assertDone(await resume(h, null, {}));
          await expectCompleted(h, journal, h.initial);
        },
      );
    });

    describe("other preconditions", () => {
      it("blocks on too little free space on the destination drive, then completes once there is enough", async () => {
        const h = await scope.create();
        const result = assertStopped(
          await start(h, { freeBytes: () => Promise.resolve(1024) }),
        );
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["destination-capacity"]);
        expect(result.journal?.phase).toBe("quiescing");
        expect(await readdir(h.destinationRoot)).toEqual([]);

        const journal = assertDone(await resume(h, null, {}));
        await expectCompleted(h, journal, h.initial);
      });

      it("blocks on a symbolic link in the source, which is neither followed nor omitted", async () => {
        const h = await scope.create();
        await symlink(
          join(h.sourceRoot, "notes"),
          join(h.sourceRoot, "a-link"),
        );
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["unsupported-entry"]);
        expect(result.blockers[0]?.object).toBe("a-link");
        expect(result.journal?.phase).toBe("quiescing");
      });

      it("blocks when a managed provider-accounts record cannot be read", async () => {
        const h = await scope.create();
        await mkdir(underRoot(h.sourceRoot, "host/config"), {
          recursive: true,
        });
        await writeFile(
          underRoot(h.sourceRoot, "host/config/provider-accounts.json"),
          "not json",
        );
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["provider-accounts-unreadable"]);
      });

      it("refuses a populated destination before any journal exists", async () => {
        const h = await scope.create();
        await mkdir(h.destinationRoot, { mode: 0o700 });
        await writeFile(
          join(h.destinationRoot, "existing.txt"),
          "someone's file",
        );
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["destination-populated"]);
        expect(result.journal).toBeNull();
        expect(await readdir(h.destinationRoot)).toEqual(["existing.txt"]);
        expect(h.gate()).toEqual({ kind: "open", generation: null });
      });

      it("accepts an existing EMPTY private destination", async () => {
        const h = await scope.create();
        await mkdir(h.destinationRoot, { mode: 0o700 });
        await chmod(h.destinationRoot, 0o700);
        const journal = assertDone(await start(h, {}));
        await expectCompleted(h, journal, h.initial);
      });

      it.each([
        {
          name: "a relative path",
          destination: (h: EngineHarness) =>
            `${h.destinationParent.slice(1)}/rel`,
          code: "destination-invalid-path",
        },
        {
          name: "a folder inside the data folder",
          destination: (h: EngineHarness) => join(h.sourceRoot, "inside"),
          code: "destination-overlaps-protected-root",
        },
        {
          name: "a missing parent",
          destination: (h: EngineHarness) =>
            join(h.base, "no-such-parent", "data"),
          code: "destination-parent-missing",
        },
      ])("refuses $name", async ({ destination, code }) => {
        const h = await scope.create();
        const result = assertStopped(
          await startMigration(h.makeDeps({}), {
            destination: destination(h),
            acceptedSessionImpactDigest: null,
            reviewImpact: false,
          }),
        );
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual([code]);
        expect(result.journal).toBeNull();
      });

      it("stops blocked when the data location changed under the running command", async () => {
        const h = await scope.create();
        const result = assertStopped(
          await start(h, { processDataRoot: () => join(h.base, "elsewhere") }),
        );
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["location-changed"]);
      });

      it("stops blocked while another coordinator holds the lock, and proceeds after it is released", async () => {
        const h = await scope.create();
        const held = await acquireMigrationCoordinatorLock({
          bootstrapDir: h.bootstrapDir,
          probe: h.probe,
        });
        if (!held.acquired)
          throw new Error("the test could not take the coordinator lock");
        const result = assertStopped(await start(h, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["coordinator-held"]);
        expect(result.journal).toBeNull();
        await held.lock.release();

        const journal = assertDone(await start(h, {}));
        await expectCompleted(h, journal, h.initial);
      });
    });

    describe("cancellation and a source that changes", () => {
      it("never rolls back on cancellation: stops failed in copying, and the next run finishes", async () => {
        const h = await scope.create();
        const controller = new AbortController();
        let copied = 0;
        const result = assertStopped(
          await start(h, {
            signal: controller.signal,
            checkpoint: (point) => {
              if (point === "after-copy-file") {
                copied += 1;
                if (copied === 2) controller.abort();
              }
              return Promise.resolve();
            },
          }),
        );
        expect(result.reason).toBe("failed");
        expect(blockerCodes(result)).toEqual(["cancelled"]);
        expect(result.journal?.phase).toBe("copying");
        expect(h.gate().kind).toBe("blocked");
        expect(readLocation(h.bootstrapDir)).toBeNull();

        const journal = assertDone(await resume(h, null, {}));
        await expectCompleted(h, journal, h.initial);
      });

      it("stops failed/cancelled before anything is planned when the signal is already aborted", async () => {
        const h = await scope.create();
        const controller = new AbortController();
        controller.abort();
        const result = assertStopped(
          await start(h, { signal: controller.signal }),
        );
        expect(result.reason).toBe("failed");
        expect(blockerCodes(result)).toEqual(["cancelled"]);
        expect(result.journal?.phase).toBe("planned");
        expect(h.gate().kind).toBe("open");
      });

      it("stops conflict, overwriting nothing, when a source file changes after the freeze", async () => {
        const h = await scope.create();
        const halted = crashAtCheckpoint({
          target: "after-journal:copying",
          occurrence: 1,
          normalize: h.normalizeCheckpoint,
        });
        await expect(
          start(h, { checkpoint: halted.checkpoint }),
        ).rejects.toBeInstanceOf(CrashError);
        await appendFile(
          underRoot(h.sourceRoot, PROVIDER_FILE),
          '{"turn":3}\n',
        );

        const result = assertStopped(await resume(h, null, {}));
        expect(result.reason).toBe("conflict");
        expect(blockerCodes(result)).toEqual(["source-modified"]);
        expect(result.blockers[0]?.object).toBe(PROVIDER_FILE);
        expect(result.journal?.phase).toBe("copying");
        expect(await h.destinationContent()).toEqual(new Map());
        expect(readLocation(h.bootstrapDir)).toBeNull();
      });
    });

    describe("diagnosis", () => {
      it("reports no migration, then a rollbackable one, then a settled one", async () => {
        const h = await scope.create();
        const none = await diagnoseMigration(h.makeDeps({}));
        if (none.kind !== "diagnosis") throw new Error("expected a diagnosis");
        expect(none.diagnosis).toEqual({
          journal: null,
          pointer: "not-applicable",
          rollbackAllowed: false,
          resumable: false,
        });

        h.probe.alive.add(PARTICIPANT_PID);
        await h.writeAdmissionEntry({
          pid: PARTICIPANT_PID,
          dataMigrationProtocol: 1,
        });
        assertStopped(await start(h, {}));
        const blocked = await diagnoseMigration(h.makeDeps({}));
        if (blocked.kind !== "diagnosis")
          throw new Error("expected a diagnosis");
        expect(blocked.diagnosis).toMatchObject({
          pointer: "previous",
          rollbackAllowed: true,
          resumable: true,
        });
        expect(blocked.diagnosis.journal?.phase).toBe("quiescing");

        h.probe.alive.delete(PARTICIPANT_PID);
        assertDone(await resume(h, null, {}));
        const settled = await diagnoseMigration(h.makeDeps({}));
        if (settled.kind !== "diagnosis")
          throw new Error("expected a diagnosis");
        expect(settled.diagnosis).toMatchObject({
          pointer: "migration",
          rollbackAllowed: false,
          resumable: false,
        });
      });
    });

    describe("the startup barrier follows the phase", () => {
      it("is down from quiescing through switched, and open before it and from activation on", async () => {
        const barrier = [
          "quiescing",
          "copying",
          "repairing",
          "preparing-external",
          "ready",
          "switching",
          "switched",
        ];
        for (const phase of barrier) {
          const h = await scope.create();
          const halted = crashAtCheckpoint({
            target: `after-journal:${phase}`,
            occurrence: 1,
            normalize: h.normalizeCheckpoint,
          });
          await expect(
            start(h, { checkpoint: halted.checkpoint }),
          ).rejects.toBeInstanceOf(CrashError);
          expect(readActiveJournal(h.bootstrapDir).phase).toBe(phase);
          expect(h.gate(), `gate in ${phase}`).toMatchObject({
            kind: "blocked",
            code: "migration-in-progress",
          });
        }
        for (const phase of ["planned", "activated", "complete"]) {
          const h = await scope.create();
          const halted = crashAtCheckpoint({
            target: `after-journal:${phase}`,
            occurrence: 1,
            normalize: h.normalizeCheckpoint,
          });
          await expect(
            start(h, { checkpoint: halted.checkpoint }),
          ).rejects.toBeInstanceOf(CrashError);
          expect(readActiveJournal(h.bootstrapDir).phase).toBe(phase);
          expect(h.gate().kind, `gate in ${phase}`).toBe("open");
        }
      });

      it("never affects an installation that never migrated", async () => {
        const h = await scope.create();
        expect(h.gate()).toEqual({ kind: "open", generation: null });
        expect(existsSync(h.bootstrapDir)).toBe(false);
      });
    });
  },
);
