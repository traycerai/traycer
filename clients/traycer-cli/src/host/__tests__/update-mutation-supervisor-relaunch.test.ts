import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withUpdateContender } from "@traycer-clients/shared/host-update";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import type { SupervisorRecord } from "@traycer/protocol/config/supervisor-record";

// `startHostServiceWithAttempt` (host/update-mutation.ts) is the one place
// every service start passes through - the fix for CRASH-RELAUNCH-ENSURE-RACE.
// Before doing anything, it asks whether the service's OWN supervisor
// (admission granted/unattended) is alive; if so it returns
// `supervisor-relaunching` and touches NOTHING - no adoption proof, no
// `controller.start` call - because the manager would start nothing for a
// service that IS running and the pending proof used to make the supervisor
// refuse its own relaunches.

const homeRef = vi.hoisted(() => ({ current: "" }));
vi.mock("../../store/paths", () => ({
  hostHomeDir: () => homeRef.current,
}));

import { readProcessStartIdentity } from "../../store/process-identity";
import {
  writeSupervisorRecords,
  type SupervisorRunState,
} from "../lifecycle-files";
import { startHostServiceWithAttempt } from "../update-mutation";
import type { ServiceController, ServiceLabel } from "../../service";

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), "update-mutation-supervisor-relaunch-test-"),
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

function sampleSupervisorRecord(pid: number): SupervisorRecord {
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
    record: sampleSupervisorRecord(pid),
    runState: sampleRunState(pid, admission, identity),
  });
}

const label: ServiceLabel = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production",
  devSlot: null,
};

const contenderOptions = {
  environment: "production" as const,
  reason: "supervisor-relaunch-facade-test",
  waitMs: 0,
  pollIntervalMs: 10,
  admission: "service-maintenance" as const,
};

interface FakeControllerCalls {
  readonly start: number;
  readonly hostStartAdoptionLabel: number;
}

function fakeController(): {
  readonly controller: Pick<
    ServiceController,
    "start" | "hostStartAdoptionLabel"
  >;
  readonly calls: FakeControllerCalls;
} {
  const calls: { start: number; hostStartAdoptionLabel: number } = {
    start: 0,
    hostStartAdoptionLabel: 0,
  };
  return {
    controller: {
      start: async () => {
        calls.start += 1;
        // Deliberately never calls `atServiceSpawnEdge()` - matching every
        // other suite's fake controller in this package (provision.test.ts,
        // service-start.test.ts): a fake spawn edge would make the REAL
        // `publishHostStartAdoption` wait for an acknowledgement nobody ever
        // sends. Not calling it keeps `publishHostStartAdoption` real but
        // inert for the control rows, while still proving the facade never
        // even reaches `controller.start` for the live-supervisor row.
      },
      hostStartAdoptionLabel: async () => {
        calls.hostStartAdoptionLabel += 1;
        return "ai.traycer.host.agent";
      },
    },
    calls,
  };
}

async function runFacade(
  hostHomeDir: string,
  controller: Pick<ServiceController, "start" | "hostStartAdoptionLabel">,
) {
  return withUpdateContender(
    {
      hostHomeDir,
      reason: contenderOptions.reason,
      waitMs: 0,
      pollIntervalMs: 10,
      admission: contenderOptions.admission,
    },
    (capability) =>
      startHostServiceWithAttempt(
        capability,
        contenderOptions,
        "terminal",
        controller,
        label,
      ),
  );
}

describe("startHostServiceWithAttempt - CRASH-RELAUNCH-ENSURE-RACE", () => {
  it("returns supervisor-relaunching and touches nothing when the service's own supervisor is alive", async () => {
    const hostHomeDir = await freshHome();
    const identity = readProcessStartIdentity(process.pid);
    await writePairedRecords(hostHomeDir, process.pid, "granted", identity);
    const { controller, calls } = fakeController();

    const outcome = await runFacade(hostHomeDir, controller);

    expect(outcome).toEqual({
      kind: "ran",
      result: { kind: "supervisor-relaunching", supervisorPid: process.pid },
    });
    expect(calls.start).toBe(0);
    // `hostStartAdoptionLabel` is the first thing `runWithHostStartAdoption`
    // calls, before any spawn edge - a zero count here proves the facade
    // never even entered that function, not merely that the edge was never
    // reached.
    expect(calls.hostStartAdoptionLabel).toBe(0);
  });

  it("takes today's path when the recorded supervisor pid is dead (stale record)", async () => {
    const hostHomeDir = await freshHome();
    // A pid essentially guaranteed to be unassigned on any test runner.
    const deadPid = 999_999;
    await writePairedRecords(hostHomeDir, deadPid, "granted", "linux:boot 1");
    const { controller, calls } = fakeController();

    const outcome = await runFacade(hostHomeDir, controller);

    expect(outcome).toEqual({ kind: "ran", result: { kind: "started" } });
    expect(calls.start).toBe(1);
  });

  it("takes today's path when the recorded identity does not match the live process (mismatch)", async () => {
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
      `${own}-mismatch`,
    );
    const { controller, calls } = fakeController();

    const outcome = await runFacade(hostHomeDir, controller);

    expect(outcome).toEqual({ kind: "ran", result: { kind: "started" } });
    expect(calls.start).toBe(1);
  });

  // A post-swap start (the CLI's own restart, `host update`'s relaunch leg,
  // `cli finalize-upgrade`'s hand-back) runs after the OLD supervisor's
  // teardown removed its records - so this start finds nothing and behaves
  // exactly as it did before this finding existed.
  it("a post-swap start (update/restart/finalize) finds no record - the old supervisor removed it - and takes today's path", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const { controller, calls } = fakeController();

    const outcome = await runFacade(hostHomeDir, controller);

    expect(outcome).toEqual({ kind: "ran", result: { kind: "started" } });
    expect(calls.start).toBe(1);
  });

  // A parked supervisor is one that exits (per the lifecycle policy) before
  // it ever reaches admission - so it never wrote `supervisor.json` /
  // `supervisor-run.json` in the first place. This is mechanically the same
  // "no record" shape as the post-swap row above, named separately because
  // it is the specific case `--defer-if-parked` starts must be untouched by:
  // nothing here can gate on a record that was never written.
  it("a parked supervisor exits before admission and writes no record, so --defer-if-parked starts are untouched", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const { controller, calls } = fakeController();

    const outcome = await runFacade(hostHomeDir, controller);

    expect(outcome).toEqual({ kind: "ran", result: { kind: "started" } });
    expect(calls.start).toBe(1);
    expect(calls.hostStartAdoptionLabel).toBe(1);
  });
});
