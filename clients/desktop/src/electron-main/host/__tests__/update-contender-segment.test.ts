import { mkdir, mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireUpdateAttemptLock,
  commitAttemptMutationWithCapability,
  updateAttemptLockPath,
  type LockMetadata,
  type UpdateContenderAdmission,
} from "@traycer-clients/shared/host-update";
import {
  acquireDesktopCliLock,
  type DesktopCliLockHandle,
} from "../desktop-cli-lock";
import {
  DesktopCliLockBusyError,
  withDesktopAttemptExecutor,
  withDesktopAttemptMutation,
  withDesktopUpdateExecutionSegment,
  type WithDesktopUpdateSegmentOptions,
} from "../update-contender";

// New segment primitives for the packaged-macOS executor (design §3.1): the
// outer attempt-lock-only segment, the forced attempt-executor admission,
// and the inner short cli-lock mutation window. `withDesktopUpdateContender`
// (the existing whole-callback wrapper) already has its own suite; these
// cover the additions that make a minute-long segment safe to hold without
// nesting `cli-lock` inside it for the whole duration.

const roots: string[] = [];
const heldLocks: DesktopCliLockHandle[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-update-segment-test-"));
  roots.push(root);
  return root;
}

function segmentOptions(
  hostHomeDir: string,
  lockPath: string,
  admission: UpdateContenderAdmission,
): WithDesktopUpdateSegmentOptions {
  return {
    hostHomeDir,
    lockPath,
    reason: "desktop-segment-test",
    waitMs: 0,
    pollIntervalMs: 10,
    admission,
  };
}

afterEach(async () => {
  await Promise.all(
    heldLocks
      .splice(0)
      .map((handle) => handle.release().catch(() => undefined)),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("withDesktopUpdateExecutionSegment", () => {
  it("holds only the outer attempt lock around the callback, never the cli lock", async () => {
    const root = await freshRoot();
    const hostHomeDir = join(root, "host-home");
    const lockPath = join(root, "cli-lock");
    await mkdir(hostHomeDir, { recursive: true });

    const outcome = await withDesktopUpdateExecutionSegment(
      segmentOptions(hostHomeDir, lockPath, "attempt-executor"),
      async () => {
        // The cli lock must be free for the callback to take itself, on
        // demand, for exactly the short window it needs it - not held for
        // the whole segment by the wrapper.
        const acquired = await acquireDesktopCliLock({
          lockPath,
          reason: "segment-body-self-acquire",
          waitMs: 0,
          pollIntervalMs: 10,
        });
        expect(acquired.kind).toBe("acquired");
        if (acquired.kind === "acquired") {
          await acquired.handle.release();
        }
        await expect(
          stat(updateAttemptLockPath(hostHomeDir)),
        ).resolves.toBeDefined();
        return "segment-ok";
      },
    );

    expect(outcome).toEqual({ kind: "acquired", result: "segment-ok" });
    await expect(stat(updateAttemptLockPath(hostHomeDir))).rejects.toThrow();
  });

  it("maps a real outer-attempt holder to a busy/attempt outcome, without running the callback", async () => {
    const root = await freshRoot();
    const hostHomeDir = join(root, "host-home");
    const lockPath = join(root, "cli-lock");
    await mkdir(hostHomeDir, { recursive: true });
    const held = await acquireUpdateAttemptLock({
      hostHomeDir,
      reason: "outer-holder",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    expect(held.kind).toBe("acquired");
    if (held.kind !== "acquired") return;
    try {
      let ran = false;
      const outcome = await withDesktopUpdateExecutionSegment(
        segmentOptions(hostHomeDir, lockPath, "attempt-executor"),
        async () => {
          ran = true;
          return "must-not-run";
        },
      );
      expect(ran).toBe(false);
      expect(outcome).toMatchObject({ kind: "busy", source: "attempt" });
    } finally {
      await held.handle.release();
    }
  });
});

describe("withDesktopAttemptExecutor", () => {
  it("forces attempt-executor admission - the issued capability can reach commitAttemptMutationWithCapability", async () => {
    const root = await freshRoot();
    const hostHomeDir = join(root, "host-home");
    const lockPath = join(root, "cli-lock");
    await mkdir(hostHomeDir, { recursive: true });

    const outcome = await withDesktopAttemptExecutor(
      {
        hostHomeDir,
        lockPath,
        reason: "executor-admission-test",
        waitMs: 0,
        pollIntervalMs: 10,
      },
      async (capability) => {
        const commit = await commitAttemptMutationWithCapability(
          capability,
          hostHomeDir,
          {
            kind: "create",
            request: {
              targetVersion: "2.0.0",
              trigger: "manual",
              action: "start",
              expected: null,
              newAttemptId: "desktop-executor-attempt-1",
              initialPhase: "preparing",
              nowIso: "2026-01-01T00:00:00.000Z",
            },
          },
        );
        expect(commit.kind).toBe("committed");
        return "ok";
      },
    );
    expect(outcome).toEqual({ kind: "acquired", result: "ok" });
  });

  it("a same-shaped segment under a non-executor admission cannot reach the executor-only write boundary", async () => {
    const root = await freshRoot();
    const hostHomeDir = join(root, "host-home");
    const lockPath = join(root, "cli-lock");
    await mkdir(hostHomeDir, { recursive: true });

    const outcome = await withDesktopUpdateExecutionSegment(
      segmentOptions(hostHomeDir, lockPath, "desktop-activation-maintenance"),
      async (capability) => {
        await expect(
          commitAttemptMutationWithCapability(capability, hostHomeDir, {
            kind: "create",
            request: {
              targetVersion: "2.0.0",
              trigger: "manual",
              action: "start",
              expected: null,
              newAttemptId: "desktop-maintenance-attempt-1",
              initialPhase: "preparing",
              nowIso: "2026-01-01T00:00:00.000Z",
            },
          }),
        ).rejects.toThrow(/not admitted/);
        return "checked";
      },
    );
    expect(outcome).toEqual({ kind: "acquired", result: "checked" });
  });
});

describe("DesktopCliLockBusyError", () => {
  it("carries the observed holder so a catcher can report who is busy", () => {
    const holder: LockMetadata = {
      pid: 4242,
      token: "tok",
      reason: "fixture",
      startedAt: "2026-01-01T00:00:00.000Z",
      hostname: null,
      processStartedAtMs: null,
      processStartIdentity: null,
    };
    const err = new DesktopCliLockBusyError(holder);
    expect(err).toBeInstanceOf(Error);
    expect(err.holder).toBe(holder);
  });

  it("also accepts a null holder (contention observed with no readable metadata)", () => {
    const err = new DesktopCliLockBusyError(null);
    expect(err.holder).toBeNull();
  });
});

describe("withDesktopAttemptMutation", () => {
  it("runs the mutator under the short-lived cli lock, verifying the capability before and after acquiring it", async () => {
    const root = await freshRoot();
    const hostHomeDir = join(root, "host-home");
    const lockPath = join(root, "cli-lock");
    await mkdir(hostHomeDir, { recursive: true });

    const outcome = await withDesktopUpdateExecutionSegment(
      segmentOptions(hostHomeDir, lockPath, "attempt-executor"),
      async (capability) => {
        const result = await withDesktopAttemptMutation(
          capability,
          segmentOptions(hostHomeDir, lockPath, "attempt-executor"),
          async (cliLock) => {
            await expect(stat(lockPath)).resolves.toBeDefined();
            expect(cliLock.metadata.pid).toBe(process.pid);
            return "mutated";
          },
        );
        expect(result).toBe("mutated");
        // Released again after the short window closes, well before the
        // outer segment itself releases.
        await expect(stat(lockPath)).rejects.toThrow();
        return "segment-ok";
      },
    );
    expect(outcome).toEqual({ kind: "acquired", result: "segment-ok" });
  });

  it("surfaces cli-lock contention as DesktopCliLockBusyError, which the segment maps to busy/cli without running the mutator", async () => {
    const root = await freshRoot();
    const hostHomeDir = join(root, "host-home");
    const lockPath = join(root, "cli-lock");
    await mkdir(hostHomeDir, { recursive: true });
    const externalHolder = await acquireDesktopCliLock({
      lockPath,
      reason: "external-cli-holder",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    expect(externalHolder.kind).toBe("acquired");
    if (externalHolder.kind !== "acquired") return;
    heldLocks.push(externalHolder.handle);

    let mutatorRan = false;
    const outcome = await withDesktopUpdateExecutionSegment(
      segmentOptions(hostHomeDir, lockPath, "attempt-executor"),
      async (capability) =>
        // Deliberately not caught here: `DesktopCliLockBusyError` is meant to
        // propagate out of this callback, several frames below where it was
        // thrown, so the segment wrapper itself is what maps it to a result.
        withDesktopAttemptMutation(
          capability,
          segmentOptions(hostHomeDir, lockPath, "attempt-executor"),
          async () => {
            mutatorRan = true;
            return "must-not-run";
          },
        ),
    );

    expect(mutatorRan).toBe(false);
    expect(outcome).toMatchObject({ kind: "busy", source: "cli" });
    if (outcome.kind === "busy") {
      expect(outcome.holder?.token).toBe(externalHolder.handle.metadata.token);
    }
  });

  it("refuses to acquire the cli lock at all once the capability has already been lost", async () => {
    const root = await freshRoot();
    const hostHomeDir = join(root, "host-home");
    const lockPath = join(root, "cli-lock");
    await mkdir(hostHomeDir, { recursive: true });

    const outcome = await withDesktopUpdateExecutionSegment(
      segmentOptions(hostHomeDir, lockPath, "attempt-executor"),
      async (capability) => {
        await unlink(updateAttemptLockPath(hostHomeDir));
        await expect(
          withDesktopAttemptMutation(
            capability,
            segmentOptions(hostHomeDir, lockPath, "attempt-executor"),
            async () => "must-not-run",
          ),
        ).rejects.toMatchObject({ verdict: "lost" });
        // Never even attempted, so nothing was left on disk.
        await expect(stat(lockPath)).rejects.toThrow();
        return "checked";
      },
    );
    // The outer segment's own post-callback verification also observes the
    // lost lock and reports it as capability-not-live.
    expect(outcome).toMatchObject({ kind: "capability-not-live" });
  });
});
