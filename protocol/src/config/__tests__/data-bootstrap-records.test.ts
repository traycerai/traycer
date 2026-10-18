import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BootstrapRecordError,
  STARTUP_GATE_EVIDENCE_FILE,
  captureStartupGateEvidence,
  evaluateStartupGate,
  initializeLocationRecord,
  listMigrationJournalIdsSync,
  migrationLocationOf,
  readLocationRecordSync,
  readMigrationJournalSync,
  readMigrationSelectorSync,
  restoreLocationForRollback,
  restorePreviousRecordRevision,
  switchLocationForMigration,
  writeMigrationJournal,
  writeMigrationSelector,
  type HeldBootstrapSerialization,
  type StartupGateDecision,
} from "../data-bootstrap-records";
import {
  currentComponentHandshake,
  newMigrationId,
  plannedJournal,
  type MigrationJournal,
  type MigrationPhase,
} from "../data-migration-contracts";
import {
  resolveDataRoot,
  type DataLocationRecord,
  type DataRootResolution,
} from "../data-root";
import {
  ensurePrivateBootstrapDir,
  type WindowsDataRootCommands,
} from "../data-root-target";

class FakeHeld implements HeldBootstrapSerialization {
  held = true;
  calls = 0;
  /** Throws from this call number on; null never. */
  throwOnCall: number | null = null;

  assertHeld(): void {
    this.calls += 1;
    if (
      !this.held ||
      (this.throwOnCall !== null && this.calls >= this.throwOnCall)
    ) {
      throw new Error("serialization lost");
    }
  }
}

type Fixture = {
  readonly homeDir: string;
  readonly bootstrapDir: string;
  readonly rootA: string;
  readonly rootB: string;
};

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function makeFixture(): Fixture {
  const homeDir = mkdtempSync(join(tmpdir(), "bootstrap-records-"));
  homes.push(homeDir);
  const rootA = join(homeDir, "data-a");
  const rootB = join(homeDir, "data-b");
  mkdirSync(rootA);
  mkdirSync(rootB);
  return {
    homeDir,
    bootstrapDir: join(homeDir, ".traycer-bootstrap"),
    rootA,
    rootB,
  };
}

function bootstrapFixture(): Fixture {
  const fixture = makeFixture();
  mkdirSync(fixture.bootstrapDir, { mode: 0o700 });
  return fixture;
}

const stubCommands: WindowsDataRootCommands = {
  probeVolume: () => Promise.reject(new Error("not used on posix")),
  applyPrivateAcl: () => Promise.reject(new Error("not used on posix")),
  readAcl: () => Promise.reject(new Error("not used on posix")),
  securePrivateChildren: () => Promise.reject(new Error("not used on posix")),
};

async function codeOf(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
    return "no-error";
  } catch (error) {
    return error instanceof BootstrapRecordError
      ? error.code
      : `other: ${String(error)}`;
  }
}

function successor(
  current: MigrationJournal,
  phase: MigrationPhase,
): MigrationJournal {
  return {
    ...current,
    revision: current.revision + 1,
    phase,
    rollbackFromPhase:
      phase === "rollback-requested" && current.phase !== "rollback-requested"
        ? current.phase
        : current.rollbackFromPhase,
    activationRevision:
      phase === "activated" && current.phase !== "activated"
        ? current.revision + 1
        : current.activationRevision,
    updatedAt: `2026-10-16T00:00:${String(current.revision + 1).padStart(2, "0")}.000Z`,
  };
}

/** Writes the planned journal and selects it as active. */
async function startMigration(
  fixture: Fixture,
  held: HeldBootstrapSerialization,
  previousLocation: DataLocationRecord | null,
  nextGeneration: number,
): Promise<MigrationJournal> {
  const journal = plannedJournal({
    id: newMigrationId(),
    previousLocation,
    source: {
      path: join(fixture.homeDir, ".traycer"),
      volumeId: null,
      directoryId: null,
    },
    destination: { path: fixture.rootB, volumeId: null, directoryId: null },
    nextGeneration,
    coordinatorBuild: currentComponentHandshake("cli", "1.0.0"),
    coordinatorExecutableSha256: null,
    coordinator: { pid: 4242, startIdentity: null, lockNonce: "nonce" },
    now: "2026-10-16T00:00:00.000Z",
  });
  await writeMigrationJournal(fixture.bootstrapDir, held, null, journal);
  await writeMigrationSelector(fixture.bootstrapDir, held, null, {
    version: 1,
    revision: 1,
    activeMigrationId: journal.id,
  });
  return journal;
}

async function advance(
  fixture: Fixture,
  held: HeldBootstrapSerialization,
  current: MigrationJournal,
  phase: MigrationPhase,
): Promise<MigrationJournal> {
  const next = successor(current, phase);
  await writeMigrationJournal(fixture.bootstrapDir, held, current, next);
  return next;
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

/** Drives the real forward chain; the location switch happens at `switching`. */
async function driveTo(
  fixture: Fixture,
  held: HeldBootstrapSerialization,
  start: MigrationJournal,
  target: MigrationPhase,
): Promise<MigrationJournal> {
  let current = start;
  for (const phase of FORWARD) {
    current = await advance(fixture, held, current, phase);
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
  throw new Error(`driveTo does not reach ${target}`);
}

/** Drives only to a phase before `switching` (no location change). */
async function driveWithoutSwitch(
  fixture: Fixture,
  held: HeldBootstrapSerialization,
  start: MigrationJournal,
  target: MigrationPhase,
): Promise<MigrationJournal> {
  let current = start;
  for (const phase of FORWARD) {
    current = await advance(fixture, held, current, phase);
    if (phase === target) return current;
  }
  throw new Error(`driveWithoutSwitch does not reach ${target}`);
}

function journalPath(fixture: Fixture, journal: MigrationJournal): string {
  return join(fixture.bootstrapDir, `migration-${journal.id}.json`);
}

function journalPrevPath(fixture: Fixture, journal: MigrationJournal): string {
  return join(fixture.bootstrapDir, `migration-${journal.id}.prev.json`);
}

function writeLocationFile(fixture: Fixture, record: DataLocationRecord): void {
  writeFileSync(
    join(fixture.bootstrapDir, "location.json"),
    `${JSON.stringify(record)}\n`,
  );
}

const LOCATION_FILE = "location.json";

describe("selector and journal records", () => {
  it("round-trips a journal and a selector", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const journal = await startMigration(f, held, null, 1);
    const read = readMigrationJournalSync(f.bootstrapDir, journal.id);
    expect(read).toEqual({
      kind: "valid",
      record: journal,
      raw: readFileSync(journalPath(f, journal), "utf8"),
    });
    const selector = readMigrationSelectorSync(f.bootstrapDir);
    expect(selector.kind).toBe("valid");
    expect(selector).toMatchObject({
      record: { version: 1, revision: 1, activeMigrationId: journal.id },
    });
    expect(listMigrationJournalIdsSync(f.bootstrapDir)).toEqual([journal.id]);
  });

  it("reads absent when nothing exists, including when the folder is missing", () => {
    const f = makeFixture();
    expect(readMigrationSelectorSync(f.bootstrapDir)).toEqual({
      kind: "absent",
    });
    expect(readMigrationJournalSync(f.bootstrapDir, newMigrationId())).toEqual({
      kind: "absent",
    });
    expect(listMigrationJournalIdsSync(f.bootstrapDir)).toEqual([]);
    expect(existsSync(f.bootstrapDir)).toBe(false);
  });

  it("retains the previous revision beside the current one", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const quiescing = await advance(f, held, planned, "quiescing");
    const main = readMigrationJournalSync(f.bootstrapDir, planned.id);
    expect(main).toMatchObject({
      kind: "valid",
      record: { revision: 2, phase: "quiescing" },
    });
    expect(readFileSync(journalPrevPath(f, planned), "utf8")).toContain(
      '"phase": "planned"',
    );
    expect(quiescing.revision).toBe(2);
    // The listing never mistakes the previous-revision file for a journal.
    expect(listMigrationJournalIdsSync(f.bootstrapDir)).toEqual([planned.id]);
  });

  it("refuses a stale expected record (compare-and-set)", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    await advance(f, held, planned, "quiescing");
    // A second coordinator still holding revision 1 tries to move it on.
    const stale = successor(planned, "quiescing");
    expect(
      await codeOf(writeMigrationJournal(f.bootstrapDir, held, planned, stale)),
    ).toBe("revision-conflict");
    // A creator expecting nothing finds the record already there.
    expect(
      await codeOf(writeMigrationJournal(f.bootstrapDir, held, null, planned)),
    ).toBe("revision-conflict");
    // Selector: the revision must advance by exactly one from what was read.
    expect(
      await codeOf(
        writeMigrationSelector(f.bootstrapDir, held, null, {
          version: 1,
          revision: 1,
          activeMigrationId: planned.id,
        }),
      ),
    ).toBe("revision-conflict");
    const current = readMigrationSelectorSync(f.bootstrapDir);
    if (current.kind !== "valid") throw new Error("selector should be valid");
    expect(
      await codeOf(
        writeMigrationSelector(f.bootstrapDir, held, current.record, {
          version: 1,
          revision: current.record.revision + 2,
          activeMigrationId: null,
        }),
      ),
    ).toBe("revision-conflict");
  });

  it("refuses a journal successor that breaks the phase table before writing anything", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const before = readFileSync(journalPath(f, planned), "utf8");
    const bad: MigrationJournal = {
      ...successor(planned, "quiescing"),
      phase: "copying",
    };
    expect(
      await codeOf(writeMigrationJournal(f.bootstrapDir, held, planned, bad)),
    ).toBe("transition-refused");
    expect(readFileSync(journalPath(f, planned), "utf8")).toBe(before);
  });

  it("refuses to record rollback after activation", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const activated = await driveTo(f, held, planned, "activated");
    let message = "";
    try {
      await writeMigrationJournal(
        f.bootstrapDir,
        held,
        activated,
        successor(activated, "rollback-requested"),
      );
    } catch (error) {
      message =
        error instanceof BootstrapRecordError
          ? `${error.code} ${error.message}`
          : "";
    }
    expect(message).toContain("transition-refused");
    expect(message).toContain("rollback-refused-after-activation");
    expect(readMigrationJournalSync(f.bootstrapDir, planned.id)).toMatchObject({
      kind: "valid",
      record: { phase: "activated" },
    });
  });

  it("writes nothing when the serialization is not held", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    held.held = false;
    const journal = plannedJournal({
      id: newMigrationId(),
      previousLocation: null,
      source: {
        path: join(f.homeDir, ".traycer"),
        volumeId: null,
        directoryId: null,
      },
      destination: { path: f.rootB, volumeId: null, directoryId: null },
      nextGeneration: 1,
      coordinatorBuild: currentComponentHandshake("cli", "1.0.0"),
      coordinatorExecutableSha256: null,
      coordinator: { pid: 1, startIdentity: null, lockNonce: "n" },
      now: "2026-10-16T00:00:00.000Z",
    });
    await expect(
      writeMigrationJournal(f.bootstrapDir, held, null, journal),
    ).rejects.toThrow("serialization lost");
    await expect(
      writeMigrationSelector(f.bootstrapDir, held, null, {
        version: 1,
        revision: 1,
        activeMigrationId: journal.id,
      }),
    ).rejects.toThrow("serialization lost");
    expect(readdirSync(f.bootstrapDir)).toEqual([]);
  });

  it("re-asserts the serialization after saving the previous revision and before replacing", async () => {
    const f = bootstrapFixture();
    const planned = await startMigration(f, new FakeHeld(), null, 1);
    const before = readFileSync(journalPath(f, planned), "utf8");
    const losing = new FakeHeld();
    losing.throwOnCall = 2;
    await expect(
      writeMigrationJournal(
        f.bootstrapDir,
        losing,
        planned,
        successor(planned, "quiescing"),
      ),
    ).rejects.toThrow("serialization lost");
    // The current record is untouched, and the pair is the benign crash window.
    expect(readFileSync(journalPath(f, planned), "utf8")).toBe(before);
    expect(readMigrationJournalSync(f.bootstrapDir, planned.id)).toMatchObject({
      kind: "valid",
      record: { revision: 1 },
    });
  });
});

describe("damaged records are reported, never repaired", () => {
  async function twoRevisions(f: Fixture): Promise<{
    planned: MigrationJournal;
    quiescing: MigrationJournal;
  }> {
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const quiescing = await advance(f, held, planned, "quiescing");
    return { planned, quiescing };
  }

  it("a torn main file is damaged and carries the valid previous revision", async () => {
    const f = bootstrapFixture();
    const { planned } = await twoRevisions(f);
    const raw = readFileSync(journalPath(f, planned), "utf8");
    const torn = raw.slice(0, Math.floor(raw.length / 2));
    writeFileSync(journalPath(f, planned), torn);
    const read = readMigrationJournalSync(f.bootstrapDir, planned.id);
    expect(read).toMatchObject({
      kind: "damaged",
      reason: "torn or not a bootstrap record",
      previous: { revision: 1, phase: "planned" },
    });
    // Reading repaired nothing.
    expect(readFileSync(journalPath(f, planned), "utf8")).toBe(torn);
  });

  it("a checksum mismatch is damaged", async () => {
    const f = bootstrapFixture();
    const { planned } = await twoRevisions(f);
    const raw = readFileSync(journalPath(f, planned), "utf8");
    expect(raw).toContain('"phase": "quiescing"');
    writeFileSync(
      journalPath(f, planned),
      raw.replace('"phase": "quiescing"', '"phase": "copying"'),
    );
    expect(readMigrationJournalSync(f.bootstrapDir, planned.id)).toMatchObject({
      kind: "damaged",
      reason: "checksum mismatch",
    });
  });

  it("a missing main file beside an existing previous revision is damaged", async () => {
    const f = bootstrapFixture();
    const { planned } = await twoRevisions(f);
    rmSync(journalPath(f, planned));
    expect(readMigrationJournalSync(f.bootstrapDir, planned.id)).toMatchObject({
      kind: "damaged",
      reason: "missing while its previous revision exists",
      previous: { revision: 1 },
    });
    expect(existsSync(journalPath(f, planned))).toBe(false);
  });

  it("a previous revision newer than the main file is damaged", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const revisionOne = readFileSync(journalPath(f, planned), "utf8");
    const quiescing = await advance(f, held, planned, "quiescing");
    await advance(f, held, quiescing, "copying");
    // Main (rev 3) replaced by the rev 1 bytes while prev holds rev 2.
    writeFileSync(journalPath(f, planned), revisionOne);
    expect(readMigrationJournalSync(f.bootstrapDir, planned.id)).toMatchObject({
      kind: "damaged",
      reason: "inconsistent with its previous revision",
      previous: { revision: 2 },
    });
  });

  it("an equal revision with different bytes is damaged", async () => {
    const f = bootstrapFixture();
    const { planned } = await twoRevisions(f);
    const main = readFileSync(journalPath(f, planned), "utf8");
    // Same body, same checksum, different bytes.
    writeFileSync(journalPrevPath(f, planned), `${main}\n`);
    expect(readMigrationJournalSync(f.bootstrapDir, planned.id)).toMatchObject({
      kind: "damaged",
      reason: "inconsistent with its previous revision",
    });
  });

  it("a damaged selector is reported the same way", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const current = readMigrationSelectorSync(f.bootstrapDir);
    if (current.kind !== "valid") throw new Error("selector should be valid");
    await writeMigrationSelector(f.bootstrapDir, held, current.record, {
      version: 1,
      revision: 2,
      activeMigrationId: null,
    });
    writeFileSync(join(f.bootstrapDir, "migration.json"), "{");
    expect(readMigrationSelectorSync(f.bootstrapDir)).toMatchObject({
      kind: "damaged",
      previous: { revision: 1, activeMigrationId: planned.id },
    });
  });

  it("refuses to write over a damaged record", async () => {
    const f = bootstrapFixture();
    const { planned, quiescing } = await twoRevisions(f);
    writeFileSync(journalPath(f, planned), "{");
    const held = new FakeHeld();
    expect(
      await codeOf(
        writeMigrationJournal(
          f.bootstrapDir,
          held,
          quiescing,
          successor(quiescing, "copying"),
        ),
      ),
    ).toBe("record-damaged");
    expect(readFileSync(journalPath(f, planned), "utf8")).toBe("{");
  });

  it("(crash window a) a previous revision identical to the main file reads valid", async () => {
    const f = bootstrapFixture();
    const { planned } = await twoRevisions(f);
    const main = readFileSync(journalPath(f, planned), "utf8");
    writeFileSync(journalPrevPath(f, planned), main);
    expect(readMigrationJournalSync(f.bootstrapDir, planned.id)).toMatchObject({
      kind: "valid",
      record: { revision: 2 },
    });
  });

  it("(crash window b) leftover temp files are ignored", async () => {
    const f = bootstrapFixture();
    const { planned } = await twoRevisions(f);
    writeFileSync(`${journalPath(f, planned)}.${randomUUID()}.tmp`, "garbage");
    writeFileSync(`${journalPrevPath(f, planned)}.${randomUUID()}.tmp`, "{");
    writeFileSync(
      join(f.bootstrapDir, `migration.json.${randomUUID()}.tmp`),
      "{",
    );
    expect(readMigrationJournalSync(f.bootstrapDir, planned.id)).toMatchObject({
      kind: "valid",
      record: { revision: 2 },
    });
    expect(readMigrationSelectorSync(f.bootstrapDir).kind).toBe("valid");
    expect(listMigrationJournalIdsSync(f.bootstrapDir)).toEqual([planned.id]);
  });
});

describe("restorePreviousRecordRevision", () => {
  it("restores a damaged journal from its valid previous revision", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    await advance(f, held, planned, "quiescing");
    writeFileSync(journalPath(f, planned), "{");
    await restorePreviousRecordRevision(f.bootstrapDir, held, {
      kind: "journal",
      id: planned.id,
    });
    expect(readMigrationJournalSync(f.bootstrapDir, planned.id)).toMatchObject({
      kind: "valid",
      record: planned,
    });
  });

  it("restores a damaged selector from its valid previous revision", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const current = readMigrationSelectorSync(f.bootstrapDir);
    if (current.kind !== "valid") throw new Error("selector should be valid");
    await writeMigrationSelector(f.bootstrapDir, held, current.record, {
      version: 1,
      revision: 2,
      activeMigrationId: null,
    });
    writeFileSync(join(f.bootstrapDir, "migration.json"), "{");
    await restorePreviousRecordRevision(f.bootstrapDir, held, {
      kind: "selector",
    });
    expect(readMigrationSelectorSync(f.bootstrapDir)).toMatchObject({
      kind: "valid",
      record: { revision: 1, activeMigrationId: planned.id },
    });
  });

  it("refuses a valid record, a damaged record without a valid previous, and an absent one", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    // Valid.
    expect(
      await codeOf(
        restorePreviousRecordRevision(f.bootstrapDir, held, {
          kind: "journal",
          id: planned.id,
        }),
      ),
    ).toBe("invalid-record");
    // Damaged, but only one revision ever existed: no previous file.
    writeFileSync(journalPath(f, planned), "{");
    expect(
      await codeOf(
        restorePreviousRecordRevision(f.bootstrapDir, held, {
          kind: "journal",
          id: planned.id,
        }),
      ),
    ).toBe("invalid-record");
    // Absent.
    expect(
      await codeOf(
        restorePreviousRecordRevision(f.bootstrapDir, held, {
          kind: "journal",
          id: newMigrationId(),
        }),
      ),
    ).toBe("invalid-record");
    expect(readFileSync(journalPath(f, planned), "utf8")).toBe("{");
  });

  it("writes nothing when the serialization is not held", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    await advance(f, held, planned, "quiescing");
    writeFileSync(journalPath(f, planned), "{");
    held.held = false;
    await expect(
      restorePreviousRecordRevision(f.bootstrapDir, held, {
        kind: "journal",
        id: planned.id,
      }),
    ).rejects.toThrow("serialization lost");
    expect(readFileSync(journalPath(f, planned), "utf8")).toBe("{");
  });
});

describe("location transitions", () => {
  it("initializeLocationRecord writes generation 1 and the resolver reads it", async () => {
    const f = bootstrapFixture();
    const record = await initializeLocationRecord({
      bootstrapDir: f.bootstrapDir,
      held: new FakeHeld(),
      platform: "posix",
      root: f.rootA,
    });
    expect(record).toEqual({
      version: 1,
      generation: 1,
      root: f.rootA,
      migrationId: null,
    });
    expect(resolveDataRoot(f.homeDir, "posix")).toMatchObject({
      kind: "configured",
      root: f.rootA,
      record,
    });
  });

  it("initializeLocationRecord is refused when a record or a selector exists, or the root is invalid", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    await initializeLocationRecord({
      bootstrapDir: f.bootstrapDir,
      held,
      platform: "posix",
      root: f.rootA,
    });
    expect(
      await codeOf(
        initializeLocationRecord({
          bootstrapDir: f.bootstrapDir,
          held,
          platform: "posix",
          root: f.rootB,
        }),
      ),
    ).toBe("revision-conflict");
    expect(readLocationRecordSync(f.bootstrapDir)).toMatchObject({
      kind: "valid",
      record: { root: f.rootA },
    });

    const withSelector = bootstrapFixture();
    await startMigration(withSelector, held, null, 1);
    expect(
      await codeOf(
        initializeLocationRecord({
          bootstrapDir: withSelector.bootstrapDir,
          held,
          platform: "posix",
          root: withSelector.rootA,
        }),
      ),
    ).toBe("transition-refused");
    expect(existsSync(join(withSelector.bootstrapDir, LOCATION_FILE))).toBe(
      false,
    );

    const invalid = bootstrapFixture();
    for (const root of [
      "relative/path",
      join(invalid.bootstrapDir, "inside"),
    ]) {
      expect(
        await codeOf(
          initializeLocationRecord({
            bootstrapDir: invalid.bootstrapDir,
            held,
            platform: "posix",
            root,
          }),
        ),
      ).toBe("invalid-record");
    }
    expect(existsSync(join(invalid.bootstrapDir, LOCATION_FILE))).toBe(false);
  });

  it("initializeLocationRecord writes nothing when the serialization is not held", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    held.held = false;
    await expect(
      initializeLocationRecord({
        bootstrapDir: f.bootstrapDir,
        held,
        platform: "posix",
        root: f.rootA,
      }),
    ).rejects.toThrow("serialization lost");
    expect(readdirSync(f.bootstrapDir)).toEqual([]);
  });

  it("switchLocationForMigration advances the generation from a configured previous location", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const previous = await initializeLocationRecord({
      bootstrapDir: f.bootstrapDir,
      held,
      platform: "posix",
      root: f.rootA,
    });
    const planned = await startMigration(f, held, previous, 2);
    const switching = await driveWithoutSwitch(f, held, planned, "switching");
    await switchLocationForMigration({
      bootstrapDir: f.bootstrapDir,
      held,
      platform: "posix",
      journal: switching,
    });
    expect(readLocationRecordSync(f.bootstrapDir)).toMatchObject({
      kind: "valid",
      record: {
        version: 1,
        generation: 2,
        root: f.rootB,
        migrationId: planned.id,
      },
    });
    expect(
      readFileSync(join(f.bootstrapDir, "location.prev.json"), "utf8"),
    ).toContain('"generation":1');
    expect(migrationLocationOf(switching)).toEqual({
      version: 1,
      generation: 2,
      root: f.rootB,
      migrationId: planned.id,
    });
  });

  it("switchLocationForMigration from the implicit default root creates the record", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    await driveTo(f, held, planned, "switching");
    expect(resolveDataRoot(f.homeDir, "posix")).toMatchObject({
      kind: "configured",
      root: f.rootB,
      record: { generation: 1, migrationId: planned.id },
    });
  });

  it("switchLocationForMigration is idempotent once switched", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const switching = await driveTo(f, held, planned, "switching");
    const before = readFileSync(join(f.bootstrapDir, LOCATION_FILE), "utf8");
    await switchLocationForMigration({
      bootstrapDir: f.bootstrapDir,
      held,
      platform: "posix",
      journal: switching,
    });
    expect(readFileSync(join(f.bootstrapDir, LOCATION_FILE), "utf8")).toBe(
      before,
    );
  });

  it("switchLocationForMigration requires the DURABLE journal in switching", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const ready = await driveWithoutSwitch(f, held, planned, "ready");
    const attempt = (journal: MigrationJournal): Promise<void> =>
      switchLocationForMigration({
        bootstrapDir: f.bootstrapDir,
        held,
        platform: "posix",
        journal,
      });
    // Durable journal is `ready`.
    expect(await codeOf(attempt(ready))).toBe("transition-refused");
    // A `switching` journal that was never written.
    expect(await codeOf(attempt(successor(ready, "switching")))).toBe(
      "transition-refused",
    );
    expect(existsSync(join(f.bootstrapDir, LOCATION_FILE))).toBe(false);
    // Other phases, even durable ones.
    const switching = await advance(f, held, ready, "switching");
    const switched = await advance(f, held, switching, "switched");
    expect(await codeOf(attempt(switched))).toBe("transition-refused");
    // A stale `switching` object once the durable one moved on.
    expect(await codeOf(attempt(switching))).toBe("transition-refused");
    expect(existsSync(join(f.bootstrapDir, LOCATION_FILE))).toBe(false);
  });

  it("switchLocationForMigration refuses a location that is not the journal's previous one", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const previous = await initializeLocationRecord({
      bootstrapDir: f.bootstrapDir,
      held,
      platform: "posix",
      root: f.rootA,
    });
    const planned = await startMigration(f, held, previous, 2);
    const switching = await driveWithoutSwitch(f, held, planned, "switching");
    // Someone changed the selection to another root at the same generation.
    writeLocationFile(f, { ...previous, root: join(f.homeDir, "data-c") });
    mkdirSync(join(f.homeDir, "data-c"));
    expect(
      await codeOf(
        switchLocationForMigration({
          bootstrapDir: f.bootstrapDir,
          held,
          platform: "posix",
          journal: switching,
        }),
      ),
    ).toBe("revision-conflict");
  });

  it("switchLocationForMigration refuses a generation that does not advance", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const previous = await initializeLocationRecord({
      bootstrapDir: f.bootstrapDir,
      held,
      platform: "posix",
      root: f.rootA,
    });
    const planned = await startMigration(f, held, previous, 1);
    const switching = await driveWithoutSwitch(f, held, planned, "switching");
    expect(
      await codeOf(
        switchLocationForMigration({
          bootstrapDir: f.bootstrapDir,
          held,
          platform: "posix",
          journal: switching,
        }),
      ),
    ).toBe("generation-not-advanced");
  });

  it("switchLocationForMigration writes nothing when the serialization is not held", async () => {
    const f = bootstrapFixture();
    const setup = new FakeHeld();
    const planned = await startMigration(f, setup, null, 1);
    const switching = await driveWithoutSwitch(f, setup, planned, "switching");
    const lost = new FakeHeld();
    lost.held = false;
    await expect(
      switchLocationForMigration({
        bootstrapDir: f.bootstrapDir,
        held: lost,
        platform: "posix",
        journal: switching,
      }),
    ).rejects.toThrow("serialization lost");
    expect(existsSync(join(f.bootstrapDir, LOCATION_FILE))).toBe(false);
  });

  it("restoreLocationForRollback from switching puts back a configured previous location", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const previous = await initializeLocationRecord({
      bootstrapDir: f.bootstrapDir,
      held,
      platform: "posix",
      root: f.rootA,
    });
    const planned = await startMigration(f, held, previous, 2);
    const switching = await driveTo(f, held, planned, "switching");
    const requested = await advance(f, held, switching, "rollback-requested");
    expect(requested.rollbackFromPhase).toBe("switching");
    await restoreLocationForRollback({
      bootstrapDir: f.bootstrapDir,
      held,
      journal: requested,
    });
    expect(readLocationRecordSync(f.bootstrapDir)).toMatchObject({
      kind: "valid",
      record: previous,
    });
    expect(resolveDataRoot(f.homeDir, "posix")).toMatchObject({
      kind: "configured",
      root: f.rootA,
      record: { generation: 1, migrationId: null },
    });
    // Idempotent.
    const before = readFileSync(join(f.bootstrapDir, LOCATION_FILE), "utf8");
    await restoreLocationForRollback({
      bootstrapDir: f.bootstrapDir,
      held,
      journal: requested,
    });
    expect(readFileSync(join(f.bootstrapDir, LOCATION_FILE), "utf8")).toBe(
      before,
    );
  });

  it("restoreLocationForRollback from switched with a null previous location removes the record", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const switched = await driveTo(f, held, planned, "switched");
    const requested = await advance(f, held, switched, "rollback-requested");
    expect(requested.rollbackFromPhase).toBe("switched");
    expect(existsSync(join(f.bootstrapDir, LOCATION_FILE))).toBe(true);
    await restoreLocationForRollback({
      bootstrapDir: f.bootstrapDir,
      held,
      journal: requested,
    });
    expect(existsSync(join(f.bootstrapDir, LOCATION_FILE))).toBe(false);
    expect(readLocationRecordSync(f.bootstrapDir)).toEqual({ kind: "absent" });
    expect(resolveDataRoot(f.homeDir, "posix")).toMatchObject({
      kind: "default",
      root: join(f.homeDir, ".traycer"),
    });
    // Idempotent: nothing to remove the second time.
    await restoreLocationForRollback({
      bootstrapDir: f.bootstrapDir,
      held,
      journal: requested,
    });
    expect(existsSync(join(f.bootstrapDir, LOCATION_FILE))).toBe(false);
  });

  it("restoreLocationForRollback is a no-op when the location never switched", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const switching = await driveWithoutSwitch(f, held, planned, "switching");
    const requested = await advance(f, held, switching, "rollback-requested");
    await restoreLocationForRollback({
      bootstrapDir: f.bootstrapDir,
      held,
      journal: requested,
    });
    expect(existsSync(join(f.bootstrapDir, LOCATION_FILE))).toBe(false);
  });

  it("restoreLocationForRollback is refused from every other phase and origin", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const ready = await driveWithoutSwitch(f, held, planned, "ready");
    const attempt = (journal: MigrationJournal): Promise<void> =>
      restoreLocationForRollback({
        bootstrapDir: f.bootstrapDir,
        held,
        journal,
      });
    // Not rollback-requested.
    expect(await codeOf(attempt(ready))).toBe("transition-refused");
    // Rollback requested from a phase that never switched the location.
    const requested = await advance(f, held, ready, "rollback-requested");
    expect(requested.rollbackFromPhase).toBe("ready");
    expect(await codeOf(attempt(requested))).toBe("transition-refused");
    // A rollback-requested journal that is not the durable one.
    expect(
      await codeOf(attempt({ ...requested, revision: requested.revision + 1 })),
    ).toBe("transition-refused");
  });

  it("restoreLocationForRollback writes nothing when the serialization is not held", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const switching = await driveTo(f, held, planned, "switching");
    const requested = await advance(f, held, switching, "rollback-requested");
    const before = readFileSync(join(f.bootstrapDir, LOCATION_FILE), "utf8");
    const lost = new FakeHeld();
    lost.held = false;
    await expect(
      restoreLocationForRollback({
        bootstrapDir: f.bootstrapDir,
        held: lost,
        journal: requested,
      }),
    ).rejects.toThrow("serialization lost");
    expect(readFileSync(join(f.bootstrapDir, LOCATION_FILE), "utf8")).toBe(
      before,
    );
  });
});

describe("evaluateStartupGate", () => {
  function gate(
    f: Fixture,
    processResolution: DataRootResolution | null,
  ): StartupGateDecision {
    return evaluateStartupGate({
      homeDir: f.homeDir,
      platform: "posix",
      processResolution,
    });
  }

  it("opens on a machine with no bootstrap folder and creates nothing", () => {
    const f = makeFixture();
    expect(gate(f, null)).toEqual({ kind: "open", generation: null });
    expect(existsSync(f.bootstrapDir)).toBe(false);
    expect(readdirSync(f.homeDir).sort()).toEqual(["data-a", "data-b"]);
  });

  it("blocks in every barrier phase with migration-in-progress", async () => {
    const barrier: readonly MigrationPhase[] = [
      "quiescing",
      "copying",
      "repairing",
      "preparing-external",
      "ready",
      "switching",
      "switched",
    ];
    for (const phase of barrier) {
      const f = bootstrapFixture();
      const held = new FakeHeld();
      const planned = await startMigration(f, held, null, 1);
      const journal = await driveTo(f, held, planned, phase);
      expect(gate(f, null), phase).toMatchObject({
        kind: "blocked",
        code: "migration-in-progress",
        migrationId: journal.id,
      });
    }
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const copying = await driveWithoutSwitch(f, held, planned, "copying");
    await advance(f, held, copying, "rollback-requested");
    expect(gate(f, null)).toMatchObject({
      kind: "blocked",
      code: "migration-in-progress",
    });
  });

  it("opens while the migration is only planned", async () => {
    const f = bootstrapFixture();
    await startMigration(f, new FakeHeld(), null, 1);
    expect(gate(f, null)).toEqual({ kind: "open", generation: null });
  });

  it("opens with the generation once activated, cleaning or complete", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    let journal = await driveTo(f, held, planned, "activated");
    expect(gate(f, null)).toEqual({ kind: "open", generation: 1 });
    journal = await advance(f, held, journal, "cleaning");
    expect(gate(f, null)).toEqual({ kind: "open", generation: 1 });
    await advance(f, held, journal, "complete");
    expect(gate(f, null)).toEqual({ kind: "open", generation: 1 });
  });

  it("reports journal-mismatch when the location and an activated journal disagree", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    await driveTo(f, held, planned, "activated");
    const read = readMigrationJournalSync(f.bootstrapDir, planned.id);
    if (read.kind !== "valid") throw new Error("journal should be valid");
    const record = migrationLocationOf(read.record);
    // Wrong generation.
    writeLocationFile(f, { ...record, generation: 7 });
    expect(gate(f, null)).toMatchObject({
      kind: "blocked",
      code: "journal-mismatch",
    });
    // Wrong root.
    const other = join(f.homeDir, "data-c");
    mkdirSync(other);
    writeLocationFile(f, { ...record, root: other });
    expect(gate(f, null)).toMatchObject({
      kind: "blocked",
      code: "journal-mismatch",
    });
    // Location no longer names the migration.
    writeLocationFile(f, { ...record, migrationId: null });
    expect(gate(f, null)).toMatchObject({
      kind: "blocked",
      code: "journal-mismatch",
    });
    // Location removed altogether.
    rmSync(join(f.bootstrapDir, LOCATION_FILE));
    expect(gate(f, null)).toMatchObject({
      kind: "blocked",
      code: "journal-mismatch",
    });
    // Restored: open again.
    writeLocationFile(f, record);
    expect(gate(f, null)).toEqual({ kind: "open", generation: 1 });
  });

  it("opens a rolled-back journal only while the previous location is selected", async () => {
    // Previous location: the implicit default root.
    const defaults = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(defaults, held, null, 1);
    const quiescing = await advance(defaults, held, planned, "quiescing");
    const requested = await advance(
      defaults,
      held,
      quiescing,
      "rollback-requested",
    );
    await advance(defaults, held, requested, "rolled-back");
    expect(gate(defaults, null)).toEqual({ kind: "open", generation: null });
    writeLocationFile(defaults, {
      version: 1,
      generation: 1,
      root: defaults.rootA,
      migrationId: null,
    });
    expect(gate(defaults, null)).toMatchObject({
      kind: "blocked",
      code: "journal-mismatch",
    });

    // Previous location: a configured record.
    const configured = bootstrapFixture();
    const previous = await initializeLocationRecord({
      bootstrapDir: configured.bootstrapDir,
      held,
      platform: "posix",
      root: configured.rootA,
    });
    const plannedConfigured = await startMigration(
      configured,
      held,
      previous,
      2,
    );
    const switching = await driveTo(
      configured,
      held,
      plannedConfigured,
      "switching",
    );
    const requestedConfigured = await advance(
      configured,
      held,
      switching,
      "rollback-requested",
    );
    await restoreLocationForRollback({
      bootstrapDir: configured.bootstrapDir,
      held,
      journal: requestedConfigured,
    });
    await advance(configured, held, requestedConfigured, "rolled-back");
    expect(gate(configured, null)).toEqual({ kind: "open", generation: 1 });
    // The destination pointer left in place does not satisfy a rolled-back journal.
    writeLocationFile(configured, migrationLocationOf(requestedConfigured));
    expect(gate(configured, null)).toMatchObject({
      kind: "blocked",
      code: "journal-mismatch",
    });
  });

  it("a discarded plan (planned -> rolled-back) opens at the previous location", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    await advance(f, held, planned, "rolled-back");
    expect(gate(f, null)).toEqual({ kind: "open", generation: null });
  });

  it("blocks journal-missing when the location names a migration with no journal", () => {
    const f = bootstrapFixture();
    writeLocationFile(f, {
      version: 1,
      generation: 1,
      root: f.rootB,
      migrationId: newMigrationId(),
    });
    expect(gate(f, null)).toMatchObject({
      kind: "blocked",
      code: "journal-missing",
    });
  });

  it("blocks journal-missing when the selector names a journal that does not exist", async () => {
    const f = bootstrapFixture();
    const id = newMigrationId();
    await writeMigrationSelector(f.bootstrapDir, new FakeHeld(), null, {
      version: 1,
      revision: 1,
      activeMigrationId: id,
    });
    expect(gate(f, null)).toMatchObject({
      kind: "blocked",
      code: "journal-missing",
      migrationId: id,
    });
  });

  it("blocks journal-damaged for a damaged active journal", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    await advance(f, held, planned, "quiescing");
    writeFileSync(journalPath(f, planned), "{");
    expect(gate(f, null)).toMatchObject({
      kind: "blocked",
      code: "journal-damaged",
      migrationId: planned.id,
    });
  });

  it("blocks selector-damaged and location-unreadable", async () => {
    const selector = bootstrapFixture();
    writeFileSync(join(selector.bootstrapDir, "migration.json"), "{");
    expect(gate(selector, null)).toMatchObject({
      kind: "blocked",
      code: "selector-damaged",
    });

    const location = bootstrapFixture();
    writeFileSync(join(location.bootstrapDir, LOCATION_FILE), "{");
    expect(gate(location, null)).toMatchObject({
      kind: "blocked",
      code: "location-unreadable",
    });
  });

  it("blocks location-changed when the process resolution differs from the current one", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const atStart = resolveDataRoot(f.homeDir, "posix");
    expect(gate(f, atStart)).toEqual({ kind: "open", generation: null });
    await initializeLocationRecord({
      bootstrapDir: f.bootstrapDir,
      held,
      platform: "posix",
      root: f.rootA,
    });
    expect(gate(f, atStart)).toMatchObject({
      kind: "blocked",
      code: "location-changed",
    });
    const now = resolveDataRoot(f.homeDir, "posix");
    expect(gate(f, now)).toEqual({ kind: "open", generation: 1 });
  });
});

describe("bootstrap folder layout", () => {
  it("leaves only flat regular files that ensurePrivateBootstrapDir accepts", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const complete = await driveTo(f, held, planned, "complete");
    expect(complete.phase).toBe("complete");
    const names = readdirSync(f.bootstrapDir).sort();
    expect(names).toEqual(
      [
        LOCATION_FILE,
        "migration.json",
        `migration-${planned.id}.json`,
        `migration-${planned.id}.prev.json`,
      ].sort(),
    );
    for (const name of names) {
      const stats = lstatSync(join(f.bootstrapDir, name));
      expect(stats.isFile(), name).toBe(true);
      expect(stats.isSymbolicLink(), name).toBe(false);
    }
    const result = await ensurePrivateBootstrapDir({
      bootstrapDir: f.bootstrapDir,
      platform: "posix",
      commands: stubCommands,
    });
    expect(result).toMatchObject({
      ok: true,
      root: f.bootstrapDir,
      created: false,
    });
  });
});

describe("fixup regressions", () => {
  async function startAnother(
    fixture: Fixture,
    held: HeldBootstrapSerialization,
    previousLocation: DataLocationRecord | null,
    nextGeneration: number,
  ): Promise<MigrationJournal> {
    const journal = plannedJournal({
      id: newMigrationId(),
      previousLocation,
      source: {
        path: join(fixture.homeDir, ".traycer"),
        volumeId: null,
        directoryId: null,
      },
      destination: { path: fixture.rootB, volumeId: null, directoryId: null },
      nextGeneration,
      coordinatorBuild: currentComponentHandshake("cli", "1.0.0"),
      coordinatorExecutableSha256: null,
      coordinator: { pid: 4242, startIdentity: null, lockNonce: "nonce" },
      now: "2026-10-16T00:00:00.000Z",
    });
    await writeMigrationJournal(fixture.bootstrapDir, held, null, journal);
    const current = readMigrationSelectorSync(fixture.bootstrapDir);
    if (current.kind !== "valid") throw new Error("selector should be valid");
    await writeMigrationSelector(fixture.bootstrapDir, held, current.record, {
      version: 1,
      revision: current.record.revision + 1,
      activeMigrationId: journal.id,
    });
    return journal;
  }

  describe("activation evidence survives previous-revision recovery", () => {
    it("a damaged activated journal cannot be restored from switched, and rollback stays impossible", async () => {
      const f = bootstrapFixture();
      const held = new FakeHeld();
      const planned = await startMigration(f, held, null, 1);
      const switched = await driveTo(f, held, planned, "switched");
      const activated = await advance(f, held, switched, "activated");
      expect(activated.activationRevision).toBe(activated.revision);
      writeFileSync(journalPath(f, planned), "{");

      expect(
        await codeOf(
          restorePreviousRecordRevision(f.bootstrapDir, held, {
            kind: "journal",
            id: planned.id,
          }),
        ),
      ).toBe("transition-refused");
      // Refusal left the damaged bytes alone and the gate closed.
      expect(readFileSync(journalPath(f, planned), "utf8")).toBe("{");
      expect(gateOf(f)).toMatchObject({
        kind: "blocked",
        code: "journal-damaged",
        migrationId: planned.id,
      });

      // Recording rollback is impossible: from the activated revision by the
      // phase rule, from the switched revision because the record is damaged.
      expect(
        await codeOf(
          writeMigrationJournal(
            f.bootstrapDir,
            held,
            activated,
            successor(activated, "rollback-requested"),
          ),
        ),
      ).toBe("transition-refused");
      expect(
        await codeOf(
          writeMigrationJournal(
            f.bootstrapDir,
            held,
            switched,
            successor(switched, "rollback-requested"),
          ),
        ),
      ).toBe("record-damaged");
      expect(readFileSync(journalPath(f, planned), "utf8")).toBe("{");
    });

    it("contrast: a damaged journal whose previous revision is copying restores fine", async () => {
      const f = bootstrapFixture();
      const held = new FakeHeld();
      const planned = await startMigration(f, held, null, 1);
      const copying = await driveWithoutSwitch(f, held, planned, "copying");
      await advance(f, held, copying, "repairing");
      writeFileSync(journalPath(f, planned), "{");
      await restorePreviousRecordRevision(f.bootstrapDir, held, {
        kind: "journal",
        id: planned.id,
      });
      expect(
        readMigrationJournalSync(f.bootstrapDir, planned.id),
      ).toMatchObject({
        kind: "valid",
        record: { phase: "copying", revision: copying.revision },
      });
    });
  });

  describe("selector restore guard", () => {
    async function damagedSelectorWithSecondJournal(
      secondPhase: "planned" | "quiescing" | "rolled-back",
    ): Promise<{
      f: Fixture;
      held: FakeHeld;
      first: MigrationJournal;
      second: MigrationJournal;
    }> {
      const f = bootstrapFixture();
      const held = new FakeHeld();
      const first = await startMigration(f, held, null, 1);
      await driveTo(f, held, first, "complete");
      const second = await startAnother(f, held, null, 2);
      if (secondPhase === "quiescing")
        await advance(f, held, second, "quiescing");
      if (secondPhase === "rolled-back")
        await advance(f, held, second, "rolled-back");
      writeFileSync(join(f.bootstrapDir, "migration.json"), "{");
      return { f, held, first, second };
    }

    it("refuses when another journal is in a barrier phase", async () => {
      const { f, held } = await damagedSelectorWithSecondJournal("quiescing");
      expect(
        await codeOf(
          restorePreviousRecordRevision(f.bootstrapDir, held, {
            kind: "selector",
          }),
        ),
      ).toBe("transition-refused");
      expect(readFileSync(join(f.bootstrapDir, "migration.json"), "utf8")).toBe(
        "{",
      );
    });

    it("restores when the other journal is only planned", async () => {
      const { f, held, first } =
        await damagedSelectorWithSecondJournal("planned");
      await restorePreviousRecordRevision(f.bootstrapDir, held, {
        kind: "selector",
      });
      expect(readMigrationSelectorSync(f.bootstrapDir)).toMatchObject({
        kind: "valid",
        record: { revision: 1, activeMigrationId: first.id },
      });
    });

    it("restores when the other journal is terminal", async () => {
      const { f, held, first } =
        await damagedSelectorWithSecondJournal("rolled-back");
      await restorePreviousRecordRevision(f.bootstrapDir, held, {
        kind: "selector",
      });
      expect(readMigrationSelectorSync(f.bootstrapDir)).toMatchObject({
        kind: "valid",
        record: { activeMigrationId: first.id },
      });
    });

    it("refuses when another journal is itself unreadable", async () => {
      const { f, held, second } =
        await damagedSelectorWithSecondJournal("planned");
      writeFileSync(journalPath(f, second), "{");
      expect(
        await codeOf(
          restorePreviousRecordRevision(f.bootstrapDir, held, {
            kind: "selector",
          }),
        ),
      ).toBe("transition-refused");
    });
  });

  describe("non-null rollback pairing", () => {
    async function configuredMigration(
      from: "switching" | "switched",
    ): Promise<{
      f: Fixture;
      held: FakeHeld;
      previous: DataLocationRecord;
      planned: MigrationJournal;
      requested: MigrationJournal;
      pointer: DataLocationRecord;
    }> {
      const f = bootstrapFixture();
      const held = new FakeHeld();
      const previous = await initializeLocationRecord({
        bootstrapDir: f.bootstrapDir,
        held,
        platform: "posix",
        root: f.rootA,
      });
      const planned = await startMigration(f, held, previous, 2);
      const reached = await driveTo(f, held, planned, from);
      const pointer = migrationLocationOf(reached);
      const requested = await advance(f, held, reached, "rollback-requested");
      return { f, held, previous, planned, requested, pointer };
    }

    function parsedFile(path: string): unknown {
      return JSON.parse(readFileSync(path, "utf8"));
    }

    it.each(["switching", "switched"] as const)(
      "rollback from %s leaves a valid pair: previous in location.json, the pointer in location.prev.json",
      async (from) => {
        const { f, held, previous, requested, pointer } =
          await configuredMigration(from);
        await restoreLocationForRollback({
          bootstrapDir: f.bootstrapDir,
          held,
          journal: requested,
        });
        expect(parsedFile(join(f.bootstrapDir, LOCATION_FILE))).toEqual(
          previous,
        );
        expect(parsedFile(join(f.bootstrapDir, "location.prev.json"))).toEqual(
          pointer,
        );
        expect(readLocationRecordSync(f.bootstrapDir)).toMatchObject({
          kind: "valid",
          record: previous,
        });
        // Idempotent.
        const bytes = readFileSync(join(f.bootstrapDir, LOCATION_FILE), "utf8");
        await restoreLocationForRollback({
          bootstrapDir: f.bootstrapDir,
          held,
          journal: requested,
        });
        expect(readFileSync(join(f.bootstrapDir, LOCATION_FILE), "utf8")).toBe(
          bytes,
        );
        expect(readLocationRecordSync(f.bootstrapDir).kind).toBe("valid");
        // Still valid once the journal is rolled back; the gate opens at the old generation.
        await advance(f, held, requested, "rolled-back");
        expect(readLocationRecordSync(f.bootstrapDir).kind).toBe("valid");
        expect(
          evaluateStartupGate({
            homeDir: f.homeDir,
            platform: "posix",
            processResolution: null,
          }),
        ).toEqual({
          kind: "open",
          generation: 1,
        });
      },
    );

    it("retries cleanly after an interruption between saving the previous pointer and replacing the record", async () => {
      const { f, held, previous, requested, pointer } =
        await configuredMigration("switching");
      // The crash window: location.prev.json already holds the current bytes.
      writeFileSync(
        join(f.bootstrapDir, "location.prev.json"),
        readFileSync(join(f.bootstrapDir, LOCATION_FILE), "utf8"),
      );
      expect(readLocationRecordSync(f.bootstrapDir)).toMatchObject({
        kind: "valid",
        record: pointer,
      });
      await restoreLocationForRollback({
        bootstrapDir: f.bootstrapDir,
        held,
        journal: requested,
      });
      expect(readLocationRecordSync(f.bootstrapDir)).toMatchObject({
        kind: "valid",
        record: previous,
      });
      expect(parsedFile(join(f.bootstrapDir, "location.prev.json"))).toEqual(
        pointer,
      );
    });

    it("an arbitrary generation regression (no rolling-back journal) is damaged", async () => {
      const f = bootstrapFixture();
      const previous: DataLocationRecord = {
        version: 1,
        generation: 1,
        root: f.rootA,
        migrationId: null,
      };
      // No journal at all, and a previous pointer that names no migration.
      writeLocationFile(f, previous);
      writeFileSync(
        join(f.bootstrapDir, "location.prev.json"),
        `${JSON.stringify({ version: 1, generation: 2, root: f.rootB, migrationId: null })}\n`,
      );
      expect(readLocationRecordSync(f.bootstrapDir)).toMatchObject({
        kind: "damaged",
        reason: "inconsistent with its previous revision",
      });
    });

    it("a regression is damaged while the naming journal is still switching", async () => {
      const f = bootstrapFixture();
      const held = new FakeHeld();
      const previous = await initializeLocationRecord({
        bootstrapDir: f.bootstrapDir,
        held,
        platform: "posix",
        root: f.rootA,
      });
      const planned = await startMigration(f, held, previous, 2);
      const switching = await driveTo(f, held, planned, "switching");
      const pointer = migrationLocationOf(switching);
      writeLocationFile(f, previous);
      writeFileSync(
        join(f.bootstrapDir, "location.prev.json"),
        `${JSON.stringify(pointer)}\n`,
      );
      expect(readLocationRecordSync(f.bootstrapDir)).toMatchObject({
        kind: "damaged",
      });
    });

    it("a regression to a location other than the journal's previous one is damaged even while rolling back", async () => {
      const { f, previous, pointer } = await configuredMigration("switching");
      const other = join(f.homeDir, "data-c");
      mkdirSync(other);
      writeLocationFile(f, { ...previous, root: other });
      writeFileSync(
        join(f.bootstrapDir, "location.prev.json"),
        `${JSON.stringify(pointer)}\n`,
      );
      expect(readLocationRecordSync(f.bootstrapDir)).toMatchObject({
        kind: "damaged",
      });
    });

    it("switchLocationForMigration refuses a generation not above the retained previous pointer", async () => {
      const f = bootstrapFixture();
      const held = new FakeHeld();
      const first = await startMigration(f, held, null, 1);
      const switching = await driveTo(f, held, first, "switching");
      const requested = await advance(f, held, switching, "rollback-requested");
      await restoreLocationForRollback({
        bootstrapDir: f.bootstrapDir,
        held,
        journal: requested,
      });
      await advance(f, held, requested, "rolled-back");
      // Back on the default root, but location.prev.json still holds generation 1.
      expect(existsSync(join(f.bootstrapDir, LOCATION_FILE))).toBe(false);
      expect(existsSync(join(f.bootstrapDir, "location.prev.json"))).toBe(true);

      const reused = await startAnother(f, held, null, 1);
      const reusedSwitching = await driveWithoutSwitch(
        f,
        held,
        reused,
        "switching",
      );
      expect(
        await codeOf(
          switchLocationForMigration({
            bootstrapDir: f.bootstrapDir,
            held,
            platform: "posix",
            journal: reusedSwitching,
          }),
        ),
      ).toBe("generation-not-advanced");
      expect(existsSync(join(f.bootstrapDir, LOCATION_FILE))).toBe(false);

      // The next generation is accepted and leaves a readable pair.
      const advanced = await startAnother(f, held, null, 2);
      const advancedSwitching = await driveWithoutSwitch(
        f,
        held,
        advanced,
        "switching",
      );
      await switchLocationForMigration({
        bootstrapDir: f.bootstrapDir,
        held,
        platform: "posix",
        journal: advancedSwitching,
      });
      expect(readLocationRecordSync(f.bootstrapDir)).toMatchObject({
        kind: "valid",
        record: { generation: 2, migrationId: advanced.id },
      });
    });
  });
});

describe("activation evidence beyond adjacency", () => {
  const POST_ACTIVATION: readonly MigrationPhase[] = [
    "activated",
    "cleaning",
    "complete",
  ];

  it("a damaged cleaning journal restores to activated, keeps its activation evidence and stays unrollbackable", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const activated = await driveTo(f, held, planned, "activated");
    await advance(f, held, activated, "cleaning");
    writeFileSync(journalPath(f, planned), "{");
    await restorePreviousRecordRevision(f.bootstrapDir, held, {
      kind: "journal",
      id: planned.id,
    });
    const restored = readMigrationJournalSync(f.bootstrapDir, planned.id);
    expect(restored).toMatchObject({
      kind: "valid",
      record: { phase: "activated", activationRevision: activated.revision },
    });
    if (restored.kind !== "valid") throw new Error("unreachable");
    expect(restored.record.activationRevision).not.toBeNull();
    expect(
      await codeOf(
        writeMigrationJournal(
          f.bootstrapDir,
          held,
          restored.record,
          successor(restored.record, "rollback-requested"),
        ),
      ),
    ).toBe("transition-refused");
  });

  it("no restore of a journal that recorded activation yields a pre-activation phase", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const activated = await driveTo(f, held, planned, "activated");
    const cleaning = await advance(f, held, activated, "cleaning");
    await advance(f, held, cleaning, "complete");
    // Damaged at complete: restores to cleaning, still post-activation.
    writeFileSync(journalPath(f, planned), "{");
    await restorePreviousRecordRevision(f.bootstrapDir, held, {
      kind: "journal",
      id: planned.id,
    });
    const read = readMigrationJournalSync(f.bootstrapDir, planned.id);
    if (read.kind !== "valid")
      throw new Error("the restored journal should be valid");
    expect(read.record.phase).toBe("cleaning");
    expect(POST_ACTIVATION).toContain(read.record.phase);
    expect(read.record.activationRevision).toBe(activated.revision);
  });

  it("restoring the selector leaves an activated journal activated", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    const activated = await driveTo(f, held, planned, "activated");
    const selector = readMigrationSelectorSync(f.bootstrapDir);
    if (selector.kind !== "valid") throw new Error("selector should be valid");
    await writeMigrationSelector(f.bootstrapDir, held, selector.record, {
      version: 1,
      revision: 2,
      activeMigrationId: planned.id,
    });
    writeFileSync(join(f.bootstrapDir, "migration.json"), "{");
    await restorePreviousRecordRevision(f.bootstrapDir, held, {
      kind: "selector",
    });
    expect(readMigrationSelectorSync(f.bootstrapDir)).toMatchObject({
      kind: "valid",
      record: { activeMigrationId: planned.id },
    });
    const journal = readMigrationJournalSync(f.bootstrapDir, planned.id);
    expect(journal).toMatchObject({
      kind: "valid",
      record: { phase: "activated", activationRevision: activated.revision },
    });
    expect(gateOf(f)).toEqual({ kind: "open", generation: 1 });
  });
});

describe("captureStartupGateEvidence", () => {
  it("lists exactly the location and migration records' bytes when the gate is open", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const previous = await initializeLocationRecord({
      bootstrapDir: f.bootstrapDir,
      held,
      platform: "posix",
      root: f.rootA,
    });
    const planned = await startMigration(f, held, previous, 2);
    // A second revision leaves a migration-<id>.prev.json beside it; the
    // terminal phase keeps the gate open.
    await advance(f, held, planned, "rolled-back");
    // Entries the evidence must not carry.
    writeFileSync(join(f.bootstrapDir, `admission-${randomUUID()}.json`), "{}");
    writeFileSync(join(f.bootstrapDir, "admission.lock"), "{}");
    writeFileSync(
      join(f.bootstrapDir, `migration.json.${randomUUID()}.tmp`),
      "{",
    );
    expect(existsSync(journalPrevPath(f, planned))).toBe(true);

    const evidence = captureStartupGateEvidence({
      homeDir: f.homeDir,
      platform: "posix",
      processResolution: null,
    });
    if (evidence === null)
      throw new Error("the gate is open, evidence expected");
    expect(evidence.bootstrapDir).toBe(f.bootstrapDir);
    expect(evidence.namePattern).toBe(STARTUP_GATE_EVIDENCE_FILE.source);
    const expectedNames = [
      LOCATION_FILE,
      `migration-${planned.id}.json`,
      "migration.json",
    ].sort();
    expect(evidence.files.map((file) => file.name)).toEqual(expectedNames);
    for (const file of evidence.files) {
      expect(file.content).toBe(
        readFileSync(join(f.bootstrapDir, file.name), "utf8"),
      );
    }
    for (const file of evidence.files) {
      expect(file.name).not.toContain(".prev");
      expect(file.name).not.toContain(".tmp");
      expect(file.name.startsWith("admission")).toBe(false);
    }
  });

  it("carries an empty list when there is no bootstrap folder", () => {
    const f = makeFixture();
    const evidence = captureStartupGateEvidence({
      homeDir: f.homeDir,
      platform: "posix",
      processResolution: null,
    });
    expect(evidence).toEqual({
      bootstrapDir: f.bootstrapDir,
      namePattern: STARTUP_GATE_EVIDENCE_FILE.source,
      files: [],
    });
    expect(existsSync(f.bootstrapDir)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "is null for a symlinked bootstrap folder",
    () => {
      const f = makeFixture();
      const real = join(f.homeDir, "real-bootstrap");
      mkdirSync(real);
      symlinkSync(real, f.bootstrapDir);
      expect(
        captureStartupGateEvidence({
          homeDir: f.homeDir,
          platform: "posix",
          processResolution: null,
        }),
      ).toBeNull();
    },
  );

  it("is null when a migration record is a directory", () => {
    const f = bootstrapFixture();
    mkdirSync(join(f.bootstrapDir, `migration-${newMigrationId()}.json`));
    expect(
      captureStartupGateEvidence({
        homeDir: f.homeDir,
        platform: "posix",
        processResolution: null,
      }),
    ).toBeNull();
  });

  it("is null when the gate is blocked", async () => {
    const f = bootstrapFixture();
    const held = new FakeHeld();
    const planned = await startMigration(f, held, null, 1);
    await advance(f, held, planned, "quiescing");
    expect(
      captureStartupGateEvidence({
        homeDir: f.homeDir,
        platform: "posix",
        processResolution: null,
      }),
    ).toBeNull();
  });

  it("is null when the location changed under the process", async () => {
    const f = bootstrapFixture();
    const atStart = resolveDataRoot(f.homeDir, "posix");
    await initializeLocationRecord({
      bootstrapDir: f.bootstrapDir,
      held: new FakeHeld(),
      platform: "posix",
      root: f.rootA,
    });
    expect(
      captureStartupGateEvidence({
        homeDir: f.homeDir,
        platform: "posix",
        processResolution: atStart,
      }),
    ).toBeNull();
  });
});

function gateOf(fixture: Fixture): StartupGateDecision {
  return evaluateStartupGate({
    homeDir: fixture.homeDir,
    platform: "posix",
    processResolution: null,
  });
}
