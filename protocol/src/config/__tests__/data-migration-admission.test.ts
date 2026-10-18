import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMISSION_MUTEX_FILENAME,
  ADMISSION_MUTEX_MAX_HOLD_MS,
  MIGRATION_COORDINATOR_LOCK_FILENAME,
  MigrationAdmissionError,
  acquireMigrationCoordinatorLock,
  admissionEntrySchema,
  admitProcess,
  advanceMigrationJournal,
  assertMigrationAdmissionOpen,
  authorizeMaintenanceRequest,
  beginMigrationJournal,
  currentMigrationAdmission,
  surveyAdmittedProcesses,
  withAdmissionMutex,
  type AdmissionEntry,
  type AdmissionResult,
  type BootstrapLockHolder,
  type MigrationAdmission,
  type MigrationAdmissionErrorCode,
  type MigrationCoordinatorLock,
  type ProcessIncarnationProbe,
} from "../data-migration-admission";
import {
  currentComponentHandshake,
  newMigrationId,
  plannedJournal,
  type ComponentHandshake,
  type MaintenanceRequest,
  type MigrationJournal,
  type MigrationPhase,
} from "../data-migration-contracts";
import { resolveDataRoot, type DataRootResolution } from "../data-root";
import type { AttemptHolderLivenessVerdict } from "../host-update-attempt-liveness";

const breakStaleLockControl = vi.hoisted(() => ({ contended: false }));

// Passes through to the real implementation unless a test makes the removal
// of a stale lock "contended" (a denied rename, a Windows sharing violation).
vi.mock("../credentials-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials-lock")>();
  return {
    ...actual,
    breakStaleLock: (lockPath: string, staleRaw: string) =>
      breakStaleLockControl.contended
        ? Promise.resolve("contended" as const)
        : actual.breakStaleLock(lockPath, staleRaw),
  };
});

const OWN_IDENTITY = "own-start-identity";

class FakeProbe implements ProcessIncarnationProbe {
  own: string | null = OWN_IDENTITY;
  ownDelayMs = 0;
  /** Runs when this process's own identity is read (inside admitProcess). */
  onOwnIdentityRead: (() => void) | null = null;
  verdicts = new Map<number, AttemptHolderLivenessVerdict>();
  livenesses = new Map<number, "alive" | "dead" | "indeterminate">();

  async ownStartIdentity(): Promise<string | null> {
    if (this.onOwnIdentityRead !== null) this.onOwnIdentityRead();
    if (this.ownDelayMs > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.ownDelayMs),
      );
    }
    return this.own;
  }

  liveness(pid: number): Promise<"alive" | "dead" | "indeterminate"> {
    return Promise.resolve(this.livenesses.get(pid) ?? "alive");
  }

  verdict(pid: number): Promise<AttemptHolderLivenessVerdict> {
    return Promise.resolve(this.verdicts.get(pid) ?? "alive-same");
  }
}

type Fixture = {
  readonly homeDir: string;
  readonly bootstrapDir: string;
};

const homes: string[] = [];
const admissions: MigrationAdmission[] = [];
const locks: MigrationCoordinatorLock[] = [];

afterEach(async () => {
  breakStaleLockControl.contended = false;
  for (const admission of admissions.splice(0)) await admission.release();
  for (const lock of locks.splice(0)) await lock.release();
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function makeFixture(): Fixture {
  const homeDir = mkdtempSync(join(tmpdir(), "migration-admission-"));
  homes.push(homeDir);
  return { homeDir, bootstrapDir: join(homeDir, ".traycer-bootstrap") };
}

function bootstrapFixture(): Fixture {
  const fixture = makeFixture();
  mkdirSync(fixture.bootstrapDir, { mode: 0o700 });
  return fixture;
}

const HOST_HANDSHAKE = currentComponentHandshake("host", "1.0.0");

async function admit(
  fixture: Fixture,
  probe: ProcessIncarnationProbe,
  identityWaitMs: number,
): Promise<AdmissionResult> {
  const result = await admitProcess({
    homeDir: fixture.homeDir,
    platform: "posix",
    processResolution: resolveDataRoot(fixture.homeDir, "posix"),
    handshake: HOST_HANDSHAKE,
    probe,
    mutexWaitMs: 1_000,
    identityWaitMs,
  });
  if (result.kind === "admitted") admissions.push(result.admission);
  return result;
}

async function mustAdmit(
  fixture: Fixture,
  probe: ProcessIncarnationProbe,
  identityWaitMs: number,
): Promise<MigrationAdmission> {
  const result = await admit(fixture, probe, identityWaitMs);
  if (result.kind !== "admitted") throw new Error("expected admission");
  return result.admission;
}

async function mustLock(
  fixture: Fixture,
  probe: ProcessIncarnationProbe,
): Promise<MigrationCoordinatorLock> {
  const result = await acquireMigrationCoordinatorLock({
    bootstrapDir: fixture.bootstrapDir,
    probe,
  });
  if (!result.acquired)
    throw new Error(`expected the coordinator lock (${result.reason})`);
  locks.push(result.lock);
  return result.lock;
}

function entryFiles(fixture: Fixture): string[] {
  return readdirSync(fixture.bootstrapDir)
    .filter((name) => /^admission-[0-9a-f-]{36}\.json$/u.test(name))
    .sort();
}

function entryPath(fixture: Fixture, entryId: string): string {
  return join(fixture.bootstrapDir, `admission-${entryId}.json`);
}

function readEntry(path: string): AdmissionEntry {
  return admissionEntrySchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function writeEntry(
  fixture: Fixture,
  input: {
    pid: number;
    startIdentity: string | null;
    handshake: ComponentHandshake;
  },
): string {
  const entryId = randomUUID();
  const entry: AdmissionEntry = {
    version: 1,
    entryId,
    pid: input.pid,
    startIdentity: input.startIdentity,
    handshake: input.handshake,
    generation: null,
    admittedAt: "2026-10-16T00:00:00.000Z",
  };
  writeFileSync(entryPath(fixture, entryId), `${JSON.stringify(entry)}\n`);
  return entryId;
}

function writeLockFile(path: string, holder: BootstrapLockHolder): void {
  writeFileSync(path, JSON.stringify(holder));
}

function coordinatorLockPath(fixture: Fixture): string {
  return join(fixture.bootstrapDir, MIGRATION_COORDINATOR_LOCK_FILENAME);
}

async function waitFor(
  check: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

async function admissionErrorCode(
  attempt: Promise<unknown>,
): Promise<MigrationAdmissionErrorCode | string> {
  try {
    await attempt;
    return "no-error";
  } catch (error) {
    return error instanceof MigrationAdmissionError
      ? error.code
      : `other: ${String(error)}`;
  }
}

function journalFor(
  fixture: Fixture,
  lock: MigrationCoordinatorLock,
): MigrationJournal {
  return plannedJournal({
    id: newMigrationId(),
    previousLocation: null,
    source: {
      path: join(fixture.homeDir, ".traycer"),
      volumeId: null,
      directoryId: null,
    },
    destination: {
      path: join(fixture.homeDir, "data-b"),
      volumeId: null,
      directoryId: null,
    },
    nextGeneration: 1,
    coordinatorBuild: currentComponentHandshake("cli", "1.0.0"),
    coordinatorExecutableSha256: null,
    coordinator: lock.incarnation,
    now: "2026-10-16T00:00:00.000Z",
  });
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
  };
}

async function step(
  fixture: Fixture,
  lock: MigrationCoordinatorLock,
  probe: ProcessIncarnationProbe,
  current: MigrationJournal,
  phase: MigrationPhase,
): Promise<MigrationJournal> {
  const next = successor(current, phase);
  await advanceMigrationJournal({
    bootstrapDir: fixture.bootstrapDir,
    coordinator: lock,
    probe,
    expected: current,
    next,
  });
  return next;
}

/** A coordinator that has begun a transaction and moved it to `quiescing`. */
async function raiseBarrier(
  fixture: Fixture,
  probe: ProcessIncarnationProbe,
): Promise<{ lock: MigrationCoordinatorLock; journal: MigrationJournal }> {
  const lock = await mustLock(fixture, probe);
  const planned = journalFor(fixture, lock);
  await beginMigrationJournal({
    bootstrapDir: fixture.bootstrapDir,
    coordinator: lock,
    journal: planned,
  });
  const journal = await step(fixture, lock, probe, planned, "quiescing");
  return { lock, journal };
}

describe("admitProcess", () => {
  it("writes an entry naming pid, handshake and generation when the gate is open", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const admission = await mustAdmit(f, probe, 1_000);
    const files = entryFiles(f);
    expect(files).toEqual([`admission-${admission.entryId}.json`]);
    const entry = readEntry(entryPath(f, admission.entryId));
    expect(entry).toMatchObject({
      version: 1,
      entryId: admission.entryId,
      pid: process.pid,
      startIdentity: OWN_IDENTITY,
      handshake: HOST_HANDSHAKE,
      generation: null,
    });
    expect(admission.generation).toBeNull();
    expect(currentMigrationAdmission()).toBe(admission);
    // The admission mutex is not left behind.
    expect(existsSync(join(f.bootstrapDir, ADMISSION_MUTEX_FILENAME))).toBe(
      false,
    );
    expect(readdirSync(f.bootstrapDir)).toEqual(files);
  });

  it("refuses behind an active barrier and writes nothing", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    const { journal } = await raiseBarrier(f, probe);
    const before = readdirSync(f.bootstrapDir).sort();
    const result = await admit(f, probe, 1_000);
    expect(result).toMatchObject({
      kind: "refused",
      decision: {
        kind: "blocked",
        code: "migration-in-progress",
        migrationId: journal.id,
      },
    });
    expect(readdirSync(f.bootstrapDir).sort()).toEqual(before);
    expect(entryFiles(f)).toEqual([]);
    expect(currentMigrationAdmission()).toBeNull();
  });

  it("refuses without creating the bootstrap folder when it is absent", async () => {
    const f = makeFixture();
    // A process that started under a configured root and finds the folder
    // gone: the selection changed under it, so the gate is blocked.
    const processResolution: DataRootResolution = {
      kind: "configured",
      root: join(f.homeDir, "data-a"),
      bootstrapDir: f.bootstrapDir,
      record: {
        version: 1,
        generation: 1,
        root: join(f.homeDir, "data-a"),
        migrationId: null,
      },
    };
    const result = await admitProcess({
      homeDir: f.homeDir,
      platform: "posix",
      processResolution,
      handshake: HOST_HANDSHAKE,
      probe: new FakeProbe(),
      mutexWaitMs: 1_000,
      identityWaitMs: 1_000,
    });
    expect(result).toMatchObject({
      kind: "refused",
      decision: { kind: "blocked", code: "location-changed" },
    });
    expect(existsSync(f.bootstrapDir)).toBe(false);
    expect(currentMigrationAdmission()).toBeNull();
  });

  it("release removes the entry, is idempotent, and clears the current admission", async () => {
    const f = makeFixture();
    const admission = await mustAdmit(f, new FakeProbe(), 1_000);
    expect(entryFiles(f)).toHaveLength(1);
    await admission.release();
    expect(entryFiles(f)).toEqual([]);
    expect(currentMigrationAdmission()).toBeNull();
    await admission.release();
    expect(entryFiles(f)).toEqual([]);
  });

  it("with identityWaitMs 0 writes a null identity first and completes it later", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    probe.ownDelayMs = 150;
    const admission = await mustAdmit(f, probe, 0);
    const path = entryPath(f, admission.entryId);
    expect(readEntry(path).startIdentity).toBeNull();
    const completed = await waitFor(
      () => readEntry(path).startIdentity === OWN_IDENTITY,
      3_000,
    );
    expect(completed).toBe(true);
    await admission.release();
    expect(existsSync(path)).toBe(false);
  });

  it("an identity that cannot be read leaves the entry with a null identity", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    probe.own = null;
    const admission = await mustAdmit(f, probe, 1_000);
    expect(readEntry(entryPath(f, admission.entryId)).startIdentity).toBeNull();
  });

  it("(race A) a process admitted before the barrier is listed as running and blocks draining", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const early = await mustAdmit(f, probe, 1_000);
    // A second admission in this process takes the current-admission slot, so
    // the first one is a registrant the survey must report.
    const own = await mustAdmit(f, probe, 1_000);
    await raiseBarrier(f, probe);
    const survey = await surveyAdmittedProcesses({
      bootstrapDir: f.bootstrapDir,
      probe,
      reap: true,
    });
    expect(survey.processes).toHaveLength(1);
    expect(survey.processes[0]).toMatchObject({
      entryId: early.entryId,
      state: "running",
    });
    expect(
      survey.processes.some((report) => report.entryId === own.entryId),
    ).toBe(false);
    expect(survey.drained).toBe(false);
    expect(existsSync(entryPath(f, early.entryId))).toBe(true);
  });

  it("(race B) once the barrier is up a new registrant is refused and adds no entry", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    await mustAdmit(f, probe, 1_000);
    await raiseBarrier(f, probe);
    const entriesBefore = entryFiles(f);
    const late = await admit(f, probe, 1_000);
    expect(late.kind).toBe("refused");
    expect(entryFiles(f)).toEqual(entriesBefore);
  });

  it("(race C) a barrier raised while the registrant is still reading its identity leaves no entry", async () => {
    // The in-mutex write-then-recheck branch cannot be interleaved through the
    // public API (the coordinator raises the barrier under the same mutex), so
    // this raises the barrier before the registrant takes the mutex, from the
    // identity read it waits on, and asserts the registrant leaves no entry.
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    const coordinatorProbe = new FakeProbe();
    const lock = await mustLock(f, coordinatorProbe);
    const planned = journalFor(f, lock);
    await beginMigrationJournal({
      bootstrapDir: f.bootstrapDir,
      coordinator: lock,
      journal: planned,
    });
    let raised: Promise<MigrationJournal> | null = null;
    probe.onOwnIdentityRead = () => {
      raised = step(f, lock, coordinatorProbe, planned, "quiescing");
    };
    const result = await admit(f, probe, 1_000);
    if (raised !== null) await raised;
    // Either ordering is safe: refused with no entry, or admitted and listed
    // (then the coordinator's survey sees it).
    if (result.kind === "refused") {
      expect(entryFiles(f)).toEqual([]);
    } else {
      expect(entryFiles(f)).toHaveLength(1);
    }
    const after = await admit(f, probe, 1_000);
    expect(after.kind).toBe("refused");
  });
});

describe("assertMigrationAdmissionOpen", () => {
  it("is a no-op for a process that never admitted, even behind a barrier", async () => {
    const f = bootstrapFixture();
    await raiseBarrier(f, new FakeProbe());
    expect(currentMigrationAdmission()).toBeNull();
    expect(() => assertMigrationAdmissionOpen()).not.toThrow();
  });

  it("throws startup-blocked for an admitted process once the barrier is raised", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    await mustAdmit(f, probe, 1_000);
    expect(() => assertMigrationAdmissionOpen()).not.toThrow();
    await raiseBarrier(f, probe);
    let thrown: unknown = null;
    try {
      assertMigrationAdmissionOpen();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationAdmissionError);
    if (!(thrown instanceof MigrationAdmissionError))
      throw new Error("unreachable");
    expect(thrown.code).toBe("startup-blocked");
    expect(thrown.decision).toMatchObject({
      kind: "blocked",
      code: "migration-in-progress",
    });
  });

  it("is open again after the admission is released", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const admission = await mustAdmit(f, probe, 1_000);
    await raiseBarrier(f, probe);
    await admission.release();
    expect(() => assertMigrationAdmissionOpen()).not.toThrow();
  });
});

describe("surveyAdmittedProcesses", () => {
  const OLD_HANDSHAKE = currentComponentHandshake("cli", "0.9.0");

  it("reaps an entry whose process is dead", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.verdicts.set(2001, "dead");
    const entryId = writeEntry(f, {
      pid: 2001,
      startIdentity: "s",
      handshake: OLD_HANDSHAKE,
    });
    const survey = await surveyAdmittedProcesses({
      bootstrapDir: f.bootstrapDir,
      probe,
      reap: true,
    });
    expect(survey.processes).toMatchObject([{ entryId, state: "exited" }]);
    expect(survey.drained).toBe(true);
    expect(existsSync(entryPath(f, entryId))).toBe(false);
  });

  it("reaps an entry whose pid now names a different process", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.verdicts.set(2002, "alive-different");
    const entryId = writeEntry(f, {
      pid: 2002,
      startIdentity: "s",
      handshake: OLD_HANDSHAKE,
    });
    const survey = await surveyAdmittedProcesses({
      bootstrapDir: f.bootstrapDir,
      probe,
      reap: true,
    });
    expect(survey.processes).toMatchObject([{ entryId, state: "recycled" }]);
    expect(survey.drained).toBe(true);
    expect(existsSync(entryPath(f, entryId))).toBe(false);
  });

  it("does not reap an entry whose liveness is indeterminate and is not drained", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.verdicts.set(2003, "indeterminate");
    const entryId = writeEntry(f, {
      pid: 2003,
      startIdentity: null,
      handshake: OLD_HANDSHAKE,
    });
    const survey = await surveyAdmittedProcesses({
      bootstrapDir: f.bootstrapDir,
      probe,
      reap: true,
    });
    expect(survey.processes).toMatchObject([{ entryId, state: "ambiguous" }]);
    expect(survey.drained).toBe(false);
    expect(existsSync(entryPath(f, entryId))).toBe(true);
  });

  it("reap: false deletes nothing", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.verdicts.set(2004, "dead");
    probe.verdicts.set(2005, "alive-different");
    const a = writeEntry(f, {
      pid: 2004,
      startIdentity: "s",
      handshake: OLD_HANDSHAKE,
    });
    const b = writeEntry(f, {
      pid: 2005,
      startIdentity: "s",
      handshake: OLD_HANDSHAKE,
    });
    const survey = await surveyAdmittedProcesses({
      bootstrapDir: f.bootstrapDir,
      probe,
      reap: false,
    });
    expect(survey.processes.map((report) => report.state).sort()).toEqual([
      "exited",
      "recycled",
    ]);
    expect(survey.drained).toBe(true);
    expect(existsSync(entryPath(f, a))).toBe(true);
    expect(existsSync(entryPath(f, b))).toBe(true);
  });

  it("reports an unreadable entry and leaves it in place", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    const entryId = randomUUID();
    writeFileSync(entryPath(f, entryId), "not json");
    const survey = await surveyAdmittedProcesses({
      bootstrapDir: f.bootstrapDir,
      probe,
      reap: true,
    });
    expect(survey.processes).toEqual([
      { entryId, entry: null, state: "unreadable" },
    ]);
    expect(survey.drained).toBe(false);
    expect(existsSync(entryPath(f, entryId))).toBe(true);
  });

  it("excludes this process's own current admission", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    await mustAdmit(f, probe, 1_000);
    const survey = await surveyAdmittedProcesses({
      bootstrapDir: f.bootstrapDir,
      probe,
      reap: true,
    });
    expect(survey.processes).toEqual([]);
    expect(survey.drained).toBe(true);
    expect(entryFiles(f)).toHaveLength(1);
  });

  it("returns an empty, drained survey when the folder does not exist", async () => {
    const f = makeFixture();
    const survey = await surveyAdmittedProcesses({
      bootstrapDir: f.bootstrapDir,
      probe: new FakeProbe(),
      reap: true,
    });
    expect(survey).toEqual({
      processes: [],
      drained: true,
      handshakeBlockers: [],
    });
    expect(existsSync(f.bootstrapDir)).toBe(false);
  });

  it("reports handshake blockers for running participants on another protocol", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.verdicts.set(2010, "alive-same");
    probe.verdicts.set(2011, "dead");
    probe.verdicts.set(2012, "alive-same");
    writeEntry(f, {
      pid: 2010,
      startIdentity: "s",
      handshake: {
        component: "desktop",
        build: "9.0.0",
        dataMigrationProtocol: 2,
      },
    });
    // Not running: never a blocker.
    writeEntry(f, {
      pid: 2011,
      startIdentity: "s",
      handshake: { component: "cli", build: "9.1.0", dataMigrationProtocol: 2 },
    });
    // Compatible and running: drains but is no blocker.
    writeEntry(f, { pid: 2012, startIdentity: "s", handshake: HOST_HANDSHAKE });
    const survey = await surveyAdmittedProcesses({
      bootstrapDir: f.bootstrapDir,
      probe,
      reap: false,
    });
    expect(survey.handshakeBlockers).toEqual([
      { component: "desktop", build: "9.0.0", reason: "protocol-too-new" },
    ]);
    expect(survey.drained).toBe(false);
  });

  it("reads an entry with protocol 0 as unreadable (the entry schema requires a positive protocol)", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    const entryId = writeEntry(f, {
      pid: 2020,
      startIdentity: "s",
      handshake: { component: "cli", build: "0.1.0", dataMigrationProtocol: 0 },
    });
    const survey = await surveyAdmittedProcesses({
      bootstrapDir: f.bootstrapDir,
      probe,
      reap: true,
    });
    expect(survey.processes).toMatchObject([
      { entryId, entry: null, state: "unreadable" },
    ]);
    expect(survey.drained).toBe(false);
    expect(survey.handshakeBlockers).toEqual([]);
  });

  it("reaping only ever removes entries and never creates one", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.verdicts.set(2030, "dead");
    probe.verdicts.set(2031, "alive-same");
    writeEntry(f, { pid: 2030, startIdentity: "s", handshake: OLD_HANDSHAKE });
    writeEntry(f, { pid: 2031, startIdentity: "s", handshake: HOST_HANDSHAKE });
    const before = new Set(entryFiles(f));
    await surveyAdmittedProcesses({
      bootstrapDir: f.bootstrapDir,
      probe,
      reap: true,
    });
    const after = entryFiles(f);
    expect(after.length).toBe(before.size - 1);
    for (const name of after) expect(before.has(name)).toBe(true);
  });
});

describe("coordinator lock", () => {
  it("acquires, names this process, and releases", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const lock = await mustLock(f, probe);
    const raw = JSON.parse(readFileSync(coordinatorLockPath(f), "utf8"));
    expect(raw).toMatchObject({
      version: 1,
      purpose: "coordinator",
      pid: process.pid,
      startIdentity: OWN_IDENTITY,
      nonce: lock.incarnation.lockNonce,
    });
    expect(lock.incarnation).toMatchObject({
      pid: process.pid,
      startIdentity: OWN_IDENTITY,
    });
    expect(() => lock.assertHeld()).not.toThrow();
    await lock.release();
    expect(existsSync(coordinatorLockPath(f))).toBe(false);
    expect(
      await admissionErrorCode(Promise.resolve().then(() => lock.assertHeld())),
    ).toBe("coordinator-not-held");
  });

  it("a second acquire reports held and leaves the first lock intact", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const first = await mustLock(f, probe);
    const second = await acquireMigrationCoordinatorLock({
      bootstrapDir: f.bootstrapDir,
      probe,
    });
    expect(second).toMatchObject({
      acquired: false,
      reason: "held",
      holder: { pid: process.pid },
    });
    expect(() => first.assertHeld()).not.toThrow();
  });

  it("takes over a holder that is proven dead", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.verdicts.set(3001, "dead");
    writeLockFile(coordinatorLockPath(f), {
      version: 1,
      purpose: "coordinator",
      pid: 3001,
      startIdentity: "old-start",
      nonce: "old-nonce",
      acquiredAt: Date.now(),
    });
    const lock = await mustLock(f, probe);
    expect(lock.incarnation.lockNonce).not.toBe("old-nonce");
    expect(
      JSON.parse(readFileSync(coordinatorLockPath(f), "utf8")),
    ).toMatchObject({
      nonce: lock.incarnation.lockNonce,
    });
  });

  it("takes over a holder whose pid names a different process", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.verdicts.set(3002, "alive-different");
    writeLockFile(coordinatorLockPath(f), {
      version: 1,
      purpose: "coordinator",
      pid: 3002,
      startIdentity: "old-start",
      nonce: "old-nonce",
      acquiredAt: Date.now(),
    });
    const lock = await mustLock(f, probe);
    expect(lock.incarnation.lockNonce).not.toBe("old-nonce");
  });

  it("never takes over an indeterminate holder", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.verdicts.set(3003, "indeterminate");
    writeLockFile(coordinatorLockPath(f), {
      version: 1,
      purpose: "coordinator",
      pid: 3003,
      startIdentity: null,
      nonce: "old-nonce",
      acquiredAt: 1,
    });
    const before = readFileSync(coordinatorLockPath(f), "utf8");
    const result = await acquireMigrationCoordinatorLock({
      bootstrapDir: f.bootstrapDir,
      probe,
    });
    expect(result).toMatchObject({
      acquired: false,
      reason: "ambiguous",
      holder: { pid: 3003 },
    });
    expect(readFileSync(coordinatorLockPath(f), "utf8")).toBe(before);
  });

  it("never takes over corrupt lock bytes, however old", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    writeFileSync(coordinatorLockPath(f), "garbage{");
    utimesSync(coordinatorLockPath(f), 1, 1);
    const result = await acquireMigrationCoordinatorLock({
      bootstrapDir: f.bootstrapDir,
      probe,
    });
    expect(result).toEqual({
      acquired: false,
      reason: "corrupt",
      holder: null,
    });
    expect(readFileSync(coordinatorLockPath(f), "utf8")).toBe("garbage{");
  });

  it("reports identity-unavailable when this process cannot read its own start identity", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    probe.own = null;
    const result = await acquireMigrationCoordinatorLock({
      bootstrapDir: f.bootstrapDir,
      probe,
    });
    expect(result).toEqual({
      acquired: false,
      reason: "identity-unavailable",
      holder: null,
    });
    expect(existsSync(coordinatorLockPath(f))).toBe(false);
  });

  it("assertHeld throws once another holder replaced the lock", async () => {
    const f = makeFixture();
    const lock = await mustLock(f, new FakeProbe());
    writeLockFile(coordinatorLockPath(f), {
      version: 1,
      purpose: "coordinator",
      pid: 3004,
      startIdentity: "x",
      nonce: "someone-else",
      acquiredAt: Date.now(),
    });
    expect(
      await admissionErrorCode(Promise.resolve().then(() => lock.assertHeld())),
    ).toBe("coordinator-not-held");
    // Releasing a lock it no longer owns removes nothing.
    await lock.release();
    expect(existsSync(coordinatorLockPath(f))).toBe(true);
  });
});

describe("withAdmissionMutex", () => {
  function mutexPath(fixture: Fixture): string {
    return join(fixture.bootstrapDir, ADMISSION_MUTEX_FILENAME);
  }

  function writeMutex(fixture: Fixture, pid: number, acquiredAt: number): void {
    writeLockFile(mutexPath(fixture), {
      version: 1,
      purpose: "admission",
      pid,
      startIdentity: null,
      nonce: "other-holder",
      acquiredAt,
    });
  }

  it("runs the function, returns its value and removes the lock", async () => {
    const f = makeFixture();
    const value = await withAdmissionMutex({
      bootstrapDir: f.bootstrapDir,
      probe: new FakeProbe(),
      waitMs: 100,
      fn: () => {
        expect(existsSync(mutexPath(f))).toBe(true);
        return Promise.resolve("done");
      },
    });
    expect(value).toBe("done");
    expect(existsSync(mutexPath(f))).toBe(false);
  });

  it("releases when the function throws", async () => {
    const f = makeFixture();
    await expect(
      withAdmissionMutex({
        bootstrapDir: f.bootstrapDir,
        probe: new FakeProbe(),
        waitMs: 100,
        fn: () => Promise.reject(new Error("boom")),
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(mutexPath(f))).toBe(false);
  });

  it("overtakes a holder whose pid is dead", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.livenesses.set(4001, "dead");
    writeMutex(f, 4001, Date.now());
    const value = await withAdmissionMutex({
      bootstrapDir: f.bootstrapDir,
      probe,
      waitMs: 1_000,
      fn: () => Promise.resolve("ran"),
    });
    expect(value).toBe("ran");
    expect(existsSync(mutexPath(f))).toBe(false);
  });

  it("overtakes a live holder older than the maximum hold time", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.livenesses.set(4002, "alive");
    writeMutex(f, 4002, Date.now() - ADMISSION_MUTEX_MAX_HOLD_MS - 1_000);
    const value = await withAdmissionMutex({
      bootstrapDir: f.bootstrapDir,
      probe,
      waitMs: 1_000,
      fn: () => Promise.resolve("ran"),
    });
    expect(value).toBe("ran");
  });

  it("times out with admission-busy behind a live, fresh holder", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.livenesses.set(4003, "alive");
    writeMutex(f, 4003, Date.now());
    const before = readFileSync(mutexPath(f), "utf8");
    let ran = false;
    const code = await admissionErrorCode(
      withAdmissionMutex({
        bootstrapDir: f.bootstrapDir,
        probe,
        waitMs: 100,
        fn: () => {
          ran = true;
          return Promise.resolve(null);
        },
      }),
    );
    expect(code).toBe("admission-busy");
    expect(ran).toBe(false);
    expect(readFileSync(mutexPath(f), "utf8")).toBe(before);
  });

  it("an indeterminate fresh holder is waited out, not overtaken", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.livenesses.set(4004, "indeterminate");
    writeMutex(f, 4004, Date.now());
    const code = await admissionErrorCode(
      withAdmissionMutex({
        bootstrapDir: f.bootstrapDir,
        probe,
        waitMs: 100,
        fn: () => Promise.resolve(null),
      }),
    );
    expect(code).toBe("admission-busy");
  });
});

describe("journal changes", () => {
  it("beginMigrationJournal writes the planned journal and selects it", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const lock = await mustLock(f, probe);
    const journal = journalFor(f, lock);
    await beginMigrationJournal({
      bootstrapDir: f.bootstrapDir,
      coordinator: lock,
      journal,
    });
    expect(
      JSON.parse(
        readFileSync(
          join(f.bootstrapDir, `migration-${journal.id}.json`),
          "utf8",
        ),
      ),
    ).toMatchObject({
      body: { id: journal.id, phase: "planned", revision: 1 },
    });
    expect(
      JSON.parse(readFileSync(join(f.bootstrapDir, "migration.json"), "utf8")),
    ).toMatchObject({
      body: { revision: 1, activeMigrationId: journal.id },
    });
  });

  it("is refused while another transaction is active and not terminal", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const lock = await mustLock(f, probe);
    const first = journalFor(f, lock);
    await beginMigrationJournal({
      bootstrapDir: f.bootstrapDir,
      coordinator: lock,
      journal: first,
    });
    const second = journalFor(f, lock);
    expect(
      await admissionErrorCode(
        beginMigrationJournal({
          bootstrapDir: f.bootstrapDir,
          coordinator: lock,
          journal: second,
        }),
      ),
    ).toBe("migration-active");
    expect(
      existsSync(join(f.bootstrapDir, `migration-${second.id}.json`)),
    ).toBe(false);
    // Still refused mid-transaction, in a barrier phase.
    await step(f, lock, probe, first, "quiescing");
    expect(
      await admissionErrorCode(
        beginMigrationJournal({
          bootstrapDir: f.bootstrapDir,
          coordinator: lock,
          journal: second,
        }),
      ),
    ).toBe("migration-active");
  });

  it("is allowed after the previous transaction rolled back", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const lock = await mustLock(f, probe);
    const first = journalFor(f, lock);
    await beginMigrationJournal({
      bootstrapDir: f.bootstrapDir,
      coordinator: lock,
      journal: first,
    });
    await step(f, lock, probe, first, "rolled-back");
    const second = journalFor(f, lock);
    await beginMigrationJournal({
      bootstrapDir: f.bootstrapDir,
      coordinator: lock,
      journal: second,
    });
    expect(
      JSON.parse(readFileSync(join(f.bootstrapDir, "migration.json"), "utf8")),
    ).toMatchObject({
      body: { revision: 2, activeMigrationId: second.id },
    });
    // The first journal is kept as history.
    expect(existsSync(join(f.bootstrapDir, `migration-${first.id}.json`))).toBe(
      true,
    );
  });

  it("is allowed after the previous transaction completed", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const lock = await mustLock(f, probe);
    let current = journalFor(f, lock);
    await beginMigrationJournal({
      bootstrapDir: f.bootstrapDir,
      coordinator: lock,
      journal: current,
    });
    for (const phase of [
      "quiescing",
      "copying",
      "repairing",
      "preparing-external",
      "ready",
      "switching",
      "switched",
      "activated",
      "complete",
    ] as const) {
      current = await step(f, lock, probe, current, phase);
    }
    const next = journalFor(f, lock);
    await beginMigrationJournal({
      bootstrapDir: f.bootstrapDir,
      coordinator: lock,
      journal: next,
    });
    expect(
      JSON.parse(readFileSync(join(f.bootstrapDir, "migration.json"), "utf8")),
    ).toMatchObject({
      body: { activeMigrationId: next.id },
    });
  });

  it("requires the journal to name the lock's incarnation", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const lock = await mustLock(f, probe);
    const journal = journalFor(f, lock);
    const foreign: MigrationJournal = {
      ...journal,
      coordinator: { pid: 5555, startIdentity: "x", lockNonce: "not-ours" },
    };
    expect(
      await admissionErrorCode(
        beginMigrationJournal({
          bootstrapDir: f.bootstrapDir,
          coordinator: lock,
          journal: foreign,
        }),
      ),
    ).toBe("coordinator-not-held");
    expect(existsSync(join(f.bootstrapDir, "migration.json"))).toBe(false);
    await beginMigrationJournal({
      bootstrapDir: f.bootstrapDir,
      coordinator: lock,
      journal,
    });
    const next: MigrationJournal = {
      ...successor(journal, "quiescing"),
      coordinator: foreign.coordinator,
    };
    expect(
      await admissionErrorCode(
        advanceMigrationJournal({
          bootstrapDir: f.bootstrapDir,
          coordinator: lock,
          probe,
          expected: journal,
          next,
        }),
      ),
    ).toBe("coordinator-not-held");
  });

  it("refuses to change anything once the lock is no longer held", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const lock = await mustLock(f, probe);
    const journal = journalFor(f, lock);
    await lock.release();
    expect(
      await admissionErrorCode(
        beginMigrationJournal({
          bootstrapDir: f.bootstrapDir,
          coordinator: lock,
          journal,
        }),
      ),
    ).toBe("coordinator-not-held");
    expect(existsSync(join(f.bootstrapDir, "migration.json"))).toBe(false);
  });

  it("refuses to begin over a damaged selector", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const lock = await mustLock(f, probe);
    writeFileSync(join(f.bootstrapDir, "migration.json"), "{");
    expect(
      await admissionErrorCode(
        beginMigrationJournal({
          bootstrapDir: f.bootstrapDir,
          coordinator: lock,
          journal: journalFor(f, lock),
        }),
      ),
    ).toBe("record-damaged");
  });

  it("advanceMigrationJournal refuses a journal that is not the active one", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const lock = await mustLock(f, probe);
    const active = journalFor(f, lock);
    await beginMigrationJournal({
      bootstrapDir: f.bootstrapDir,
      coordinator: lock,
      journal: active,
    });
    const other = journalFor(f, lock);
    expect(
      await admissionErrorCode(
        advanceMigrationJournal({
          bootstrapDir: f.bootstrapDir,
          coordinator: lock,
          probe,
          expected: other,
          next: successor(other, "quiescing"),
        }),
      ),
    ).toBe("migration-active");
  });

  it("advanceMigrationJournal into a barrier phase is what a later admission is refused by", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const lock = await mustLock(f, probe);
    const planned = journalFor(f, lock);
    await beginMigrationJournal({
      bootstrapDir: f.bootstrapDir,
      coordinator: lock,
      journal: planned,
    });
    // Planned holds no barrier: a process can still be admitted.
    const early = await mustAdmit(f, probe, 1_000);
    await early.release();
    await step(f, lock, probe, planned, "quiescing");
    expect((await admit(f, probe, 1_000)).kind).toBe("refused");
  });
});

describe("authorizeMaintenanceRequest", () => {
  async function setup(
    fixture: Fixture,
    probe: FakeProbe,
  ): Promise<{
    lock: MigrationCoordinatorLock;
    journal: MigrationJournal;
  }> {
    const lock = await mustLock(fixture, probe);
    const journal = journalFor(fixture, lock);
    await beginMigrationJournal({
      bootstrapDir: fixture.bootstrapDir,
      coordinator: lock,
      journal,
    });
    return { lock, journal };
  }

  function request(
    lock: MigrationCoordinatorLock,
    journal: MigrationJournal,
    operation: MaintenanceRequest["operation"],
  ): MaintenanceRequest {
    return {
      version: 1,
      migrationId: journal.id,
      journalRevision: journal.revision,
      operation,
      inventoryDigest: null,
      authorization: lock.incarnation,
    };
  }

  it("authorizes the live holder's inventory in planned as provisional", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const { lock, journal } = await setup(f, probe);
    const result = await authorizeMaintenanceRequest({
      bootstrapDir: f.bootstrapDir,
      request: request(lock, journal, "inventory"),
      probe,
    });
    expect(result).toMatchObject({
      ok: true,
      provisional: true,
      journal: { id: journal.id, revision: 1 },
    });
  });

  it("authorizes phase-permitted operations at the current revision", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const { lock, journal } = await setup(f, probe);
    const quiescing = await step(f, lock, probe, journal, "quiescing");
    const inventory = await authorizeMaintenanceRequest({
      bootstrapDir: f.bootstrapDir,
      request: request(lock, quiescing, "inventory"),
      probe,
    });
    expect(inventory).toMatchObject({ ok: true, provisional: false });
    const verify = await authorizeMaintenanceRequest({
      bootstrapDir: f.bootstrapDir,
      request: request(lock, quiescing, "verify-quiesced-source"),
      probe,
    });
    expect(verify).toMatchObject({ ok: true, provisional: false });
  });

  it("denies an operation the phase does not permit", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const { lock, journal } = await setup(f, probe);
    const result = await authorizeMaintenanceRequest({
      bootstrapDir: f.bootstrapDir,
      request: request(lock, journal, "repair-copy"),
      probe,
    });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain(
      "repair-copy is not permitted in phase planned",
    );
  });

  it("denies a wrong nonce, pid or identity", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const { lock, journal } = await setup(f, probe);
    for (const authorization of [
      { ...lock.incarnation, lockNonce: "wrong" },
      { ...lock.incarnation, pid: lock.incarnation.pid + 1 },
      { ...lock.incarnation, startIdentity: "other-start" },
    ]) {
      const result = await authorizeMaintenanceRequest({
        bootstrapDir: f.bootstrapDir,
        request: { ...request(lock, journal, "inventory"), authorization },
        probe,
      });
      expect(result).toMatchObject({ ok: false });
      if (result.ok) throw new Error("unreachable");
      expect(result.message).toContain(
        "does not name the migration lock's holder",
      );
    }
  });

  it("denies a stale journal revision", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const { lock, journal } = await setup(f, probe);
    await step(f, lock, probe, journal, "quiescing");
    const result = await authorizeMaintenanceRequest({
      bootstrapDir: f.bootstrapDir,
      request: request(lock, journal, "inventory"),
      probe,
    });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("stale journal revision");
  });

  it("denies when the coordinator is not alive-same", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const { lock, journal } = await setup(f, probe);
    for (const verdict of [
      "dead",
      "alive-different",
      "indeterminate",
    ] as const) {
      probe.verdicts.set(process.pid, verdict);
      const result = await authorizeMaintenanceRequest({
        bootstrapDir: f.bootstrapDir,
        request: request(lock, journal, "inventory"),
        probe,
      });
      expect(result, verdict).toMatchObject({ ok: false });
      if (result.ok) throw new Error("unreachable");
      expect(result.message).toContain("coordinator is not running");
    }
  });

  it("denies another migration id and a missing lock", async () => {
    const f = makeFixture();
    const probe = new FakeProbe();
    const { lock, journal } = await setup(f, probe);
    const other = await authorizeMaintenanceRequest({
      bootstrapDir: f.bootstrapDir,
      request: {
        ...request(lock, journal, "inventory"),
        migrationId: newMigrationId(),
      },
      probe,
    });
    expect(other).toMatchObject({ ok: false });
    if (other.ok) throw new Error("unreachable");
    expect(other.message).toContain("does not name the active migration");

    await lock.release();
    const noLock = await authorizeMaintenanceRequest({
      bootstrapDir: f.bootstrapDir,
      request: request(lock, journal, "inventory"),
      probe,
    });
    expect(noLock).toMatchObject({ ok: false });
    if (noLock.ok) throw new Error("unreachable");
    expect(noLock.message).toContain(
      "does not name the migration lock's holder",
    );
  });
});

describe("fixup regressions", () => {
  it("a stale holder whose removal is contended yields a bounded admission-busy, not a hang", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.livenesses.set(6001, "alive");
    const mutex = join(f.bootstrapDir, ADMISSION_MUTEX_FILENAME);
    writeLockFile(mutex, {
      version: 1,
      purpose: "admission",
      pid: 6001,
      startIdentity: null,
      nonce: "stuck-holder",
      // Old enough to be overtakable by age.
      acquiredAt: Date.now() - ADMISSION_MUTEX_MAX_HOLD_MS - 5_000,
    });
    const before = readFileSync(mutex, "utf8");
    breakStaleLockControl.contended = true;
    const startedAt = Date.now();
    let ran = false;
    const code = await admissionErrorCode(
      withAdmissionMutex({
        bootstrapDir: f.bootstrapDir,
        probe,
        waitMs: 200,
        fn: () => {
          ran = true;
          return Promise.resolve(null);
        },
      }),
    );
    const elapsedMs = Date.now() - startedAt;
    expect(code).toBe("admission-busy");
    expect(ran).toBe(false);
    // Waited out its budget by polling rather than spinning or giving up early.
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(readFileSync(mutex, "utf8")).toBe(before);
  }, 10_000);

  it("a contended removal does not block a later clean takeover", async () => {
    const f = bootstrapFixture();
    const probe = new FakeProbe();
    probe.livenesses.set(6002, "dead");
    writeLockFile(join(f.bootstrapDir, ADMISSION_MUTEX_FILENAME), {
      version: 1,
      purpose: "admission",
      pid: 6002,
      startIdentity: null,
      nonce: "dead-holder",
      acquiredAt: Date.now(),
    });
    breakStaleLockControl.contended = false;
    const value = await withAdmissionMutex({
      bootstrapDir: f.bootstrapDir,
      probe,
      waitMs: 1_000,
      fn: () => Promise.resolve("ran"),
    });
    expect(value).toBe("ran");
  });

  it("the admission carries the gate input it was admitted under", async () => {
    const f = makeFixture();
    const processResolution = resolveDataRoot(f.homeDir, "posix");
    const admission = await mustAdmit(f, new FakeProbe(), 1_000);
    expect(admission.gateInput).toEqual({
      homeDir: f.homeDir,
      platform: "posix",
      processResolution,
    });
  });
});
