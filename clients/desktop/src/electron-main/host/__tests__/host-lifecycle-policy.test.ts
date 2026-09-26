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
    expect(await store.readSupervisorState()).toBe("enforcing");
  });

  it("is enforcing regardless of pid.json when the capability is present", async () => {
    const store = makeStore(OWN_IDENTITY);
    await writeSupervisor(store, [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1]);
    await writePid();
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

  it("D6: writePresence with a null identity returns identity-unavailable, writes no file, and logs nothing (the caller retries and owns the log line)", async () => {
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
