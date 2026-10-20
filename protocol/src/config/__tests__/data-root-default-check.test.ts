import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  switchLocationForMigration,
  writeMigrationJournal,
  type HeldBootstrapSerialization,
} from "../data-bootstrap-records";
import {
  currentComponentHandshake,
  newMigrationId,
  plannedJournal,
  type CapturedRoot,
  type MigrationId,
  type MigrationJournal,
  type MigrationPhase,
} from "../data-migration-contracts";
import {
  describeDefaultDataRootFinding,
  inspectDefaultDataRoot,
  type DefaultDataRootFinding,
} from "../data-root-default-check";
import {
  dataBootstrapDir,
  defaultDataRoot,
  type DataRootResolution,
} from "../data-root";

class FakeHeld implements HeldBootstrapSerialization {
  assertHeld(): void {
    return undefined;
  }
}

type Fixture = {
  readonly homeDir: string;
  readonly bootstrapDir: string;
  readonly defaultRoot: string;
  readonly configuredRoot: string;
};

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const homeDir = mkdtempSync(join(tmpdir(), "default-root-check-"));
  homes.push(homeDir);
  const bootstrapDir = dataBootstrapDir(homeDir);
  mkdirSync(bootstrapDir, { mode: 0o700 });
  const configuredRoot = join(homeDir, "configured-data");
  mkdirSync(configuredRoot);
  return {
    homeDir,
    bootstrapDir,
    defaultRoot: defaultDataRoot(homeDir),
    configuredRoot,
  };
}

function populateDefault(fixture: Fixture): void {
  mkdirSync(fixture.defaultRoot, { recursive: true });
  writeFileSync(join(fixture.defaultRoot, "host-id"), "host-0001\n");
}

function configured(fixture: Fixture): DataRootResolution {
  return {
    kind: "configured",
    root: fixture.configuredRoot,
    bootstrapDir: fixture.bootstrapDir,
    record: {
      version: 1,
      generation: 1,
      root: fixture.configuredRoot,
      migrationId: null,
    },
  };
}

function inspect(
  fixture: Fixture,
  resolution: DataRootResolution,
): DefaultDataRootFinding {
  return inspectDefaultDataRoot({
    homeDir: fixture.homeDir,
    platform: "posix",
    resolution,
  });
}

function identityOf(path: string): CapturedRoot {
  const stats = lstatSync(path, { bigint: true });
  return { path, volumeId: String(stats.dev), directoryId: String(stats.ino) };
}

const FORWARD: readonly MigrationPhase[] = [
  "quiescing",
  "copying",
  "repairing",
  "preparing-external",
  "ready",
  "switching",
  "switched",
  "activated",
  "cleaning",
  "complete",
];

function successor(
  current: MigrationJournal,
  phase: MigrationPhase,
  cleanupFinished: boolean,
): MigrationJournal {
  const revision = current.revision + 1;
  return {
    ...current,
    revision,
    phase,
    activationRevision:
      phase === "activated" ? revision : current.activationRevision,
    cleanupProgress:
      phase === "complete" && cleanupFinished
        ? { removedEntries: 1, removedBytes: 1, finished: true }
        : current.cleanupProgress,
    updatedAt: `2026-10-16T00:00:${String(revision).padStart(2, "0")}.000Z`,
  };
}

/** Writes a journal whose source is `source` and drives it forward to `target`. */
async function journalAt(
  fixture: Fixture,
  source: CapturedRoot,
  target: MigrationPhase | "planned",
  cleanupFinished: boolean,
): Promise<MigrationJournal> {
  const held = new FakeHeld();
  const id: MigrationId = newMigrationId();
  let current = plannedJournal({
    id,
    previousLocation: null,
    source,
    destination: {
      path: fixture.configuredRoot,
      volumeId: null,
      directoryId: null,
    },
    nextGeneration: 1,
    coordinatorBuild: currentComponentHandshake("cli", "1.0.0"),
    coordinatorExecutableSha256: null,
    coordinator: { pid: 4242, startIdentity: null, lockNonce: "nonce" },
    now: "2026-10-16T00:00:00.000Z",
  });
  await writeMigrationJournal(fixture.bootstrapDir, held, null, current);
  if (target === "planned") return current;
  for (const phase of FORWARD) {
    const next = successor(current, phase, cleanupFinished);
    await writeMigrationJournal(fixture.bootstrapDir, held, current, next);
    current = next;
    if (phase === "switching") {
      await switchLocationForMigration({
        bootstrapDir: fixture.bootstrapDir,
        held,
        platform: "posix",
        journal: current,
      });
    }
    if (phase === target) return current;
  }
  return current;
}

describe("inspectDefaultDataRoot", () => {
  it("is none for the default resolution", () => {
    const fixture = makeFixture();
    populateDefault(fixture);
    const resolution: DataRootResolution = {
      kind: "default",
      root: fixture.defaultRoot,
      bootstrapDir: fixture.bootstrapDir,
    };
    expect(inspect(fixture, resolution)).toEqual({ kind: "none" });
  });

  it("is none when a configured root has no default folder beside it", () => {
    const fixture = makeFixture();
    expect(inspect(fixture, configured(fixture))).toEqual({ kind: "none" });
  });

  it("is none when the default folder exists but is empty", () => {
    const fixture = makeFixture();
    mkdirSync(fixture.defaultRoot);
    expect(inspect(fixture, configured(fixture))).toEqual({ kind: "none" });
  });

  it("is unexpected/no-migration for a populated default folder with no journals", () => {
    const fixture = makeFixture();
    populateDefault(fixture);
    expect(inspect(fixture, configured(fixture))).toEqual({
      kind: "unexpected",
      path: fixture.defaultRoot,
      reason: "no-migration",
      migrationId: null,
    });
  });

  it("is a retained backup when a post-activation journal's source identity equals the default folder", async () => {
    const fixture = makeFixture();
    populateDefault(fixture);
    const journal = await journalAt(
      fixture,
      identityOf(fixture.defaultRoot),
      "complete",
      false,
    );
    expect(inspect(fixture, configured(fixture))).toEqual({
      kind: "retained-backup",
      path: fixture.defaultRoot,
      migrationId: journal.id,
    });
  });

  it("is unexpected/replaced when the folder's identity differs from the journal's source", async () => {
    const fixture = makeFixture();
    populateDefault(fixture);
    const journal = await journalAt(
      fixture,
      { path: fixture.defaultRoot, volumeId: "0", directoryId: "0" },
      "complete",
      false,
    );
    expect(inspect(fixture, configured(fixture))).toEqual({
      kind: "unexpected",
      path: fixture.defaultRoot,
      reason: "replaced",
      migrationId: journal.id,
    });
  });

  it("is unexpected/cleaned-up when the backup was deleted and the folder populated again", async () => {
    const fixture = makeFixture();
    populateDefault(fixture);
    const journal = await journalAt(
      fixture,
      identityOf(fixture.defaultRoot),
      "complete",
      true,
    );
    expect(inspect(fixture, configured(fixture))).toEqual({
      kind: "unexpected",
      path: fixture.defaultRoot,
      reason: "cleaned-up",
      migrationId: journal.id,
    });
  });

  it("is none while a pre-activation journal names the default folder as its source", async () => {
    const fixture = makeFixture();
    populateDefault(fixture);
    await journalAt(fixture, identityOf(fixture.defaultRoot), "copying", false);
    expect(inspect(fixture, configured(fixture))).toEqual({ kind: "none" });
  });

  it("is none while a planned journal names the default folder as its source", async () => {
    const fixture = makeFixture();
    populateDefault(fixture);
    await journalAt(fixture, identityOf(fixture.defaultRoot), "planned", false);
    expect(inspect(fixture, configured(fixture))).toEqual({ kind: "none" });
  });
});

describe("describeDefaultDataRootFinding", () => {
  it("is null for none", () => {
    expect(describeDefaultDataRootFinding({ kind: "none" })).toBeNull();
  });

  it("names the migration id and the cleanup command for a retained backup", async () => {
    const fixture = makeFixture();
    populateDefault(fixture);
    const journal = await journalAt(
      fixture,
      identityOf(fixture.defaultRoot),
      "complete",
      false,
    );
    const finding = inspect(fixture, configured(fixture));
    const line = describeDefaultDataRootFinding(finding);
    expect(line).not.toBeNull();
    expect(line).toContain(journal.id);
    expect(line).toContain(`traycer data cleanup ${journal.id}`);
  });

  it("describes an unexpected finding with the folder path and the status command", () => {
    const line = describeDefaultDataRootFinding({
      kind: "unexpected",
      path: "/home/someone/.traycer",
      reason: "no-migration",
      migrationId: null,
    });
    expect(line).toContain("/home/someone/.traycer");
    expect(line).toContain("traycer data status");
  });
});
