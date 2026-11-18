import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  killConflictingPortOwner,
  PORT_PROBE_TIMEOUT_MS,
  PORT_RELEASE_VERIFY_TIMEOUT_MS,
} from "../free-port-kill";

const testMutationVerifier = async (): Promise<void> => undefined;

type SpawnOverride = (command: string, args: readonly string[]) => ChildProcess;

const mocks = vi.hoisted(() => ({
  // `null` delegates to the real `spawn` so the Finding 7 tests below (which
  // launch genuine fake-`lsof` scripts off `PATH`) are untouched; only the
  // "post-kill release verification" describe block sets this.
  spawnOverride: null as SpawnOverride | null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (
      command: string,
      args: readonly string[],
      options: SpawnOptions,
    ): ChildProcess => {
      if (mocks.spawnOverride !== null) {
        return mocks.spawnOverride(command, args);
      }
      return actual.spawn(command, args, options);
    },
  };
});

// Finding 7 (ticket-2 review round 1): the `lsof`/`netstat` ownership
// probes now run entirely inside `cli-lock`. Before `PORT_PROBE_TIMEOUT_MS`
// existed, a wedged/hijacked probe binary would hang `execFileAsync`
// forever - the lock holder stays positively alive, so ticket-1's
// hardened stale-lock breaking correctly refuses to break it, and every
// other host mutation wedges until a human kills the process by hand.
// This forces a REAL TERM-ignoring probe binary (not a mocked error shape)
// to hang past the bound, proving the SIGKILL escalation rather than merely
// `execFile`'s soft SIGTERM timeout wiring.
describe.skipIf(process.platform === "win32")(
  "killConflictingPortOwner - bounded probe timeout (Finding 7)",
  () => {
    let binDir: string;
    let fakeLsof: string;
    let originalPath: string | undefined;

    beforeEach(() => {
      binDir = mkdtempSync(join(tmpdir(), "traycer-free-port-hang-test-"));
      // Stands in for the real `lsof` - PATH is prepended with `binDir`
      // below so the probe resolves to this script instead of the system
      // binary. It deliberately ignores SIGTERM, so only the hard SIGKILL
      // escalation can release the CLI lock.
      fakeLsof = join(binDir, "lsof");
      writeFileSync(
        fakeLsof,
        "#!/bin/sh\ntrap '' TERM\nwhile true; do /bin/sleep 1; done\n",
      );
      chmodSync(fakeLsof, 0o755);
      originalPath = process.env.PATH;
      process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    });

    afterEach(() => {
      process.env.PATH = originalPath;
      rmSync(binDir, { recursive: true, force: true });
    });

    it(
      "settles in bounded time with a structured timeout verdict instead of hanging forever",
      async () => {
        const start = Date.now();
        // `process.pid` (this test process) is guaranteed alive, so the
        // liveness pre-check passes and the hung `lsof` stand-in is what
        // actually gets exercised.
        await expect(
          killConflictingPortOwner({
            pid: process.pid,
            port: 65535,
            commandName: "host free-port",
            verifyMutationCapability: testMutationVerifier,
          }),
        ).rejects.toMatchObject({
          details: { probe: "timeout" },
        });
        const elapsedMs = Date.now() - start;
        // Bounded, not indefinite: the TERM-ignoring fixture proves the
        // SIGKILL escalation settles the promise shortly after the soft
        // deadline, instead of waiting for its infinite loop.
        expect(elapsedMs).toBeGreaterThanOrEqual(PORT_PROBE_TIMEOUT_MS);
        expect(elapsedMs).toBeLessThan(PORT_PROBE_TIMEOUT_MS + 3_000);
      },
      PORT_PROBE_TIMEOUT_MS + 5_000,
    );

    it(
      "kills an unbounded-output probe at the output budget instead of growing memory until the deadline",
      async () => {
        writeFileSync(fakeLsof, "#!/bin/sh\nexec yes x\n");
        const start = Date.now();

        await expect(
          killConflictingPortOwner({
            pid: process.pid,
            port: 65535,
            commandName: "host free-port",
            verifyMutationCapability: testMutationVerifier,
          }),
        ).rejects.toMatchObject({
          details: { probe: "output-overflow" },
        });

        expect(Date.now() - start).toBeLessThan(PORT_PROBE_TIMEOUT_MS);
      },
      PORT_PROBE_TIMEOUT_MS,
    );
  },
);

// `verifyPortReleased` is not exported - exercised entirely through the
// public `killConflictingPortOwner`, which requires a pre-kill ownership
// check to pass and a SIGTERM to be "delivered" before the verification
// loop it drives ever runs. `node:child_process.spawn` and `process.kill`
// are stubbed so the loop's outcome is fully controlled without touching a
// real process or a real port. Fake timers collapse the 5s verification
// deadline used by the still-held/unverified cases below to (near-)zero
// wall-clock time.
interface StubProbeChild extends EventEmitter {
  readonly pid: number;
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  kill: (signal: NodeJS.Signals) => boolean;
}

function makeStubProbeChild(): StubProbeChild {
  const emitter = new EventEmitter() as StubProbeChild;
  Object.assign(emitter, {
    pid: 9999,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => true,
  });
  return emitter;
}

// The ONE place this file bridges `StubProbeChild` to `ChildProcess` (see
// `host-start.test.ts`'s identical convention) - one reviewed bridge rather
// than a scattered `as unknown as ChildProcess` at every call site.
function asChildProcess(child: StubProbeChild): ChildProcess {
  const bridged: unknown = child;
  return bridged as ChildProcess;
}

type ProbeResponse =
  | { readonly kind: "close"; readonly stdout: string; readonly code: number }
  | { readonly kind: "error"; readonly err: Record<string, unknown> };

// Fires after `spawn()` returns, so `executePortProbe` has already attached
// its `stdout`/`close`/`error` listeners synchronously - matching a real
// child process, whose I/O always arrives after the caller gets the handle.
function scheduleProbeResponse(
  child: StubProbeChild,
  response: ProbeResponse,
): void {
  Promise.resolve().then(() => {
    if (response.kind === "error") {
      child.emit("error", response.err);
      return;
    }
    if (response.stdout.length > 0) {
      child.stdout.emit("data", Buffer.from(response.stdout));
    }
    child.emit("close", response.code, null);
  });
}

// `lsof -Fpn` output: a line `p<pid>` per matching file descriptor.
function ownsPort(pid: number): ProbeResponse {
  return { kind: "close", stdout: `p${pid}\n`, code: 0 };
}
const NO_LISTENER: ProbeResponse = { kind: "close", stdout: "", code: 1 };
const UNSUPPORTED: ProbeResponse = { kind: "error", err: { code: "ENOENT" } };
const PROBE_TIMEOUT: ProbeResponse = { kind: "error", err: { killed: true } };
const OUTPUT_OVERFLOW: ProbeResponse = {
  kind: "error",
  err: { killed: true, outputOverflow: true },
};

describe.skipIf(process.platform === "win32")(
  "killConflictingPortOwner - post-kill release verification",
  () => {
    const TARGET_PID = 4242;
    const PORT = 51820;
    let killSpy: MockInstance;
    let responseQueue: ProbeResponse[];
    let defaultResponse: ProbeResponse | null;

    beforeEach(() => {
      vi.useFakeTimers();
      responseQueue = [];
      defaultResponse = null;
      mocks.spawnOverride = () => {
        const response = responseQueue.shift() ?? defaultResponse;
        if (response === null || response === undefined) {
          throw new Error(
            "free-port-kill.test.ts: probe response queue exhausted - queue a response or set a default",
          );
        }
        const child = makeStubProbeChild();
        scheduleProbeResponse(child, response);
        return asChildProcess(child);
      };
      // Neither the pre-kill liveness check (`signal: 0`) nor the SIGTERM
      // delivery should touch a real process - both are asserted through
      // the result, not through an actual signal.
      killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    });

    afterEach(() => {
      mocks.spawnOverride = null;
      killSpy.mockRestore();
      vi.useRealTimers();
    });

    it("released: the port has no listener across consecutive checks after SIGTERM", async () => {
      responseQueue = [ownsPort(TARGET_PID)];
      defaultResponse = NO_LISTENER;

      const pending = killConflictingPortOwner({
        pid: TARGET_PID,
        port: PORT,
        commandName: "host free-port",
        verifyMutationCapability: testMutationVerifier,
      });
      await vi.advanceTimersByTimeAsync(PORT_RELEASE_VERIFY_TIMEOUT_MS);
      const result = await pending;

      expect(result.release).toBe("released");
      expect(result.releaseDetail).toContain("no listener");
      expect(result.holderPid).toBeNull();
    });

    // A SINGLE free observation is not a release. It is equally consistent
    // with a supervised process's respawn gap, and returning on it hands the
    // caller a restart that races the replacement.
    it("does not certify a release from one free sample when the port is retaken", async () => {
      responseQueue = [ownsPort(TARGET_PID), NO_LISTENER];
      // The replacement binds immediately after the single free sample.
      defaultResponse = ownsPort(7777);

      const pending = killConflictingPortOwner({
        pid: TARGET_PID,
        port: PORT,
        commandName: "host free-port",
        verifyMutationCapability: testMutationVerifier,
      });
      await vi.advanceTimersByTimeAsync(PORT_RELEASE_VERIFY_TIMEOUT_MS + 1_000);
      const result = await pending;

      expect(result.release).not.toBe("released");
      expect(result.release).toBe("still-held");
      expect(result.holderPid).toBe(7777);
    });

    it("released: the verdict comes from the port probe, never from process liveness", async () => {
      // The verifier does not consult `isProcessAlive` at all any more - a
      // dead pid says nothing about whether the PORT is free, and the module
      // no longer imports it. Only the probe can produce a release. The
      // companion test below pins the case those two facts disagree in.
      responseQueue = [ownsPort(TARGET_PID)];
      defaultResponse = NO_LISTENER;

      const pending = killConflictingPortOwner({
        pid: TARGET_PID,
        port: PORT,
        commandName: "host free-port",
        verifyMutationCapability: testMutationVerifier,
      });
      await vi.advanceTimersByTimeAsync(PORT_RELEASE_VERIFY_TIMEOUT_MS);
      const result = await pending;

      expect(result.release).toBe("released");
      expect(result.holderPid).toBeNull();
    });

    it("still-held: the target died but a replacement listener took the port", async () => {
      // The CLI-011 regression that three reviewers caught. A supervised
      // foreign listener respawning under a NEW pid leaves the conflict fully
      // intact even though the pid we signalled is gone. Reporting `released` here
      // would restart the host onto an occupied port and call it a completed
      // repair - the exact false success this change exists to remove.
      responseQueue = [ownsPort(TARGET_PID)];
      defaultResponse = ownsPort(7777);

      const pending = killConflictingPortOwner({
        pid: TARGET_PID,
        port: PORT,
        commandName: "host free-port",
        verifyMutationCapability: testMutationVerifier,
      });
      await vi.advanceTimersByTimeAsync(PORT_RELEASE_VERIFY_TIMEOUT_MS + 1_000);
      const result = await pending;

      expect(result.release).toBe("still-held");
      expect(result.release).not.toBe("released");
      expect(result.holderPid).toBe(7777);
      expect(result.releaseDetail).toContain("7777");
    });

    // The owner exiting between the ownership probe and the SIGTERM is a race
    // no lock can close, because the process is foreign. Treating the
    // resulting ESRCH as "still held" named a pid that no longer exists and
    // told the operator to terminate it, while the port was already free.
    it("released: the target exits before SIGTERM lands (ESRCH) but the port is free", async () => {
      responseQueue = [ownsPort(TARGET_PID)];
      defaultResponse = NO_LISTENER;
      killSpy.mockImplementation(
        (_pid: number, signal: string | number | undefined) => {
          // The pre-kill liveness probe (signal 0) still succeeds; only the
          // SIGTERM races the exit.
          if (signal === "SIGTERM") {
            throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
          }
          return true;
        },
      );

      const pending = killConflictingPortOwner({
        pid: TARGET_PID,
        port: PORT,
        commandName: "host free-port",
        verifyMutationCapability: testMutationVerifier,
      });
      await vi.advanceTimersByTimeAsync(PORT_RELEASE_VERIFY_TIMEOUT_MS);
      const result = await pending;

      expect(result.release).toBe("released");
      expect(result.killed).toBe(false);
      expect(result.killError).not.toBeNull();
      expect(result.holderPid).toBeNull();
    });

    it("still-held: SIGTERM fails with EPERM and the target keeps the port", async () => {
      responseQueue = [ownsPort(TARGET_PID)];
      defaultResponse = ownsPort(TARGET_PID);
      killSpy.mockImplementation(
        (_pid: number, signal: string | number | undefined) => {
          if (signal === "SIGTERM") {
            throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
          }
          return true;
        },
      );

      const pending = killConflictingPortOwner({
        pid: TARGET_PID,
        port: PORT,
        commandName: "host free-port",
        verifyMutationCapability: testMutationVerifier,
      });
      await vi.advanceTimersByTimeAsync(PORT_RELEASE_VERIFY_TIMEOUT_MS + 1_000);
      const result = await pending;

      expect(result.release).toBe("still-held");
      expect(result.killError).toContain("EPERM");
      expect(result.holderPid).toBe(TARGET_PID);
    });

    // lsof overloads exit 1 for BOTH "nothing matched" and "an error
    // occurred", so an exit-1-with-empty-stdout result is only a clean
    // no-listener signal when stderr is also empty. Certifying a release off
    // an errored probe is the same false success this verification exists to
    // prevent - it would just arrive through a probe failure instead.
    it("unverified, never released: lsof exits 1 with empty stdout but writes to stderr", async () => {
      responseQueue = [ownsPort(TARGET_PID)];
      defaultResponse = {
        kind: "error",
        err: { code: 1, stdout: "", stderr: "lsof: no pwd entry for UID 1000" },
      };

      const pending = killConflictingPortOwner({
        pid: TARGET_PID,
        port: PORT,
        commandName: "host free-port",
        verifyMutationCapability: testMutationVerifier,
      });
      await vi.advanceTimersByTimeAsync(PORT_RELEASE_VERIFY_TIMEOUT_MS + 1_000);
      const result = await pending;

      expect(result.release).toBe("unverified");
      expect(result.release).not.toBe("released");
    });

    // "free, could-not-tell, free" is not two CONSECUTIVE free observations.
    // The middle sample is exactly where a replacement could have bound and
    // unbound unseen, so letting it count would convert an intermittent
    // inability to inspect the port into the stable interval this loop
    // requires.
    it("does not let an unverified probe bridge two free samples into a release", async () => {
      responseQueue = [
        ownsPort(TARGET_PID),
        NO_LISTENER,
        UNSUPPORTED,
        NO_LISTENER,
      ];
      // After the bridged pair, the port is taken again - so if the streak had
      // survived the unverified sample this would already have returned
      // `released` and never reached here.
      defaultResponse = ownsPort(7777);

      const pending = killConflictingPortOwner({
        pid: TARGET_PID,
        port: PORT,
        commandName: "host free-port",
        verifyMutationCapability: testMutationVerifier,
      });
      await vi.advanceTimersByTimeAsync(PORT_RELEASE_VERIFY_TIMEOUT_MS + 1_000);
      const result = await pending;

      expect(result.release).not.toBe("released");
      expect(result.holderPid).toBe(7777);
    });

    it("still-held: target stays alive and keeps the port past the deadline", async () => {
      responseQueue = [ownsPort(TARGET_PID)];
      defaultResponse = ownsPort(TARGET_PID);

      const pending = killConflictingPortOwner({
        pid: TARGET_PID,
        port: PORT,
        commandName: "host free-port",
        verifyMutationCapability: testMutationVerifier,
      });
      await vi.advanceTimersByTimeAsync(PORT_RELEASE_VERIFY_TIMEOUT_MS + 1_000);
      const result = await pending;

      expect(result.release).toBe("still-held");
      expect(result.holderPid).toBe(TARGET_PID);
    });

    it.each([
      ["unsupported (probe binary missing)", UNSUPPORTED],
      ["timeout (probe hung past its own bound)", PROBE_TIMEOUT],
      ["output-overflow (probe exceeded the output budget)", OUTPUT_OVERFLOW],
    ])(
      "unverified, never released: probe stays %s throughout",
      async (_label, errorResponse) => {
        responseQueue = [ownsPort(TARGET_PID)];
        defaultResponse = errorResponse;

        const pending = killConflictingPortOwner({
          pid: TARGET_PID,
          port: PORT,
          commandName: "host free-port",
          verifyMutationCapability: testMutationVerifier,
        });
        await vi.advanceTimersByTimeAsync(
          PORT_RELEASE_VERIFY_TIMEOUT_MS + 1_000,
        );
        const result = await pending;

        expect(result.release).toBe("unverified");
        expect(result.release).not.toBe("released");
      },
    );
  },
);
