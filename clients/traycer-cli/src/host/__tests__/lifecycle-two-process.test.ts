import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseDesktopPresenceText,
  serializeDesktopPresence,
  type DesktopPresence,
  type DesktopPresenceOnExit,
} from "@traycer/protocol/config/desktop-presence";
import type { ILogger } from "../../logger";
import { readProcessStartIdentity } from "../../store/process-identity";
import {
  probeDesktopPresenceLiveness,
  type LifecycleRecordRead,
} from "../lifecycle-files";
import {
  startLifecycleObserver,
  LIFECYCLE_OBSERVER_POLL_MS,
  LIFECYCLE_PRESENCE_CRASH_GRACE_MS,
  type LifecycleObserverHandle,
  type LifecycleObserverRuntime,
} from "../lifecycle-observer";
import {
  createLifecycleTeardown,
  type LifecycleTeardownPlatform,
  type OwnedHostChild,
} from "../lifecycle-teardown";
import type { HostPidMetadata } from "../pid-metadata";

// The observer and actuator against a REAL second process standing in for the
// desktop: presence liveness is the real pid + start-identity probe, read from
// a real `desktop-presence.json`. Only the host itself is faked.

const GRACE = LIFECYCLE_PRESENCE_CRASH_GRACE_MS;
const silent: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function spawnFakeDesktop(): Promise<ChildProcess> {
  const desktop = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      stdio: "ignore",
    },
  );
  cleanups.push(async () => {
    desktop.kill("SIGKILL");
  });
  await new Promise<void>((resolve, reject) => {
    desktop.once("spawn", () => resolve());
    desktop.once("error", reject);
  });
  return desktop;
}

function killAndWait(desktop: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    desktop.once("exit", () => resolve());
    desktop.kill("SIGKILL");
  });
}

interface Rig {
  readonly handle: LifecycleObserverHandle;
  readonly tick: () => void;
  readonly clock: { now: number };
  readonly seen: {
    cooperative: number;
    purged: number[];
    completes: number;
    ticks: number;
  };
  readonly adopted: { value: boolean };
  readonly settle: () => Promise<void>;
}

async function buildRig(input: {
  readonly presenceFile: string;
  readonly initialAdopted: boolean;
}): Promise<Rig> {
  const clock = { now: 0 };
  const seen: Rig["seen"] = {
    cooperative: 0,
    purged: [],
    completes: 0,
    ticks: 0,
  };
  const adopted = { value: input.initialAdopted };
  let tickFn: () => void = () => undefined;
  const runtime: LifecycleObserverRuntime = {
    nowMs: () => clock.now,
    scheduleTicks: (_interval, tick) => {
      tickFn = tick;
      return () => undefined;
    },
    watchHostHome: () => null,
  };
  let ended = false;
  const child: OwnedHostChild = {
    pid: 999_999,
    ended: () => ended,
    waitForEnd: async () => ended,
    signal: () => undefined,
  };
  let pidRecord: HostPidMetadata | null = {
    pid: child.pid,
    hostId: "h",
    version: "1.0.0",
    websocketUrl: "ws://127.0.0.1:1",
    startedAt: "2026-01-01T00:00:00.000Z",
    processStartIdentity: "child-ident",
    processStartIdentityRead: "present",
    layer0: null,
    layer0Slot: null,
  };
  const platform: LifecycleTeardownPlatform = {
    platform: "linux",
    withLock: async (_env, run) => run(async () => undefined),
    readPidMetadata: async () => pidRecord,
    requestCooperativeShutdown: async () => {
      seen.cooperative += 1;
      ended = true;
      return { kind: "stopped" };
    },
    forceStopPublishedHost: async () => ({ kind: "no-metadata" }),
    killHostTree: async () => undefined,
    verifyPublishedInstance: async () => "dead",
    removePidMetadataIfUnchanged: async (_env, instance) => {
      seen.purged.push(instance.pid);
      pidRecord = null;
      return true;
    },
  };
  const teardown = createLifecycleTeardown({
    environment: "dev",
    logger: silent,
    platform,
    ownChild: () => child,
    commit: () => undefined,
  });
  const readPresence = async (): Promise<
    LifecycleRecordRead<DesktopPresence>
  > => {
    let text: string;
    try {
      text = await readFile(input.presenceFile, "utf8");
    } catch {
      return { kind: "absent" };
    }
    const record = parseDesktopPresenceText(text);
    return record === null ? { kind: "invalid" } : { kind: "valid", record };
  };
  const handle = startLifecycleObserver({
    environment: "dev",
    logger: silent,
    runtime,
    reads: {
      readPolicy: async () => ({
        kind: "valid",
        record: {
          v: 1,
          rev: 1,
          mode: "linked",
          updatedAt: "t",
          updatedBy: "cli",
        },
      }),
      readPresence,
      probePresence: probeDesktopPresenceLiveness,
    },
    nowIso: () => "2026-01-01T00:00:00.000Z",
    pollMs: LIFECYCLE_OBSERVER_POLL_MS,
    graceMs: GRACE,
    initial: { adopted: input.initialAdopted, lastPresence: null },
    publishRunState: async (facts) => {
      adopted.value = facts.adopted;
    },
    teardown,
    onTeardownComplete: () => {
      seen.completes += 1;
    },
  });
  cleanups.push(async () => handle.stop());
  return {
    handle,
    tick: () => tickFn(),
    clock,
    seen,
    adopted,
    settle: async () => {
      await handle.idle();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await handle.idle();
    },
  };
}

async function writePresence(
  file: string,
  pid: number,
  onExit: DesktopPresenceOnExit,
): Promise<void> {
  const identity = await readProcessStartIdentity(pid);
  if (identity === null)
    throw new Error("could not read the fake desktop's identity");
  const presence: DesktopPresence = {
    v: 1,
    pid,
    processStartIdentity: identity,
    onExit,
    policyRev: 1,
    writtenAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(file, serializeDesktopPresence(presence), "utf8");
}

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lifecycle-two-process-"));
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return join(dir, "desktop-presence.json");
}

const describeUnlessWindows =
  process.platform === "win32" ? describe.skip : describe;

describeUnlessWindows(
  "lifecycle observer against a real second process",
  () => {
    it("adopts while the desktop lives; kill it, pass the grace, and the host is stopped and its record purged", async () => {
      const file = await tempFile();
      const desktop = await spawnFakeDesktop();
      const desktopPid = desktop.pid;
      if (desktopPid === undefined) throw new Error("no fake desktop pid");
      await writePresence(file, desktopPid, "stop");
      const rig = await buildRig({ presenceFile: file, initialAdopted: false });

      rig.tick();
      await rig.settle();
      expect(rig.adopted.value).toBe(true);
      expect(rig.seen.cooperative).toBe(0);

      // Alive at any later time: the grace never starts.
      rig.clock.now = GRACE * 10;
      rig.tick();
      await rig.settle();
      expect(rig.seen.cooperative).toBe(0);

      await killAndWait(desktop);
      rig.clock.now = 1_000_000;
      rig.tick();
      await rig.settle();
      // Positively dead, but inside the crash grace.
      expect(rig.seen.cooperative).toBe(0);

      rig.clock.now = 1_000_000 + GRACE;
      rig.tick();
      await rig.settle();
      expect(rig.seen.cooperative).toBe(1);
      expect(rig.seen.purged).toEqual([999_999]);
      expect(rig.seen.completes).toBe(1);
    });

    it.each(["keep", "handoff"] as const)(
      "a %s verdict: the desktop dying triggers nothing",
      async (verdict) => {
        const file = await tempFile();
        const desktop = await spawnFakeDesktop();
        const desktopPid = desktop.pid;
        if (desktopPid === undefined) throw new Error("no fake desktop pid");
        await writePresence(file, desktopPid, verdict);
        const rig = await buildRig({
          presenceFile: file,
          initialAdopted: false,
        });
        rig.tick();
        await rig.settle();
        expect(rig.adopted.value).toBe(true);
        await killAndWait(desktop);
        rig.clock.now = 1_000_000;
        rig.tick();
        await rig.settle();
        rig.clock.now = 1_000_000 + GRACE * 10;
        rig.tick();
        await rig.settle();
        expect(rig.seen.cooperative).toBe(0);
        expect(rig.seen.purged).toEqual([]);
        expect(rig.seen.completes).toBe(0);
      },
    );

    it("a run whose presence was never alive: the desktop already dead triggers nothing", async () => {
      const file = await tempFile();
      const desktop = await spawnFakeDesktop();
      const desktopPid = desktop.pid;
      if (desktopPid === undefined) throw new Error("no fake desktop pid");
      await writePresence(file, desktopPid, "stop");
      await killAndWait(desktop);
      const rig = await buildRig({ presenceFile: file, initialAdopted: false });
      rig.tick();
      await rig.settle();
      rig.clock.now = 1_000_000;
      rig.tick();
      await rig.settle();
      rig.clock.now = 1_000_000 + GRACE * 10;
      rig.tick();
      await rig.settle();
      expect(rig.adopted.value).toBe(false);
      expect(rig.seen.cooperative).toBe(0);
      expect(rig.seen.completes).toBe(0);
    });
  },
);
