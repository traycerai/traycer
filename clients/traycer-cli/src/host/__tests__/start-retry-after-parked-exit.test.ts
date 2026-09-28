import { rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
import type {
  HostLifecyclePolicy,
  HostLifecycleMode,
} from "@traycer/protocol/config/host-lifecycle-policy";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import type { SupervisorRecord } from "@traycer/protocol/config/supervisor-record";

// `admitSupervisorLifecycle`
// (`lifecycle-admission.ts`) already re-consumes the adoption proof ONCE
// more right before it parks (a later fix), so a proof published BEFORE that
// late consume is never lost. But a proof published AFTER it - in the window
// between the late consume and the parking supervisor's own `exitSupervisor
// (0)` - still is:
//
//   1. the gate's late consume finds the proof file absent and decides park;
//   2. an explicit starter's `startHostServiceWithAttempt` publishes ITS OWN
//      proof (`atServiceSpawnEdge` inside `controller.start`) and asks its
//      service manager to start the service;
//   3. the manager sees the (still-parking) supervisor's service as ACTIVE
//      and does nothing (`systemctl start` on an active unit, a plain
//      `kickstart`, `/Run` under IgnoreNew) - it has no way to know that
//      supervisor already decided to park;
//   4. the parking supervisor exits WITHOUT ever looking at the proof again
//      (it already made its one park decision);
//   5. nobody ever consumes the starter's proof, and its
//      `lease.waitForSpawn()` (`host-start-adoption.ts`,
//      `HOST_START_ADOPTION_ACK_WAIT_MS` = 50s) times out.
//
// The review's ruling: closed with a STARTER-SIDE retry. If the ack wait times out,
// the starter must look again before giving up:
//   - the service is genuinely running (another starter, or this same manager,
//     already got it up) - report `started` and stop, no second `start`;
//   - the service's own supervisor is now alive on record (someone else's
//     relaunch beat the retry to it) - report `supervisor-relaunching` and
//     stop, no second `start`;
//   - otherwise the service is genuinely stopped - ask the manager again with
//     a FRESH proof, which the newly launched supervisor consumes and
//     acknowledges.
// A failed status read during that check must never invent its own error: it
// must fall back to the ORIGINAL ack-timeout, not retry blindly and not
// surface "status read failed" instead.
//
// This file asserts THAT RULE, not what production currently does. Every row
// but the sanity check and control (a) is expected to fail until the retry is
// built.
//
// HOME is redirected to a private temp dir before anything reads it (in
// addition to `vitest.setup.ts`'s file-wide isolation) - the real
// `consumeHostStartAdoption`/`readHostStartAdoptionNonce` and the real outer
// update-attempt lock all resolve paths off `os.homedir()` at module load.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSync(
      join(actual.tmpdir(), "traycer-start-retry-after-parked-exit-test-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

// Test-only seam, NOT a production change: this overrides the imported
// BINDING our own test module sees, exactly like the `node:os` mock above -
// it never touches `spawn-edge-bounds.ts` on disk. Faking `Date`/`setTimeout`
// wholesale (`vi.useFakeTimers()`) was tried first and deadlocked: the real
// lock acquisition and `findLiveServiceSupervisor` this scenario also runs
// through use real `setTimeout`-based polling of their own
// (`cross-process-lock.ts`), which never fires while fake timers sit
// un-advanced - and advancing them only after the fact races the internal
// `waitForSpawn()` deadline computation, which can equally land before or
// after the advance. Shrinking the constant itself sidesteps both problems:
// every wait in this file runs on the REAL clock, just against a much
// smaller ack-wait budget, so ordering is whatever it would really be and
// nothing needs advancing.
const ACK_WAIT_MS_FOR_TEST = vi.hoisted(() => 300);
vi.mock("../../service/spawn-edge-bounds", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/spawn-edge-bounds")>();
  return { ...actual, HOST_START_ADOPTION_ACK_WAIT_MS: ACK_WAIT_MS_FOR_TEST };
});

// `status()` reporting "running" is not, by itself, evidence a host is
// positively serving - on Linux/Windows it is derived from pid metadata
// alone, and a dead host can leave that behind. The retry's "is this already
// satisfied?" check must ask `findLiveIncumbentHost` too, exactly as
// `commands/service-start.ts`'s own `isHostPositivelyServing` does. Mocked
// with a switchable flag, exactly as `commands/__tests__/service-start.test.ts`
// does, rather than standing up a real reachable endpoint.
const incumbent = vi.hoisted(() => ({ hostServing: false }));
vi.mock("../incumbent-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../incumbent-check")>()),
  findLiveIncumbentHost: async () =>
    incumbent.hostServing
      ? {
          pid: process.pid,
          version: "1.0.0",
          websocketUrl: "ws://127.0.0.1:1/rpc",
        }
      : null,
}));

import {
  admitSupervisorLifecycle,
  type SupervisorLifecycleGateDeps,
} from "../lifecycle-admission";
import {
  consumeHostStartAdoption,
  readHostStartAdoptionNonce,
} from "../host-start-adoption";
import {
  relaunchHostAfterRestartWithAttempt,
  startHostServiceWithAttempt,
} from "../update-mutation";
import { atServiceSpawnEdge } from "../../service/spawn-edge";
import { HOST_START_ADOPTION_ACK_WAIT_MS } from "../../service/spawn-edge-bounds";
import { hostHomeDir, hostPidMetadataPath } from "../../store/paths";
import { readProcessStartIdentity } from "../../store/process-identity";
import {
  writeSupervisorRecords,
  type SupervisorRunState,
} from "../lifecycle-files";
import { readHostPidMetadataEvidence } from "../pid-metadata";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import type { ServiceLabel, RestartStop } from "../../service";
import type { LifecycleRecordRead } from "../lifecycle-files";

beforeAll(() => {
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
  expect(HOST_START_ADOPTION_ACK_WAIT_MS).toBe(ACK_WAIT_MS_FOR_TEST);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

afterEach(async () => {
  incumbent.hostServing = false;
  await rm(hostHomeDir("production"), { recursive: true, force: true });
});

const ENVIRONMENT = "production" as const;
const LABEL: ServiceLabel = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production",
  devSlot: null,
};

function linkedPolicy(): LifecycleRecordRead<HostLifecyclePolicy> {
  const mode: HostLifecycleMode = "linked";
  return {
    kind: "valid",
    record: {
      v: 1,
      rev: 1,
      mode,
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: "cli",
    },
  };
}

/** The gate deps every supervisor instance (parking, or newly launched) in
 * this file shares: Linked mode, no desktop presence record, and the REAL
 * proof consumer against the isolated home. `probePresence` must never be
 * reached - `readPresence` is absent, so `presence` stays `null` and the
 * park rule never asks liveness. */
function gateDeps(): SupervisorLifecycleGateDeps {
  return {
    readPolicy: async () => linkedPolicy(),
    readPresence: async () => ({ kind: "absent" }),
    probePresence: async () => {
      throw new Error(
        "probePresence must not be called: readPresence is absent",
      );
    },
    consumeAdoption: (environment, serviceLabel, adoptionNonce) =>
      consumeHostStartAdoption(environment, serviceLabel, adoptionNonce),
    now: () => new Date().toISOString(),
  };
}

/** Runs the supervisor gate to completion with no adoption nonce of its own
 * (a routine service-manager relaunch, not an explicit nonce-bearing start) -
 * the shape that races an explicit starter's proof. */
async function runParkingSupervisor() {
  return admitSupervisorLifecycle(
    {
      environment: ENVIRONMENT,
      serviceLaunch: { serviceLabel: LABEL.id, adoptionNonce: null },
    },
    gateDeps(),
  );
}

const CONTENDER_OPTIONS = {
  environment: ENVIRONMENT,
  reason: "start-retry-after-parked-exit-test",
  waitMs: 0,
  pollIntervalMs: 10,
  admission: "service-maintenance" as const,
};

/** The facade's own outcome, once the real contender admitted the start. */
async function runStarter(controller: FakeController) {
  const admitted = await withUpdateContender(
    {
      hostHomeDir: hostHomeDir(ENVIRONMENT),
      reason: CONTENDER_OPTIONS.reason,
      waitMs: 0,
      pollIntervalMs: 10,
      admission: CONTENDER_OPTIONS.admission,
    },
    (capability) =>
      startHostServiceWithAttempt(
        capability,
        CONTENDER_OPTIONS,
        "terminal",
        controller,
        LABEL,
      ),
  );
  if (admitted.kind !== "ran") {
    throw new Error(`the contender did not admit the start: ${admitted.kind}`);
  }
  return admitted.result;
}

interface FakeStatus {
  readonly state: "running" | "stopped" | "externally-managed";
  readonly version: string;
  readonly listenUrl: null;
  readonly pid: null;
}

interface FakeController {
  status: () => Promise<FakeStatus>;
  start: () => Promise<void>;
  hostStartAdoptionLabel: (label: ServiceLabel) => Promise<string>;
}

interface FakeControllerHandle {
  readonly controller: FakeController;
  readonly calls: { start: number; status: number };
  readonly service: { active: boolean };
  /** Incremented every time a `start()` call's OWN fresh proof is consumed as
   * a grant and acknowledged by the fake new supervisor it runs - i.e. every
   * time a launch (not a no-op) genuinely succeeds end to end. */
  readonly grants: { count: number };
  /**
   * Resolves the instant a `start()` call has made its "already active"
   * no-op decision (the branch this whole race depends on). `publish`
   * (`atServiceSpawnEdge`) does real, un-fake-timer-affected async fs I/O
   * before that decision is reachable, so a caller that flips
   * `service.active` to `false` right after invoking `start()` - without
   * awaiting this - races ahead of the check itself: `service.active` would
   * already read `false` by the time the no-op branch runs, and `start()`
   * would take the "launch" branch instead, defeating the whole scenario
   * (this is exactly what the first, unsynchronized version of this file
   * did, and why it failed with `{ kind: "started" }` instead of a
   * rejection). Awaiting this signal before flipping `service.active` is
   * what makes "the manager already said no-op, and only THEN the parked
   * supervisor exits" a real, ordered fact rather than a coin flip.
   */
  readonly noOpDecided: Promise<void>;
}

/**
 * The OS service manager's-eye view: `start` publishes the real proof at the
 * real spawn edge, then behaves exactly as a manager would -
 * - service already ACTIVE (the parking supervisor hasn't exited yet):
 *   no-op, same as `systemctl start` on an active unit;
 * - service STOPPED (the parking supervisor already exited): "launches" -
 *   marks the service active and runs a fake NEW supervisor instance (the
 *   real gate again), which finds THIS call's own just-published proof,
 *   consumes it as a grant, and acknowledges the spawn.
 */
function fakeManagedController(): FakeControllerHandle {
  const calls = { start: 0, status: 0 };
  const service = { active: true };
  const grants = { count: 0 };
  let resolveNoOpDecided: () => void;
  const noOpDecided = new Promise<void>((resolve) => {
    resolveNoOpDecided = resolve;
  });
  return {
    controller: {
      status: async (): Promise<FakeStatus> => {
        calls.status += 1;
        return {
          state: service.active ? "running" : "stopped",
          version: "1.0.0",
          listenUrl: null,
          pid: null,
        };
      },
      start: async () => {
        calls.start += 1;
        await atServiceSpawnEdge();
        if (service.active) {
          // "already active" - the manager does nothing.
          resolveNoOpDecided();
          return;
        }
        service.active = true;
        // "launches" - a fake new supervisor consumes and acknowledges the
        // proof THIS call just published.
        const nonce = await readHostStartAdoptionNonce(ENVIRONMENT, LABEL.id);
        const gate = await admitSupervisorLifecycle(
          {
            environment: ENVIRONMENT,
            serviceLaunch: { serviceLabel: LABEL.id, adoptionNonce: nonce },
          },
          gateDeps(),
        );
        if (
          gate.kind === "run" &&
          gate.consumed !== null &&
          gate.consumed.kind === "grant"
        ) {
          grants.count += 1;
          await gate.consumed.grant.acknowledgeSpawn();
        }
      },
      hostStartAdoptionLabel: async (label: ServiceLabel) => label.id,
    },
    calls,
    service,
    grants,
    noOpDecided,
  };
}

/** The exact Windows verify-loop refusal (`service/platforms/windows.ts`'s
 * `runTaskAndVerifyStart`): `/Run` under `IgnoreNew` is suppressed against
 * the still-parking supervisor's active service, so no spawn evidence ever
 * appears inside its 15s poll, and it throws this instead of returning. */
function windowsSpawnEvidenceTimeout() {
  return cliError({
    code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    message:
      "schtasks /Run for ai.traycer.host accepted the request but no host spawn evidence appeared within 15000ms",
    details: { task: "ai.traycer.host", registrationCommitted: true },
    exitCode: 1,
  });
}

/**
 * Gap 1: on Windows the same race (§ file doc) is reported differently.
 * `runWithLeaseAtServiceSpawnEdge` sees `didServiceRegistrationCommit` on
 * this thrown error, waits out the (swallowed) ack, and RETHROWS it - so the
 * retry, keyed on `SpawnAcknowledgementTimeoutError`, never even sees this
 * shape. Only the no-op branch differs from `fakeManagedController`: the
 * launch branch (a genuine, later relaunch) is unchanged and still resolves.
 */
function fakeWindowsNoOpThrowsController(): FakeControllerHandle {
  const calls = { start: 0, status: 0 };
  const service = { active: true };
  const grants = { count: 0 };
  let resolveNoOpDecided: () => void;
  const noOpDecided = new Promise<void>((resolve) => {
    resolveNoOpDecided = resolve;
  });
  return {
    controller: {
      status: async (): Promise<FakeStatus> => {
        calls.status += 1;
        return {
          state: service.active ? "running" : "stopped",
          version: "1.0.0",
          listenUrl: null,
          pid: null,
        };
      },
      start: async () => {
        calls.start += 1;
        await atServiceSpawnEdge();
        if (service.active) {
          resolveNoOpDecided();
          throw windowsSpawnEvidenceTimeout();
        }
        service.active = true;
        const nonce = await readHostStartAdoptionNonce(ENVIRONMENT, LABEL.id);
        const gate = await admitSupervisorLifecycle(
          {
            environment: ENVIRONMENT,
            serviceLaunch: { serviceLabel: LABEL.id, adoptionNonce: nonce },
          },
          gateDeps(),
        );
        if (
          gate.kind === "run" &&
          gate.consumed !== null &&
          gate.consumed.kind === "grant"
        ) {
          grants.count += 1;
          await gate.consumed.grant.acknowledgeSpawn();
        }
      },
      hostStartAdoptionLabel: async (label: ServiceLabel) => label.id,
    },
    calls,
    service,
    grants,
    noOpDecided,
  };
}

/**
 * Control (h): the service was already genuinely stopped (no race at all -
 * "the parked supervisor is NOT parked"), the launch fully succeeds - the
 * fresh proof is consumed and acknowledged for real - but the Windows
 * verify-loop STILL reports no evidence (a false-negative report on a
 * genuine success). `runWithLeaseAtServiceSpawnEdge` rethrows the original
 * error regardless of how its swallowed wait-out went, so this must surface
 * unchanged, and the retry (keyed on the OTHER error type) must never fire.
 */
function fakeWindowsAcknowledgedButReportedLostController(): FakeControllerHandle {
  const calls = { start: 0, status: 0 };
  const service = { active: false };
  const grants = { count: 0 };
  const noOpDecided = Promise.resolve();
  return {
    controller: {
      status: async (): Promise<FakeStatus> => {
        calls.status += 1;
        return {
          state: service.active ? "running" : "stopped",
          version: "1.0.0",
          listenUrl: null,
          pid: null,
        };
      },
      start: async () => {
        calls.start += 1;
        await atServiceSpawnEdge();
        service.active = true;
        const nonce = await readHostStartAdoptionNonce(ENVIRONMENT, LABEL.id);
        const gate = await admitSupervisorLifecycle(
          {
            environment: ENVIRONMENT,
            serviceLaunch: { serviceLabel: LABEL.id, adoptionNonce: nonce },
          },
          gateDeps(),
        );
        if (
          gate.kind === "run" &&
          gate.consumed !== null &&
          gate.consumed.kind === "grant"
        ) {
          grants.count += 1;
          await gate.consumed.grant.acknowledgeSpawn();
        }
        throw windowsSpawnEvidenceTimeout();
      },
      hostStartAdoptionLabel: async (label: ServiceLabel) => label.id,
    },
    calls,
    service,
    grants,
    noOpDecided,
  };
}

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

/** Stands up a genuinely LIVE service supervisor record for THIS process -
 * what `findLiveServiceSupervisor` looks for - the way
 * `update-mutation-supervisor-relaunch.test.ts` does. Models someone else's
 * relaunch beating the retry to it: a supervisor that is not this file's fake
 * launch branch at all. */
async function writeLiveServiceSupervisorRecord(): Promise<void> {
  const identity = readProcessStartIdentity(process.pid);
  await writeSupervisorRecords(ENVIRONMENT, {
    record: sampleSupervisorRecord(process.pid),
    runState: sampleRunState(process.pid, "granted", identity),
  });
}

/** A real pid.json naming a genuinely LIVE process - THIS test process - with
 * its real start identity, so `publishedHostProcessGone` reads it as NOT
 * proven gone. Models the case the retry must NOT treat as "genuinely
 * stopped": the manager's own status/liveness signals disagree (nothing
 * answers, no supervisor), but the pid record names a process that is, in
 * fact, still alive, so the retry has no positive evidence to act on. */
async function writeLivePidMetadata(): Promise<void> {
  const home = hostHomeDir(ENVIRONMENT);
  await mkdir(home, { recursive: true });
  await writeFile(
    hostPidMetadataPath(ENVIRONMENT),
    JSON.stringify({
      pid: process.pid,
      hostId: "test-host",
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:54998/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: readProcessStartIdentity(process.pid),
      processStartIdentityRead: "present",
      layer0: null,
      layer0Slot: null,
    }),
    "utf8",
  );
}

/** A present but corrupt pid.json - `readHostPidMetadataEvidence` must read
 * this as `unreadable`, never as absence or as a live/gone verdict. Models
 * the retry's "no positive evidence either way" case: it must not treat a
 * parse failure as proof the host is gone and safe to retry over. */
async function writeCorruptPidMetadata(): Promise<void> {
  const home = hostHomeDir(ENVIRONMENT);
  await mkdir(home, { recursive: true });
  await writeFile(hostPidMetadataPath(ENVIRONMENT), "{not json", "utf8");
}

describe("a starter's proof published after the gate's late-consume window", () => {
  it("the parking gate finds no proof and parks (sanity: the race window is real)", async () => {
    const result = await runParkingSupervisor();
    expect(result).toEqual({ kind: "park", mode: "linked" });
  });

  it("an unacknowledged start whose service is positively stopped is retried once with a fresh proof, and the relaunched supervisor adopts it", async () => {
    await runParkingSupervisor();
    const { controller, calls, service, grants, noOpDecided } =
      fakeManagedController();
    incumbent.hostServing = false;

    const starterOutcome = runStarter(controller);
    // Wait for the manager's own "already active" no-op decision before the
    // parked supervisor exits - otherwise `service.active` could flip to
    // `false` before `start()` ever reads it, which would take the "launch"
    // branch instead of racing it.
    await noOpDecided;
    service.active = false;

    await expect(starterOutcome).resolves.toEqual({ kind: "started" });
    expect(calls.start).toBe(2);
    expect(calls.status).toBeGreaterThanOrEqual(1);
    expect(grants.count).toBe(1);
    // No pid.json is ever written in this scenario - the retry's evidence
    // that the service is genuinely stopped must come from status/incumbent/
    // supervisor alone here, not from a pid record that was never there.
    expect((await readHostPidMetadataEvidence(ENVIRONMENT)).kind).toBe(
      "absent",
    );
  });

  // Control (a): a failing status read during the retry's own look-again must
  // not be treated as "still down, retry blindly" - it must surface the
  // ORIGINAL ack-timeout, never the status error itself. Already true today
  // (nothing calls status at all, so there is nothing to fail), and must stay
  // true once the retry exists and calls it.
  it("control (a): a failing status read must not cause a retry, and must not replace the ack-timeout error", async () => {
    await runParkingSupervisor();
    const { controller, calls, service, noOpDecided } = fakeManagedController();
    controller.status = async () => {
      throw new Error("status read failed");
    };

    const starterOutcome = runStarter(controller);
    await noOpDecided;
    service.active = false;

    await expect(starterOutcome).rejects.toMatchObject({
      message: expect.stringContaining(
        "host-start supervisor did not acknowledge its spawn",
      ),
    });
    expect(calls.start).toBe(1);
  });

  // Control (b): if, by the time the ack wait times out, another starter has
  // already gotten the service RUNNING - and a host is POSITIVELY serving,
  // not just stale pid metadata - the retry is a no-op: the goal is already
  // met, so it must resolve rather than surface a stale ack-timeout for a
  // host that is, in fact, up.
  it("control (b): the service already running, and positively serving, by the timeout means no second start", async () => {
    await runParkingSupervisor();
    const { controller, calls, service, noOpDecided } = fakeManagedController();
    controller.status = async () => ({
      state: "running" as const,
      version: "1.0.0",
      listenUrl: null,
      pid: null,
    });
    incumbent.hostServing = true;

    const starterOutcome = runStarter(controller);
    await noOpDecided;
    service.active = false;

    await expect(starterOutcome).resolves.toEqual({ kind: "started" });
    expect(calls.start).toBe(1);
  });

  // Control (d): "running" alone is not evidence. A pid record naming a
  // process that is genuinely still alive (this test process itself) but
  // with no host answering and no supervisor relaunching it either is not
  // positive proof the service is down - the retry must not treat that as
  // satisfied; the ack-timeout must stand. Realistic, not synthetic: the
  // pid.json is real, naming this process with its real start identity, the
  // same record `publishedHostProcessGone` reads to decide "provably gone".
  it("control (d): a stale 'running' status, with no host positively serving and no live supervisor, keeps the timeout", async () => {
    await runParkingSupervisor();
    const { controller, calls, service, noOpDecided } = fakeManagedController();
    controller.status = async () => ({
      state: "running" as const,
      version: "1.0.0",
      listenUrl: null,
      pid: null,
    });
    incumbent.hostServing = false;
    await writeLivePidMetadata();

    const starterOutcome = runStarter(controller);
    await noOpDecided;
    service.active = false;

    await expect(starterOutcome).rejects.toMatchObject({
      message: expect.stringContaining(
        "host-start supervisor did not acknowledge its spawn",
      ),
    });
    expect(calls.start).toBe(1);
  });

  // Control (e): a Desktop-owned macOS registration reports `status` as
  // `externally-managed` whether or not its host is running -
  // `service/platforms/macos.ts` - and provisioning already routes that state
  // to a start. So the retry cannot rest on `status === "stopped"`; it must
  // treat a successful, REGISTERED read (anything but `not-installed`) the
  // same way once no host answers, no supervisor is alive, and the pid
  // record is absent (or provably gone). No pid.json here at all - absence
  // is itself one of the two positive "gone" readings.
  it("control (e): macOS Desktop-owned (externally-managed) is retried exactly like a stopped service", async () => {
    await runParkingSupervisor();
    const { controller, calls, service, grants, noOpDecided } =
      fakeManagedController();
    controller.status = async () => ({
      state: "externally-managed" as const,
      version: "1.0.0",
      listenUrl: null,
      pid: null,
    });
    incumbent.hostServing = false;

    const starterOutcome = runStarter(controller);
    await noOpDecided;
    service.active = false;

    await expect(starterOutcome).resolves.toEqual({ kind: "started" });
    expect(calls.start).toBe(2);
    expect(grants.count).toBe(1);
  });

  // Control (f): a PRESENT but corrupt pid record is no evidence either way -
  // `readHostPidMetadataEvidence` reads it as `unreadable`, never as absence
  // and never as a live/gone verdict. The retry must not treat a parse
  // failure as proof the host is gone and safe to retry over; the
  // ack-timeout must stand, exactly as an unreadable status read does
  // (control (a)).
  it("control (f): an unreadable pid record keeps the timeout", async () => {
    await runParkingSupervisor();
    const { controller, calls, service, noOpDecided } = fakeManagedController();
    controller.status = async () => ({
      state: "stopped" as const,
      version: "1.0.0",
      listenUrl: null,
      pid: null,
    });
    incumbent.hostServing = false;
    await writeCorruptPidMetadata();

    const starterOutcome = runStarter(controller);
    await noOpDecided;
    service.active = false;

    await expect(starterOutcome).rejects.toMatchObject({
      message: expect.stringContaining(
        "host-start supervisor did not acknowledge its spawn",
      ),
    });
    expect(calls.start).toBe(1);
  });

  // Control (c): if, by the time the ack wait times out, the service reads
  // STOPPED but its own supervisor is now alive on record (someone else's
  // relaunch beat the retry to it), the retry must defer to it exactly as
  // `startHostServiceWithAttempt`'s own up-front check does - no second
  // `start`, and the outcome is `supervisor-relaunching`, not `started`.
  it("control (c): stopped, but a live service supervisor is now on record - no second start, reports supervisor-relaunching", async () => {
    await runParkingSupervisor();
    const { controller, calls, service, noOpDecided } = fakeManagedController();
    controller.status = async () => ({
      state: "stopped" as const,
      version: "1.0.0",
      listenUrl: null,
      pid: null,
    });

    const starterOutcome = runStarter(controller);
    await noOpDecided;
    service.active = false;
    await writeLiveServiceSupervisorRecord();

    await expect(starterOutcome).resolves.toEqual({
      kind: "supervisor-relaunching",
      supervisorPid: process.pid,
    });
    expect(calls.start).toBe(1);
  });

  // Gap 1 (sibling sweep): Windows reports the SAME race differently - a
  // thrown, registration-committed `SERVICE_CONTROL_FAILED`, never the
  // `SpawnAcknowledgementTimeoutError` the retry keys on.
  it("(g) a Windows-shaped lost start (verify timed out, registration committed, no acknowledgement) is retried once with a fresh proof", async () => {
    await runParkingSupervisor();
    const { controller, calls, grants, service, noOpDecided } =
      fakeWindowsNoOpThrowsController();
    incumbent.hostServing = false;

    const starterOutcome = runStarter(controller);
    await noOpDecided;
    service.active = false;

    await expect(starterOutcome).resolves.toEqual({ kind: "started" });
    expect(calls.start).toBe(2);
    expect(grants.count).toBe(1);
  });

  // Control (h): an acknowledged spawn is never retried, even when the
  // Windows verify-loop reports it lost anyway - the raw
  // `SERVICE_CONTROL_FAILED` must surface unchanged.
  it("control (h): an acknowledged Windows spawn still reports SERVICE_CONTROL_FAILED, and is never retried", async () => {
    await runParkingSupervisor();
    const { controller, calls } =
      fakeWindowsAcknowledgedButReportedLostController();
    incumbent.hostServing = false;

    const starterOutcome = runStarter(controller);

    await expect(starterOutcome).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      details: expect.objectContaining({ registrationCommitted: true }),
    });
    expect(calls.start).toBe(1);
  });
});

interface FakeRelauncher {
  status: () => Promise<FakeStatus>;
  relaunchAfterRestart: (
    label: ServiceLabel,
    stop: RestartStop,
  ) => Promise<void>;
  hostStartAdoptionLabel: (label: ServiceLabel) => Promise<string>;
}

interface FakeRelauncherHandle {
  readonly controller: FakeRelauncher;
  readonly calls: { relaunch: number; status: number };
  readonly service: { active: boolean };
  readonly grants: { count: number };
  readonly noOpDecided: Promise<void>;
}

/** The relaunch leg's OS-manager-eye view, same shape as
 * `fakeManagedController` - no-op while active, launches (consumes and
 * acknowledges a fresh proof) once genuinely stopped. */
function fakeManagedRelauncher(): FakeRelauncherHandle {
  const calls = { relaunch: 0, status: 0 };
  const service = { active: true };
  const grants = { count: 0 };
  let resolveNoOpDecided: () => void;
  const noOpDecided = new Promise<void>((resolve) => {
    resolveNoOpDecided = resolve;
  });
  return {
    controller: {
      status: async (): Promise<FakeStatus> => {
        calls.status += 1;
        return {
          state: service.active ? "running" : "stopped",
          version: "1.0.0",
          listenUrl: null,
          pid: null,
        };
      },
      relaunchAfterRestart: async () => {
        calls.relaunch += 1;
        await atServiceSpawnEdge();
        if (service.active) {
          resolveNoOpDecided();
          return;
        }
        service.active = true;
        const nonce = await readHostStartAdoptionNonce(ENVIRONMENT, LABEL.id);
        const gate = await admitSupervisorLifecycle(
          {
            environment: ENVIRONMENT,
            serviceLaunch: { serviceLabel: LABEL.id, adoptionNonce: nonce },
          },
          gateDeps(),
        );
        if (
          gate.kind === "run" &&
          gate.consumed !== null &&
          gate.consumed.kind === "grant"
        ) {
          grants.count += 1;
          await gate.consumed.grant.acknowledgeSpawn();
        }
      },
      hostStartAdoptionLabel: async (label: ServiceLabel) => label.id,
    },
    calls,
    service,
    grants,
    noOpDecided,
  };
}

const STOPPED: RestartStop = { forcedRecycle: false };

/** The facade's own outcome, once the real contender admitted the relaunch. */
async function runRelauncher(controller: FakeRelauncher, stopped: RestartStop) {
  const admitted = await withUpdateContender(
    {
      hostHomeDir: hostHomeDir(ENVIRONMENT),
      reason: CONTENDER_OPTIONS.reason,
      waitMs: 0,
      pollIntervalMs: 10,
      admission: CONTENDER_OPTIONS.admission,
    },
    (capability) =>
      relaunchHostAfterRestartWithAttempt(
        capability,
        CONTENDER_OPTIONS,
        "maintenance",
        controller,
        LABEL,
        stopped,
      ),
  );
  if (admitted.kind !== "ran") {
    throw new Error(
      `the contender did not admit the relaunch: ${admitted.kind}`,
    );
  }
  return admitted.result;
}

describe("the restart/update relaunch leg has no retry at all", () => {
  it("(r1) an unacknowledged relaunch whose service is positively stopped is relaunched once more with a fresh proof", async () => {
    await runParkingSupervisor();
    const { controller, calls, grants, service, noOpDecided } =
      fakeManagedRelauncher();
    incumbent.hostServing = false;

    const relaunchOutcome = runRelauncher(controller, STOPPED);
    await noOpDecided;
    service.active = false;

    await expect(relaunchOutcome).resolves.toBeUndefined();
    expect(calls.relaunch).toBe(2);
    expect(grants.count).toBe(1);
  });

  // Control (r2): already true today - nothing calls status at all on this
  // leg, so a failing read cannot be reached, and the plain ack-timeout
  // stands.
  it("control (r2): a failing status read keeps the ack-timeout rejection", async () => {
    await runParkingSupervisor();
    const { controller, calls, service, noOpDecided } = fakeManagedRelauncher();
    controller.status = async () => {
      throw new Error("status read failed");
    };

    const relaunchOutcome = runRelauncher(controller, STOPPED);
    await noOpDecided;
    service.active = false;

    await expect(relaunchOutcome).rejects.toMatchObject({
      message: expect.stringContaining(
        "host-start supervisor did not acknowledge its spawn",
      ),
    });
    expect(calls.relaunch).toBe(1);
  });

  // Control (r3): the host is POSITIVELY serving by the timeout - the goal is
  // already met, so this must resolve with no second relaunch, exactly as
  // control (b) does for the start leg.
  it("control (r3): the host positively serving means no second relaunch", async () => {
    await runParkingSupervisor();
    const { controller, calls, service, noOpDecided } = fakeManagedRelauncher();
    controller.status = async () => ({
      state: "running" as const,
      version: "1.0.0",
      listenUrl: null,
      pid: null,
    });
    incumbent.hostServing = true;

    const relaunchOutcome = runRelauncher(controller, STOPPED);
    await noOpDecided;
    service.active = false;

    await expect(relaunchOutcome).resolves.toBeUndefined();
    expect(calls.relaunch).toBe(1);
  });
});
