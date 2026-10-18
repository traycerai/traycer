import { describe, expect, it } from "vitest";
import type {
  MigrationId,
  SessionImpact,
} from "@traycer/protocol/config/data-migration-contracts";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import type { MigrationEngineDeps } from "../../engine/engine-deps";
import { underRoot } from "../../engine/content-inventory";
import {
  rollbackMigration,
  startMigration,
} from "../../engine/migration-engine";
import {
  assertDone,
  assertStopped,
  CrashError,
  crashAtCheckpoint,
  expectCompleted,
  expectRolledBack,
  factTree,
  FakeProcessProbe,
  freshContextImpact,
  harnessScope,
  NOTES_FILE,
  pathExists,
  readActiveJournal,
  runToCompletion,
  type EngineHarness,
} from "../../engine/__tests__/engine-fixtures";
import type { DataRootAvailability } from "../data-availability";
import type {
  DataCommandDeps,
  DataCommandIo,
  DataCommandOutcome,
} from "../data-command-types";
import { dataCleanup } from "../data-cleanup";
import { dataRecover } from "../data-recover";

const ENABLED: DataRootAvailability = {
  win32: { init: true, migrate: true },
  posix: { init: true, migrate: true },
};
const UNKNOWN_MIGRATION: MigrationId = "m-00000000-0000-4000-8000-0000000000aa";

class ScriptedIo implements DataCommandIo {
  readonly json = false;
  readonly notes: string[] = [];
  readonly questions: string[] = [];
  constructor(
    readonly interactive: boolean,
    private readonly answers: boolean[],
  ) {}
  note(text: string): void {
    this.notes.push(text);
  }
  progress(): void {
    return undefined;
  }
  confirm(question: string): Promise<boolean> {
    this.questions.push(question);
    return Promise.resolve(this.answers.shift() ?? false);
  }
}

function depsFor(
  harness: EngineHarness,
  io: ScriptedIo,
  engine: () => MigrationEngineDeps,
): DataCommandDeps {
  return {
    homeDir: harness.home,
    platform: "posix",
    env: {},
    availability: ENABLED,
    probe: new FakeProcessProbe(),
    engine,
    signal: new AbortController().signal,
    io,
  };
}

function errorOf(
  outcome: DataCommandOutcome,
): Extract<DataCommandOutcome, { status: "error" }> {
  if (outcome.status !== "error")
    throw new Error(
      `expected an error outcome, got ok: ${outcome.text.join(" | ")}`,
    );
  return outcome;
}

function okOf(
  outcome: DataCommandOutcome,
): Extract<DataCommandOutcome, { status: "ok" }> {
  if (outcome.status !== "ok")
    throw new Error(`expected ok, got ${outcome.code}: ${outcome.message}`);
  return outcome;
}

const RECOVER = { restoreRecord: false, acceptSessionImpact: null };

describe.skipIf(process.platform === "win32")(
  "traycer data recover and cleanup",
  { timeout: 180_000 },
  () => {
    const scope = harnessScope();

    /** A migration halted just after `phase` was recorded. */
    async function haltedAfter(phase: string): Promise<EngineHarness> {
      const harness = await scope.create();
      const crash = crashAtCheckpoint({
        target: `after-journal:${phase}`,
        occurrence: 1,
        normalize: harness.normalizeCheckpoint,
      });
      await expect(
        startMigration(harness.makeDeps({ checkpoint: crash.checkpoint }), {
          destination: harness.destinationRoot,
          acceptedSessionImpactDigest: null,
          reviewImpact: false,
        }),
      ).rejects.toBeInstanceOf(CrashError);
      expect(readActiveJournal(harness.bootstrapDir).phase).toBe(phase);
      return harness;
    }

    function recoverDeps(
      harness: EngineHarness,
      io: ScriptedIo,
    ): DataCommandDeps {
      return depsFor(harness, io, () => harness.makeDeps({}));
    }

    function cleanupDeps(
      harness: EngineHarness,
      io: ScriptedIo,
      fromDestination: boolean,
    ): DataCommandDeps {
      return depsFor(harness, io, () =>
        fromDestination
          ? harness.makeDestinationDeps({})
          : harness.makeDeps({}),
      );
    }

    describe("dataRecover", () => {
      it("--rollback --yes at a barrier phase puts everything back", async () => {
        const harness = await haltedAfter("copying");
        const outcome = okOf(
          await dataRecover(recoverDeps(harness, new ScriptedIo(false, [])), {
            ...RECOVER,
            rollback: true,
            yes: true,
          }),
        );
        expect(outcome.data.phase).toBe("rolled-back");
        await expectRolledBack(
          harness,
          readActiveJournal(harness.bootstrapDir),
          harness.initial,
        );
      });

      it("refuses a rollback after activation and leaves the migration where it was", async () => {
        const harness = await haltedAfter("activated");
        const outcome = errorOf(
          await dataRecover(recoverDeps(harness, new ScriptedIo(false, [])), {
            ...RECOVER,
            rollback: true,
            yes: true,
          }),
        );
        expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED);
        expect(outcome.message).toContain("can no longer be rolled back");
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe("activated");
      });

      it("plain recover resumes a halted move to done", async () => {
        const harness = await haltedAfter("copying");
        const outcome = okOf(
          await dataRecover(recoverDeps(harness, new ScriptedIo(false, [])), {
            ...RECOVER,
            rollback: false,
            yes: true,
          }),
        );
        expect(outcome.data.phase).toBe("complete");
        await expectCompleted(
          harness,
          readActiveJournal(harness.bootstrapDir),
          harness.initial,
        );
      });

      it("without --yes and without a prompt changes nothing", async () => {
        const harness = await haltedAfter("copying");
        const outcome = errorOf(
          await dataRecover(recoverDeps(harness, new ScriptedIo(false, [])), {
            ...RECOVER,
            rollback: false,
            yes: false,
          }),
        );
        expect(outcome.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe("copying");
      });

      describe("rolling back a planned move", () => {
        async function plannedHarness(): Promise<EngineHarness> {
          const harness = await scope.create();
          const impact: SessionImpact = {
            ...freshContextImpact("s2"),
            route: { primary: "native-resume", onFailure: "hold" },
          };
          harness.maintenance.impacts = () => [impact];
          const stopped = assertStopped(
            await startMigration(harness.makeDeps({}), {
              destination: harness.destinationRoot,
              acceptedSessionImpactDigest: null,
              reviewImpact: true,
            }),
          );
          expect(stopped.journal?.phase).toBe("planned");
          return harness;
        }

        it("describes it as nothing copied, and reports it rolled back before anything was copied", async () => {
          const harness = await plannedHarness();
          const io = new ScriptedIo(false, []);

          const outcome = okOf(
            await dataRecover(recoverDeps(harness, io), {
              ...RECOVER,
              rollback: true,
              yes: true,
            }),
          );

          const notes = io.notes.join("\n");
          expect(notes).toContain("Nothing has been copied");
          expect(notes.toLowerCase()).not.toContain("nothing has been changed");
          const text = outcome.text.join("\n");
          expect(text).toContain("rolled back before anything was copied");
          expect(text).not.toContain("Everything is back");
          expect(outcome.data.phase).toBe("rolled-back");
          expect(readActiveJournal(harness.bootstrapDir).phase).toBe(
            "rolled-back",
          );
          expect(await factTree(harness.sourceRoot)).toEqual(
            harness.initial.facts,
          );
        });
      });
    });

    describe("dataCleanup", () => {
      it("after completion deletes the old folder, and the prompt names it as the OLD folder", async () => {
        const harness = await scope.create();
        const journal = await runToCompletion(harness);
        const io = new ScriptedIo(true, [true]);

        const outcome = okOf(
          await dataCleanup(cleanupDeps(harness, io, true), {
            migrationId: journal.id,
            yes: false,
          }),
        );

        expect(outcome.data).toMatchObject({
          migrationId: journal.id,
          deleted: "source",
          path: harness.sourceRoot,
        });
        expect(io.questions).toHaveLength(1);
        expect(io.questions[0]).toContain(harness.sourceRoot);
        const notes = io.notes.join("\n");
        expect(notes).toContain(harness.sourceRoot);
        expect(notes).toContain("OLD folder");
        expect(await pathExists(harness.sourceRoot)).toBe(false);
        expect(await pathExists(harness.destinationRoot)).toBe(true);
      });

      it("with --yes names the old folder in its notes and deletes it", async () => {
        const harness = await scope.create();
        const journal = await runToCompletion(harness);
        const io = new ScriptedIo(false, []);

        okOf(
          await dataCleanup(cleanupDeps(harness, io, true), {
            migrationId: journal.id,
            yes: true,
          }),
        );

        const notes = io.notes.join("\n");
        expect(notes).toContain(harness.sourceRoot);
        expect(notes).toContain("OLD folder");
        expect(await pathExists(harness.sourceRoot)).toBe(false);
      });

      it("a second cleanup after the old folder was deleted reports it already deleted and succeeds", async () => {
        const harness = await scope.create();
        const journal = await runToCompletion(harness);

        const first = okOf(
          await dataCleanup(
            cleanupDeps(harness, new ScriptedIo(false, []), true),
            { migrationId: journal.id, yes: true },
          ),
        );

        const second = okOf(
          await dataCleanup(
            cleanupDeps(harness, new ScriptedIo(false, []), true),
            { migrationId: journal.id, yes: true },
          ),
        );
        expect(second.data).toMatchObject({
          migrationId: journal.id,
          deleted: "source",
          path: harness.sourceRoot,
          phase: "complete",
          alreadyDeleted: true,
        });
        expect(second.text.join("\n")).toContain("was already deleted");
        expect(first.data).toMatchObject({ alreadyDeleted: false });
      });

      it("after a rollback from copying discards the unused destination and says the source is untouched", async () => {
        const harness = await haltedAfter("copying");
        assertDone(await rollbackMigration(harness.makeDeps({})));
        const journal = readActiveJournal(harness.bootstrapDir);
        expect(journal.phase).toBe("rolled-back");
        const io = new ScriptedIo(false, []);

        const outcome = okOf(
          await dataCleanup(cleanupDeps(harness, io, false), {
            migrationId: journal.id,
            yes: true,
          }),
        );

        expect(outcome.data).toMatchObject({
          migrationId: journal.id,
          deleted: "destination",
          path: harness.destinationRoot,
        });
        const notes = io.notes.join("\n");
        expect(notes).toContain(harness.destinationRoot);
        expect(notes).toContain("not touched");
        expect(notes).toContain(harness.sourceRoot);
        expect(await pathExists(harness.destinationRoot)).toBe(false);
        expect(await factTree(harness.sourceRoot)).toEqual(
          harness.initial.facts,
        );
      });

      it("a second cleanup after a rollback reports the unused copy already deleted and asks nothing", async () => {
        const harness = await haltedAfter("copying");
        assertDone(await rollbackMigration(harness.makeDeps({})));
        const journal = readActiveJournal(harness.bootstrapDir);
        okOf(
          await dataCleanup(
            cleanupDeps(harness, new ScriptedIo(false, []), false),
            { migrationId: journal.id, yes: true },
          ),
        );
        const io = new ScriptedIo(true, []);

        const again = okOf(
          await dataCleanup(cleanupDeps(harness, io, false), {
            migrationId: journal.id,
            yes: false,
          }),
        );

        expect(again.data).toMatchObject({
          migrationId: journal.id,
          deleted: "destination",
          path: harness.destinationRoot,
          phase: "rolled-back",
          alreadyDeleted: true,
        });
        expect(again.text.join("\n")).toContain("was already deleted");
        expect(io.questions).toEqual([]);
      });

      // After repair the engine keeps repaired stores (no exact byte record
      // proves them unchanged; source-cleanup.ts discard rules), so the discard
      // stops with only kept-file blockers and the user may finish by hand.
      it("after a rollback from ready keeps the repaired stores, deletes the plain copies and says the folder can be deleted by hand", async () => {
        const harness = await haltedAfter("ready");
        assertDone(await rollbackMigration(harness.makeDeps({})));
        const journal = readActiveJournal(harness.bootstrapDir);
        expect(journal.phase).toBe("rolled-back");
        const io = new ScriptedIo(false, []);

        const outcome = await dataCleanup(cleanupDeps(harness, io, false), {
          migrationId: journal.id,
          yes: true,
        });

        if (outcome.status !== "error")
          throw new Error("expected the discard to stop with kept files");
        expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED);
        const blockers = (outcome.details?.blockers ?? []) as readonly {
          readonly code: string;
        }[];
        expect(blockers.length).toBeGreaterThan(0);
        expect(
          blockers.every((blocker) => blocker.code.startsWith("discard-")),
        ).toBe(true);
        expect(
          blockers.some((blocker) => blocker.code === "discard-repaired-store"),
        ).toBe(true);
        expect(outcome.text.join("\n")).toContain(
          "you can delete that folder yourself",
        );
        expect(
          await pathExists(underRoot(harness.destinationRoot, NOTES_FILE)),
        ).toBe(false);
        expect(await factTree(harness.sourceRoot)).toEqual(
          harness.initial.facts,
        );
      });

      it("gives E_NOT_FOUND for an unknown migration id", async () => {
        const harness = await scope.create();
        const outcome = errorOf(
          await dataCleanup(
            cleanupDeps(harness, new ScriptedIo(false, []), true),
            { migrationId: UNKNOWN_MIGRATION, yes: true },
          ),
        );
        expect(outcome.code).toBe(CLI_ERROR_CODES.NOT_FOUND);
      });

      it("gives E_INVALID_ARGUMENT for a malformed migration id", async () => {
        const harness = await scope.create();
        const outcome = errorOf(
          await dataCleanup(
            cleanupDeps(harness, new ScriptedIo(false, []), true),
            { migrationId: "not-a-migration", yes: true },
          ),
        );
        expect(outcome.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
      });

      it("without --yes and without a prompt deletes nothing", async () => {
        const harness = await scope.create();
        const journal = await runToCompletion(harness);
        const outcome = errorOf(
          await dataCleanup(
            cleanupDeps(harness, new ScriptedIo(false, []), true),
            { migrationId: journal.id, yes: false },
          ),
        );
        expect(outcome.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
        expect(outcome.message).toContain("--yes");
        expect(await factTree(harness.sourceRoot)).toEqual(
          harness.initial.facts,
        );
      });

      it("declining at the prompt deletes nothing", async () => {
        const harness = await scope.create();
        const journal = await runToCompletion(harness);
        const io = new ScriptedIo(true, [false]);
        errorOf(
          await dataCleanup(cleanupDeps(harness, io, true), {
            migrationId: journal.id,
            yes: false,
          }),
        );
        expect(io.questions).toHaveLength(1);
        expect(await factTree(harness.sourceRoot)).toEqual(
          harness.initial.facts,
        );
      });
    });
  },
);
