import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __acquireCliLockAtPathForTest,
  isProcessAlive,
  type CliLockHandle,
} from "../../store/cli-lock";
import { ownProcessStartIdentity } from "../../store/process-identity";
import { DOCTOR_ISSUE_CODES } from "../issues";
import {
  MARKER_LOCK_RECHECK_DELAY_MS,
  probeUpdateMarkerLock,
} from "../update-marker-lock";

// The probe against real lock files at a temp path: a lock this process
// holds through the real facade, lock files written by hand with a holder
// that has exited, one whose holder cannot be verified, one whose pid was
// recycled, a hold that ends between the two reads, the break-arbitration
// file behind a stale lock in each of its states, empty files on either
// side of the grace window and dated in the future, and unreadable paths.
// No `~/.traycer` is touched - the path is the probe's only input.

let workDir: string;
let lockPath: string;
let breakPath: string;
let held: CliLockHandle | null = null;

const NO_DELAY = async (): Promise<void> => undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "traycer-doctor-marker-lock-"));
  lockPath = join(workDir, "update-progress.json.lock");
  breakPath = `${lockPath}.break`;
});

afterEach(async () => {
  if (held !== null) {
    await held.release();
    held = null;
  }
  // The non-writable-directory case leaves the directory 0555.
  chmodSync(workDir, 0o755);
  rmSync(workDir, { recursive: true, force: true });
});

// Root ignores directory write bits, and Windows has no mode bits to flip.
const CAN_DENY_DIRECTORY_WRITE =
  process.platform !== "win32" && process.getuid?.() !== 0;

function findDeadPid(): number {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = spawnSync(process.execPath, ["-e", "0"]);
    if (result.pid !== undefined && !isProcessAlive(result.pid)) {
      return result.pid;
    }
  }
  throw new Error("could not obtain a dead pid");
}

// A well-formed creation stamp of THIS platform that no process has - the
// only way to model a recycled pid from inside one process.
function foreignStamp(): string | null {
  const own = ownProcessStartIdentity();
  if (own === null) return null;
  return `${own.slice(0, own.indexOf(":"))}:not the holder of this lock 1`;
}

function writeLock(fields: {
  readonly pid: number;
  readonly processStartIdentity: string | null;
}): void {
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: fields.pid,
      reason: "host-update-progress-marker-create",
      startedAt: "2026-09-06T22:00:00.000Z",
      hostname: null,
      token: "test-token",
      processStartedAtMs: null,
      processStartIdentity: fields.processStartIdentity,
    }),
  );
}

function writeBreak(fields: {
  readonly pid: number;
  readonly processStartIdentity: string | null;
}): void {
  writeFileSync(
    breakPath,
    JSON.stringify({
      pid: fields.pid,
      startedAt: "2026-09-06T22:00:00.500Z",
      processStartedAtMs: null,
      processStartIdentity: fields.processStartIdentity,
      token: "break-token",
    }),
  );
}

function ageFile(path: string, secondsAgo: number): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, when, when);
}

describe("probeUpdateMarkerLock", () => {
  it("says nothing when there is no lock file", async () => {
    await expect(
      probeUpdateMarkerLock({ lockPath, delay: NO_DELAY }),
    ).resolves.toBeNull();
  });

  it("reports a lock this process holds across both reads, and nothing once it is released", async () => {
    held = await __acquireCliLockAtPathForTest(lockPath, {
      reason: "host-update-progress-marker-create",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    const delays: number[] = [];
    const issue = await probeUpdateMarkerLock({
      lockPath,
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(issue?.code).toBe(DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_HELD);
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain(`pid ${String(process.pid)}`);
    expect(issue?.message).toContain(lockPath);
    expect(issue?.message).toContain("still running");
    expect(issue?.details).toMatchObject({
      lockPath,
      liveness: "alive-same",
      holder: { pid: process.pid },
    });
    expect(delays).toEqual([MARKER_LOCK_RECHECK_DELAY_MS]);

    await held.release();
    held = null;
    await expect(
      probeUpdateMarkerLock({ lockPath, delay: NO_DELAY }),
    ).resolves.toBeNull();
  });

  it("says nothing for a holder that has exited when the arbitration is free - the next acquisition breaks it", async () => {
    writeLock({ pid: findDeadPid(), processStartIdentity: null });
    await expect(
      probeUpdateMarkerLock({ lockPath, delay: NO_DELAY }),
    ).resolves.toBeNull();
  });

  it("reports a live holder whose identity cannot be verified - the one lock no acquisition will ever break", async () => {
    writeLock({ pid: process.pid, processStartIdentity: null });
    const issue = await probeUpdateMarkerLock({ lockPath, delay: NO_DELAY });
    expect(issue?.code).toBe(DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_HELD);
    expect(issue?.title).toContain("unverifiable");
    expect(issue?.message).toContain("remove the file");
    expect(issue?.details).toMatchObject({ liveness: "indeterminate" });
  });

  it("says nothing for a live pid that is not the holder (recycled pid) when the arbitration is free", async () => {
    const stamp = foreignStamp();
    if (stamp === null) return;
    writeLock({ pid: process.pid, processStartIdentity: stamp });
    await expect(
      probeUpdateMarkerLock({ lockPath, delay: NO_DELAY }),
    ).resolves.toBeNull();
  });

  it("says nothing for a hold that ends between the two reads - a writer in flight", async () => {
    writeLock({
      pid: process.pid,
      processStartIdentity: ownProcessStartIdentity(),
    });
    const issue = await probeUpdateMarkerLock({
      lockPath,
      delay: async () => {
        unlinkSync(lockPath);
      },
    });
    expect(issue).toBeNull();
  });

  it("says nothing for a lock re-taken by another holder between the reads", async () => {
    const own = ownProcessStartIdentity();
    writeLock({ pid: process.pid, processStartIdentity: own });
    const issue = await probeUpdateMarkerLock({
      lockPath,
      delay: async () => {
        writeFileSync(
          lockPath,
          JSON.stringify({
            pid: process.pid,
            reason: "host-update-progress-marker-clear",
            startedAt: "2026-09-06T22:00:01.000Z",
            hostname: null,
            token: "another-token",
            processStartedAtMs: null,
            processStartIdentity: own,
          }),
        );
      },
    });
    expect(issue).toBeNull();
  });

  it("says nothing for a lock that only arrives on the second read", async () => {
    writeFileSync(lockPath, "");
    const issue = await probeUpdateMarkerLock({
      lockPath,
      delay: async () => {
        writeLock({
          pid: process.pid,
          processStartIdentity: ownProcessStartIdentity(),
        });
      },
    });
    expect(issue).toBeNull();
  });

  it("says nothing for a fresh empty lock file - a holder mid-create", async () => {
    writeFileSync(lockPath, "");
    await expect(
      probeUpdateMarkerLock({ lockPath, delay: NO_DELAY }),
    ).resolves.toBeNull();
  });

  it("says nothing for an empty lock file past the grace window when the arbitration is free - the next acquisition age-breaks it", async () => {
    writeFileSync(lockPath, "");
    ageFile(lockPath, 30);
    await expect(
      probeUpdateMarkerLock({ lockPath, delay: NO_DELAY }),
    ).resolves.toBeNull();
  });

  it("reports an empty lock file dated in the future - not age-breakable until that time", async () => {
    writeFileSync(lockPath, "");
    ageFile(lockPath, -120);
    const issue = await probeUpdateMarkerLock({ lockPath, delay: NO_DELAY });
    expect(issue?.code).toBe(
      DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNBREAKABLE,
    );
    expect(issue?.title).toContain("dated in the future");
    expect(issue?.message).toContain("in the future");
  });

  describe("a stale lock behind a wedged break arbitration", () => {
    it("reports a stale (exited-holder) lock whose break file is held by a running breaker", async () => {
      writeLock({ pid: findDeadPid(), processStartIdentity: null });
      writeBreak({
        pid: process.pid,
        processStartIdentity: ownProcessStartIdentity(),
      });
      const issue = await probeUpdateMarkerLock({ lockPath, delay: NO_DELAY });
      expect(issue?.code).toBe(
        DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNBREAKABLE,
      );
      expect(issue?.message).toContain(breakPath);
      expect(issue?.message).toContain(`pid ${String(process.pid)}`);
      expect(issue?.message).toContain("still running");
      expect(issue?.details).toMatchObject({
        breakPath,
        cause: "breaker-live",
        breaker: { pid: process.pid },
      });
    });

    it("reports a stale lock whose break file is held by an unverifiable breaker", async () => {
      writeLock({ pid: findDeadPid(), processStartIdentity: null });
      writeBreak({ pid: process.pid, processStartIdentity: null });
      const issue = await probeUpdateMarkerLock({ lockPath, delay: NO_DELAY });
      expect(issue?.code).toBe(
        DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNBREAKABLE,
      );
      expect(issue?.details).toMatchObject({ cause: "breaker-unverifiable" });
    });

    it("reports a stale (recycled-pid) lock behind a live breaker too", async () => {
      const stamp = foreignStamp();
      if (stamp === null) return;
      writeLock({ pid: process.pid, processStartIdentity: stamp });
      writeBreak({
        pid: process.pid,
        processStartIdentity: ownProcessStartIdentity(),
      });
      const issue = await probeUpdateMarkerLock({ lockPath, delay: NO_DELAY });
      expect(issue?.code).toBe(
        DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNBREAKABLE,
      );
      expect(issue?.message).toContain("belongs to another process");
    });

    it("reports an aged empty lock behind a live breaker", async () => {
      writeFileSync(lockPath, "");
      ageFile(lockPath, 30);
      writeBreak({
        pid: process.pid,
        processStartIdentity: ownProcessStartIdentity(),
      });
      const issue = await probeUpdateMarkerLock({ lockPath, delay: NO_DELAY });
      expect(issue?.code).toBe(
        DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNBREAKABLE,
      );
      expect(issue?.message).toContain("empty or corrupt file");
    });

    it("says nothing when the break file was left by a crashed breaker past its grace - the next contender recovers it", async () => {
      writeLock({ pid: findDeadPid(), processStartIdentity: null });
      writeBreak({ pid: findDeadPid(), processStartIdentity: null });
      ageFile(breakPath, 30);
      await expect(
        probeUpdateMarkerLock({ lockPath, delay: NO_DELAY }),
      ).resolves.toBeNull();
    });

    it("says nothing when the break file was left by a crashed breaker moments ago - recovered within the contender's own wait", async () => {
      writeLock({ pid: findDeadPid(), processStartIdentity: null });
      writeBreak({ pid: findDeadPid(), processStartIdentity: null });
      await expect(
        probeUpdateMarkerLock({ lockPath, delay: NO_DELAY }),
      ).resolves.toBeNull();
    });

    it("says nothing when the break file is empty and past its grace", async () => {
      writeLock({ pid: findDeadPid(), processStartIdentity: null });
      writeFileSync(breakPath, "");
      ageFile(breakPath, 30);
      await expect(
        probeUpdateMarkerLock({ lockPath, delay: NO_DELAY }),
      ).resolves.toBeNull();
    });

    it("reports a break file dated in the future", async () => {
      writeLock({ pid: findDeadPid(), processStartIdentity: null });
      writeBreak({ pid: findDeadPid(), processStartIdentity: null });
      ageFile(breakPath, -120);
      const issue = await probeUpdateMarkerLock({ lockPath, delay: NO_DELAY });
      expect(issue?.code).toBe(
        DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNBREAKABLE,
      );
      expect(issue?.details).toMatchObject({ cause: "dated-in-the-future" });
    });

    it("reports a break file that cannot be read", async () => {
      writeLock({ pid: findDeadPid(), processStartIdentity: null });
      mkdirSync(breakPath);
      const issue = await probeUpdateMarkerLock({ lockPath, delay: NO_DELAY });
      expect(issue?.code).toBe(
        DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNREADABLE,
      );
      expect(issue?.title).toContain("break-arbitration");
      expect(issue?.details).toEqual({ lockPath, breakPath });
    });
  });

  describe.skipIf(!CAN_DENY_DIRECTORY_WRITE)(
    "a stale lock in a directory this user cannot write",
    () => {
      it("reports an exited-holder lock whose directory cannot be unlinked from, even with the arbitration free", async () => {
        writeLock({ pid: findDeadPid(), processStartIdentity: null });
        chmodSync(workDir, 0o555);
        const issue = await probeUpdateMarkerLock({
          lockPath,
          delay: NO_DELAY,
        });
        expect(issue?.code).toBe(
          DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNBREAKABLE,
        );
        expect(issue?.title).toContain("not writable");
        expect(issue?.message).toContain(workDir);
        expect(issue?.details).toMatchObject({
          cause: "directory-not-writable",
          directory: workDir,
        });
      });

      it("reports an aged empty lock the same way", async () => {
        writeFileSync(lockPath, "");
        ageFile(lockPath, 30);
        chmodSync(workDir, 0o555);
        const issue = await probeUpdateMarkerLock({
          lockPath,
          delay: NO_DELAY,
        });
        expect(issue?.code).toBe(
          DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNBREAKABLE,
        );
        expect(issue?.details).toMatchObject({
          cause: "directory-not-writable",
        });
      });

      it("stays silent for a LIVE holder's directory permissions - that lock is released by its holder, not unlinked", async () => {
        writeLock({
          pid: process.pid,
          processStartIdentity: ownProcessStartIdentity(),
        });
        chmodSync(workDir, 0o555);
        const issue = await probeUpdateMarkerLock({
          lockPath,
          delay: NO_DELAY,
        });
        expect(issue?.code).toBe(
          DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_HELD,
        );
      });
    },
  );

  it("reports a lock path that exists but cannot be read", async () => {
    mkdirSync(lockPath);
    const issue = await probeUpdateMarkerLock({ lockPath, delay: NO_DELAY });
    expect(issue?.code).toBe(
      DOCTOR_ISSUE_CODES.HOST_UPDATE_MARKER_LOCK_UNREADABLE,
    );
    expect(issue?.details).toEqual({ lockPath, breakPath: null });
  });
});
