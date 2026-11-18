import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATION_COORDINATOR_LOCK_FILENAME } from "@traycer/protocol/config/data-migration-admission";
import type { MigrationEngineDeps } from "../engine-deps";
import type { EngineResult } from "../engine-types";
import {
  resumeMigration,
  rollbackMigration,
  startMigration,
} from "../migration-engine";
import {
  assertDone,
  assertStopped,
  blockerCodes,
  CrashError,
  crashAtCheckpoint,
  expectCompleted,
  expectRolledBack,
  harnessScope,
  pathExists,
  readActiveJournal,
  readLocation,
  readText,
  recordingCheckpoint,
  STATE_DISABLED,
  sweepPoints,
  type CrashingCheckpoint,
  type EngineHarness,
} from "./engine-fixtures";

/**
 * Crash and recovery. A crash is an exception thrown from the engine's
 * `checkpoint` hook, which sits on both sides of every durable effect: the
 * journal write, each external action, the pointer switch and restore, the
 * receipt mirror, each copied file and each cleanup delete. The recovery is
 * then run by a FRESH set of deps against the same bootstrap folder and
 * filesystem, exactly as another process would.
 *
 * Checkpoint names are normalized (a ledger action id becomes its role) so a
 * recording from one fixture describes every other. Each sweep crashes at the
 * first AND the last time every distinct checkpoint is reached.
 */

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
  overrides: Partial<MigrationEngineDeps>,
): Promise<EngineResult> {
  return resumeMigration(harness.makeDeps(overrides), {
    acceptedSessionImpactDigest: null,
    reviewImpact: false,
  });
}

function rollback(
  harness: EngineHarness,
  overrides: Partial<MigrationEngineDeps>,
): Promise<EngineResult> {
  return rollbackMigration(harness.makeDeps(overrides));
}

/** Runs `run` and requires that the injected crash is what ended it. */
async function expectCrash(
  run: Promise<unknown>,
  crash: CrashingCheckpoint,
): Promise<void> {
  try {
    await run;
  } catch (error) {
    if (error instanceof CrashError && crash.fired()) return;
    throw error;
  }
  throw new Error("the injected crash was never reached");
}

async function labelled(
  label: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[${label}] ${message}`, { cause: error });
  }
}

function hasJournal(harness: EngineHarness): boolean {
  try {
    readActiveJournal(harness.bootstrapDir);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")(
  "migration engine recovery",
  { timeout: 900_000 },
  () => {
    const scope = harnessScope();

    /** A harness whose migration was halted just after `phase` was recorded. */
    async function haltedAt(phase: string): Promise<EngineHarness> {
      const harness = await scope.create();
      const crash = crashAtCheckpoint({
        target: `after-journal:${phase}`,
        occurrence: 1,
        normalize: harness.normalizeCheckpoint,
      });
      await expectCrash(
        start(harness, { checkpoint: crash.checkpoint }),
        crash,
      );
      expect(readActiveJournal(harness.bootstrapDir).phase).toBe(phase);
      return harness;
    }

    async function haltedAtPoint(target: string): Promise<EngineHarness> {
      const harness = await scope.create();
      const crash = crashAtCheckpoint({
        target,
        occurrence: 1,
        normalize: harness.normalizeCheckpoint,
      });
      await expectCrash(
        start(harness, { checkpoint: crash.checkpoint }),
        crash,
      );
      return harness;
    }

    describe("forward recovery", () => {
      it("converges to a complete, byte-equal migration from a crash at the first and last time every checkpoint is reached", async () => {
        const recorder = await scope.create();
        const recording = recordingCheckpoint(recorder.normalizeCheckpoint);
        assertDone(await start(recorder, { checkpoint: recording.checkpoint }));
        await recorder.dispose();

        const points = sweepPoints(recording.counts);
        // Every durable boundary of the happy path is in the sweep.
        const names = new Set(points.map((point) => point.name));
        for (const required of [
          "before-journal:planned",
          "after-journal:planned",
          "before-journal:quiescing",
          "after-journal:copying",
          "after-copy-file",
          "before-receipt-mirror",
          "after-receipt-mirror",
          "before-action:quiesce:state",
          "after-action:prepare:definition",
          "before-action:activate:state",
          "before-pointer-switch",
          "after-pointer-switch",
          "before-journal:activated",
          "after-journal:activated",
          "before-journal:complete",
          "after-journal:complete",
        ]) {
          expect(
            names.has(required),
            `the happy path reaches ${required}`,
          ).toBe(true);
        }
        expect(points.length).toBeGreaterThan(30);

        for (const { name, occurrence } of points) {
          const label = `${name}#${String(occurrence)}`;
          const harness = await scope.create();
          await labelled(label, async () => {
            const crash = crashAtCheckpoint({
              target: name,
              occurrence,
              normalize: harness.normalizeCheckpoint,
            });
            await expectCrash(
              start(harness, { checkpoint: crash.checkpoint }),
              crash,
            );
            // A crash before the first journal write leaves no migration to resume: a fresh start finishes.
            const result = hasJournal(harness)
              ? await resume(harness, {})
              : await start(harness, {});
            const journal = assertDone(result);
            await expectCompleted(harness, journal, harness.initial);
          });
          await harness.dispose();
        }
      });
    });

    describe("rollback", () => {
      const rollbackPhases = [
        "planned",
        "quiescing",
        "copying",
        "repairing",
        "preparing-external",
        "ready",
        "switching",
        "switched",
      ];

      it("rolls back from every pre-activation phase: pointer, registrations and source restored, gate open", async () => {
        for (const phase of rollbackPhases) {
          const harness = await haltedAt(phase);
          await labelled(`rollback from ${phase}`, async () => {
            const journal = assertDone(await rollback(harness, {}));
            await expectRolledBack(harness, journal, harness.initial);
            if (phase === "planned") {
              // Discarding a plan removes the empty destination this start allocated.
              expect(await pathExists(harness.destinationRoot)).toBe(false);
              expect(journal.rollbackFromPhase).toBeNull();
            } else {
              expect(journal.rollbackFromPhase).toBe(phase);
            }
          });
          await harness.dispose();
        }
      });

      it("a second rollback of a rolled-back migration is a no-op that still reports done", async () => {
        const harness = await haltedAt("ready");
        assertDone(await rollback(harness, {}));
        const again = assertDone(await rollback(harness, {}));
        await expectRolledBack(harness, again, harness.initial);
      });

      it("a crash during rollback is finished by the next run, from every checkpoint the rollback reaches", async () => {
        const recorder = await haltedAt("switched");
        const recording = recordingCheckpoint(recorder.normalizeCheckpoint);
        assertDone(
          await rollback(recorder, { checkpoint: recording.checkpoint }),
        );
        await recorder.dispose();

        const points = sweepPoints(recording.counts);
        for (const required of [
          "before-journal:rollback-requested",
          "after-journal:rollback-requested",
          "before-pointer-restore",
          "after-pointer-restore",
          "before-action:prepare:definition",
          "after-action:quiesce:state",
          "before-journal:rolled-back",
          "after-journal:rolled-back",
        ]) {
          expect(
            points.some((point) => point.name === required),
            `the rollback reaches ${required}`,
          ).toBe(true);
        }

        for (const { name, occurrence } of points) {
          const label = `${name}#${String(occurrence)}`;
          const harness = await haltedAt("switched");
          await labelled(label, async () => {
            const crash = crashAtCheckpoint({
              target: name,
              occurrence,
              normalize: harness.normalizeCheckpoint,
            });
            await expectCrash(
              rollback(harness, { checkpoint: crash.checkpoint }),
              crash,
            );
            const phase = readActiveJournal(harness.bootstrapDir).phase;
            // Once rollback-requested is durable, a plain resume continues the ROLLBACK, never the migration.
            const result =
              phase === "rollback-requested"
                ? await resume(harness, {})
                : await rollback(harness, {});
            const journal = assertDone(result);
            await expectRolledBack(harness, journal, harness.initial);
          });
          await harness.dispose();
        }
      });

      it("never moves forward again once rollback was requested", async () => {
        const harness = await haltedAt("ready");
        const crash = crashAtCheckpoint({
          target: "after-journal:rollback-requested",
          occurrence: 1,
          normalize: harness.normalizeCheckpoint,
        });
        await expectCrash(
          rollback(harness, { checkpoint: crash.checkpoint }),
          crash,
        );
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe(
          "rollback-requested",
        );
        const journal = assertDone(await resume(harness, {}));
        expect(journal.phase).toBe("rolled-back");
        expect(readLocation(harness.bootstrapDir)).toBeNull();
      });

      it("is refused from activation on, leaving the destination authoritative", async () => {
        const harness = await haltedAt("activated");
        const atActivation = assertStopped(await rollback(harness, {}));
        expect(atActivation.reason).toBe("blocked");
        expect(blockerCodes(atActivation)).toEqual(["rollback-refused"]);
        expect(atActivation.journal?.phase).toBe("activated");
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe("activated");
        const journal = assertDone(await resume(harness, {}));
        await expectCompleted(harness, journal, harness.initial);

        const afterComplete = assertStopped(await rollback(harness, {}));
        expect(blockerCodes(afterComplete)).toEqual(["rollback-refused"]);
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe("complete");
        expect(readLocation(harness.bootstrapDir)?.root).toBe(
          harness.destinationRoot,
        );
        // Resuming a complete migration is a no-op.
        assertDone(await resume(harness, {}));
      });
    });

    describe("a third party changes what the migration owns", () => {
      it("stops conflict, overwriting nothing, when the pointer holds a value that is neither old nor new (switching)", async () => {
        const harness = await haltedAtPoint("before-pointer-switch");
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe("switching");
        const elsewhere = join(harness.base, "elsewhere");
        await mkdir(elsewhere);
        const thirdValue = `${JSON.stringify({ version: 1, generation: 99, root: elsewhere, migrationId: null })}\n`;
        const locationPath = join(harness.bootstrapDir, "location.json");
        await writeFile(locationPath, thirdValue);

        const result = assertStopped(await resume(harness, {}));
        expect(result.reason).toBe("conflict");
        expect(blockerCodes(result)).toEqual(["pointer-conflict"]);
        expect(result.journal?.phase).toBe("switching");
        expect(await readText(locationPath)).toBe(thirdValue);
        expect(harness.gate().kind).toBe("blocked");

        // Rollback does not overwrite it either.
        const rolled = assertStopped(await rollback(harness, {}));
        expect(rolled.reason).toBe("conflict");
        expect(blockerCodes(rolled)).toEqual(["pointer-conflict"]);
        expect(await readText(locationPath)).toBe(thirdValue);
      });

      it("stops conflict when the pointer changes after the switch (switched)", async () => {
        const harness = await haltedAt("switched");
        const elsewhere = join(harness.base, "elsewhere");
        await mkdir(elsewhere);
        const thirdValue = `${JSON.stringify({ version: 1, generation: 99, root: elsewhere, migrationId: null })}\n`;
        const locationPath = join(harness.bootstrapDir, "location.json");
        await writeFile(locationPath, thirdValue);

        const result = assertStopped(await resume(harness, {}));
        expect(result.reason).toBe("conflict");
        expect(blockerCodes(result)).toEqual(["pointer-conflict"]);
        expect(result.journal?.phase).toBe("switched");
        expect(await readText(locationPath)).toBe(thirdValue);
      });

      it("stops conflict naming a registration someone else edited, leaving it exactly as they wrote it", async () => {
        const harness = await haltedAt("preparing-external");
        const theirs = "someone else rewrote this task definition\n";
        await writeFile(harness.services.definitionPath, theirs);

        const result = assertStopped(await resume(harness, {}));
        expect(result.reason).toBe("conflict");
        expect(blockerCodes(result)).toEqual(["external-conflict"]);
        expect(result.blockers[0]?.object).toBe(
          harness.services.definitionPath,
        );
        expect(result.journal?.phase).toBe("preparing-external");
        expect(await readText(harness.services.definitionPath)).toBe(theirs);
        expect(readLocation(harness.bootstrapDir)).toBeNull();
        expect(harness.gate().kind).toBe("blocked");

        // Rollback stops at the same object and does not touch it.
        const rolled = assertStopped(await rollback(harness, {}));
        expect(rolled.reason).toBe("conflict");
        expect(rolled.blockers[0]?.object).toBe(
          harness.services.definitionPath,
        );
        expect(await readText(harness.services.definitionPath)).toBe(theirs);
      });

      it("stops conflict for a registration changed after it was quiesced", async () => {
        const harness = await haltedAt("copying");
        expect(await harness.readTaskState()).toBe(STATE_DISABLED);
        await writeFile(harness.services.statePath, "re-enabled by hand\n");
        const result = assertStopped(await resume(harness, {}));
        expect(result.reason).toBe("conflict");
        expect(await harness.readTaskState()).toBe("re-enabled by hand\n");
      });
    });

    describe("the host's maintenance role changes underneath the migration", () => {
      it("fails when the installed build is not the one that started the migration, and finishes once it is back", async () => {
        const harness = await haltedAt("copying");
        harness.maintenance.build = "a-newer-build";
        const result = assertStopped(await resume(harness, {}));
        expect(result.reason).toBe("failed");
        expect(blockerCodes(result)).toEqual(["maintenance-build-changed"]);
        expect(result.journal?.phase).toBe("repairing");
        expect(harness.gate().kind).toBe("blocked");

        harness.maintenance.build = "test-host";
        const journal = assertDone(await resume(harness, {}));
        await expectCompleted(harness, journal, harness.initial);
      });

      it("stops conflict when a repair receipt differs from the one the journal mirrored, and finishes once it agrees", async () => {
        const harness = await haltedAtPoint("after-receipt-mirror");
        expect(
          readActiveJournal(harness.bootstrapDir).adapterReceipts,
        ).toHaveLength(1);
        harness.maintenance.receiptSalt = "b";
        const result = assertStopped(await resume(harness, {}));
        expect(result.reason).toBe("conflict");
        expect(blockerCodes(result)).toEqual(["receipt-mismatch"]);

        harness.maintenance.receiptSalt = "a";
        const journal = assertDone(await resume(harness, {}));
        await expectCompleted(harness, journal, harness.initial);
      });
    });

    describe("the coordinator lock", () => {
      async function writeLock(
        harness: EngineHarness,
        pid: number,
      ): Promise<void> {
        const holder = {
          version: 1,
          purpose: "coordinator",
          pid,
          startIdentity: "recorded-start",
          nonce: "stale-nonce",
          acquiredAt: Date.now(),
        };
        await writeFile(
          join(harness.bootstrapDir, MIGRATION_COORDINATOR_LOCK_FILENAME),
          JSON.stringify(holder),
          { mode: 0o600 },
        );
      }

      it("is taken over from a coordinator proven gone, and the migration finishes", async () => {
        const harness = await haltedAt("ready");
        await writeLock(harness, 999_991);
        const journal = assertDone(await resume(harness, {}));
        await expectCompleted(harness, journal, harness.initial);
      });

      it("is never taken over from a coordinator whose liveness cannot be proven", async () => {
        const harness = await haltedAt("ready");
        await writeLock(harness, 999_992);
        harness.probe.indeterminate.add(999_992);
        const result = assertStopped(await resume(harness, {}));
        expect(result.reason).toBe("blocked");
        expect(blockerCodes(result)).toEqual(["coordinator-ambiguous"]);
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe("ready");
      });

      it("is never taken over while its holder is alive, nor when it is unreadable", async () => {
        const harness = await haltedAt("ready");
        await writeLock(harness, 999_993);
        harness.probe.alive.add(999_993);
        const held = assertStopped(await resume(harness, {}));
        expect(blockerCodes(held)).toEqual(["coordinator-held"]);

        await writeFile(
          join(harness.bootstrapDir, MIGRATION_COORDINATOR_LOCK_FILENAME),
          "{ torn",
          { mode: 0o600 },
        );
        const corrupt = assertStopped(await resume(harness, {}));
        expect(blockerCodes(corrupt)).toEqual(["coordinator-corrupt"]);
        expect(
          await readFile(
            join(harness.bootstrapDir, MIGRATION_COORDINATOR_LOCK_FILENAME),
            "utf8",
          ),
        ).toBe("{ torn");
      });
    });
  },
);
