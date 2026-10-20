import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  sha256DigestSchema,
  type MigrationJournal,
  type SessionImpact,
  type Sha256Digest,
} from "@traycer/protocol/config/data-migration-contracts";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import { startMigration } from "../../engine/migration-engine";
import {
  assertStopped,
  expectCompleted,
  factTree,
  FakeProcessProbe,
  freshContextImpact,
  harnessScope,
  pathExists,
  readActiveJournal,
  sampleJournal,
  snapshotIfPresent,
  type EngineHarness,
} from "../../engine/__tests__/engine-fixtures";
import {
  DATA_ROOT_AVAILABILITY,
  type DataRootAvailability,
} from "../data-availability";
import type {
  DataCommandDeps,
  DataCommandIo,
  DataCommandOutcome,
} from "../data-command-types";
import { dataMigrate, discardPlan } from "../data-migrate";
import { nextStepLines } from "../data-report";

const ENABLED: DataRootAvailability = {
  win32: { init: true, migrate: true },
  posix: { init: true, migrate: true },
};

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
  availability: DataRootAvailability,
  io: ScriptedIo,
): DataCommandDeps {
  return {
    homeDir: harness.home,
    platform: "posix",
    env: {},
    availability,
    probe: new FakeProcessProbe(),
    engine: () => harness.makeDeps({}),
    signal: new AbortController().signal,
    io,
  };
}

function nativeHold(sessionId: string): SessionImpact {
  return {
    ...freshContextImpact(sessionId),
    route: { primary: "native-resume", onFailure: "hold" },
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

function digestOf(
  outcome: Extract<DataCommandOutcome, { status: "error" }>,
): Sha256Digest {
  return sha256DigestSchema.parse(outcome.details?.digest);
}

const START = { dryRun: false, acceptSessionImpact: null };

describe.skipIf(process.platform === "win32")(
  "traycer data migrate",
  { timeout: 180_000 },
  () => {
    const scope = harnessScope();

    it("is unavailable under the production availability: no destination and no journal", async () => {
      const harness = await scope.create();
      const outcome = errorOf(
        await dataMigrate(
          depsFor(harness, DATA_ROOT_AVAILABILITY, new ScriptedIo(false, [])),
          { ...START, to: harness.destinationRoot, yes: true },
        ),
      );
      expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_OPERATION_UNAVAILABLE);
      expect(await pathExists(harness.destinationRoot)).toBe(false);
      expect(await pathExists(harness.bootstrapDir)).toBe(false);
    });

    it("--dry-run writes nothing even when the migration is enabled", async () => {
      const harness = await scope.create();
      const before = [
        await snapshotIfPresent(harness.home),
        await snapshotIfPresent(harness.destinationParent),
      ];
      const outcome = okOf(
        await dataMigrate(
          depsFor(harness, ENABLED, new ScriptedIo(false, [])),
          {
            to: harness.destinationRoot,
            dryRun: true,
            yes: false,
            acceptSessionImpact: null,
          },
        ),
      );
      expect(outcome.data.available).toBe(true);
      expect(outcome.text.join("\n")).toContain("This dry run changed nothing");
      expect([
        await snapshotIfPresent(harness.home),
        await snapshotIfPresent(harness.destinationParent),
      ]).toEqual(before);
      expect(await pathExists(harness.bootstrapDir)).toBe(false);
      expect(await pathExists(harness.destinationRoot)).toBe(false);
    });

    it("on a machine with no data folder, refuses with source-absent and describes no move", async () => {
      const harness = await scope.create();
      await rm(harness.sourceRoot, { recursive: true, force: true });

      for (const dryRun of [true, false]) {
        const outcome = errorOf(
          await dataMigrate(
            depsFor(harness, ENABLED, new ScriptedIo(false, [])),
            { ...START, to: harness.destinationRoot, dryRun, yes: true },
          ),
        );
        expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED);
        const text = outcome.text.join("\n");
        expect(text).toContain("[source-absent]");
        expect(text).not.toMatch(/Moves:|Space:|backup/u);
      }
      expect(await pathExists(harness.destinationRoot)).toBe(false);
    });

    describe("impact acceptance", () => {
      it("non-interactive --yes with an impact needing acceptance reports the digest and rolls the plan back; the digest then completes", async () => {
        const harness = await scope.create();
        harness.maintenance.impacts = () => [freshContextImpact("s1")];
        const sourceBefore = await factTree(harness.sourceRoot);

        const stopped = errorOf(
          await dataMigrate(
            depsFor(harness, ENABLED, new ScriptedIo(false, [])),
            { ...START, to: harness.destinationRoot, yes: true },
          ),
        );

        expect(stopped.code).toBe(CLI_ERROR_CODES.DATA_ACCEPTANCE_REQUIRED);
        const digest = digestOf(stopped);
        expect(stopped.message).toContain(digest);
        expect(stopped.details?.phase).toBe("rolled-back");
        const text = stopped.text.join("\n");
        expect(text).toContain("rolled back");
        expect(text).toContain("removed");
        expect(text).toContain("Its record stays in ~/.traycer-bootstrap");
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe(
          "rolled-back",
        );
        expect(harness.gate()).toEqual({ kind: "open", generation: null });
        expect(await factTree(harness.sourceRoot)).toEqual(sourceBefore);

        const done = okOf(
          await dataMigrate(
            depsFor(harness, ENABLED, new ScriptedIo(false, [])),
            {
              ...START,
              to: harness.destinationRoot,
              yes: true,
              acceptSessionImpact: digest,
            },
          ),
        );
        expect(done.data.phase).toBe("complete");
        await expectCompleted(
          harness,
          readActiveJournal(harness.bootstrapDir),
          harness.initial,
        );
      });

      it("an interactive review stops even an all-native impact, shows it, and completes after confirm", async () => {
        const harness = await scope.create();
        harness.maintenance.impacts = () => [nativeHold("s2")];
        const io = new ScriptedIo(true, [true, true]);

        const done = okOf(
          await dataMigrate(depsFor(harness, ENABLED, io), {
            ...START,
            to: harness.destinationRoot,
            yes: false,
          }),
        );

        expect(done.data.phase).toBe("complete");
        expect(io.questions).toEqual(["Start the move?", "Continue the move?"]);
        expect(io.notes.join("\n")).toContain(
          "Sessions whose working folder or provider files move: 1",
        );
        await expectCompleted(
          harness,
          readActiveJournal(harness.bootstrapDir),
          harness.initial,
        );
      });

      it("declining at the impact review discards the plan and changes nothing", async () => {
        const harness = await scope.create();
        harness.maintenance.impacts = () => [nativeHold("s2")];
        const io = new ScriptedIo(true, [true, false]);
        const sourceBefore = await factTree(harness.sourceRoot);

        const outcome = errorOf(
          await dataMigrate(depsFor(harness, ENABLED, io), {
            ...START,
            to: harness.destinationRoot,
            yes: false,
          }),
        );

        expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_ACCEPTANCE_REQUIRED);
        expect(outcome.message).toBe("the move was not continued");
        expect(io.notes.join("\n")).toContain(
          "Sessions whose working folder or provider files move: 1",
        );
        expect(outcome.text.join("\n")).toContain("rolled back");
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe(
          "rolled-back",
        );
        expect(harness.gate()).toEqual({ kind: "open", generation: null });
        expect(await factTree(harness.sourceRoot)).toEqual(sourceBefore);
        expect(await harness.readTaskState()).toBe("enabled\n");
      });

      it("declining the first prompt changes nothing: no journal, no destination", async () => {
        const harness = await scope.create();
        const io = new ScriptedIo(true, [false]);
        const outcome = errorOf(
          await dataMigrate(depsFor(harness, ENABLED, io), {
            ...START,
            to: harness.destinationRoot,
            yes: false,
          }),
        );
        expect(outcome.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
        expect(io.questions).toEqual(["Start the move?"]);
        expect(await pathExists(harness.bootstrapDir)).toBe(false);
        expect(await pathExists(harness.destinationRoot)).toBe(false);
      });

      it("--yes on an interactive terminal never prompts, even for an all-native impact", async () => {
        const harness = await scope.create();
        harness.maintenance.impacts = () => [nativeHold("s2")];
        const io = new ScriptedIo(true, []);
        const done = okOf(
          await dataMigrate(depsFor(harness, ENABLED, io), {
            ...START,
            to: harness.destinationRoot,
            yes: true,
          }),
        );
        expect(done.data.phase).toBe("complete");
        expect(io.questions).toEqual([]);
      });

      it("--yes on an interactive terminal does not prompt for an impact needing acceptance either", async () => {
        const harness = await scope.create();
        harness.maintenance.impacts = () => [freshContextImpact("s1")];
        const io = new ScriptedIo(true, []);
        const outcome = errorOf(
          await dataMigrate(depsFor(harness, ENABLED, io), {
            ...START,
            to: harness.destinationRoot,
            yes: true,
          }),
        );
        expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_ACCEPTANCE_REQUIRED);
        expect(io.questions).toEqual([]);
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe(
          "rolled-back",
        );
      });

      it("refuses without --yes when there is no prompt", async () => {
        const harness = await scope.create();
        const outcome = errorOf(
          await dataMigrate(
            depsFor(harness, ENABLED, new ScriptedIo(false, [])),
            { ...START, to: harness.destinationRoot, yes: false },
          ),
        );
        expect(outcome.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
        expect(await pathExists(harness.bootstrapDir)).toBe(false);
        expect(await pathExists(harness.destinationRoot)).toBe(false);
      });
    });

    describe("discardPlan", () => {
      async function planned(
        harness: EngineHarness,
      ): Promise<MigrationJournal> {
        harness.maintenance.impacts = () => [nativeHold("s2")];
        const stopped = assertStopped(
          await startMigration(harness.makeDeps({}), {
            destination: harness.destinationRoot,
            acceptedSessionImpactDigest: null,
            reviewImpact: true,
          }),
        );
        if (stopped.journal === null)
          throw new Error("the stop carries the planned journal");
        expect(stopped.journal.phase).toBe("planned");
        return stopped.journal;
      }

      function expectRecordLine(text: string): void {
        expect(text).toContain("Its record stays in ~/.traycer-bootstrap");
      }

      it("says the empty destination was removed", async () => {
        const harness = await scope.create();
        const journal = await planned(harness);
        const result = await discardPlan(harness.makeDeps({}), journal);
        const text = result.lines.join("\n");
        expect(result.discarded).toBe(true);
        expect(text).toContain("was removed");
        expectRecordLine(text);
        expect(await pathExists(harness.destinationRoot)).toBe(false);
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe(
          "rolled-back",
        );
      });

      it("says the destination was kept when something was written into it", async () => {
        const harness = await scope.create();
        const journal = await planned(harness);
        await writeFile(
          join(harness.destinationRoot, "stray.txt"),
          "not ours\n",
        );
        const result = await discardPlan(harness.makeDeps({}), journal);
        const text = result.lines.join("\n");
        expect(result.discarded).toBe(true);
        expect(text).toContain("was kept");
        expect(text).not.toContain("was removed");
        expectRecordLine(text);
        expect(await pathExists(harness.destinationRoot)).toBe(true);
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe(
          "rolled-back",
        );
      });

      it("says it could not be checked, never removed, when the destination and its parent are gone", async () => {
        const harness = await scope.create();
        const journal = await planned(harness);
        await rename(
          harness.destinationRoot,
          join(harness.destinationParent, "data-away"),
        );
        await rename(
          harness.destinationParent,
          join(harness.base, "dest-away"),
        );
        const result = await discardPlan(harness.makeDeps({}), journal);
        const text = result.lines.join("\n");
        expect(result.discarded).toBe(true);
        expect(text).toContain("could not check whether");
        expect(text).not.toContain("was removed");
        expectRecordLine(text);
        expect(readActiveJournal(harness.bootstrapDir).phase).toBe(
          "rolled-back",
        );
      });

      it.skipIf(process.getuid !== undefined && process.getuid() === 0)(
        "says it could not be checked, never removed, when the parent cannot be read (EACCES)",
        async () => {
          const harness = await scope.create();
          const journal = await planned(harness);
          const parent = dirname(journal.destination.path);
          await chmod(parent, 0o000);
          try {
            const result = await discardPlan(harness.makeDeps({}), journal);
            const text = result.lines.join("\n");
            expect(result.discarded).toBe(true);
            expect(text).toContain("could not check whether");
            expect(text).not.toContain("was removed");
            expectRecordLine(text);
          } finally {
            await chmod(parent, 0o700);
          }
          expect(readActiveJournal(harness.bootstrapDir).phase).toBe(
            "rolled-back",
          );
        },
      );
    });

    describe("nextStepLines for a planned journal", () => {
      it("says nothing was copied yet, not that nothing has been changed", () => {
        const text = nextStepLines(
          sampleJournal({ maintenanceBuild: null }),
        ).join("\n");
        expect(text).toContain("nothing was copied yet");
        expect(text).not.toContain("nothing has been changed");
        expect(text).toContain("traycer data recover --rollback");
      });
    });
  },
);
