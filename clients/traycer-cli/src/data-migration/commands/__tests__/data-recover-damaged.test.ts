import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import { startMigration } from "../../engine/migration-engine";
import {
  CrashError,
  crashAtCheckpoint,
  FakeProcessProbe,
  harnessScope,
  readActiveJournal,
  type EngineHarness,
} from "../../engine/__tests__/engine-fixtures";
import type { DataRootAvailability } from "../data-availability";
import type {
  DataCommandDeps,
  DataCommandIo,
  DataCommandOutcome,
} from "../data-command-types";
import { dataRecover } from "../data-recover";
import { dataStatus } from "../data-status";

const ENABLED: DataRootAvailability = {
  win32: { init: true, migrate: true },
  posix: { init: true, migrate: true },
};
const TORN = "{ this record was torn";

class SilentIo implements DataCommandIo {
  readonly json = false;
  readonly interactive = false;
  note(): void {
    return undefined;
  }
  progress(): void {
    return undefined;
  }
  confirm(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function depsFor(harness: EngineHarness): DataCommandDeps {
  return {
    homeDir: harness.home,
    platform: "posix",
    env: {},
    availability: ENABLED,
    probe: new FakeProcessProbe(),
    engine: () => harness.makeDeps({}),
    signal: new AbortController().signal,
    io: new SilentIo(),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected an object");
  return value;
}

const RECOVER = {
  rollback: false,
  restoreRecord: false,
  yes: true,
  acceptSessionImpact: null,
};
const RESTORE = { ...RECOVER, restoreRecord: true };

describe.skipIf(process.platform === "win32")(
  "traycer data recover with damaged records",
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

    const selectorPath = (harness: EngineHarness): string =>
      join(harness.bootstrapDir, "migration.json");
    const journalPath = (harness: EngineHarness, id: string): string =>
      join(harness.bootstrapDir, `migration-${id}.json`);
    const previousJournalPath = (harness: EngineHarness, id: string): string =>
      join(harness.bootstrapDir, `migration-${id}.prev.json`);

    /** The phase recorded in a journal file's envelope (`{ body: { phase } }`). */
    function phaseInFile(path: string): string {
      const body = record(record(JSON.parse(readFileSync(path, "utf8"))).body);
      const phase = body.phase;
      if (typeof phase !== "string")
        throw new Error("the record carries no phase");
      return phase;
    }

    it("a damaged selector blocks plain recover, naming --restore-record, and changes nothing", async () => {
      const harness = await haltedAfter("copying");
      writeFileSync(selectorPath(harness), TORN);

      const outcome = errorOf(await dataRecover(depsFor(harness), RECOVER));

      expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED);
      expect(outcome.message).toContain("--restore-record");
      expect(outcome.details).toEqual({ record: "damaged-selector" });
      expect(readFileSync(selectorPath(harness), "utf8")).toBe(TORN);
    });

    it("--restore-record on a damaged selector is refused by the engine when a barrier journal could be the lost transaction", async () => {
      // Trace: dataRecover -> restoreDamagedRecord(selector) -> restorePreviousRecordRevision.
      // The selector was written once (revision 1), so there is no migration.prev.json at all,
      // and the protocol first checks every other journal: the active one is non-terminal and
      // not `planned`, so it could hold a barrier the restore would silently drop. Either that
      // transition-refused or the missing previous revision (invalid-record) stops it, both
      // BootstrapRecordErrors that the coordinator wrapper turns into a stopped result, which
      // stoppedOutcome reports as E_DATA_MIGRATION_BLOCKED. Nothing is overwritten.
      const harness = await haltedAfter("copying");
      writeFileSync(selectorPath(harness), TORN);

      const outcome = errorOf(await dataRecover(depsFor(harness), RESTORE));

      expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED);
      expect(readFileSync(selectorPath(harness), "utf8")).toBe(TORN);
      const status = okOf(await dataStatus(depsFor(harness)));
      expect(record(status.data.selector).kind).toBe("damaged");
    });

    it("restores a damaged journal at a barrier phase from its previous revision", async () => {
      const harness = await haltedAfter("copying");
      const id = readActiveJournal(harness.bootstrapDir).id;
      const expectedPhase = phaseInFile(previousJournalPath(harness, id));
      expect(expectedPhase).not.toBe("switched");
      writeFileSync(journalPath(harness, id), TORN);

      const plain = errorOf(await dataRecover(depsFor(harness), RECOVER));
      expect(plain.code).toBe(CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED);
      expect(plain.message).toContain("--restore-record");

      const restored = okOf(await dataRecover(depsFor(harness), RESTORE));

      expect(restored.data).toEqual({ migrationId: id, phase: expectedPhase });
      expect(readActiveJournal(harness.bootstrapDir).phase).toBe(expectedPhase);
      const status = okOf(await dataStatus(depsFor(harness)));
      expect(record(status.data.selector).kind).toBe("valid");
      const migrations = status.data.migrations;
      if (!Array.isArray(migrations))
        throw new Error("expected a migrations list");
      expect(record(migrations[0])).toMatchObject({
        id,
        kind: "valid",
        phase: expectedPhase,
      });
    });

    it("refuses to restore a damaged journal whose previous revision is switched, and overwrites nothing", async () => {
      // Trace: restorePreviousRecordRevision(journal) reads the pair; a damaged current with a
      // previous revision in `switched` throws transition-refused, because the lost revision
      // may have been `activated` and restoring `switched` would reopen rollback.
      const harness = await haltedAfter("activated");
      const id = readActiveJournal(harness.bootstrapDir).id;
      expect(phaseInFile(previousJournalPath(harness, id))).toBe("switched");
      const previousBytes = readFileSync(
        previousJournalPath(harness, id),
        "utf8",
      );
      writeFileSync(journalPath(harness, id), TORN);

      const outcome = errorOf(await dataRecover(depsFor(harness), RESTORE));

      expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED);
      expect(readFileSync(journalPath(harness, id), "utf8")).toBe(TORN);
      expect(readFileSync(previousJournalPath(harness, id), "utf8")).toBe(
        previousBytes,
      );
    });

    it("--restore-record with nothing damaged is E_INVALID_ARGUMENT", async () => {
      const harness = await haltedAfter("copying");
      const outcome = errorOf(await dataRecover(depsFor(harness), RESTORE));
      expect(outcome.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
      expect(outcome.message).toContain("no damaged migration record");
      expect(readActiveJournal(harness.bootstrapDir).phase).toBe("copying");
    });

    it("--rollback together with --restore-record is E_INVALID_ARGUMENT", async () => {
      const harness = await haltedAfter("copying");
      const outcome = errorOf(
        await dataRecover(depsFor(harness), {
          ...RECOVER,
          rollback: true,
          restoreRecord: true,
        }),
      );
      expect(outcome.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
      expect(readActiveJournal(harness.bootstrapDir).phase).toBe("copying");
    });
  },
);
