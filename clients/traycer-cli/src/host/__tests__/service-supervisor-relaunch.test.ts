import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import type { SupervisorRecord } from "@traycer/protocol/config/supervisor-record";

// `findLiveServiceSupervisor` (host/service-supervisor-relaunch.ts, NEW for
// CRASH-RELAUNCH-ENSURE-RACE) narrows `readLiveSupervisorRun` to "the
// SERVICE's own supervisor" - an admission of `granted` or `unattended`. A
// `foreground` run (`traycer host start` by hand) is a different question
// and must take the ordinary path, which is the one control this suite
// exists to pin (R2 in the ablation table).

const homeRef = vi.hoisted(() => ({ current: "" }));
vi.mock("../../store/paths", () => ({
  hostHomeDir: () => homeRef.current,
}));

import { readProcessStartIdentity } from "../../store/process-identity";
import {
  writeSupervisorRecords,
  type SupervisorRunState,
} from "../lifecycle-files";
import { readLiveSupervisorRun } from "../live-supervisor-run";
import { findLiveServiceSupervisor } from "../service-supervisor-relaunch";

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), "service-supervisor-relaunch-test-"),
  );
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

describe("findLiveServiceSupervisor", () => {
  it("finds the supervisor when admission is granted", async () => {
    const hostHomeDir = await freshHome();
    const identity = readProcessStartIdentity(process.pid);
    await writePairedRecords(hostHomeDir, process.pid, "granted", identity);

    expect(await findLiveServiceSupervisor("production")).toEqual({
      supervisorPid: process.pid,
    });
  });

  it("finds the supervisor when admission is unattended", async () => {
    const hostHomeDir = await freshHome();
    const identity = readProcessStartIdentity(process.pid);
    await writePairedRecords(hostHomeDir, process.pid, "unattended", identity);

    expect(await findLiveServiceSupervisor("production")).toEqual({
      supervisorPid: process.pid,
    });
  });

  // R2: dropping the `=== "foreground"` check in `findLiveServiceRelaunch`
  // would make this row `{ supervisorPid: process.pid }` instead of `null`,
  // even though `readLiveSupervisorRun` genuinely found a live run - the two
  // assertions in one test pin exactly that distinction, not merely "returns
  // null for some reason".
  it("returns null for a foreground admission even though readLiveSupervisorRun still finds it", async () => {
    const hostHomeDir = await freshHome();
    const identity = readProcessStartIdentity(process.pid);
    await writePairedRecords(hostHomeDir, process.pid, "foreground", identity);

    expect(await readLiveSupervisorRun("production")).toEqual({
      supervisorPid: process.pid,
      admission: "foreground",
    });
    expect(await findLiveServiceSupervisor("production")).toBeNull();
  });

  it("returns null when no record exists - a parked supervisor exits before admission and writes no record", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;

    expect(await findLiveServiceSupervisor("production")).toBeNull();
  });
});
