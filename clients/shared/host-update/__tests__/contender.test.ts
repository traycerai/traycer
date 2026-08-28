import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetHeldInProcessForTest,
  isUpdateAttemptLockHeldInProcess,
} from "../lock";
import { updateAttemptLockPath, updateAttemptRecordPath } from "../paths";
import { TERMINAL_ATTEMPT_RETENTION_MS } from "../record";
import type { HostUpdateAttemptRecord } from "../record";
import { __setBeforeRecordRenameHookForTest } from "../store";
import {
  commitExecutorAttemptMutation,
  commitExecutorRecoveryMutation,
  verifyUpdateMutationCapability,
  withUpdateContender,
  withUpdateExecutorCompletionSegment,
  type ExecutorCompletionSession,
  type UpdateContenderAdmission,
  type UpdateContenderExecutionContext,
  type UpdateContenderOutcome,
  type UpdateMutationCapability,
} from "../contender";
import type { AttemptClaimRequest } from "../transition";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitUntil(
  predicate: () => boolean,
  maxWaitMs: number,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitUntil: condition never became true");
}

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const supervisedPids: number[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "host-update-contender-test-"));
  roots.push(root);
  return join(root, "first-run", "host-home");
}

function options(hostHomeDir: string, admission: UpdateContenderAdmission) {
  return {
    hostHomeDir,
    reason: "contender-test",
    waitMs: 0,
    pollIntervalMs: 10,
    admission,
  } as const;
}

function record(
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

function baseCreateRequest(
  overrides: Partial<AttemptClaimRequest>,
): AttemptClaimRequest {
  return {
    targetVersion: "1.2.3",
    trigger: "manual",
    action: "start",
    expected: null,
    newAttemptId: "attempt-1",
    initialPhase: "downloading",
    nowIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function writeRecord(
  hostHomeDir: string,
  value: HostUpdateAttemptRecord | string,
): Promise<void> {
  await mkdir(hostHomeDir, { recursive: true });
  await writeFile(
    updateAttemptRecordPath(hostHomeDir),
    typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
  );
}

async function waitForFile(path: string, maxWaitMs: number): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function spawnAttemptCompetitor(
  hostHomeDir: string,
  barrierDir: string,
): ChildProcessWithoutNullStreams {
  const worker = spawn(
    "bun",
    ["run", join(__dirname, "fixtures", "lock-worker.ts")],
    {
      env: {
        ...process.env,
        WORKER_HOST_HOME_DIR: hostHomeDir,
        WORKER_BARRIER_DIR: barrierDir,
        WORKER_WAIT_MS: "0",
      },
    },
  );
  children.push(worker);
  return worker;
}

function forgetChild(child: ChildProcessWithoutNullStreams): void {
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
}

afterEach(async () => {
  __setBeforeRecordRenameHookForTest(null);
  __resetHeldInProcessForTest();
  for (const pid of supervisedPids.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The actuator normally exits through its release barrier; cleanup is
      // best effort when an assertion fails before that point.
    }
  }
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          child.kill("SIGKILL");
          // The test body already performs the barrier-level reap. Do not
          // wait for inherited stdio/close bookkeeping from a killed helper.
          resolve();
        }),
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("withUpdateContender - canonical first-run boundary", () => {
  it("keeps rebindAttemptLockLiveness authority on a blocked actuator when helper or executor dies", async () => {
    const hostHomeDir = await freshHome();
    const barrierDir = join(hostHomeDir, "bcd-barrier");
    await mkdir(barrierDir, { recursive: true });
    const helper = spawn(
      "bun",
      [
        "run",
        join(__dirname, "fixtures", "maintenance-helper-executor-actuator.ts"),
      ],
      {
        env: {
          ...process.env,
          MAINTENANCE_HOST_HOME: hostHomeDir,
          MAINTENANCE_BARRIER_DIR: barrierDir,
        },
      },
    );
    children.push(helper);
    await waitForFile(join(barrierDir, "helper-rebound"), 10_000);
    await waitForFile(join(barrierDir, "supervisor-bind"), 10_000);
    await waitForFile(join(barrierDir, "supervisor-granted"), 10_000);
    const bindMessage = JSON.parse(
      await readFile(join(barrierDir, "supervisor-bind"), "utf8"),
    ) as { readonly kind: string; readonly pid: number };
    expect(bindMessage.kind).toBe("bind-actuator");
    expect(bindMessage.pid).toBeGreaterThan(0);
    const grantMessage = JSON.parse(
      await readFile(join(barrierDir, "supervisor-granted"), "utf8"),
    ) as { readonly kind: string };
    expect(grantMessage.kind).toBe("actuator-bound");
    const rebound = JSON.parse(
      await readFile(join(barrierDir, "helper-rebound"), "utf8"),
    ) as {
      readonly helperPid: number;
      readonly executorPid: number;
      readonly actuatorPid: number;
    };
    expect(rebound.helperPid).toBe(helper.pid);
    supervisedPids.push(rebound.actuatorPid);
    await waitForFile(join(barrierDir, "actuator-ready"), 10_000);
    await waitForFile(join(barrierDir, "actuator-edge-running"), 10_000);

    // The lock-acquiring helper's death must not make the blocked actuator's
    // irreversible edge reclaimable. This is a lower-level
    // rebindAttemptLockLiveness primitive test, not the production C-envelope
    // process topology (covered by the OS-descendant fixture below).
    helper.kill("SIGKILL");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    forgetChild(helper);
    const afterHelperDeath = join(barrierDir, "after-helper-death");
    await mkdir(afterHelperDeath, { recursive: true });
    const helperCompetitor = spawnAttemptCompetitor(
      hostHomeDir,
      afterHelperDeath,
    );
    await waitForFile(join(afterHelperDeath, "busy"), 10_000);
    await new Promise<void>((resolve) => {
      if (helperCompetitor.exitCode !== null) resolve();
      else helperCompetitor.once("close", resolve);
    });
    forgetChild(helperCompetitor);
    expect(
      (
        JSON.parse(await readFile(join(afterHelperDeath, "busy"), "utf8")) as {
          readonly holder: { readonly pid: number } | null;
        }
      ).holder?.pid,
    ).toBe(rebound.actuatorPid);

    // The executor can be terminated without making a live actuator look like
    // a stale lock owner after the primitive rebind.
    process.kill(rebound.executorPid, "SIGTERM");
    const whileActuatorBlocked = join(barrierDir, "while-actuator-blocked");
    await mkdir(whileActuatorBlocked, { recursive: true });
    const blockedAfterSupervisorDeath = spawnAttemptCompetitor(
      hostHomeDir,
      whileActuatorBlocked,
    );
    await waitForFile(join(whileActuatorBlocked, "busy"), 10_000);
    await new Promise<void>((resolve) => {
      if (blockedAfterSupervisorDeath.exitCode !== null) resolve();
      else blockedAfterSupervisorDeath.once("close", resolve);
    });
    forgetChild(blockedAfterSupervisorDeath);
    expect(
      (
        JSON.parse(
          await readFile(join(whileActuatorBlocked, "busy"), "utf8"),
        ) as {
          readonly holder: { readonly pid: number } | null;
        }
      ).holder?.pid,
    ).toBe(rebound.actuatorPid);
    expect(
      await stat(join(barrierDir, "actuator-exited")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    await writeFile(join(barrierDir, "actuator-release"), "");
    await waitForFile(join(barrierDir, "actuator-exited"), 10_000);

    // Only after the rebound actuator exits may a fresh contender acquire and
    // release the lock.
    const afterActuatorDeath = join(barrierDir, "after-actuator-death");
    await mkdir(afterActuatorDeath, { recursive: true });
    const reclaim = spawnAttemptCompetitor(hostHomeDir, afterActuatorDeath);
    await waitForFile(join(afterActuatorDeath, "held"), 10_000);
    await writeFile(join(afterActuatorDeath, "release"), "");
    await waitForFile(join(afterActuatorDeath, "released"), 10_000);
    await new Promise<void>((resolve) => {
      if (reclaim.exitCode !== null) resolve();
      else reclaim.once("close", resolve);
    });
    forgetChild(reclaim);
  }, 60_000);

  it("keeps the actuator authoritative after its helper dies", async () => {
    const hostHomeDir = await freshHome();
    const barrierDir = join(hostHomeDir, "maintenance-barrier");
    await mkdir(barrierDir, { recursive: true });
    const helper = spawn(
      "bun",
      ["run", join(__dirname, "fixtures", "maintenance-helper-actuator.ts")],
      {
        env: {
          ...process.env,
          MAINTENANCE_HOST_HOME: hostHomeDir,
          MAINTENANCE_BARRIER_DIR: barrierDir,
        },
      },
    );
    children.push(helper);
    await waitForFile(join(barrierDir, "helper-rebound"), 10_000);
    const rebound = JSON.parse(
      await readFile(join(barrierDir, "helper-rebound"), "utf8"),
    ) as { readonly helperPid: number; readonly actuatorPid: number };
    supervisedPids.push(rebound.actuatorPid);
    await new Promise<void>((resolve) => {
      if (helper.exitCode !== null) {
        resolve();
        return;
      }
      helper.once("close", () => resolve());
    });
    expect(helper.exitCode).toBe(0);
    expect(rebound.helperPid).not.toBe(rebound.actuatorPid);

    const blockedBarrier = join(hostHomeDir, "blocked-contender");
    await mkdir(blockedBarrier, { recursive: true });
    const blocked = spawnAttemptCompetitor(hostHomeDir, blockedBarrier);
    await waitForFile(join(blockedBarrier, "busy"), 10_000);
    await new Promise<void>((resolve) => {
      if (blocked.exitCode !== null) {
        resolve();
        return;
      }
      blocked.once("close", () => resolve());
    });
    const busy = JSON.parse(
      await readFile(join(blockedBarrier, "busy"), "utf8"),
    ) as { readonly holder: { readonly pid: number } | null };
    expect(busy.holder?.pid).toBe(rebound.actuatorPid);

    await writeFile(join(barrierDir, "actuator-release"), "");
    await waitForFile(join(barrierDir, "actuator-exited"), 10_000);

    const reclaimBarrier = join(hostHomeDir, "reclaim-contender");
    await mkdir(reclaimBarrier, { recursive: true });
    const reclaim = spawnAttemptCompetitor(hostHomeDir, reclaimBarrier);
    await waitForFile(join(reclaimBarrier, "held"), 10_000);
    const held = JSON.parse(
      await readFile(join(reclaimBarrier, "held"), "utf8"),
    ) as { readonly pid: number };
    expect(held.pid).toBe(reclaim.pid);
    await writeFile(join(reclaimBarrier, "release"), "");
    await waitForFile(join(reclaimBarrier, "released"), 10_000);
  }, 60_000);

  it("uses the live supervisor as the liveness envelope across D death and B/C death ordering", async () => {
    const hostHomeDir = await freshHome();
    const barrierDir = join(hostHomeDir, "os-descendant-barrier");
    await mkdir(barrierDir, { recursive: true });
    const helper = spawn(
      "bun",
      [
        "run",
        join(__dirname, "fixtures", "maintenance-os-descendant-actuator.ts"),
      ],
      {
        env: {
          ...process.env,
          MAINTENANCE_HOST_HOME: hostHomeDir,
          MAINTENANCE_BARRIER_DIR: barrierDir,
          MAINTENANCE_NODE_BINARY: process.execPath,
        },
      },
    );
    children.push(helper);

    await waitForFile(join(barrierDir, "helper-rebound"), 10_000);
    const rebound = JSON.parse(
      await readFile(join(barrierDir, "helper-rebound"), "utf8"),
    ) as {
      readonly wrapperPid: number;
      readonly descendantPid: number;
      readonly supervisorPid: number;
    };
    supervisedPids.push(rebound.supervisorPid, rebound.descendantPid);
    await waitForFile(join(barrierDir, "descendant-ready"), 10_000);

    // D is only a wrapper. Killing it must not make the still-running OS
    // descendant breakable or let a contender race the publisher handoff.
    process.kill(rebound.wrapperPid, "SIGKILL");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const blockedBarrier = join(hostHomeDir, "after-wrapper-death");
    await mkdir(blockedBarrier, { recursive: true });
    const blocked = spawnAttemptCompetitor(hostHomeDir, blockedBarrier);
    await waitForFile(join(blockedBarrier, "busy"), 10_000);
    await new Promise<void>((resolve) => {
      if (blocked.exitCode !== null) resolve();
      else blocked.once("close", () => resolve());
    });
    forgetChild(blocked);
    const busy = JSON.parse(
      await readFile(join(blockedBarrier, "busy"), "utf8"),
    ) as {
      readonly holder: { readonly pid: number } | null;
    };
    // The holder is the live C envelope, never transient D or E.
    expect(busy.holder?.pid).toBe(rebound.supervisorPid);

    // B dying first must not reclaim the attempt while C still owns the
    // detached D/E process group and can perform cleanup.
    process.kill(helper.pid!, "SIGKILL");
    const afterBBarrier = join(hostHomeDir, "after-helper-death");
    await mkdir(afterBBarrier, { recursive: true });
    const afterB = spawnAttemptCompetitor(hostHomeDir, afterBBarrier);
    await waitForFile(join(afterBBarrier, "busy"), 10_000);
    await new Promise<void>((resolve) => {
      if (afterB.exitCode !== null) resolve();
      else afterB.once("close", () => resolve());
    });
    forgetChild(afterB);
    expect(
      JSON.parse(await readFile(join(afterBBarrier, "busy"), "utf8")) as {
        readonly holder: { readonly pid: number } | null;
      },
    ).toMatchObject({ holder: { pid: rebound.supervisorPid } });

    // C death is the reclamation boundary: it kills/reaps D/E before the
    // envelope disappears, after which a fresh contender may acquire.
    process.kill(rebound.supervisorPid, "SIGTERM");
    await waitForFile(join(barrierDir, "descendant-exited"), 10_000);
    await waitForFile(join(barrierDir, "supervisor-exited"), 10_000);
    const reclaimBarrier = join(hostHomeDir, "after-supervisor-death");
    await mkdir(reclaimBarrier, { recursive: true });
    const reclaim = spawnAttemptCompetitor(hostHomeDir, reclaimBarrier);
    await waitForFile(join(reclaimBarrier, "held"), 10_000);
    await writeFile(join(reclaimBarrier, "release"), "");
    await waitForFile(join(reclaimBarrier, "released"), 10_000);
  }, 60_000);

  it("keeps admission busy after hard C death until the supervised D/E group is gone", async () => {
    const hostHomeDir = await freshHome();
    const barrierDir = join(hostHomeDir, "hard-supervisor-death-barrier");
    await mkdir(barrierDir, { recursive: true });
    const helper = spawn(
      "bun",
      [
        "run",
        join(__dirname, "fixtures", "maintenance-os-descendant-actuator.ts"),
      ],
      {
        env: {
          ...process.env,
          MAINTENANCE_HOST_HOME: hostHomeDir,
          MAINTENANCE_BARRIER_DIR: barrierDir,
          MAINTENANCE_NODE_BINARY: process.execPath,
        },
      },
    );
    children.push(helper);
    await waitForFile(join(barrierDir, "helper-rebound"), 10_000);
    const rebound = JSON.parse(
      await readFile(join(barrierDir, "helper-rebound"), "utf8"),
    ) as {
      readonly wrapperPid: number;
      readonly descendantPid: number;
      readonly supervisorPid: number;
    };
    supervisedPids.push(
      rebound.supervisorPid,
      rebound.wrapperPid,
      rebound.descendantPid,
    );
    await waitForFile(join(barrierDir, "descendant-ready"), 10_000);
    const published = JSON.parse(
      await readFile(updateAttemptLockPath(hostHomeDir), "utf8"),
    ) as {
      readonly pid: number;
      readonly supervisedProcessGroupId?: number;
      readonly retainOnPublisherDeath?: boolean;
    };
    expect(published.pid).toBe(rebound.supervisorPid);
    expect(published.supervisedProcessGroupId).toBe(rebound.wrapperPid);
    expect(published.retainOnPublisherDeath).toBe(true);

    // Hard C death bypasses its graceful group-reap handler. B also dies so
    // no normal handback can make the lock disappear while D/E remain live.
    process.kill(rebound.supervisorPid, "SIGKILL");
    helper.kill("SIGKILL");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    forgetChild(helper);
    expect(() => process.kill(rebound.wrapperPid, 0)).not.toThrow();
    expect(() => process.kill(rebound.descendantPid, 0)).not.toThrow();
    expect(() => process.kill(-rebound.wrapperPid, 0)).not.toThrow();

    const blockedBarrier = join(hostHomeDir, "after-hard-supervisor-death");
    await mkdir(blockedBarrier, { recursive: true });
    const blocked = spawnAttemptCompetitor(hostHomeDir, blockedBarrier);
    await waitForFile(join(blockedBarrier, "busy"), 10_000);
    await new Promise<void>((resolve) => {
      if (blocked.exitCode !== null) resolve();
      else blocked.once("close", () => resolve());
    });
    forgetChild(blocked);
    expect(
      JSON.parse(await readFile(join(blockedBarrier, "busy"), "utf8")) as {
        readonly holder: { readonly pid: number } | null;
      },
    ).toMatchObject({ holder: { pid: rebound.supervisorPid } });
    expect(
      await stat(join(barrierDir, "descendant-exited")).then(
        () => false,
        () => true,
      ),
    ).toBe(true);

    // Releasing E (and therefore D's group) is the only reclamation point.
    await writeFile(join(barrierDir, "descendant-release"), "");
    await waitForFile(join(barrierDir, "descendant-exited"), 10_000);
    const reclaimBarrier = join(hostHomeDir, "after-final-descendant");
    await mkdir(reclaimBarrier, { recursive: true });
    const reclaim = spawnAttemptCompetitor(hostHomeDir, reclaimBarrier);
    await waitForFile(join(reclaimBarrier, "held"), 10_000);
    await writeFile(join(reclaimBarrier, "release"), "");
    await waitForFile(join(reclaimBarrier, "released"), 10_000);
  }, 60_000);

  it("C escalates a TERM-resistant descendant and reclaims only after the group is reaped", async () => {
    const hostHomeDir = await freshHome();
    const barrierDir = join(hostHomeDir, "term-resistant-barrier");
    await mkdir(barrierDir, { recursive: true });
    const helper = spawn(
      "bun",
      [
        "run",
        join(__dirname, "fixtures", "maintenance-os-descendant-actuator.ts"),
      ],
      {
        env: {
          ...process.env,
          MAINTENANCE_HOST_HOME: hostHomeDir,
          MAINTENANCE_BARRIER_DIR: barrierDir,
          MAINTENANCE_NODE_BINARY: process.execPath,
          MAINTENANCE_TERM_RESISTANT: "1",
        },
      },
    );
    children.push(helper);
    await waitForFile(join(barrierDir, "helper-rebound"), 10_000);
    const rebound = JSON.parse(
      await readFile(join(barrierDir, "helper-rebound"), "utf8"),
    ) as {
      readonly supervisorPid: number;
      readonly wrapperPid: number;
      readonly descendantPid: number;
    };
    supervisedPids.push(
      rebound.supervisorPid,
      rebound.wrapperPid,
      rebound.descendantPid,
    );
    await waitForFile(join(barrierDir, "descendant-ready"), 10_000);

    process.kill(rebound.supervisorPid, "SIGTERM");
    await waitForFile(join(barrierDir, "descendant-term-received"), 10_000);
    await waitForFile(join(barrierDir, "term-grace-started"), 10_000);
    const graceStartedAt = Number(
      await readFile(join(barrierDir, "term-grace-started"), "utf8"),
    );
    const blockedBarrier = join(hostHomeDir, "during-term-grace");
    await mkdir(blockedBarrier, { recursive: true });
    const blocked = spawnAttemptCompetitor(hostHomeDir, blockedBarrier);
    await waitForFile(join(blockedBarrier, "busy"), 10_000);
    expect(Date.now() - graceStartedAt).toBeLessThan(2_000);
    expect(
      await stat(join(barrierDir, "descendant-release")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    forgetChild(blocked);
    await waitForFile(join(barrierDir, "descendant-killed"), 10_000);
    await waitForFile(join(barrierDir, "group-absent"), 10_000);
    await waitForFile(join(barrierDir, "supervisor-exited"), 10_000);
    await waitForFile(join(barrierDir, "descendant-exited"), 10_000);
    const killedAt = Number(
      await readFile(join(barrierDir, "descendant-killed"), "utf8"),
    );
    expect(killedAt - graceStartedAt).toBeGreaterThanOrEqual(2_000);
    expect(
      JSON.parse(await readFile(join(barrierDir, "descendant-exited"), "utf8")),
    ).toMatchObject({ kind: "sigkill" });
    expect(() => process.kill(-rebound.wrapperPid, 0)).toThrow();

    const reclaimBarrier = join(hostHomeDir, "after-term-resistant-reap");
    await mkdir(reclaimBarrier, { recursive: true });
    const reclaim = spawnAttemptCompetitor(hostHomeDir, reclaimBarrier);
    await waitForFile(join(reclaimBarrier, "held"), 10_000);
    await writeFile(join(reclaimBarrier, "release"), "");
    await waitForFile(join(reclaimBarrier, "released"), 10_000);
    forgetChild(reclaim);
    helper.kill("SIGKILL");
    forgetChild(helper);
  }, 60_000);

  it("keeps a root-style maintenance lease live through the CLI completion gap", async () => {
    const hostHomeDir = await freshHome();
    const barrierDir = join(hostHomeDir, "competitor-barrier");
    await mkdir(barrierDir, { recursive: true });
    let rootActuatorRan = false;

    const outcome = await withUpdateContender(
      options(hostHomeDir, "service-maintenance"),
      async () => {
        // This is the gap a root script has after its lock-aware CLI child
        // reports success and before the first root-side launchctl/rm edge.
        // A real second OS process must still lose the canonical lease here.
        const competitor = spawnAttemptCompetitor(hostHomeDir, barrierDir);
        await waitForFile(join(barrierDir, "busy"), 10_000);
        await new Promise<void>((resolve) => {
          if (competitor.exitCode !== null) {
            resolve();
            return;
          }
          competitor.once("close", () => resolve());
        });
        rootActuatorRan = true;
        return "root-maintenance-complete";
      },
    );

    expect(rootActuatorRan).toBe(true);
    expect(outcome).toEqual({
      kind: "ran",
      result: "root-maintenance-complete",
    });
    await expect(readFile(join(barrierDir, "busy"), "utf8")).resolves.toContain(
      '"holder"',
    );
  }, 30_000);

  it("creates only the canonical parent, binds the capability to it, and preserves legacy absence", async () => {
    const hostHomeDir = await freshHome();
    let callbackCalls = 0;
    let capabilityHome = "";

    const outcome = await withUpdateContender(
      options(hostHomeDir, "legacy-update-shadow"),
      async (capability) => {
        callbackCalls += 1;
        capabilityHome = capability.hostHomeDir;
        expect(
          await verifyUpdateMutationCapability(capability, hostHomeDir),
        ).toEqual({ kind: "live" });
        return "legacy-result";
      },
    );

    expect(outcome).toEqual({ kind: "ran", result: "legacy-result" });
    expect(callbackCalls).toBe(1);
    expect(capabilityHome).toBe(resolve(hostHomeDir));
    await expect(stat(hostHomeDir)).resolves.toBeDefined();
    await expect(stat(updateAttemptRecordPath(hostHomeDir))).rejects.toThrow();
    await expect(stat(updateAttemptLockPath(hostHomeDir))).rejects.toThrow();
    expect(isUpdateAttemptLockHeldInProcess(hostHomeDir)).toBe(false);
  });

  it("preserves the callback for a retained terminal record without selecting a schema-v2 executor", async () => {
    const hostHomeDir = await freshHome();
    // `completedAt` must be INSIDE `TERMINAL_ATTEMPT_RETENTION_MS` for this
    // record to be "retained" at all, which is what the test name claims. It
    // was previously a fixed `2026-01-01`, i.e. months past a seven-day
    // retention - harmless only for as long as `pruneTerminalAttemptRecord` had
    // no production caller. Now that attempt-store open prunes, an expired
    // fixture would be legitimately deleted and the survival assertion below
    // would be asserting that retention does NOT work.
    const terminal = record({
      phase: "complete",
      execution: "terminal",
      completedAt: new Date().toISOString(),
    });
    await writeRecord(hostHomeDir, terminal);

    const outcome = await withUpdateContender(
      options(hostHomeDir, "legacy-update-shadow"),
      async () => "legacy-terminal-result",
    );

    expect(outcome).toEqual({ kind: "ran", result: "legacy-terminal-result" });
    await expect(
      readFile(updateAttemptRecordPath(hostHomeDir), "utf8"),
    ).resolves.toBe(`${JSON.stringify(terminal)}\n`);
  });

  describe("terminal-attempt retention is enforced at attempt-store open", () => {
    // Codex round 3, P2. `pruneTerminalAttemptRecord` had no production caller,
    // so `TERMINAL_ATTEMPT_RETENTION_MS` was dead policy: a terminal attempt
    // that no newer attempt replaced survived forever and `host.status` kept
    // projecting it, so the Overview could show an old failure indefinitely.
    //
    // Wired at lock acquisition because that is the ONLY place it can go: prune
    // is handle-bound, and a handle exists here and on no read path - the very
    // surface that exposes the stale record is structurally unable to expire
    // it.
    const EXPIRED_MS = TERMINAL_ATTEMPT_RETENTION_MS + 60_000;

    it("removes a terminal record older than the retention window", async () => {
      const hostHomeDir = await freshHome();
      await writeRecord(
        hostHomeDir,
        record({
          phase: "complete",
          execution: "terminal",
          completedAt: new Date(Date.now() - EXPIRED_MS).toISOString(),
        }),
      );

      const outcome = await withUpdateContender(
        options(hostHomeDir, "legacy-update-shadow"),
        async () => "ran",
      );

      expect(outcome).toEqual({ kind: "ran", result: "ran" });
      // Gone from disk is exactly what stops `host.status` projecting it: the
      // status read decodes this file, so an absent record is an absent
      // projection.
      await expect(
        stat(updateAttemptRecordPath(hostHomeDir)),
      ).rejects.toThrow();
    });

    it("keeps a terminal record that is still INSIDE the retention window", async () => {
      // The paired direction, and the one that matters: retention must expire
      // old records without becoming "delete every terminal record", which
      // would erase a just-completed failure before anyone could read it.
      const hostHomeDir = await freshHome();
      const fresh = record({
        phase: "complete",
        execution: "terminal",
        completedAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await writeRecord(hostHomeDir, fresh);

      await withUpdateContender(
        options(hostHomeDir, "legacy-update-shadow"),
        async () => "ran",
      );

      await expect(
        readFile(updateAttemptRecordPath(hostHomeDir), "utf8"),
      ).resolves.toBe(`${JSON.stringify(fresh)}\n`);
    });

    it("leaves a NON-terminal record alone however old it is", async () => {
      // Retention is scoped to terminal records. An active attempt that has
      // been running a long time is not garbage, and pruning it would delete
      // live state - so age alone must never be sufficient.
      const hostHomeDir = await freshHome();
      const active = record({
        phase: "downloading",
        execution: "active",
        updatedAt: new Date(Date.now() - EXPIRED_MS).toISOString(),
      });
      await writeRecord(hostHomeDir, active);

      await withUpdateContender(
        options(hostHomeDir, "recovery-maintenance"),
        async () => "ran",
      );

      await expect(
        readFile(updateAttemptRecordPath(hostHomeDir), "utf8"),
      ).resolves.toBe(`${JSON.stringify(active)}\n`);
    });
  });

  it("lets first-run maintenance proceed without manufacturing schema-v2 evidence", async () => {
    const hostHomeDir = await freshHome();
    let callbackCalls = 0;

    const outcome = await withUpdateContender(
      options(hostHomeDir, "service-maintenance"),
      async () => {
        callbackCalls += 1;
        return "legacy-service-result";
      },
    );

    expect(outcome).toEqual({ kind: "ran", result: "legacy-service-result" });
    expect(callbackCalls).toBe(1);
    await expect(stat(updateAttemptRecordPath(hostHomeDir))).rejects.toThrow();
    await expect(stat(updateAttemptLockPath(hostHomeDir))).rejects.toThrow();
  });
});

describe("update mutation capabilities", () => {
  it("distinguishes issued-live, forged, wrong-home, released, and lost capabilities", async () => {
    const hostHomeDir = await freshHome();
    const otherHomeDir = await freshHome();
    let issued: UpdateMutationCapability | null = null;
    let lostInCallback: unknown = null;

    const outcome = await withUpdateContender(
      options(hostHomeDir, "legacy-update-shadow"),
      async (capability) => {
        issued = capability;
        expect(
          await verifyUpdateMutationCapability(capability, hostHomeDir),
        ).toEqual({
          kind: "live",
        });
        expect(
          await verifyUpdateMutationCapability(
            { hostHomeDir } as UpdateMutationCapability,
            hostHomeDir,
          ),
        ).toEqual({ kind: "not-issued" });
        expect(
          await verifyUpdateMutationCapability(capability, otherHomeDir),
        ).toEqual({
          kind: "wrong-host-home",
        });

        await unlink(updateAttemptLockPath(hostHomeDir));
        lostInCallback = await verifyUpdateMutationCapability(
          capability,
          hostHomeDir,
        );
        return "done";
      },
    );

    expect(outcome).toEqual({
      kind: "lock-not-live",
      verdict: { kind: "lost" },
    });
    expect(lostInCallback).toEqual({ kind: "lost" });
    if (issued === null) throw new Error("contender did not issue capability");
    expect(await verifyUpdateMutationCapability(issued, hostHomeDir)).toEqual({
      kind: "released",
    });
  });
});

describe("withUpdateContender - active attempt admissions", () => {
  it("keeps recovery context at both restart consumers while kill-only free-port stays context-free", async () => {
    const cliCommands = resolve(__dirname, "../../../traycer-cli/src/commands");
    const restart = await readFile(
      join(cliCommands, "host-restart.ts"),
      "utf8",
    );
    const freePortAndRestart = await readFile(
      join(cliCommands, "host-free-port-and-restart.ts"),
      "utf8",
    );
    const freePort = await readFile(
      join(cliCommands, "host-free-port.ts"),
      "utf8",
    );

    for (const source of [restart, freePortAndRestart]) {
      expect(source).toContain("withCliUpdateContenderContext");
      expect(source).toContain("contenderContext.recoveryAction");
      expect(source).toContain('admission: "recovery-maintenance"');
    }
    expect(freePort).toContain("withCliUpdateContender");
    expect(freePort).not.toContain("withCliUpdateContenderContext");
    expect(freePort).toContain('admission: "recovery-maintenance"');
  });

  it.each([
    ["legacy-update-shadow", "yield"],
    ["stage-maintenance", "yield"],
    ["uninstall-maintenance", "refuse"],
    ["service-maintenance", "refuse"],
    ["desktop-activation-maintenance", "refuse"],
    ["runtime-repair-maintenance", "refuse"],
    ["recovery-maintenance", "allow"],
  ] as const)(
    "returns the exact %s disposition for a nonterminal record",
    async (admission, disposition) => {
      const hostHomeDir = await freshHome();
      await writeRecord(hostHomeDir, record({}));
      let callbackCalls = 0;

      const outcome = await withUpdateContender(
        options(hostHomeDir, admission),
        async () => {
          callbackCalls += 1;
          return "must-not-run";
        },
      );

      if (admission === "recovery-maintenance") {
        expect(outcome).toEqual({ kind: "ran", result: "must-not-run" });
        expect(callbackCalls).toBe(1);
        return;
      }
      expect(outcome.kind).toBe("nonterminal-attempt");
      if (outcome.kind !== "nonterminal-attempt") return;
      expect(outcome.admission).toBe(admission);
      expect(outcome.disposition).toBe(disposition);
      expect(outcome.record).toEqual(record({}));
      expect(callbackCalls).toBe(0);
    },
  );

  it.each([
    [
      "active-fresh",
      record({ updatedAt: "2026-08-25T00:00:00.000Z" }),
      "restart-current",
    ],
    [
      "active-stale",
      record({ updatedAt: "2020-01-01T00:00:00.000Z" }),
      "restart-current",
    ],
    [
      "parked",
      record({
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
      }),
      "stop-only",
    ],
    [
      "preparing-activate",
      record({
        phase: "preparing",
        execution: "active",
        continuation: "activate",
      }),
      "stop-only",
    ],
    [
      "preparing-resume-apply",
      record({
        phase: "preparing",
        execution: "active",
        continuation: "resume-apply",
      }),
      "restart-current",
    ],
    [
      "restarting-activate",
      record({
        phase: "restarting",
        execution: "active",
        continuation: "activate",
      }),
      "restart-current",
    ],
    [
      "verifying-activate",
      record({
        phase: "verifying",
        execution: "active",
        continuation: "activate",
      }),
      "restart-current",
    ],
    [
      "applying-fresh",
      record({
        phase: "applying",
        execution: "active",
        continuation: null,
      }),
      "stop-only",
    ],
    [
      "applying-resume-apply",
      record({
        phase: "applying",
        execution: "active",
        continuation: "resume-apply",
      }),
      "stop-only",
    ],
    [
      "failed-terminal",
      record({
        phase: "failed",
        execution: "terminal",
        completedAt: "2026-01-01T00:10:00.000Z",
        error: {
          code: "HOST_UPDATE_FAILED",
          message: "test failure",
          phase: "failed",
        },
      }),
      "restart-current",
    ],
    ["absent", null, "restart-current"],
  ] as const)(
    "keeps independent service restart available for %s attempt evidence",
    async (_label, current, expectedRecoveryAction) => {
      const hostHomeDir = await freshHome();
      if (current !== null) await writeRecord(hostHomeDir, current);
      let callbackCalls = 0;
      let recoveryAction: string | undefined;
      const outcome = await withUpdateContender(
        options(hostHomeDir, "recovery-maintenance"),
        async (_capability, context) => {
          callbackCalls += 1;
          recoveryAction = context.recoveryAction;
          return "restart-ran";
        },
      );

      expect(outcome).toEqual({ kind: "ran", result: "restart-ran" });
      expect(callbackCalls).toBe(1);
      expect(recoveryAction).toBe(expectedRecoveryAction);
    },
  );
});

describe("withUpdateContender - fail closed record reads", () => {
  it.each([
    ["corrupt", "not-json"],
    [
      "unsupported-version",
      JSON.stringify({ ...record({}), schemaVersion: 99 }),
    ],
  ] as const)(
    "refuses a %s record without invoking the callback",
    async (_label, bytes) => {
      const hostHomeDir = await freshHome();
      await writeRecord(hostHomeDir, bytes);
      let callbackCalls = 0;

      const outcome = await withUpdateContender(
        options(hostHomeDir, "legacy-update-shadow"),
        async () => {
          callbackCalls += 1;
          return "must-not-run";
        },
      );

      expect(outcome.kind).toBe("record-fail-closed");
      if (outcome.kind !== "record-fail-closed") return;
      expect(outcome.record.kind).toBe(
        _label === "unsupported-version" ? "unsupported-version" : "corrupt",
      );
      expect(callbackCalls).toBe(0);
    },
  );

  it("refuses an unreadable record-shaped entry without treating it as absent", async () => {
    const hostHomeDir = await freshHome();
    await mkdir(hostHomeDir, { recursive: true });
    await mkdir(updateAttemptRecordPath(hostHomeDir));
    let callbackCalls = 0;

    const outcome = await withUpdateContender(
      options(hostHomeDir, "legacy-update-shadow"),
      async () => {
        callbackCalls += 1;
        return "must-not-run";
      },
    );

    expect(outcome.kind).toBe("record-fail-closed");
    if (outcome.kind !== "record-fail-closed") return;
    expect(outcome.record.kind).toBe("unreadable");
    expect(callbackCalls).toBe(0);
  });
});

describe("commitExecutorAttemptMutation - executor-only capability", () => {
  it.each([
    "legacy-update-shadow",
    "stage-maintenance",
    "uninstall-maintenance",
    "service-maintenance",
    "desktop-activation-maintenance",
    "runtime-repair-maintenance",
    "recovery-maintenance",
  ] as const)(
    "throws for the %s admission - only attempt-executor may write through this facade",
    async (admission) => {
      const hostHomeDir = await freshHome();
      let threw: unknown = null;

      await withUpdateContender(
        options(hostHomeDir, admission),
        async (capability) => {
          try {
            await commitExecutorAttemptMutation(capability, hostHomeDir, {
              kind: "create",
              request: baseCreateRequest({}),
            });
          } catch (err) {
            threw = err;
          }
          return "done";
        },
      );

      expect(threw).toBeInstanceOf(Error);
      expect((threw as Error).message).toContain("not admitted");
      // Confirm nothing was actually written by the rejected attempt.
      const record = await readFile(
        updateAttemptRecordPath(hostHomeDir),
        "utf8",
      ).catch(() => null);
      expect(record).toBeNull();
    },
  );

  it("throws for a generic advance intent that targets phase complete - completion requires the verified facade", async () => {
    const hostHomeDir = await freshHome();
    let threw: unknown = null;

    await withUpdateContender(
      options(hostHomeDir, "attempt-executor"),
      async (capability) => {
        const created = await commitExecutorAttemptMutation(
          capability,
          hostHomeDir,
          { kind: "create", request: baseCreateRequest({}) },
        );
        if (created.kind !== "committed") {
          throw new Error(`expected committed create, got ${created.kind}`);
        }
        try {
          await commitExecutorAttemptMutation(capability, hostHomeDir, {
            kind: "advance",
            held: created.identity,
            advance: {
              phase: "complete",
              continuation: null,
              progress: null,
              error: null,
              nowIso: "2026-01-01T00:05:00.000Z",
            },
          });
        } catch (err) {
          threw = err;
        }
        return "done";
      },
    );

    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain(
      "exact running-version verification",
    );
    const onDisk = JSON.parse(
      await readFile(updateAttemptRecordPath(hostHomeDir), "utf8"),
    ) as { readonly phase: string };
    expect(onDisk.phase).toBe("downloading");
  });

  it("commits a legal non-complete advance for the attempt-executor capability", async () => {
    const hostHomeDir = await freshHome();

    const outcome = await withUpdateContender(
      options(hostHomeDir, "attempt-executor"),
      async (capability) => {
        const created = await commitExecutorAttemptMutation(
          capability,
          hostHomeDir,
          { kind: "create", request: baseCreateRequest({}) },
        );
        if (created.kind !== "committed") {
          throw new Error(`expected committed create, got ${created.kind}`);
        }
        return commitExecutorAttemptMutation(capability, hostHomeDir, {
          kind: "advance",
          held: created.identity,
          advance: {
            phase: "preparing",
            continuation: null,
            progress: null,
            error: null,
            nowIso: "2026-01-01T00:05:00.000Z",
          },
        });
      },
    );

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.result.kind).toBe("committed");
  });

  it("commitExecutorAttemptMutation's intent parameter type excludes a structural recover intent - a `recover` literal is a compile-time error, closing the authority-fixup cold-review's public-facade bypass (previously this facade forwarded a caller-constructed recover intent unchanged)", () => {
    const rejectsRecoverIntentAtCompileTime = (
      capability: UpdateMutationCapability,
      hostHomeDir: string,
    ): void => {
      void commitExecutorAttemptMutation(
        capability,
        hostHomeDir,
        // @ts-expect-error `recover` is excluded from
        // commitExecutorAttemptMutation's intent type - only
        // commitExecutorRecoveryMutation accepts it now.
        { kind: "recover", recovery: {} as never },
      );
    };
    void rejectsRecoverIntentAtCompileTime;
    expect(true).toBe(true);
  });
});

describe("commitExecutorRecoveryMutation - the internal recovery-only writer, not barrel-exported", () => {
  it.each([
    "legacy-update-shadow",
    "stage-maintenance",
    "uninstall-maintenance",
    "service-maintenance",
    "desktop-activation-maintenance",
    "runtime-repair-maintenance",
    "recovery-maintenance",
  ] as const)(
    "throws for the %s admission - only attempt-executor may write through this facade",
    async (admission) => {
      const hostHomeDir = await freshHome();
      let threw: unknown = null;

      await withUpdateContender(
        options(hostHomeDir, admission),
        async (capability) => {
          try {
            await commitExecutorRecoveryMutation(capability, hostHomeDir, {
              kind: "recover",
              recovery: {
                expected: {
                  attemptId: "attempt-1",
                  generation: 1,
                  sequence: 1,
                },
                action: "force",
                requestedTargetVersion: "1.2.3",
                evidence: {
                  installed: { kind: "verified", version: "1.2.3" },
                  staged: { kind: "absent" },
                  running: {
                    kind: "verified",
                    version: "1.2.3",
                    owner: "host-home-bound",
                  },
                },
                nowIso: "2026-01-01T00:06:00.000Z",
              },
            });
          } catch (err) {
            threw = err;
          }
          return "done";
        },
      );

      expect(threw).toBeInstanceOf(Error);
      expect((threw as Error).message).toContain("not admitted");
      const record = await readFile(
        updateAttemptRecordPath(hostHomeDir),
        "utf8",
      ).catch(() => null);
      expect(record).toBeNull();
    },
  );

  it("commits a legal recover intent for the attempt-executor capability - the reviewer's exact reproduction shape, now reaching a real evidence-bound terminalization instead of a caller-testimony-only write", async () => {
    const hostHomeDir = await freshHome();

    const outcome = await withUpdateContender(
      options(hostHomeDir, "attempt-executor"),
      async (capability) => {
        const created = await commitExecutorAttemptMutation(
          capability,
          hostHomeDir,
          { kind: "create", request: baseCreateRequest({}) },
        );
        if (created.kind !== "committed") {
          throw new Error(`expected committed create, got ${created.kind}`);
        }
        return commitExecutorRecoveryMutation(capability, hostHomeDir, {
          kind: "recover",
          recovery: {
            expected: created.identity,
            action: "force",
            requestedTargetVersion: "1.2.3",
            evidence: {
              installed: { kind: "verified", version: "1.2.3" },
              staged: { kind: "absent" },
              running: {
                kind: "verified",
                version: "1.2.3",
                owner: "host-home-bound",
              },
            },
            nowIso: "2026-01-01T00:06:00.000Z",
          },
        });
      },
    );

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.result.kind).toBe("committed");
    if (outcome.result.kind !== "committed") return;
    expect(outcome.result.record.phase).toBe("complete");
  });

  it("commitExecutorRecoveryMutation's intent parameter type accepts only a recover intent - a create/advance/supersede literal is a compile-time error", () => {
    const onlyAcceptsRecoverAtCompileTime = (
      capability: UpdateMutationCapability,
      hostHomeDir: string,
    ): void => {
      void commitExecutorRecoveryMutation(
        capability,
        hostHomeDir,
        // @ts-expect-error `create` is not assignable to
        // Extract<AttemptMutationIntent, { kind: "recover" }>.
        { kind: "create", request: baseCreateRequest({}) },
      );
    };
    void onlyAcceptsRecoverAtCompileTime;
    expect(true).toBe(true);
  });
});

describe("public barrel cannot reach a structural recover terminal write (authority-fixup cold-review regression)", () => {
  it("the shared host-update barrel does not export commitExecutorAttemptMutation, commitExecutorRecoveryMutation, or withUpdateExecutorCompletionSegment", async () => {
    const barrel: Record<string, unknown> = await import("../index");
    expect("commitExecutorAttemptMutation" in barrel).toBe(false);
    expect("commitExecutorRecoveryMutation" in barrel).toBe(false);
    expect("withUpdateExecutorCompletionSegment" in barrel).toBe(false);
    // withUpdateContender itself remains the only public admission route -
    // it hands out a capability, never a mutation writer.
    expect(typeof barrel.withUpdateContender).toBe("function");
  });
});

describe("withUpdateExecutorCompletionSegment / ExecutorCompletionSession.complete - the sole terminal-completion path", () => {
  // `sealVerifiedExecutorCompletion`/`commitVerifiedExecutorCompletion` are
  // module-PRIVATE to `contender.ts`. `ExecutorCompletionObservation` (the
  // evidence a caller supplies) is ALSO module-private now - it is a plain,
  // non-exported interface, so `completionEvidence()` below builds a
  // structurally-matching literal, the same as any other caller with access
  // to this module would have to. What actually closes the authority gap is
  // that the only way to reach a terminal write from outside this module is
  // through the `ExecutorCompletionSession` object `withUpdateExecutorCompletionSegment`
  // hands directly to its `run` callback as a THIRD argument - there is no
  // free function to import and call from anywhere else, and the session
  // itself is a plain closure (not an AsyncLocalStorage-propagated value), so
  // it is `revoke()`-d and made single-use the instant that callback settles,
  // not merely "intended" to be scope-bound.
  async function advanceToVerifying(
    capability: UpdateMutationCapability,
    hostHomeDir: string,
  ) {
    const created = await commitExecutorAttemptMutation(
      capability,
      hostHomeDir,
      { kind: "create", request: baseCreateRequest({}) },
    );
    if (created.kind !== "committed") {
      throw new Error(`expected committed create, got ${created.kind}`);
    }
    let current = created;
    for (const phase of [
      "preparing",
      "applying",
      "restarting",
      "verifying",
    ] as const) {
      const advanced = await commitExecutorAttemptMutation(
        capability,
        hostHomeDir,
        {
          kind: "advance",
          held: current.identity,
          advance: {
            phase,
            continuation: null,
            progress: null,
            error: null,
            nowIso: "2026-01-01T00:05:00.000Z",
          },
        },
      );
      if (advanced.kind !== "committed") {
        throw new Error(
          `expected committed advance to ${phase}, got ${advanced.kind}`,
        );
      }
      current = advanced;
    }
    return current;
  }

  // This local shape mirrors the exported, publicly-constructible
  // `ExecutorCompletionObservation` - the argument to
  // `completeUpdateExecutorCompletionSession()`. It is declared locally
  // rather than imported only so the malformed-owner cast below has a named
  // target type in this file; the type itself is not what production keeps
  // private (that is the completion scope/session, not the evidence shape).
  interface CompletionEvidenceInput {
    readonly expected: {
      readonly attemptId: string;
      readonly generation: number;
      readonly sequence: number;
    };
    readonly targetVersion: string;
    readonly runningVersion: string;
    readonly runningOwner: "host-home-bound";
    readonly nowIso: string;
  }

  // The real `ExecutorCompletionObservation.runningOwner` is typed as the
  // single literal `"host-home-bound"`, so the only way to prove the session
  // actually re-checks it (rather than trusting the type) is to force a
  // differently-shaped value through a single direct cast to the exact
  // seal-input type - not a chain through `unknown`.
  type MalformedRunningOwnerEvidence = Omit<
    CompletionEvidenceInput,
    "runningOwner"
  > & { readonly runningOwner: string };

  function completionEvidence(
    overrides: Partial<CompletionEvidenceInput>,
    identity: { attemptId: string; generation: number; sequence: number },
  ): CompletionEvidenceInput {
    return {
      expected: identity,
      targetVersion: "1.2.3",
      runningVersion: "1.2.3",
      runningOwner: "host-home-bound",
      nowIso: "2026-01-01T00:06:00.000Z",
      ...overrides,
    };
  }

  interface ExecutorCompletionTestOptions {
    readonly hostHomeDir: string;
    readonly reason: string;
    readonly waitMs: number;
    readonly pollIntervalMs: number;
  }

  function executorCompletionOptions(
    hostHomeDir: string,
  ): ExecutorCompletionTestOptions {
    return {
      hostHomeDir,
      reason: "contender-test",
      waitMs: 0,
      pollIntervalMs: 10,
    };
  }

  it("ExecutorCompletionSession.complete commits with exact matching identity, target, running version, and host-home-bound owner", async () => {
    const hostHomeDir = await freshHome();

    const outcome = await withUpdateExecutorCompletionSegment(
      executorCompletionOptions(hostHomeDir),
      async (capability, _context, completion) => {
        const verifying = await advanceToVerifying(capability, hostHomeDir);
        return completion.complete(completionEvidence({}, verifying.identity));
      },
    );

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.result.kind).toBe("committed");
    if (outcome.result.kind !== "committed") return;
    expect(outcome.result.record.phase).toBe("complete");
    expect(outcome.result.record.execution).toBe("terminal");
  });

  it.each([
    [
      "wrong version (running does not match target)",
      (identity: { attemptId: string; generation: number; sequence: number }) =>
        completionEvidence({ runningVersion: "9.9.9" }, identity),
    ],
    [
      "wrong owner (running process is not host-home-bound)",
      (identity: {
        attemptId: string;
        generation: number;
        sequence: number;
      }) => {
        const malformed: MalformedRunningOwnerEvidence = {
          ...completionEvidence({}, identity),
          runningOwner: "unbound",
        };
        return malformed as CompletionEvidenceInput;
      },
    ],
  ] as const)(
    "ExecutorCompletionSession.complete itself throws for %s - never even reaches a durable write",
    async (_label, makeEvidence) => {
      const hostHomeDir = await freshHome();
      let threw: unknown = null;

      await withUpdateExecutorCompletionSegment(
        executorCompletionOptions(hostHomeDir),
        async (capability, _context, completion) => {
          const verifying = await advanceToVerifying(capability, hostHomeDir);
          try {
            await completion.complete(makeEvidence(verifying.identity));
          } catch (err) {
            threw = err;
          }
          return "done";
        },
      );

      expect(threw).toBeInstanceOf(Error);
      expect((threw as Error).message).toContain("not exact");
      const onDisk = JSON.parse(
        await readFile(updateAttemptRecordPath(hostHomeDir), "utf8"),
      ) as { readonly phase: string };
      expect(onDisk.phase).toBe("verifying");
    },
  );

  it.each([
    [
      "wrong target (targetVersion no longer matches canonical record)",
      (identity: { attemptId: string; generation: number; sequence: number }) =>
        completionEvidence(
          { targetVersion: "9.9.9", runningVersion: "9.9.9" },
          identity,
        ),
    ],
    [
      "wrong identity (stale generation/sequence)",
      (identity: { attemptId: string; generation: number; sequence: number }) =>
        completionEvidence(
          {
            expected: {
              attemptId: identity.attemptId,
              generation: identity.generation,
              sequence: 1,
            },
          },
          identity,
        ),
    ],
  ] as const)(
    "ExecutorCompletionSession.complete itself succeeds internally but the write is refused intent-not-legal for %s",
    async (_label, makeEvidence) => {
      const hostHomeDir = await freshHome();

      const outcome = await withUpdateExecutorCompletionSegment(
        executorCompletionOptions(hostHomeDir),
        async (capability, _context, completion) => {
          const verifying = await advanceToVerifying(capability, hostHomeDir);
          return completion.complete(makeEvidence(verifying.identity));
        },
      );

      expect(outcome.kind).toBe("ran");
      if (outcome.kind !== "ran") return;
      expect(outcome.result).toMatchObject({
        kind: "rejected",
        reason: "intent-not-legal",
      });
      const onDisk = JSON.parse(
        await readFile(updateAttemptRecordPath(hostHomeDir), "utf8"),
      ) as { readonly phase: string };
      expect(onDisk.phase).toBe("verifying");
    },
  );

  it("refuses intent-not-legal when the canonical record is not in the verifying phase", async () => {
    const hostHomeDir = await freshHome();

    const outcome = await withUpdateExecutorCompletionSegment(
      executorCompletionOptions(hostHomeDir),
      async (capability, _context, completion) => {
        const created = await commitExecutorAttemptMutation(
          capability,
          hostHomeDir,
          { kind: "create", request: baseCreateRequest({}) },
        );
        if (created.kind !== "committed") {
          throw new Error(`expected committed create, got ${created.kind}`);
        }
        return completion.complete(completionEvidence({}, created.identity));
      },
    );

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.result).toMatchObject({
      kind: "rejected",
      reason: "intent-not-legal",
    });
  });

  it("withUpdateExecutorCompletionSegment always forces attempt-executor admission - its options type has no admission field to override", () => {
    const optionsHaveNoAdmissionField = (
      value: ExecutorCompletionTestOptions,
    ): void => {
      // @ts-expect-error `admission` does not exist on
      // WithUpdateExecutorCompletionSegmentOptions - the admission is fixed
      // internally, not caller-selectable.
      void value.admission;
    };
    void optionsHaveNoAdmissionField;
    expect(true).toBe(true);
  });

  it("a session captured from the callback cannot be used after the executor segment settles - revoke() makes it single-use for the segment's own lifetime, not merely for as long as somebody happens to hold a reference", async () => {
    const hostHomeDir = await freshHome();
    const escaped: {
      session: ExecutorCompletionSession | null;
      identity: {
        attemptId: string;
        generation: number;
        sequence: number;
      } | null;
    } = { session: null, identity: null };

    const outcome = await withUpdateExecutorCompletionSegment(
      executorCompletionOptions(hostHomeDir),
      async (capability, _context, completion) => {
        const verifying = await advanceToVerifying(capability, hostHomeDir);
        // Simulates a caller stashing the session object somewhere it
        // outlives the callback - the exact shape of the prior bug, where
        // an AsyncLocalStorage-propagated flag could outlive the callback
        // that established it through a detached async resource.
        escaped.session = completion;
        escaped.identity = verifying.identity;
        return "done";
      },
    );

    expect(outcome.kind).toBe("ran");
    if (escaped.session === null || escaped.identity === null) {
      throw new Error("session/identity were not captured by the callback");
    }
    await expect(
      escaped.session.complete(completionEvidence({}, escaped.identity)),
    ).rejects.toThrow(
      "executor terminal completion was called outside its session",
    );
    const onDisk = JSON.parse(
      await readFile(updateAttemptRecordPath(hostHomeDir), "utf8"),
    ) as { readonly phase: string };
    expect(onDisk.phase).toBe("verifying");
  });

  it("a detached async child that calls complete() after the callback has already returned is rejected, even though it was created while the callback was still live", async () => {
    const hostHomeDir = await freshHome();
    const detached: { promise: Promise<unknown> | null } = { promise: null };

    const outcome = await withUpdateExecutorCompletionSegment(
      executorCompletionOptions(hostHomeDir),
      async (capability, _context, completion) => {
        const verifying = await advanceToVerifying(capability, hostHomeDir);
        // Deliberately NOT awaited: this schedules a macrotask from inside
        // the still-live callback, then returns immediately. `revoke()` runs
        // in `withUpdateExecutorCompletionSegment`'s `finally` as part of
        // this callback's own microtask settling, strictly before the
        // detached `setImmediate` macrotask below can fire.
        detached.promise = new Promise((resolve) => {
          setImmediate(() => {
            resolve(
              completion
                .complete(completionEvidence({}, verifying.identity))
                .catch((err: unknown) => err),
            );
          });
        });
        return "returned-before-detached-child-ran";
      },
    );

    expect(outcome.kind).toBe("ran");
    const detachedResult = await detached.promise;
    if (!(detachedResult instanceof Error)) {
      throw new Error("expected the detached complete() call to reject");
    }
    expect(detachedResult.message).toContain(
      "executor terminal completion was called outside its session",
    );
    const onDisk = JSON.parse(
      await readFile(updateAttemptRecordPath(hostHomeDir), "utf8"),
    ) as { readonly phase: string };
    expect(onDisk.phase).toBe("verifying");
  });

  it("a structurally-matching literal is rejected exactly the same way once the session has been revoked - revocation, not evidence shape, is what gates the write", async () => {
    const hostHomeDir = await freshHome();
    const escaped: { session: ExecutorCompletionSession | null } = {
      session: null,
    };

    await withUpdateExecutorCompletionSegment(
      executorCompletionOptions(hostHomeDir),
      async (capability, _context, completion) => {
        const verifying = await advanceToVerifying(capability, hostHomeDir);
        escaped.session = completion;
        // A perfectly legitimate, exactly-matching literal - the same shape
        // the genuine live verifier would have produced. Even this cannot
        // complete once the session outlives its callback.
        void verifying;
        return "done";
      },
    );

    const verifyingAgain = JSON.parse(
      await readFile(updateAttemptRecordPath(hostHomeDir), "utf8"),
    ) as { attemptId: string; generation: number; sequence: number };
    if (escaped.session === null) {
      throw new Error("session was not captured by the callback");
    }
    await expect(
      escaped.session.complete(completionEvidence({}, verifyingAgain)),
    ).rejects.toThrow(
      "executor terminal completion was called outside its session",
    );
  });

  it("revoke() awaits an already-started in-flight complete() call before the outer segment settles - a completion that began before the callback returned must finish before revocation, not race it (authority-fixup cold-review P1: revocation checked liveness too early and did not track an in-flight write)", async () => {
    const hostHomeDir = await freshHome();
    const gate = deferred();
    let hookEntered = false;
    __setBeforeRecordRenameHookForTest(async () => {
      hookEntered = true;
      await gate.promise;
    });

    let completeSettled = false;
    const detached: { promise: Promise<unknown> | null } = { promise: null };

    const outcomePromise = withUpdateExecutorCompletionSegment(
      executorCompletionOptions(hostHomeDir),
      async (capability, _context, completion) => {
        const verifying = await advanceToVerifying(capability, hostHomeDir);
        // Deliberately NOT awaited: starts the terminal write and returns
        // immediately - the same shape as the CLI's un-awaited detached call
        // reaching the inner mutation lock before `execute()` returns. The
        // hook above pauses this write mid-rename, simulating "already past
        // the last liveness check, mid-durable-write" rather than "not yet
        // started".
        detached.promise = completion
          .complete(completionEvidence({}, verifying.identity))
          .finally(() => {
            completeSettled = true;
          });
        return "returned-with-completion-in-flight";
      },
    );

    await waitUntil(() => hookEntered, 5_000);

    // The callback has already returned and the terminal write is paused
    // mid-rename. `revoke()` runs inside withUpdateExecutorCompletionSegment's
    // own `finally`, so the ENTIRE outer segment promise must not settle
    // until the in-flight write actually finishes.
    let outerSettled = false;
    void outcomePromise.then(() => {
      outerSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(outerSettled).toBe(false);
    expect(completeSettled).toBe(false);

    gate.resolve();

    const outcome = await outcomePromise;
    expect(completeSettled).toBe(true);
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    // The callback's own return value settles independently of the detached
    // write it started; the write's outcome is only observable through the
    // promise it returned, asserted below.
    expect(outcome.result).toBe("returned-with-completion-in-flight");

    if (detached.promise === null) {
      throw new Error("detached complete() promise was not captured");
    }
    await expect(detached.promise).resolves.toMatchObject({
      kind: "committed",
    });
  });
});

describe("withUpdateContender - a generic contender callback cannot receive or use a completion session", () => {
  it("does not accept a 3-parameter callback at the type level, even for attempt-executor admission", () => {
    const attemptToWidenCallback = (): Promise<
      UpdateContenderOutcome<string>
    > =>
      withUpdateContender(
        options("/tmp/does-not-matter", "attempt-executor"),
        // @ts-expect-error `run` is `(capability, context) => Promise<T>` -
        // a third completion parameter is not assignable. Generic contenders
        // are structurally incapable of receiving a session, not merely
        // discouraged from asking for one.
        async (
          capability: UpdateMutationCapability,
          context: UpdateContenderExecutionContext,
          completion: unknown,
        ) => {
          void capability;
          void context;
          void completion;
          return "done";
        },
      );
    void attemptToWidenCallback;
    expect(true).toBe(true);
  });

  it("never passes a third (completion) argument at runtime, even under a type-erasing cast and attempt-executor admission", async () => {
    const hostHomeDir = await freshHome();
    let observedArgCount = -1;
    let observedThirdArg: unknown = "not-yet-observed";

    const outcome = await withUpdateContender(
      options(hostHomeDir, "attempt-executor"),
      (async (...args: unknown[]) => {
        observedArgCount = args.length;
        observedThirdArg = args[2];
        return "done";
      }) as (
        capability: UpdateMutationCapability,
        context: UpdateContenderExecutionContext,
      ) => Promise<string>,
    );

    expect(outcome.kind).toBe("ran");
    expect(observedArgCount).toBe(2);
    expect(observedThirdArg).toBeUndefined();
  });
});
