import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { withUpdateContender } from "@traycer-clients/shared/host-update";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import type { SupervisorRecord } from "@traycer/protocol/config/supervisor-record";

// HOME is redirected to a private temp dir BEFORE anything reads it: this
// file's own `store/paths` mock below only replaces `hostHomeDir` - it is
// NOT isolation on its own, because `createCliLogger` (through
// `store/paths.ts`'s `cliLogPath`) and the protocol path helpers still
// resolve `homedir()` for real. `node:os.homedir()` itself must be
// redirected first.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(
        actual.tmpdir(),
        "traycer-update-mutation-supervisor-relaunch-test-home-",
      ),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

beforeAll(async () => {
  expect(osHome.current).not.toBe("");
  expect(homedir()).toBe(osHome.current);
  const paths =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  expect(paths.hostHomeDir("production").startsWith(osHome.current)).toBe(true);
  expect(paths.cliLogPath("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

// `startHostServiceWithAttempt` (host/update-mutation.ts) is the one place
// every service start passes through - the fix for the crash-relaunch race with `host ensure`.
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
    startIdentity: null,
    admittedAs: null,
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
    "start" | "status" | "hostStartAdoptionLabel"
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
      // Read only after a start whose proof no supervisor acknowledged, and
      // no start here reaches the spawn edge that would publish one.
      status: async () => {
        throw new Error("status is not read by these rows");
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
  controller: Pick<
    ServiceController,
    "start" | "status" | "hostStartAdoptionLabel"
  >,
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

describe("startHostServiceWithAttempt - the crash-relaunch race with `host ensure`", () => {
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

  // The facade's half of "a parked supervisor never gates a start": with no
  // record on disk this start is not gated, and it goes through the adoption
  // proof (`hostStartAdoptionLabel` is `runWithHostStartAdoption`'s first
  // call) before the manager's start. That a parked supervisor never writes a
  // record is decided in `host start`, before `publishSupervisorRecords`, and
  // is pinned there: `host-start.test.ts`, "supervisor.json lifecycle across
  // outcomes" > "is never written when the lifecycle policy parks the start".
  // No supervisor parks here - this row used to claim one did.
  it("with no supervisor record on disk, the start is not gated: it publishes its adoption proof and starts", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const { controller, calls } = fakeController();

    const outcome = await runFacade(hostHomeDir, controller);

    expect(outcome).toEqual({ kind: "ran", result: { kind: "started" } });
    expect(calls.start).toBe(1);
    expect(calls.hostStartAdoptionLabel).toBe(1);
  });
});
