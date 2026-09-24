import { spawn } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  serializeSupervisorRecord,
  supervisorRecordPath,
  type SupervisorRecord,
} from "@traycer/protocol/config/supervisor-record";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";

// `readLiveSupervisorRun` (host/live-supervisor-run.ts, NEW for
// CRASH-RELAUNCH-ENSURE-RACE) is the one reader that answers "is a
// supervisor alive here, and how was it admitted?" - every doubt reads as
// `null`. These tests use REAL processes for identity (this test process
// itself for "alive", a spawned-then-killed child for "dead") and real
// on-disk records, never a stub of the identity verdict - the finding is
// specifically about that verdict's plumbing.

const homeRef = vi.hoisted(() => ({ current: "" }));
vi.mock("../../store/paths", () => ({
  hostHomeDir: () => homeRef.current,
}));

import { readProcessStartIdentity } from "../../store/process-identity";
import {
  writeSupervisorRecords,
  supervisorRunStatePath,
  type SupervisorRunState,
} from "../lifecycle-files";
import { readLiveSupervisorRun } from "../live-supervisor-run";

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "live-supervisor-run-test-"));
  roots.push(root);
  return join(root, "host-home");
}

afterEach(async () => {
  homeRef.current = "";
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function sampleRecord(pid: number): SupervisorRecord {
  return {
    v: 1,
    pid,
    cliVersion: "1.0.0",
    capabilities: [],
    startedAt: new Date().toISOString(),
  };
}

function sampleRunState(
  pid: number,
  admission: SupervisorRunState["admission"],
  identity: ProcessStartIdentity | null,
): SupervisorRunState {
  return {
    v: 1,
    supervisorPid: pid,
    supervisorStartIdentity: identity,
    admission,
    origin: null,
    adopted: false,
    lastPresence: null,
    updatedAt: new Date().toISOString(),
  };
}

/** Writes both records the way the product does, naming the same pid. */
async function writePairedRecords(
  hostHomeDir: string,
  pid: number,
  admission: SupervisorRunState["admission"],
  identity: ProcessStartIdentity | null,
): Promise<void> {
  homeRef.current = hostHomeDir;
  await writeSupervisorRecords("production", {
    record: sampleRecord(pid),
    runState: sampleRunState(pid, admission, identity),
  });
}

/** A validly-formatted identity token that does not match any real process. */
function mismatchedIdentity(own: ProcessStartIdentity): ProcessStartIdentity {
  return `${own}-mismatch`;
}

async function spawnAndKillChild(): Promise<{
  readonly pid: number;
  readonly identity: ProcessStartIdentity | null;
}> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await new Promise<void>((resolvePid, reject) => {
    child.once("spawn", () => resolvePid());
    child.once("error", reject);
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("child did not report a pid");
  const identity = readProcessStartIdentity(pid);
  await new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
    child.kill("SIGKILL");
  });
  return { pid, identity };
}

describe("readLiveSupervisorRun", () => {
  it("finds a live run when both records name the same alive pid with matching identity (admission: granted)", async () => {
    const hostHomeDir = await freshHome();
    const identity = readProcessStartIdentity(process.pid);
    await writePairedRecords(hostHomeDir, process.pid, "granted", identity);

    const result = await readLiveSupervisorRun("production");

    expect(result).toEqual({
      supervisorPid: process.pid,
      admission: "granted",
    });
  });

  it("finds a live run for admission: unattended too", async () => {
    const hostHomeDir = await freshHome();
    const identity = readProcessStartIdentity(process.pid);
    await writePairedRecords(hostHomeDir, process.pid, "unattended", identity);

    const result = await readLiveSupervisorRun("production");

    expect(result).toEqual({
      supervisorPid: process.pid,
      admission: "unattended",
    });
  });

  it("finds a live run for admission: foreground too - readLiveSupervisorRun does not filter by admission", async () => {
    const hostHomeDir = await freshHome();
    const identity = readProcessStartIdentity(process.pid);
    await writePairedRecords(hostHomeDir, process.pid, "foreground", identity);

    const result = await readLiveSupervisorRun("production");

    expect(result).toEqual({
      supervisorPid: process.pid,
      admission: "foreground",
    });
  });

  it("returns null for a dead pid", async () => {
    const hostHomeDir = await freshHome();
    const dead = await spawnAndKillChild();

    await writePairedRecords(hostHomeDir, dead.pid, "granted", dead.identity);

    expect(await readLiveSupervisorRun("production")).toBeNull();
  });

  it("returns null when the recorded identity does not match the live process (mismatch)", async () => {
    const hostHomeDir = await freshHome();
    const own = readProcessStartIdentity(process.pid);
    if (own === null) {
      throw new Error(
        "this platform's identity probe returned null for own pid",
      );
    }

    await writePairedRecords(
      hostHomeDir,
      process.pid,
      "granted",
      mismatchedIdentity(own),
    );

    expect(await readLiveSupervisorRun("production")).toBeNull();
  });

  it("returns null when no start identity was recorded (null identity)", async () => {
    const hostHomeDir = await freshHome();

    await writePairedRecords(hostHomeDir, process.pid, "granted", null);

    expect(await readLiveSupervisorRun("production")).toBeNull();
  });

  it("returns null when supervisor-run.json exists but supervisor.json does not (the 77/76 kept-run-state shape)", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const identity = readProcessStartIdentity(process.pid);
    // Write both the way the product does, then remove ONLY supervisor.json -
    // exactly what `removeSupervisorRecords(..., "keep-run-state")` leaves
    // behind for a restart-owed successor to continue from.
    await writeSupervisorRecords("production", {
      record: sampleRecord(process.pid),
      runState: sampleRunState(process.pid, "granted", identity),
    });
    await unlink(supervisorRecordPath(hostHomeDir));

    expect(await readLiveSupervisorRun("production")).toBeNull();
  });

  it("returns null when the two records name different pids", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const identity = readProcessStartIdentity(process.pid);
    // Write a consistent pair for our own pid, then overwrite supervisor.json
    // alone with a DIFFERENT pid - the exact pairing readHostLifecycleSnapshot
    // (and this reader) key off.
    await writeSupervisorRecords("production", {
      record: sampleRecord(process.pid),
      runState: sampleRunState(process.pid, "granted", identity),
    });
    const otherPid = process.pid + 1;
    await writeFile(
      supervisorRecordPath(hostHomeDir),
      serializeSupervisorRecord(sampleRecord(otherPid)),
      "utf8",
    );

    expect(await readLiveSupervisorRun("production")).toBeNull();
  });

  it("returns null when neither record exists", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;

    expect(await readLiveSupervisorRun("production")).toBeNull();
  });

  it("returns null when supervisor-run.json's own path is written but is not valid JSON (invalid record, not a pairing failure)", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    await writeSupervisorRecords("production", {
      record: sampleRecord(process.pid),
      runState: sampleRunState(
        process.pid,
        "granted",
        readProcessStartIdentity(process.pid),
      ),
    });
    await writeFile(supervisorRunStatePath("production"), "not-json", "utf8");

    expect(await readLiveSupervisorRun("production")).toBeNull();
  });
});
