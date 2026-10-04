import { rmSync } from "node:fs";
import { rm, writeFile, mkdir } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  withUpdateContender,
  updateAttemptRecordPath,
  type HostUpdateAttemptRecord,
} from "@traycer-clients/shared/host-update";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import type { SupervisorRecord } from "@traycer/protocol/config/supervisor-record";

// The rule under test (production: `update-mutation.ts`'s
// `afterUnacknowledgedStart`) does not exist yet - every row here but the two
// guards (e3, e4) is expected to FAIL against current bytes. This file
// documents what a fix must do, the same way `start-retry-after-parked-exit
// .test.ts` (this directory, a sibling agent's file, read-only reference)
// documents its own not-yet-built retry.
//
// TODAY, `afterUnacknowledgedStart` finds a live service supervisor and
// unconditionally returns `supervisor-relaunching`, trusting that supervisor
// to bring the host back. But that supervisor re-admits each relaunch under
// `supervisor-relaunch-maintenance`, which REFUSES a standing attempt record
// that is not parked for work (or a matching, in-place activation/interrupted
// restart) - e.g. `downloading` or `preparing`. Trusting it there is trusting
// a relaunch that will itself refuse to spawn.
//
// The rule these rows pin:
//   - a standing record the supervisor's own relaunch WOULD ADMIT (no record,
//     a terminal record, `waiting-for-work`, ...) -> `supervisor-relaunching`,
//     exactly as today (e3, e4 - guards, already green);
//   - otherwise WAIT for that supervisor to leave (`waitForSupervisorRelaunch`,
//     `defaultSupervisorRelaunchWaitDeps`), at most `MAX_SUPERVISOR_RELAUNCH
//     _WAITS` (2) waits;
//   - a host answering meanwhile -> `started`, no second start (e6);
//   - the supervisor gone AND the host's pid record absent/provably gone ->
//     start ONCE more with a fresh proof (e1, e2);
//   - still there after the cap -> throw the ORIGINAL ack-timeout error (e5).
//
// HOME is redirected to a private temp dir before anything reads it - the
// real `consumeHostStartAdoption`/`readHostStartAdoptionNonce`, the real
// outer update-attempt lock, and the real attempt-record reader all resolve
// paths off `os.homedir()` at module load. Same pattern as the sibling file.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSync(
      join(
        actual.tmpdir(),
        "traycer-start-retry-refused-live-supervisor-test-",
      ),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

// Same reasoning and the same seam as the sibling file: shrinking the real
// ack-wait constant, rather than faking timers wholesale, keeps every wait in
// this file on the REAL clock (the real lock acquisition and
// `findLiveServiceSupervisor` this scenario also runs through use real
// `setTimeout`-based polling of their own), just against a much smaller
// budget.
// Targets the shared leaf directly, not this project's own
// `../../service/spawn-edge-bounds` (a thin `export *` wrapper post-#2267
// extraction): `publishHostStartAdoption`'s `waitForSpawn` reads
// `HOST_START_ADOPTION_ACK_WAIT_MS` from
// `@traycer-clients/shared/host-start-adoption/index.ts`'s own `"./spawn-
// edge-bounds"` import - the SHARED file, a different module specifier than
// the CLI wrapper - so mocking the wrapper alone would never shrink the
// budget this test actually waits on.
const ACK_WAIT_MS_FOR_TEST = vi.hoisted(() => 300);
vi.mock(
  "@traycer-clients/shared/host-start-adoption/spawn-edge-bounds",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-start-adoption/spawn-edge-bounds")
      >();
    return { ...actual, HOST_START_ADOPTION_ACK_WAIT_MS: ACK_WAIT_MS_FOR_TEST };
  },
);

// Switchable, exactly as `commands/__tests__/service-start.test.ts` and the
// sibling file do, rather than standing up a real reachable endpoint.
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

// The seam for the (not yet built) wait: only `defaultSupervisorRelaunchWait
// Deps` is overridden, to a much smaller budget so this file's cap-exhaustion
// row (e5) does not cost the real ~2.5-minute `SUPERVISOR_RELAUNCH_WAIT_MS`.
// `findLiveServiceSupervisor` and `waitForSupervisorRelaunch` themselves stay
// REAL - nothing here mocks their behavior.
const WAIT_DEPS_FOR_TEST = vi.hoisted(() => ({
  waitMs: 400,
  pollIntervalMs: 20,
}));
vi.mock("../service-supervisor-relaunch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../service-supervisor-relaunch")>();
  return {
    ...actual,
    defaultSupervisorRelaunchWaitDeps: {
      ...actual.defaultSupervisorRelaunchWaitDeps,
      ...WAIT_DEPS_FOR_TEST,
    },
  };
});

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
import { hostHomeDir } from "../../store/paths";
import { readProcessStartIdentity } from "../../store/process-identity";
import {
  removeSupervisorRecords,
  writeSupervisorRecords,
  type SupervisorRunState,
} from "../lifecycle-files";
import type { ServiceLabel, RestartStop } from "../../service";
import type {
  HostLifecycleMode,
  HostLifecyclePolicy,
} from "@traycer/protocol/config/host-lifecycle-policy";
import type { LifecycleRecordRead } from "../lifecycle-files";

beforeAll(() => {
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
  expect(HOST_START_ADOPTION_ACK_WAIT_MS).toBe(ACK_WAIT_MS_FOR_TEST);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

const pendingTimers: NodeJS.Timeout[] = [];

afterEach(async () => {
  incumbent.hostServing = false;
  for (const timer of pendingTimers.splice(0)) clearTimeout(timer);
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

/** Same shared gate deps as the sibling file's `fakeManagedController`'s
 * "launch" branch: what a fresh supervisor instance consuming THIS call's
 * own just-published proof runs against. */
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

// The relaunch leg of a `host restart` - a whole-product admission that
// always runs regardless of any standing attempt record (`dispositionFor`'s
// `recovery-maintenance` arm is unconditional `allow`), which is exactly why
// this file can drive both facades over a `downloading`/`preparing` record
// still standing: neither the start-facade calls below nor the relaunch
// ones would even be ADMITTED under an admission a standing record refuses.
const CONTENDER_OPTIONS = {
  environment: ENVIRONMENT,
  reason: "start-retry-refused-live-supervisor-test",
  waitMs: 0,
  pollIntervalMs: 10,
  admission: "recovery-maintenance" as const,
};

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

const STOPPED: RestartStop = { forcedRecycle: false };

async function runRelauncher(controller: FakeRelauncher) {
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
        STOPPED,
      ),
  );
  if (admitted.kind !== "ran") {
    throw new Error(
      `the contender did not admit the relaunch: ${admitted.kind}`,
    );
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
  readonly grants: { count: number };
  readonly noOpDecided: Promise<void>;
}

/** Copied from `start-retry-after-parked-exit.test.ts`'s `fakeManagedController`
 * (this directory, read-only reference): the OS service manager's-eye view.
 * `start` publishes the real proof at the real spawn edge, then behaves
 * exactly as a manager would - service already ACTIVE: no-op (nothing
 * consumes the proof, so its ack wait times out); service STOPPED:
 * "launches" a fake new supervisor that consumes and acknowledges THIS
 * call's own just-published proof. */
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

/** Copied from the sibling file's `fakeManagedRelauncher` - the relaunch
 * leg's OS-manager-eye view, same shape as `fakeManagedController`. */
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
  identity: ProcessStartIdentity | null,
): SupervisorRunState {
  return {
    v: 1,
    supervisorPid: pid,
    supervisorStartIdentity: identity,
    admission: "granted",
    origin: null,
    adopted: false,
    lastPresence: null,
    updatedAt: new Date().toISOString(),
  };
}

/** Stands up a genuinely LIVE service supervisor record for THIS process -
 * what `findLiveServiceSupervisor` looks for - copied from the sibling
 * file's `writeLiveServiceSupervisorRecord`. Models a DIFFERENT supervisor
 * relaunch beating this retry to it - never this file's own fake launch
 * branch. */
async function writeLiveServiceSupervisorRecord(): Promise<void> {
  const identity = readProcessStartIdentity(process.pid);
  await writeSupervisorRecords(ENVIRONMENT, {
    record: sampleSupervisorRecord(process.pid),
    runState: sampleRunState(process.pid, identity),
  });
}

async function removeLiveServiceSupervisorRecord(): Promise<void> {
  await removeSupervisorRecords(ENVIRONMENT, process.pid, "all");
}

/** Schedules the live supervisor record's removal `ms` after this call,
 * tracked so `afterEach` can clear anything still pending. Fire-and-forget:
 * best-effort, exactly like the production removal it models. */
function scheduleSupervisorRecordRemoval(ms: number): void {
  const timer = setTimeout(() => {
    void removeLiveServiceSupervisorRecord().catch(() => undefined);
  }, ms);
  pendingTimers.push(timer);
}

/** A real attempt record on disk, built and written the same way
 * `cli-finalize-upgrade-over-update-attempt.test.ts` (read-only reference)
 * does - through the real decoder's own shape, never a hand-faked one. */
function attemptRecord(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    trigger: "manual",
    targetVersion: "1.2.3",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    ...overrides,
  };
}

async function writeAttemptRecord(
  overrides: Partial<HostUpdateAttemptRecord>,
): Promise<void> {
  const home = hostHomeDir(ENVIRONMENT);
  await mkdir(home, { recursive: true });
  await writeFile(
    updateAttemptRecordPath(home),
    `${JSON.stringify(attemptRecord(overrides))}\n`,
    "utf8",
  );
}

const ACK_TIMEOUT_MESSAGE =
  "host-start supervisor did not acknowledge its spawn";

describe("afterUnacknowledgedStart must ask whether supervisor-relaunch would admit the standing attempt, not trust it unconditionally", () => {
  // (e1) downloading: a live supervisor is present through the ack timeout,
  // then leaves ~150ms into the (future) wait window - well before its cap.
  // `downloading` is refused by `supervisor-relaunch-maintenance`
  // (`supervisorRelaunchDisposition` falls through to
  // `supervisorRelaunchOverActive`, which does not admit it - see
  // `cli-finalize-upgrade-over-update-attempt.test.ts`'s "(s1) downloading"
  // row, which needs a THIRD tier for exactly this reason). TODAY the code
  // never asks, and reports `supervisor-relaunching` the instant it is found -
  // called once, never `started`.
  it("(e1-start) downloading: a live supervisor that leaves before the wait cap is followed by one more start", async () => {
    await writeAttemptRecord({});
    const { controller, calls, service, grants, noOpDecided } =
      fakeManagedController();
    incumbent.hostServing = false;

    const outcome = runStarter(controller);
    await noOpDecided;
    service.active = false;
    await writeLiveServiceSupervisorRecord();
    // Removed ~150ms into the wait window that opens once the ack timeout
    // itself fires (ACK_WAIT_MS_FOR_TEST), comfortably inside the wait
    // cap (WAIT_DEPS_FOR_TEST.waitMs) - never before the timeout, or a
    // retry that already exists today (supervisor gone -> "stopped") would
    // fire for an unrelated reason.
    scheduleSupervisorRecordRemoval(ACK_WAIT_MS_FOR_TEST + 150);

    await expect(outcome).resolves.toEqual({ kind: "started" });
    expect(calls.start).toBe(2);
    expect(grants.count).toBe(1);
  });

  it("(e1-relaunch) downloading: a live supervisor that leaves before the wait cap is followed by one more relaunch", async () => {
    await writeAttemptRecord({});
    const { controller, calls, service, grants, noOpDecided } =
      fakeManagedRelauncher();
    incumbent.hostServing = false;

    const outcome = runRelauncher(controller);
    await noOpDecided;
    service.active = false;
    await writeLiveServiceSupervisorRecord();
    scheduleSupervisorRecordRemoval(ACK_WAIT_MS_FOR_TEST + 150);

    await expect(outcome).resolves.toBeUndefined();
    expect(calls.relaunch).toBe(2);
    expect(grants.count).toBe(1);
  });

  // (e2) preparing, continuation null: the same refusal as (s2) in
  // `cli-finalize-upgrade-over-update-attempt.test.ts` - relaunch facade
  // only, per the assignment.
  it("(e2) preparing (continuation null): a live supervisor that leaves before the wait cap is followed by one more relaunch", async () => {
    await writeAttemptRecord({
      phase: "preparing",
      execution: "active",
      continuation: null,
    });
    const { controller, calls, service, grants, noOpDecided } =
      fakeManagedRelauncher();
    incumbent.hostServing = false;

    const outcome = runRelauncher(controller);
    await noOpDecided;
    service.active = false;
    await writeLiveServiceSupervisorRecord();
    scheduleSupervisorRecordRemoval(ACK_WAIT_MS_FOR_TEST + 150);

    await expect(outcome).resolves.toBeUndefined();
    expect(calls.relaunch).toBe(2);
    expect(grants.count).toBe(1);
  });

  // (e3) guard: `waiting-for-work` is admitted by `supervisor-relaunch
  // -maintenance` unconditionally (`supervisorRelaunchDisposition`'s first
  // line). The new rule must not touch this case at all - GREEN today AND
  // green under the eventual fix.
  it("(e3 guard) waiting-for-work with a live supervisor resolves immediately - no wait", async () => {
    await writeAttemptRecord({
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
      targetVersion: "9.9.9",
    });
    const { controller, calls, service, noOpDecided } = fakeManagedController();
    incumbent.hostServing = false;

    const startedAt = Date.now();
    const outcome = runStarter(controller);
    await noOpDecided;
    service.active = false;
    await writeLiveServiceSupervisorRecord();

    await expect(outcome).resolves.toEqual({
      kind: "supervisor-relaunching",
      supervisorPid: process.pid,
    });
    expect(calls.start).toBe(1);
    // No extra wait beyond the intrinsic ack-timeout: well under
    // ack-timeout + the wait cap, which a genuine (future) wait would add.
    expect(Date.now() - startedAt).toBeLessThan(
      ACK_WAIT_MS_FOR_TEST + WAIT_DEPS_FOR_TEST.waitMs / 2,
    );
  });

  // (e4) guard: no attempt record at all - the disposition check is never
  // even reached (there is no `activeAttempt`), so this is unconditionally
  // admitted. Already green today, and must stay so.
  it("(e4 guard) no attempt record at all, with a live supervisor, resolves immediately - no wait", async () => {
    const { controller, calls, service, noOpDecided } = fakeManagedController();
    incumbent.hostServing = false;

    const startedAt = Date.now();
    const outcome = runStarter(controller);
    await noOpDecided;
    service.active = false;
    await writeLiveServiceSupervisorRecord();

    await expect(outcome).resolves.toEqual({
      kind: "supervisor-relaunching",
      supervisorPid: process.pid,
    });
    expect(calls.start).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(
      ACK_WAIT_MS_FOR_TEST + WAIT_DEPS_FOR_TEST.waitMs / 2,
    );
  });

  // (e5) cap: downloading, and the live supervisor NEVER leaves. The wait
  // must give up after `MAX_SUPERVISOR_RELAUNCH_WAITS` (2) waits and
  // surface the ORIGINAL ack-timeout - never invent a new error, and never
  // report `supervisor-relaunching` for a relaunch that would refuse to
  // spawn. TODAY there is no cap and no wait: the code reports
  // `supervisor-relaunching` immediately and never throws at all.
  it("(e5 cap) downloading: a live supervisor that never leaves exhausts the wait cap and the original ack-timeout stands", async () => {
    await writeAttemptRecord({});
    const { controller, calls, service, noOpDecided } = fakeManagedRelauncher();
    incumbent.hostServing = false;

    const outcome = runRelauncher(controller);
    await noOpDecided;
    service.active = false;
    await writeLiveServiceSupervisorRecord();
    // Never removed - models a supervisor that keeps refusing its own
    // relaunches for the life of this test.

    await expect(outcome).rejects.toMatchObject({
      message: expect.stringContaining(ACK_TIMEOUT_MESSAGE),
    });
    expect(calls.relaunch).toBe(1);
  });

  // (e6) downloading: the supervisor leaves AND a host answers concurrently.
  // The host-answering race must win: `waitForSupervisorRelaunch` checks
  // `findLiveIncumbentHost` before `findLiveServiceSupervisor`, so a host
  // that answers as the supervisor's record disappears resolves
  // `host-ready`, not `supervisor-gone` -> no second start at all. Both
  // changes land strictly AFTER the ack timeout itself fires, so this
  // cannot be satisfied by TODAY's single, ack-timeout-only check (which
  // would see the supervisor still live and the host not yet answering,
  // and wrongly report `supervisor-relaunching`).
  it("(e6) downloading: the host answers as the supervisor leaves - no second start", async () => {
    await writeAttemptRecord({});
    const { controller, calls, service, noOpDecided } = fakeManagedController();
    incumbent.hostServing = false;

    const outcome = runStarter(controller);
    await noOpDecided;
    service.active = false;
    await writeLiveServiceSupervisorRecord();

    const timer = setTimeout(() => {
      incumbent.hostServing = true;
      void removeLiveServiceSupervisorRecord().catch(() => undefined);
    }, ACK_WAIT_MS_FOR_TEST + 50);
    pendingTimers.push(timer);

    await expect(outcome).resolves.toEqual({ kind: "started" });
    expect(calls.start).toBe(1);
  });
});
