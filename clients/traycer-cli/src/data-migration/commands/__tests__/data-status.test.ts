import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startMigration } from "../../engine/migration-engine";
import { underRoot } from "../../engine/content-inventory";
import {
  crashAtCheckpoint,
  CrashError,
  FakeProcessProbe,
  harnessScope,
  NOTES_FILE,
  pathExists,
  readActiveJournal,
  runToCompletion,
  snapshotIfPresent,
  type EngineHarness,
} from "../../engine/__tests__/engine-fixtures";
import type { DataRootAvailability } from "../data-availability";
import type {
  DataCommandDeps,
  DataCommandIo,
  DataCommandOutcome,
} from "../data-command-types";
import { dataStatus } from "../data-status";

const ENABLED: DataRootAvailability = {
  win32: { init: true, migrate: true },
  posix: { init: true, migrate: true },
};

class RecordingIo implements DataCommandIo {
  readonly json = false;
  readonly interactive = false;
  readonly notes: string[] = [];
  note(text: string): void {
    this.notes.push(text);
  }
  progress(): void {
    return undefined;
  }
  confirm(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected an object");
  return value;
}

function okData(outcome: DataCommandOutcome): {
  readonly data: Record<string, unknown>;
  readonly text: string;
} {
  if (outcome.status !== "ok")
    throw new Error(`expected ok, got ${outcome.code}: ${outcome.message}`);
  return { data: outcome.data, text: outcome.text.join("\n") };
}

function statusDeps(harness: EngineHarness): DataCommandDeps {
  return {
    homeDir: harness.home,
    platform: "posix",
    env: {},
    availability: ENABLED,
    probe: new FakeProcessProbe(),
    engine: () => harness.makeDeps({}),
    signal: new AbortController().signal,
    io: new RecordingIo(),
  };
}

function migrationsOf(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  const migrations = data.migrations;
  if (!Array.isArray(migrations)) throw new Error("expected a migrations list");
  return migrations.map((entry) => record(entry));
}

async function tree(
  harness: EngineHarness,
): Promise<readonly (Map<string, string> | null)[]> {
  return [
    await snapshotIfPresent(harness.home),
    await snapshotIfPresent(harness.destinationParent),
  ];
}

describe.skipIf(process.platform === "win32")(
  "traycer data status",
  { timeout: 120_000 },
  () => {
    const scope = harnessScope();

    it("reports the default location and an open startup for a home with no records", async () => {
      const harness = await scope.create();
      const before = await tree(harness);
      const { data } = okData(await dataStatus(statusDeps(harness)));
      expect(record(data.location).kind).toBe("default");
      expect(record(data.location).root).toBe(harness.sourceRoot);
      expect(record(data.startup).kind).toBe("open");
      expect(migrationsOf(data)).toEqual([]);
      expect(await tree(harness)).toEqual(before);
      expect(await pathExists(harness.bootstrapDir)).toBe(false);
    });

    it("reports a malformed location record as an ok outcome with a location error and writes nothing", async () => {
      const harness = await scope.create();
      await mkdir(harness.bootstrapDir, { mode: 0o700 });
      await writeFile(
        join(harness.bootstrapDir, "location.json"),
        "{ not valid json",
      );
      const before = await tree(harness);

      const { data, text } = okData(await dataStatus(statusDeps(harness)));

      expect(record(data.location).kind).toBe("error");
      expect(record(data.location).code).toBe("record-malformed");
      expect(text).toContain("Data folder: unusable");
      expect(await tree(harness)).toEqual(before);
      expect(
        await pathExists(
          join(harness.bootstrapDir, "migration-coordinator.lock"),
        ),
      ).toBe(false);
    });

    it("reports a configured root whose folder is missing as root-unavailable", async () => {
      const harness = await scope.create();
      const missingRoot = join(harness.base, "missing-root");
      await mkdir(harness.bootstrapDir, { mode: 0o700 });
      await writeFile(
        join(harness.bootstrapDir, "location.json"),
        `${JSON.stringify({ version: 1, generation: 1, root: missingRoot, migrationId: null })}\n`,
      );
      const before = await tree(harness);

      const { data, text } = okData(await dataStatus(statusDeps(harness)));

      expect(record(data.location).kind).toBe("error");
      expect(record(data.location).code).toBe("root-unavailable");
      expect(text).toContain("Reconnect the drive");
      expect(await tree(harness)).toEqual(before);
      expect(await pathExists(missingRoot)).toBe(false);
    });

    it("reports an active migration at a barrier phase with its recovery commands, and writes nothing", async () => {
      const harness = await scope.create();
      const crash = crashAtCheckpoint({
        target: "after-journal:copying",
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
      const journal = readActiveJournal(harness.bootstrapDir);
      expect(journal.phase).toBe("copying");
      const before = await tree(harness);

      const { data, text } = okData(await dataStatus(statusDeps(harness)));

      const migrations = migrationsOf(data);
      expect(migrations).toHaveLength(1);
      expect(migrations[0]).toMatchObject({
        id: journal.id,
        phase: "copying",
        active: true,
        rollbackAllowed: true,
      });
      expect(record(data.startup).kind).toBe("blocked");
      expect(text).toContain("traycer data recover");
      expect(text).toContain("--rollback");
      expect(await tree(harness)).toEqual(before);
    });

    it("reports an unchanged backup after a completed migration, with the cleanup step naming the migration id", async () => {
      const harness = await scope.create();
      const journal = await runToCompletion(harness);
      const before = await tree(harness);

      const { data, text } = okData(await dataStatus(statusDeps(harness)));

      const migrations = migrationsOf(data);
      expect(migrations).toHaveLength(1);
      expect(migrations[0]).toMatchObject({
        id: journal.id,
        phase: "complete",
        backup: "unchanged",
      });
      expect(text).toContain(`traycer data cleanup ${journal.id}`);
      expect(await tree(harness)).toEqual(before);
    });

    it("reports the backup as changed once a file is written into the source", async () => {
      const harness = await scope.create();
      const journal = await runToCompletion(harness);
      await writeFile(
        join(harness.sourceRoot, "added-after-the-move.txt"),
        "written by an older Traycer\n",
      );

      const { data, text } = okData(await dataStatus(statusDeps(harness)));

      expect(migrationsOf(data)[0]).toMatchObject({
        id: journal.id,
        backup: "changed",
      });
      expect(text).toContain("CHANGED since the move");
    });

    it("also reports the backup as changed when an existing source file is edited", async () => {
      const harness = await scope.create();
      const journal = await runToCompletion(harness);
      await appendFile(underRoot(harness.sourceRoot, NOTES_FILE), "edited\n");

      const { data } = okData(await dataStatus(statusDeps(harness)));

      expect(migrationsOf(data)[0]).toMatchObject({
        id: journal.id,
        backup: "changed",
      });
    });
  },
);
