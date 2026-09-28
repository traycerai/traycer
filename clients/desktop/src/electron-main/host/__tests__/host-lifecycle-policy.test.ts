import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseDesktopPresenceText,
  serializeDesktopPresence,
  type DesktopPresence,
} from "@traycer/protocol/config/desktop-presence";
import {
  parseHostLifecyclePolicyText,
  serializeHostLifecyclePolicy,
  type HostLifecycleMode,
} from "@traycer/protocol/config/host-lifecycle-policy";
import {
  serializeSupervisorRecord,
  SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1,
} from "@traycer/protocol/config/supervisor-record";
import {
  formatDarwinProcessStartIdentity,
  formatLinuxProcessStartIdentity,
  type ProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle/process-start-identity";
import {
  __setAsyncProcessLivenessReaderForTest,
  __setAsyncProcessStartIdentityReaderForTest,
  type ProcessLivenessVerdict,
} from "@traycer-clients/shared/host-lock/process-identity";
import { HostLifecyclePolicyStore } from "../host-lifecycle-policy";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (cause: unknown) => String(cause),
}));

import { log } from "../../app/logger";

const OWN_PID = 4242;
const NOW = new Date("2026-09-24T10:00:00.000Z");

function requireIdentity(
  value: ProcessStartIdentity | null,
): ProcessStartIdentity {
  if (value === null) throw new Error("test fixture: identity was null");
  return value;
}

const OWN_IDENTITY = requireIdentity(
  formatDarwinProcessStartIdentity("Sun Jul 6 12:00:00 2026"),
);
const OTHER_IDENTITY = requireIdentity(
  formatLinuxProcessStartIdentity("boot-id-1", 9999),
);

let root: string;
let hostHome: string;
let pidFile: string;

function makeStore(
  identity: ProcessStartIdentity | null,
): HostLifecyclePolicyStore {
  return new HostLifecyclePolicyStore({
    hostHomeDir: hostHome,
    pidMetadataFile: pidFile,
    ownPid: OWN_PID,
    readOwnStartIdentity: () => Promise.resolve(identity),
    now: () => NOW,
  });
}

async function writeExternalPolicy(
  store: HostLifecyclePolicyStore,
  rev: number,
  mode: HostLifecycleMode,
): Promise<void> {
  await mkdir(hostHome, { recursive: true });
  await writeFile(
    store.policyPath,
    serializeHostLifecyclePolicy({
      v: 1,
      rev,
      mode,
      updatedAt: "2026-09-24T09:00:00.000Z",
      updatedBy: "cli",
    }),
    "utf8",
  );
}

function presenceRecord(
  pid: number,
  identity: ProcessStartIdentity,
): DesktopPresence {
  return {
    v: 1,
    pid,
    processStartIdentity: identity,
    onExit: "keep",
    policyRev: 3,
    writtenAt: "2026-09-24T09:00:00.000Z",
  };
}

async function writeRawPresence(
  store: HostLifecyclePolicyStore,
  record: DesktopPresence,
): Promise<void> {
  await mkdir(hostHome, { recursive: true });
  await writeFile(store.presencePath, serializeDesktopPresence(record), "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "host-lifecycle-policy-"));
  hostHome = join(root, "nested", "host-home");
  pidFile = join(hostHome, "pid.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("HostLifecyclePolicyStore.readPolicy", () => {
  it("reads an absent file as background at rev 0", async () => {
    const read = await makeStore(OWN_IDENTITY).readPolicy();
    expect(read).toEqual({ policy: null, mode: "background", rev: 0 });
  });

  it("reads non-JSON garbage as background at rev 0", async () => {
    const store = makeStore(OWN_IDENTITY);
    await mkdir(hostHome, { recursive: true });
    await writeFile(store.policyPath, "{not json", "utf8");
    const read = await store.readPolicy();
    expect(read).toEqual({ policy: null, mode: "background", rev: 0 });
  });

  it("salvages the rev of a JSON file that is not a valid policy", async () => {
    const store = makeStore(OWN_IDENTITY);
    await mkdir(hostHome, { recursive: true });
    await writeFile(
      store.policyPath,
      JSON.stringify({ v: 1, rev: 7, mode: "not-a-mode" }),
      "utf8",
    );
    const read = await store.readPolicy();
    expect(read.policy).toBeNull();
    expect(read.mode).toBe("background");
    expect(read.rev).toBe(7);
  });

  it("reads a valid record's mode and rev (positive control)", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writeExternalPolicy(store, 5, "linked");
    const read = await store.readPolicy();
    expect(read.mode).toBe("linked");
    expect(read.rev).toBe(5);
    expect(read.policy?.updatedBy).toBe("cli");
  });
});

describe("HostLifecyclePolicyStore.writePolicy", () => {
  it("creates the missing directory and writes rev 1 by desktop", async () => {
    const store = makeStore(OWN_IDENTITY);
    const written = await store.writePolicy("ask");
    expect(written.rev).toBe(1);
    expect(written.updatedBy).toBe("desktop");
    expect(written.mode).toBe("ask");
    const onDisk = parseHostLifecyclePolicyText(
      await readFile(store.policyPath, "utf8"),
    );
    expect(onDisk).toEqual(written);
    expect(onDisk?.updatedAt).toBe(NOW.toISOString());
  });

  it("writes one rev past the record on disk", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writeExternalPolicy(store, 10, "linked");
    const written = await store.writePolicy("background");
    expect(written.rev).toBe(11);
  });

  it("re-reads before each write, so an external write between two desktop writes is not clobbered backwards", async () => {
    const store = makeStore(OWN_IDENTITY);
    const first = await store.writePolicy("ask");
    expect(first.rev).toBe(1);
    await writeExternalPolicy(store, 9, "linked");
    const second = await store.writePolicy("stop-if-idle");
    expect(second.rev).toBe(10);
    expect((await store.readPolicy()).rev).toBe(10);
  });

  it("detects an external CLI write through readPolicy", async () => {
    const store = makeStore(OWN_IDENTITY);
    await store.writePolicy("ask");
    await writeExternalPolicy(store, 2, "none");
    const read = await store.readPolicy();
    expect(read.mode).toBe("none");
    expect(read.policy?.updatedBy).toBe("cli");
  });

  it("writes over a malformed file with a rev past the salvaged one", async () => {
    const store = makeStore(OWN_IDENTITY);
    await mkdir(hostHome, { recursive: true });
    await writeFile(store.policyPath, JSON.stringify({ rev: 4 }), "utf8");
    const written = await store.writePolicy("linked");
    expect(written.rev).toBe(5);
  });

  it("leaves no temp files behind and the file always parses", async () => {
    const store = makeStore(OWN_IDENTITY);
    const modes: readonly HostLifecycleMode[] = [
      "linked",
      "ask",
      "background",
      "stop-if-idle",
    ];
    for (const mode of modes) {
      await store.writePolicy(mode);
      expect(
        parseHostLifecyclePolicyText(await readFile(store.policyPath, "utf8")),
      ).not.toBeNull();
    }
    await store.writePresence("keep", 4);
    const entries = await readdir(hostHome);
    expect(entries.sort()).toEqual(
      ["desktop-presence.json", "lifecycle-policy.json"].sort(),
    );
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });
});

describe("HostLifecyclePolicyStore.readSupervisorState", () => {
  afterEach(() => {
    __setAsyncProcessLivenessReaderForTest(null);
  });

  async function writeSupervisor(
    store: HostLifecyclePolicyStore,
    capabilities: readonly string[],
  ): Promise<void> {
    await mkdir(hostHome, { recursive: true });
    await writeFile(
      store.supervisorPath,
      serializeSupervisorRecord({
        v: 1,
        pid: 1234,
        cliVersion: "1.0.0",
        capabilities,
        startedAt: "2026-09-24T09:00:00.000Z",
        startIdentity: null,
        admittedAs: null,
      }),
      "utf8",
    );
  }

  async function writePid(): Promise<void> {
    await mkdir(hostHome, { recursive: true });
    await writeFile(
      pidFile,
      JSON.stringify({
        hostId: "host-1",
        websocketUrl: "ws://127.0.0.1:1234",
        version: "1.0.0",
        pid: 1234,
      }),
      "utf8",
    );
  }

  it("is enforcing with a supervisor record advertising lifecycle-policy-v1", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writeSupervisor(store, [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1]);
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    expect(await store.readSupervisorState()).toBe("enforcing");
  });

  it("is enforcing regardless of pid.json while the recorded supervisor is alive", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writeSupervisor(store, [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1]);
    await writePid();
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    expect(await store.readSupervisorState()).toBe("enforcing");
  });

  it("is not-running with neither supervisor.json nor pid.json", async () => {
    expect(await makeStore(OWN_IDENTITY).readSupervisorState()).toBe(
      "not-running",
    );
  });

  it("is not-enforcing with a valid pid.json and no supervisor.json", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writePid();
    expect(await store.readSupervisorState()).toBe("not-enforcing");
  });

  it("is not-enforcing when the supervisor record lacks the capability", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writeSupervisor(store, ["some-other-capability"]);
    await writePid();
    expect(await store.readSupervisorState()).toBe("not-enforcing");
  });

  // ---------------------------------------------------------------------
  // A supervisor record naming a dead or recycled pid must not read as
  // "enforcing" - the recorded supervisor is provably gone, so its promise
  // that the lifecycle policy is enforced does not hold. Only POSITIVE
  // liveness/identity evidence (dead, or alive-different) may downgrade the
  // verdict; anything the probe could not establish (indeterminate, a legacy
  // record with no identity to compare, or one whose `startIdentity` is not a
  // usable identity string) falls back to `enforcing` on the capability alone.
  // ---------------------------------------------------------------------
  describe("readSupervisorState liveness", () => {
    async function writeRawSupervisorWithIdentity(
      store: HostLifecyclePolicyStore,
      pid: number,
      startIdentity: ProcessStartIdentity | null | "garbage",
    ): Promise<void> {
      await mkdir(hostHome, { recursive: true });
      await writeFile(
        store.supervisorPath,
        JSON.stringify({
          v: 1,
          pid,
          cliVersion: "1.0.0",
          capabilities: [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1],
          startedAt: "2026-09-24T09:00:00.000Z",
          startIdentity,
        }),
        "utf8",
      );
    }

    async function writeRawSupervisorLegacy(
      store: HostLifecyclePolicyStore,
      pid: number,
    ): Promise<void> {
      await mkdir(hostHome, { recursive: true });
      await writeFile(
        store.supervisorPath,
        JSON.stringify({
          v: 1,
          pid,
          cliVersion: "1.0.0",
          capabilities: [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1],
          startedAt: "2026-09-24T09:00:00.000Z",
        }),
        "utf8",
      );
    }

    const RECORDED_PID = 777_001;
    const RECORDED_IDENTITY = requireIdentity(
      formatDarwinProcessStartIdentity("Sun Jul 6 12:00:00 2026"),
    );
    const OBSERVED_DIFFERENT_IDENTITY = requireIdentity(
      formatDarwinProcessStartIdentity("Mon Jul 7 09:00:00 2026"),
    );

    afterEach(() => {
      __setAsyncProcessLivenessReaderForTest(null);
      __setAsyncProcessStartIdentityReaderForTest(null);
    });

    function stubLiveness(verdict: ProcessLivenessVerdict): void {
      __setAsyncProcessLivenessReaderForTest(() => Promise.resolve(verdict));
    }

    function stubIdentity(identity: ProcessStartIdentity | null): void {
      __setAsyncProcessStartIdentityReaderForTest(() =>
        Promise.resolve(identity),
      );
    }

    it("dead + no pid.json is not-running", async () => {
      const store = makeStore(OWN_IDENTITY);
      await writeRawSupervisorLegacy(store, RECORDED_PID);
      stubLiveness("dead");
      expect(await store.readSupervisorState()).toBe("not-running");
    });

    it("dead + a valid pid.json is not-enforcing", async () => {
      const store = makeStore(OWN_IDENTITY);
      await writeRawSupervisorLegacy(store, RECORDED_PID);
      await writePid();
      stubLiveness("dead");
      expect(await store.readSupervisorState()).toBe("not-enforcing");
    });

    it("alive with a different start identity is not-running", async () => {
      const store = makeStore(OWN_IDENTITY);
      await writeRawSupervisorWithIdentity(
        store,
        RECORDED_PID,
        RECORDED_IDENTITY,
      );
      stubLiveness("alive");
      stubIdentity(OBSERVED_DIFFERENT_IDENTITY);
      expect(await store.readSupervisorState()).toBe("not-running");
    });

    it("alive with the same start identity is enforcing", async () => {
      const store = makeStore(OWN_IDENTITY);
      await writeRawSupervisorWithIdentity(
        store,
        RECORDED_PID,
        RECORDED_IDENTITY,
      );
      stubLiveness("alive");
      stubIdentity(RECORDED_IDENTITY);
      expect(await store.readSupervisorState()).toBe("enforcing");
    });

    it("a legacy record (no startIdentity) with an alive pid is enforcing", async () => {
      const store = makeStore(OWN_IDENTITY);
      await writeRawSupervisorLegacy(store, RECORDED_PID);
      stubLiveness("alive");
      expect(await store.readSupervisorState()).toBe("enforcing");
    });

    it("indeterminate liveness is enforcing (only positive evidence downgrades it)", async () => {
      const store = makeStore(OWN_IDENTITY);
      await writeRawSupervisorLegacy(store, RECORDED_PID);
      stubLiveness("indeterminate");
      expect(await store.readSupervisorState()).toBe("enforcing");
    });

    it("a non-identity startIdentity string with an alive pid is enforcing (liveness only)", async () => {
      const store = makeStore(OWN_IDENTITY);
      await writeRawSupervisorWithIdentity(store, RECORDED_PID, "garbage");
      stubLiveness("alive");
      expect(await store.readSupervisorState()).toBe("enforcing");
    });
  });
});

// `supervisorRecordIsStale`'s memo is reused only for less than
// `SUPERVISOR_VERDICT_REUSE_MS` (60s) AND only while the spawn-free existence
// probe still agrees with the cached verdict. Both conditions matter: on
// Windows a dead supervisor's pid is commonly reissued within seconds, and a
// reissued pid also answers `exists` - existence alone cannot tell the
// recorded supervisor from its replacement, which is exactly what the age
// bound is for. These tests use a REAL, live, non-self pid (`process.ppid`)
// so the actual spawn-free existence probe (`probeProcessExistenceWithoutSpawn`,
// a bare `process.kill(pid, 0)`) answers `exists` throughout, standing in for
// "the pid still exists" without mocking that probe itself. `process.pid` is
// deliberately not used: `verifyProcessIdentityAsync` special-cases it.
describe("the supervisor verdict cache is re-probed after its max age (pid reuse)", () => {
  const RECORDED_PID = process.ppid;
  const RECORDED = requireIdentity(
    formatDarwinProcessStartIdentity("Sun Jul 6 12:00:00 2026"),
  );
  const OTHER = requireIdentity(
    formatDarwinProcessStartIdentity("Mon Jul 7 09:00:00 2026"),
  );

  let clockMs: number;

  function makeClockedStore(): HostLifecyclePolicyStore {
    return new HostLifecyclePolicyStore({
      hostHomeDir: hostHome,
      pidMetadataFile: pidFile,
      ownPid: OWN_PID,
      readOwnStartIdentity: () => Promise.resolve(OWN_IDENTITY),
      now: () => new Date(clockMs),
    });
  }

  async function writeRawSupervisor(
    store: HostLifecyclePolicyStore,
    pid: number,
    startIdentity: ProcessStartIdentity,
  ): Promise<void> {
    await mkdir(hostHome, { recursive: true });
    await writeFile(
      store.supervisorPath,
      JSON.stringify({
        v: 1,
        pid,
        cliVersion: "1.0.0",
        capabilities: [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1],
        startedAt: "2026-09-24T09:00:00.000Z",
        startIdentity,
      }),
      "utf8",
    );
  }

  afterEach(() => {
    __setAsyncProcessLivenessReaderForTest(null);
    __setAsyncProcessStartIdentityReaderForTest(null);
  });

  it("re-probes 60s after the cached verdict, even while the pid still exists", async () => {
    clockMs = Date.parse("2026-09-24T10:00:00.000Z");
    const store = makeClockedStore();
    await writeRawSupervisor(store, RECORDED_PID, RECORDED);
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    const identityReader = vi.fn(() =>
      Promise.resolve<ProcessStartIdentity | null>(RECORDED),
    );
    __setAsyncProcessStartIdentityReaderForTest(identityReader);

    // 1. First read: no memo yet, a full probe runs.
    expect(await store.readSupervisorState()).toBe("enforcing");
    expect(identityReader).toHaveBeenCalledTimes(1);

    // 2. The pid has since been reissued to another process (the reader now
    // answers OTHER), but only 30s have passed: within the reuse window
    // (existence still `exists`, verdict still cached and under 60s old) the
    // cached verdict wins and no new probe runs.
    identityReader.mockResolvedValue(OTHER);
    clockMs += 30_000;
    expect(await store.readSupervisorState()).toBe("enforcing");
    expect(identityReader).toHaveBeenCalledTimes(1);

    // 3. 60s after the first probe: the cache has expired and is re-probed
    // regardless of the pid still existing, picking up the reissue.
    clockMs += 30_000;
    expect(await store.readSupervisorState()).toBe("not-running");
    expect(identityReader).toHaveBeenCalledTimes(2);
  });

  it("a negative age (the clock stepped backward) does not reuse the cache", async () => {
    clockMs = Date.parse("2026-09-24T10:00:00.000Z");
    const store = makeClockedStore();
    await writeRawSupervisor(store, RECORDED_PID, RECORDED);
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    const identityReader = vi.fn(() =>
      Promise.resolve<ProcessStartIdentity | null>(RECORDED),
    );
    __setAsyncProcessStartIdentityReaderForTest(identityReader);

    expect(await store.readSupervisorState()).toBe("enforcing");
    expect(identityReader).toHaveBeenCalledTimes(1);

    // The clock steps BACKWARD (NTP correction, a resumed VM). A negative age
    // is not "within window": it re-probes just like an expired one, and
    // picks up the reissue.
    identityReader.mockResolvedValue(OTHER);
    clockMs -= 10_000;
    expect(await store.readSupervisorState()).toBe("not-running");
    expect(identityReader).toHaveBeenCalledTimes(2);
  });
});

// (Lifecycle side) "the desktop leaves a host that a person started in a
// terminal untouched; the mode governs the service run only." `readSupervisorRun`
// is the one call that gives a caller BOTH facts at once - whether the running
// supervisor enforces the policy at all (`state`, exactly `readSupervisorState`'s
// answer) and, when it does, which kind of run this is (`admittedAs`, from the
// live record's own field) - so a decision that must leave a foreground run
// alone can be made from one read. Reuses the fixture shape from the liveness tests above: a real, live,
// non-self pid (`process.ppid`) so the spawn-free existence probe answers
// `exists`, and the liveness/identity seams.
describe("HostLifecyclePolicyStore.readSupervisorRun", () => {
  const RUN_RECORDED_PID = process.ppid;
  const RUN_RECORDED_IDENTITY = requireIdentity(
    formatDarwinProcessStartIdentity("Sun Jul 6 12:00:00 2026"),
  );
  const RUN_OBSERVED_DIFFERENT_IDENTITY = requireIdentity(
    formatDarwinProcessStartIdentity("Mon Jul 7 09:00:00 2026"),
  );

  async function writeRawSupervisorRun(
    store: HostLifecyclePolicyStore,
    pid: number,
    startIdentity: ProcessStartIdentity,
    admittedAs: "service" | "foreground",
  ): Promise<void> {
    await mkdir(hostHome, { recursive: true });
    await writeFile(
      store.supervisorPath,
      JSON.stringify({
        v: 1,
        pid,
        cliVersion: "1.0.0",
        capabilities: [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1],
        startedAt: "2026-09-24T09:00:00.000Z",
        startIdentity,
        admittedAs,
      }),
      "utf8",
    );
  }

  async function writeRawLegacySupervisorRun(
    store: HostLifecyclePolicyStore,
    pid: number,
  ): Promise<void> {
    await mkdir(hostHome, { recursive: true });
    await writeFile(
      store.supervisorPath,
      JSON.stringify({
        v: 1,
        pid,
        cliVersion: "1.0.0",
        capabilities: [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1],
        startedAt: "2026-09-24T09:00:00.000Z",
      }),
      "utf8",
    );
  }

  afterEach(() => {
    __setAsyncProcessLivenessReaderForTest(null);
    __setAsyncProcessStartIdentityReaderForTest(null);
  });

  it("a live foreground record reads enforcing with the pid and admittedAs 'foreground'", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writeRawSupervisorRun(
      store,
      RUN_RECORDED_PID,
      RUN_RECORDED_IDENTITY,
      "foreground",
    );
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    __setAsyncProcessStartIdentityReaderForTest(() =>
      Promise.resolve(RUN_RECORDED_IDENTITY),
    );

    expect(await store.readSupervisorRun()).toEqual({
      state: "enforcing",
      supervisorPid: RUN_RECORDED_PID,
      admittedAs: "foreground",
    });
  });

  it("a live service record reads enforcing with admittedAs 'service'", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writeRawSupervisorRun(
      store,
      RUN_RECORDED_PID,
      RUN_RECORDED_IDENTITY,
      "service",
    );
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    __setAsyncProcessStartIdentityReaderForTest(() =>
      Promise.resolve(RUN_RECORDED_IDENTITY),
    );

    expect(await store.readSupervisorRun()).toEqual({
      state: "enforcing",
      supervisorPid: RUN_RECORDED_PID,
      admittedAs: "service",
    });
  });

  it("a legacy record with no admittedAs field reads enforcing with admittedAs null", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writeRawLegacySupervisorRun(store, RUN_RECORDED_PID);
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));

    expect(await store.readSupervisorRun()).toEqual({
      state: "enforcing",
      supervisorPid: RUN_RECORDED_PID,
      admittedAs: null,
    });
  });

  it("a stale record (identity mismatch) with no pid.json reads not-running with no pid and no admittedAs", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writeRawSupervisorRun(
      store,
      RUN_RECORDED_PID,
      RUN_RECORDED_IDENTITY,
      "foreground",
    );
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    __setAsyncProcessStartIdentityReaderForTest(() =>
      Promise.resolve(RUN_OBSERVED_DIFFERENT_IDENTITY),
    );

    expect(await store.readSupervisorRun()).toEqual({
      state: "not-running",
      supervisorPid: null,
      admittedAs: null,
    });
  });
});

// Addendum: the health monitor's hold key. `readIdentifiedSupervisorPid`
// returns the live supervisor's pid ONLY when its record carries a start
// identity AND that identity checks out - a positively-identified process to
// hold, never a bare pid a legacy record cannot vouch for. This is the one
// difference from `readSupervisorRun().supervisorPid`, which returns the pid
// for a legacy record too (liveness alone is enough for that read's purpose).
describe("HostLifecyclePolicyStore.readIdentifiedSupervisorPid", () => {
  const ID_RECORDED_PID = process.ppid;
  const ID_RECORDED_IDENTITY = requireIdentity(
    formatDarwinProcessStartIdentity("Sun Jul 6 12:00:00 2026"),
  );
  const ID_OBSERVED_DIFFERENT_IDENTITY = requireIdentity(
    formatDarwinProcessStartIdentity("Mon Jul 7 09:00:00 2026"),
  );

  async function writeRawSupervisorWithIdentity(
    store: HostLifecyclePolicyStore,
    pid: number,
    startIdentity: ProcessStartIdentity,
  ): Promise<void> {
    await mkdir(hostHome, { recursive: true });
    await writeFile(
      store.supervisorPath,
      JSON.stringify({
        v: 1,
        pid,
        cliVersion: "1.0.0",
        capabilities: [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1],
        startedAt: "2026-09-24T09:00:00.000Z",
        startIdentity,
      }),
      "utf8",
    );
  }

  async function writeRawLegacySupervisor(
    store: HostLifecyclePolicyStore,
    pid: number,
  ): Promise<void> {
    await mkdir(hostHome, { recursive: true });
    await writeFile(
      store.supervisorPath,
      JSON.stringify({
        v: 1,
        pid,
        cliVersion: "1.0.0",
        capabilities: [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1],
        startedAt: "2026-09-24T09:00:00.000Z",
      }),
      "utf8",
    );
  }

  afterEach(() => {
    __setAsyncProcessLivenessReaderForTest(null);
    __setAsyncProcessStartIdentityReaderForTest(null);
  });

  it("a live record whose identity checks out returns the pid", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writeRawSupervisorWithIdentity(
      store,
      ID_RECORDED_PID,
      ID_RECORDED_IDENTITY,
    );
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    __setAsyncProcessStartIdentityReaderForTest(() =>
      Promise.resolve(ID_RECORDED_IDENTITY),
    );

    expect(await store.readIdentifiedSupervisorPid()).toBe(ID_RECORDED_PID);
  });

  it("a live legacy record with no startIdentity returns null", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writeRawLegacySupervisor(store, ID_RECORDED_PID);
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));

    expect(await store.readIdentifiedSupervisorPid()).toBeNull();
  });

  it("a record whose identity mismatches (pid reissued) returns null", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writeRawSupervisorWithIdentity(
      store,
      ID_RECORDED_PID,
      ID_RECORDED_IDENTITY,
    );
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    __setAsyncProcessStartIdentityReaderForTest(() =>
      Promise.resolve(ID_OBSERVED_DIFFERENT_IDENTITY),
    );

    expect(await store.readIdentifiedSupervisorPid()).toBeNull();
  });
});

describe("HostLifecyclePolicyStore presence", () => {
  it("reads an absent presence as null", async () => {
    expect(await makeStore(OWN_IDENTITY).readPresence()).toBeNull();
  });

  it("writePresence publishes this pid and identity with verdict and rev", async () => {
    const store = makeStore(OWN_IDENTITY);
    expect(await store.writePresence("stop", 6)).toBe("written");
    const presence = await store.readPresence();
    expect(presence).toEqual({
      v: 1,
      pid: OWN_PID,
      processStartIdentity: OWN_IDENTITY,
      onExit: "stop",
      policyRev: 6,
      writtenAt: NOW.toISOString(),
    });
  });

  it("writePresence with a null identity returns identity-unavailable, writes no file, and logs nothing (the caller retries and owns the log line)", async () => {
    const store = makeStore(null);
    const warnCallsBefore = vi.mocked(log.warn).mock.calls.length;
    expect(await store.writePresence("keep", 1)).toBe("identity-unavailable");
    expect(await store.readPresence()).toBeNull();
    let exists = true;
    try {
      await readFile(store.presencePath, "utf8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
    expect(vi.mocked(log.warn).mock.calls.length).toBe(warnCallsBefore);
  });

  it("removeOwnPresence removes a record naming this pid and identity", async () => {
    const store = makeStore(OWN_IDENTITY);
    await store.writePresence("keep", 2);
    expect(await store.readPresence()).not.toBeNull();
    await store.removeOwnPresence();
    expect(await store.readPresence()).toBeNull();
    expect(await readdir(hostHome)).toEqual([]);
  });

  it("removeOwnPresence leaves a foreign pid's record intact", async () => {
    const store = makeStore(OWN_IDENTITY);
    const foreign = presenceRecord(OWN_PID + 1, OWN_IDENTITY);
    await writeRawPresence(store, foreign);
    await store.removeOwnPresence();
    expect(await store.readPresence()).toEqual(foreign);
    expect((await readdir(hostHome)).sort()).toEqual(["desktop-presence.json"]);
  });

  it("removeOwnPresence leaves a same-pid different-identity record intact", async () => {
    const store = makeStore(OWN_IDENTITY);
    const recycled = presenceRecord(OWN_PID, OTHER_IDENTITY);
    await writeRawPresence(store, recycled);
    await store.removeOwnPresence();
    expect(await store.readPresence()).toEqual(recycled);
    expect((await readdir(hostHome)).sort()).toEqual(["desktop-presence.json"]);
  });

  it("removeOwnPresence is a no-op when no record exists", async () => {
    const store = makeStore(OWN_IDENTITY);
    await mkdir(hostHome, { recursive: true });
    await store.removeOwnPresence();
    expect(await readdir(hostHome)).toEqual([]);
  });

  it("presence file written by the store parses with the protocol parser", async () => {
    const store = makeStore(OWN_IDENTITY);
    await store.writePresence("handoff", 0);
    expect(
      parseDesktopPresenceText(await readFile(store.presencePath, "utf8"))
        ?.onExit,
    ).toBe("handoff");
  });
});
