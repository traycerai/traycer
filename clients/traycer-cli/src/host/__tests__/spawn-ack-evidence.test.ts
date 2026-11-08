import { mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  SpawnAcknowledgementTimeoutError,
  readSpawnAckEvidenceWithin,
  type SpawnAckMarkerState,
  type SpawnAckProofState,
  type SpawnAckSupervisorState,
} from "@traycer-clients/shared/host-start-adoption/spawn-acknowledgement-error";
import { withUpdateContender } from "@traycer-clients/shared/host-update";

// The grant window's 50 s ack wait, shrunk the way the other timeout tests do:
// every wait runs on the real clock against a small budget. The SHARED leaf is
// what `waitForSpawn` reads, so it is the one mocked.
vi.mock(
  "@traycer-clients/shared/host-start-adoption/spawn-edge-bounds",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-start-adoption/spawn-edge-bounds")
      >();
    return { ...actual, HOST_START_ADOPTION_ACK_WAIT_MS: 200 };
  },
);

// HOME is redirected before anything reads it, so the host home, the marker log
// and the supervisor records all live in a private temp dir.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-spawn-ack-evidence-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

import { bootstrapLogPath, hostHomeDir } from "../../store/paths";
import { readProcessStartIdentity } from "../../store/process-identity";
import { publishHostStartAdoption } from "../host-start-adoption";
import { writeSupervisorRecords } from "../lifecycle-files";
import { spawnAckSentryTags } from "../spawn-ack-tags";

const TIMEOUT_MESSAGE = "host-start supervisor did not acknowledge its spawn";
const OTHER_NONCE = "11111111-1111-4111-8111-111111111111";

beforeAll(() => {
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
});

afterAll(async () => {
  await rm(osHome.current, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(hostHomeDir("production"), { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function proofPath(): string {
  return join(hostHomeDir("production"), ".host-start-adoption.json");
}

async function writeSupervisor(): Promise<void> {
  const identity = await readProcessStartIdentity(process.pid);
  await writeSupervisorRecords("production", {
    record: {
      v: 1,
      pid: process.pid,
      cliVersion: "1.0.0",
      capabilities: [],
      startedAt: new Date().toISOString(),
    },
    runState: {
      v: 1,
      supervisorPid: process.pid,
      supervisorStartIdentity: identity,
      admission: "granted",
      origin: null,
      adopted: false,
      lastPresence: null,
      updatedAt: new Date().toISOString(),
    },
  });
}

async function writeMarkerLine(phase: string, atMs: number): Promise<void> {
  const path = bootstrapLogPath("production");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `[${new Date(atMs).toISOString()}] phase=${phase} writer=supervisor\n`,
  );
}

async function changeProof(state: SpawnAckProofState): Promise<void> {
  if (state === "absent") {
    await rm(proofPath(), { force: true });
  } else if (state === "other-nonce") {
    const file = JSON.parse(await readFile(proofPath(), "utf8")) as {
      nonce: string;
    };
    file.nonce = OTHER_NONCE;
    await writeFile(proofPath(), JSON.stringify(file));
  } else if (state === "unreadable") {
    await writeFile(proofPath(), "not json");
  }
}

// Publishes a real grant through the CLI's own publisher, lets `beforeWait`
// shape what the service left on disk, and returns the timeout it raised.
async function timeoutAfter(
  beforeWait: () => Promise<void>,
): Promise<SpawnAcknowledgementTimeoutError> {
  const home = hostHomeDir("production");
  return withUpdateContender(
    {
      hostHomeDir: home,
      reason: "spawn-ack-evidence-test",
      waitMs: 0,
      pollIntervalMs: 10,
      admission: "recovery-maintenance",
    },
    async (capability): Promise<SpawnAcknowledgementTimeoutError> => {
      const lease = await publishHostStartAdoption(
        capability,
        {
          environment: "production",
          hostHomeDir: home,
          reason: "spawn-ack-evidence-test",
          waitMs: 0,
          pollIntervalMs: 10,
          admission: "recovery-maintenance",
        },
        "com.traycer.host",
        "terminal",
      );
      await beforeWait();
      try {
        await lease.waitForSpawn();
      } catch (error) {
        if (error instanceof SpawnAcknowledgementTimeoutError) return error;
        throw error;
      } finally {
        await lease.cancel();
      }
      throw new Error("the grant was acknowledged");
    },
  ).then((outcome) => {
    if (outcome.kind !== "ran") throw new Error("no attempt capability");
    return outcome.result;
  });
}

const PROOF_STATES: readonly SpawnAckProofState[] = [
  "pending-ours",
  "absent",
  "other-nonce",
  "unreadable",
];
const SUPERVISORS: readonly SpawnAckSupervisorState[] = ["live", "none"];
const SUPERVISOR_STATES: readonly SpawnAckSupervisorState[] = [
  "live",
  "none",
  "unknown",
];
const MARKER_STATES: readonly SpawnAckMarkerState[] = [
  "none",
  "starting",
  "exited",
  "crashed",
  "killed",
  "failed-to-spawn",
  "other",
  "unknown",
];

describe("host-start acknowledgement timeout evidence", () => {
  it.each(
    PROOF_STATES.flatMap((proof) =>
      SUPERVISORS.map((supervisor) => ({ proof, supervisor })),
    ),
  )(
    "reads proof=$proof with supervisor=$supervisor into the error's tags",
    async ({ proof, supervisor }) => {
      const error = await timeoutAfter(async () => {
        await changeProof(proof);
        if (supervisor === "live") await writeSupervisor();
      });

      expect(error.message).toBe(TIMEOUT_MESSAGE);
      expect(error.evidence).toEqual({ proof, supervisor, marker: "none" });
      expect(spawnAckSentryTags(error)).toEqual({
        spawn_ack_proof: proof,
        spawn_ack_supervisor: supervisor,
        spawn_ack_marker: "none",
      });
    },
  );

  it.each([
    { phase: "starting", expected: "starting" },
    { phase: "crashed", expected: "crashed" },
    { phase: "killed", expected: "killed" },
    { phase: "exited", expected: "exited" },
    { phase: "failed-to-spawn", expected: "failed-to-spawn" },
    { phase: "surprise", expected: "other" },
  ])(
    "reports the newest marker written since the grant: $phase",
    async ({ phase, expected }) => {
      const error = await timeoutAfter(async () => {
        await writeMarkerLine("starting", Date.now() + 500);
        await writeMarkerLine(phase, Date.now() + 1_000);
      });

      expect(error.evidence?.marker).toBe(expected);
    },
  );

  it("ignores a marker an earlier run left before the grant was published", async () => {
    await writeMarkerLine("crashed", Date.now() - 60_000);

    const error = await timeoutAfter(async () => undefined);

    expect(error.evidence?.marker).toBe("none");
  });

  it("reads a marker log it cannot read as unknown, not as no marker", async () => {
    // A directory where the log should be: the read fails with something other
    // than "not found", which must not read as an affirmative `none`.
    await mkdir(bootstrapLogPath("production"), { recursive: true });

    const error = await timeoutAfter(async () => undefined);

    expect(error.evidence?.marker).toBe("unknown");
  });

  it("carries only closed-set words under exactly three tag keys", async () => {
    const error = await timeoutAfter(async () => {
      await writeSupervisor();
      await writeMarkerLine("crashed", Date.now() + 500);
    });

    const tags = spawnAckSentryTags(error);
    expect(tags).not.toBeNull();
    expect(Object.keys(tags ?? {}).sort()).toEqual([
      "spawn_ack_marker",
      "spawn_ack_proof",
      "spawn_ack_supervisor",
    ]);
    expect(PROOF_STATES).toContain(tags?.spawn_ack_proof);
    expect(SUPERVISOR_STATES).toContain(tags?.spawn_ack_supervisor);
    expect(MARKER_STATES).toContain(tags?.spawn_ack_marker);
    // Nothing a person or machine chose: no path, id or nonce can be in them.
    expect(JSON.stringify(tags)).not.toContain(osHome.current);
    expect(JSON.stringify(tags)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it("tags nothing for another error, or a timeout raised before any evidence", () => {
    expect(spawnAckSentryTags(new Error(TIMEOUT_MESSAGE))).toBeNull();
    expect(spawnAckSentryTags("a string")).toBeNull();
    expect(
      spawnAckSentryTags(new SpawnAcknowledgementTimeoutError()),
    ).toBeNull();
  });
});

describe("readSpawnAckEvidenceWithin", () => {
  it("answers the fallback when the read throws", async () => {
    await expect(
      readSpawnAckEvidenceWithin(() => Promise.reject(new Error("boom")), "x"),
    ).resolves.toBe("x");
  });

  it("answers the fallback once the 2 s budget passes without an answer", async () => {
    vi.useFakeTimers();
    const answer = readSpawnAckEvidenceWithin(
      () => new Promise<string>(() => undefined),
      "unknown",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(answer).resolves.toBe("unknown");
  });

  it("answers the read's own value when it settles in time", async () => {
    await expect(
      readSpawnAckEvidenceWithin(() => Promise.resolve("live"), "unknown"),
    ).resolves.toBe("live");
  });
});
