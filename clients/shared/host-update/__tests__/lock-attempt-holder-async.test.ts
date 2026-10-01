/**
 * probeAttemptHolder for a supervised-group holder (Electron main): the
 * supervised-group branch of
 * `probeAttemptHolder` (`clients/shared/host-update/lock.ts`) currently calls
 * the SYNC `verifyLockHolderLiveness` (which itself calls sync
 * `verifyProcessIdentity`, which shells out via `execFileSync`) whenever a
 * holder carries `supervisedProcessGroupId` or `retainOnPublisherDeath:
 * true`. A read-only status probe blocking the event loop on a synchronous
 * `ps` spawn is exactly the defect this row targets. Once the fix lands (an
 * async twin, `verifyLockHolderLivenessAsync`, replacing the sync call on
 * this branch), `execFileSync` must never be invoked by this probe.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

import { execFileSync } from "node:child_process";
import { readProcessStartIdentity } from "../../host-lock/process-identity";
import { updateAttemptLockPath } from "../paths";
import { probeAttemptHolder } from "../lock";

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lock-attempt-holder-async-"));
  dirs.push(dir);
  return dir;
}

describe("probeAttemptHolder — supervised-group holder sync-vs-async spawn", () => {
  // A supervised-group holder must be probed WITHOUT any
  // synchronous execFileSync spawn (the mechanism: darwin's
  // readProcessStartIdentityImpl / verifyProcessIdentity shell out via
  // execFileSync — see clients/shared/host-lock/process-identity.ts).
  it("probes a live supervised-group holder without a synchronous execFileSync spawn", async () => {
    const dir = await freshDir();

    // A real, live foreign process to act as the holder.
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    children.push(child);
    await new Promise<void>((resolvePid, rejectPid) => {
      child.once("spawn", () => resolvePid());
      child.once("error", rejectPid);
    });
    const childPid = child.pid;
    if (childPid === undefined) {
      throw new Error("failed to obtain spawned child's pid");
    }

    // Read the child's REAL processStartIdentity before resetting the mock's
    // call count, so this identity read happens for real and the lock file
    // carries a genuine, verifiable identity stamp.
    const startIdentity = readProcessStartIdentity(childPid);

    const lockPath = updateAttemptLockPath(dir);
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: childPid,
        reason: "lock-attempt-holder-async-row3",
        startedAt: new Date().toISOString(),
        hostname: null,
        token: "row3-token",
        processStartedAtMs: null,
        processStartIdentity: startIdentity,
        // Exercises the supervised-group branch. Any integer > 1 is a
        // structurally valid group id per parseLockMetadata's validation;
        // this row is about the SYNC-vs-ASYNC code path, not group-liveness
        // correctness.
        supervisedProcessGroupId: 999999,
      }),
      "utf8",
    );

    const mockedExecFileSync = vi.mocked(execFileSync);
    mockedExecFileSync.mockClear();

    const evidence = await probeAttemptHolder({
      hostHomeDir: dir,
      nowMs: Date.now(),
      cacheTtlMs: 0,
    });

    // THE RED ASSERTION: on current (unmodified) code, the supervised-group
    // branch calls sync verifyLockHolderLiveness -> sync verifyProcessIdentity
    // -> execFileSync("ps", ...) to read the live child's identity, so this
    // fails with a nonzero call count today.
    expect(mockedExecFileSync).not.toHaveBeenCalled();

    // Control assertion, not part of the red: the evidence must still
    // correctly reflect a live/held holder.
    expect(evidence.kind).toBe("holder-live");
    if (evidence.kind === "holder-live") {
      expect(evidence.holder.pid).toBe(childPid);
      expect(evidence.holder.supervisedProcessGroupId).toBe(999999);
    }
  });
});
