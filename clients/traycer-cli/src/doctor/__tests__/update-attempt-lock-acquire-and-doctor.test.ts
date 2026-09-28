import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lockHolderLivenessGivenPublisher } from "@traycer-clients/shared/host-lock/cross-process-lock";
import { verifyProcessIdentityAsync } from "@traycer-clients/shared/host-lock/process-identity";
import {
  acquireUpdateAttemptLock,
  updateAttemptLockPath,
  type UpdateAttemptLockHandle,
} from "@traycer-clients/shared/host-update";
import { DOCTOR_ISSUE_CODES } from "../issues";
import { probeUpdateAttemptLock } from "../update-attempt-lock";

// Doctor judges the retain-flag dead-pid record with the async
// verifier + `lockHolderLivenessGivenPublisher`; acquisition uses the
// sync `verifyLockHolderLiveness`. This file acquires against that
// record and asserts both the doctor issue and the acquire refusal.
//
// Ablation (named production mutation): make `verifyLockHolderLiveness`
// return only `verifyProcessIdentity(...)` and skip
// `lockHolderLivenessGivenPublisher`. Doctor still flags; acquire
// stale-breaks (`kind: "acquired"`).

const dirs: string[] = [];
const handles: UpdateAttemptLockHandle[] = [];

afterEach(async () => {
  await Promise.all(
    handles.splice(0).map((handle) => handle.release().catch(() => undefined)),
  );
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function spawnAndWaitDeadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "0"]);
  if (result.pid === undefined) {
    throw new Error("could not obtain a pid from the spawned child");
  }
  return result.pid;
}

describe("update-attempt lock acquire vs doctor on a retain-flag dead-pid record", () => {
  it("refuses acquire and reports HOST_UPDATE_ATTEMPT_LOCK_UNBREAKABLE", async () => {
    const hostHomeDir = mkdtempSync(join(tmpdir(), "tu6-attempt-lock-"));
    dirs.push(hostHomeDir);
    const lockPath = updateAttemptLockPath(hostHomeDir);
    const deadPid = spawnAndWaitDeadPid();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        reason: "host-maintenance-lease",
        startedAt: "2026-09-06T22:00:00.000Z",
        hostname: null,
        token: "tu6-retain-dead-pid",
        processStartedAtMs: null,
        processStartIdentity: null,
        retainOnPublisherDeath: true,
      }),
    );

    const issue = await probeUpdateAttemptLock({
      lockPath,
      verifyPublisher: verifyProcessIdentityAsync,
      livenessGivenPublisher: lockHolderLivenessGivenPublisher,
    });
    expect(issue).not.toBeNull();
    expect(issue?.code).toBe(
      DOCTOR_ISSUE_CODES.HOST_UPDATE_ATTEMPT_LOCK_UNBREAKABLE,
    );

    const outcome = await acquireUpdateAttemptLock({
      hostHomeDir,
      reason: "tu6-acquire-against-retain-dead-pid",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    if (outcome.kind === "acquired") {
      handles.push(outcome.handle);
    }
    expect(outcome.kind).toBe("busy");
  });
});
