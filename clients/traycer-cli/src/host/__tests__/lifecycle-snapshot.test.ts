import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `readHostLifecycleSnapshot`'s owner/run attribution logic
// (`ownerOf`/`describeOwner` in `../lifecycle-snapshot.ts`), exercised
// directly against real files in a temp host home - copied from the
// `src/host/__tests__/lifecycle-files.test.ts` homedir-redirect pattern.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-lifecycle-snapshot-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
  rmSync(workHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("../../store/process-identity");
});

const ENVIRONMENT = "production";

function hostRoot(): string {
  return join(workHome, ".traycer", "host");
}

function writeSupervisorRecord(pid: number): void {
  mkdirSync(hostRoot(), { recursive: true });
  writeFileSync(
    join(hostRoot(), "supervisor.json"),
    JSON.stringify(
      {
        v: 1,
        pid,
        cliVersion: "1.7.2",
        capabilities: ["lifecycle-policy-v1"],
        startedAt: "2026-08-01T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
}

interface RunStateInput {
  readonly supervisorPid: number;
  readonly adopted: boolean;
  readonly lastPresencePid: number | null;
}

function writeSupervisorRunState(input: RunStateInput): void {
  mkdirSync(hostRoot(), { recursive: true });
  writeFileSync(
    join(hostRoot(), "supervisor-run.json"),
    JSON.stringify(
      {
        v: 1,
        supervisorPid: input.supervisorPid,
        supervisorStartIdentity: null,
        admission: "granted",
        origin: "desktop",
        adopted: input.adopted,
        lastPresence:
          input.lastPresencePid === null
            ? null
            : {
                pid: input.lastPresencePid,
                onExit: "stop",
                liveness: "alive",
                observedAt: "2026-08-01T00:00:00.000Z",
              },
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
}

function mockSupervisorLiveness(
  verdict: "alive-same" | "dead" | "alive-different" | "indeterminate",
): void {
  vi.doMock("../../store/process-identity", async (importOriginal) => {
    const actual =
      await importOriginal<typeof import("../../store/process-identity")>();
    return {
      ...actual,
      verifyProcessIdentityAsync: async () => verdict,
    };
  });
}

describe("readHostLifecycleSnapshot attribution", () => {
  it("does not attribute a run state whose supervisorPid does not match supervisor.json's pid", async () => {
    mockSupervisorLiveness("alive-same");
    writeSupervisorRecord(4242);
    // A DIFFERENT pid than the supervisor record: a leftover from a prior
    // supervisor, not this one's run state.
    writeSupervisorRunState({
      supervisorPid: 9999,
      adopted: true,
      lastPresencePid: 555,
    });

    const { readHostLifecycleSnapshot } = await import("../lifecycle-snapshot");
    const snapshot = await readHostLifecycleSnapshot(ENVIRONMENT, true);

    expect(snapshot.run).toBeNull();
  });

  it("reports a supervisor naming a dead pid as stale and not enforcing the policy", async () => {
    mockSupervisorLiveness("dead");
    writeSupervisorRecord(9_999_999);

    const { readHostLifecycleSnapshot } = await import("../lifecycle-snapshot");
    const snapshot = await readHostLifecycleSnapshot(ENVIRONMENT, false);

    expect(snapshot.supervisor.liveness).toBe("stale");
    expect(snapshot.supervisor.enforcesLifecyclePolicy).toBe(false);
  });

  it("attributes an adopted run to the desktop, with the observed pid, via describeOwner", async () => {
    mockSupervisorLiveness("alive-same");
    writeSupervisorRecord(4242);
    writeSupervisorRunState({
      supervisorPid: 4242,
      adopted: true,
      lastPresencePid: 777,
    });

    const { readHostLifecycleSnapshot, describeOwner } =
      await import("../lifecycle-snapshot");
    const snapshot = await readHostLifecycleSnapshot(ENVIRONMENT, true);

    expect(snapshot.run).not.toBeNull();
    expect(snapshot.owner).toEqual({ kind: "desktop", pid: 777 });
    expect(describeOwner(snapshot.owner)).toBe("desktop pid=777");
  });
});
