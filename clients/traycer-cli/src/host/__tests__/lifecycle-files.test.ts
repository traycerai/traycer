import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHostLifecyclePolicyText } from "@traycer/protocol/config/host-lifecycle-policy";
import type { SupervisorRecords } from "../lifecycle-files";

// `store/paths` binds its home root from `os.homedir()` at module load. Keep
// the environment mutation below, but redirect `homedir()` too - copied from
// `src/doctor/__tests__/engine-service-stopped.test.ts`.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-lifecycle-files-test-"));
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

describe("readHostLifecyclePolicy / effectiveModeOf", () => {
  it("reads absent when the policy file does not exist", async () => {
    const { readHostLifecyclePolicy, effectiveModeOf } =
      await import("../lifecycle-files");
    const read = await readHostLifecyclePolicy(ENVIRONMENT);
    expect(read.kind).toBe("absent");
    expect(effectiveModeOf(read)).toBe("background");
  });

  it("reads invalid for malformed JSON and falls back to background", async () => {
    const {
      readHostLifecyclePolicy,
      effectiveModeOf,
      hostLifecyclePolicyFilePath,
    } = await import("../lifecycle-files");
    const path = hostLifecyclePolicyFilePath(ENVIRONMENT);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json at all {");

    const read = await readHostLifecyclePolicy(ENVIRONMENT);
    expect(read.kind).toBe("invalid");
    expect(effectiveModeOf(read)).toBe("background");
  });

  it("reads unreadable when a directory sits at the policy path and falls back to background", async () => {
    const {
      readHostLifecyclePolicy,
      effectiveModeOf,
      hostLifecyclePolicyFilePath,
    } = await import("../lifecycle-files");
    const path = hostLifecyclePolicyFilePath(ENVIRONMENT);
    mkdirSync(path, { recursive: true });

    const read = await readHostLifecyclePolicy(ENVIRONMENT);
    expect(read.kind).toBe("unreadable");
    expect(effectiveModeOf(read)).toBe("background");
  });

  it("reads valid for a well-formed record and returns its actual mode", async () => {
    const {
      readHostLifecyclePolicy,
      effectiveModeOf,
      hostLifecyclePolicyFilePath,
    } = await import("../lifecycle-files");
    const path = hostLifecyclePolicyFilePath(ENVIRONMENT);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        v: 1,
        rev: 3,
        mode: "linked",
        updatedAt: new Date().toISOString(),
        updatedBy: "desktop",
      })}\n`,
    );

    const read = await readHostLifecyclePolicy(ENVIRONMENT);
    expect(read.kind).toBe("valid");
    expect(effectiveModeOf(read)).toBe("linked");
  });
});

describe("writeHostLifecyclePolicyFromCli", () => {
  it("writes rev 1 when no file is present", async () => {
    const { writeHostLifecyclePolicyFromCli } =
      await import("../lifecycle-files");
    const now = new Date("2026-09-24T00:00:00.000Z");
    const policy = await writeHostLifecyclePolicyFromCli(
      ENVIRONMENT,
      "linked",
      now,
    );
    expect(policy.rev).toBe(1);
    expect(policy.mode).toBe("linked");
    expect(policy.updatedBy).toBe("cli");
  });

  it("bumps rev on a second call", async () => {
    const { writeHostLifecyclePolicyFromCli } =
      await import("../lifecycle-files");
    const first = await writeHostLifecyclePolicyFromCli(
      ENVIRONMENT,
      "linked",
      new Date("2026-09-24T00:00:00.000Z"),
    );
    expect(first.rev).toBe(1);
    const second = await writeHostLifecyclePolicyFromCli(
      ENVIRONMENT,
      "ask",
      new Date("2026-09-24T00:01:00.000Z"),
    );
    expect(second.rev).toBe(2);
    expect(second.updatedBy).toBe("cli");
  });

  it("salvages the rev from a corrupt-but-JSON file with a bad mode", async () => {
    const { writeHostLifecyclePolicyFromCli, hostLifecyclePolicyFilePath } =
      await import("../lifecycle-files");
    const path = hostLifecyclePolicyFilePath(ENVIRONMENT);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        v: 1,
        rev: 7,
        mode: "bogus",
        updatedAt: new Date().toISOString(),
        updatedBy: "cli",
      })}\n`,
    );

    const policy = await writeHostLifecyclePolicyFromCli(
      ENVIRONMENT,
      "linked",
      new Date("2026-09-24T00:02:00.000Z"),
    );
    expect(policy.rev).toBe(8);
    expect(policy.updatedBy).toBe("cli");
  });

  it("restarts the rev counter at 1 when the on-disk file is not JSON at all", async () => {
    const { writeHostLifecyclePolicyFromCli, hostLifecyclePolicyFilePath } =
      await import("../lifecycle-files");
    const path = hostLifecyclePolicyFilePath(ENVIRONMENT);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "totally not json {{{");

    const policy = await writeHostLifecyclePolicyFromCli(
      ENVIRONMENT,
      "linked",
      new Date("2026-09-24T00:03:00.000Z"),
    );
    expect(policy.rev).toBe(1);
  });

  it("writes bytes that parse back with parseHostLifecyclePolicyText after every write", async () => {
    const { writeHostLifecyclePolicyFromCli, hostLifecyclePolicyFilePath } =
      await import("../lifecycle-files");
    const path = hostLifecyclePolicyFilePath(ENVIRONMENT);

    await writeHostLifecyclePolicyFromCli(
      ENVIRONMENT,
      "stop-if-idle",
      new Date("2026-09-24T00:04:00.000Z"),
    );

    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(path, "utf8");
    const parsed = parseHostLifecyclePolicyText(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.mode).toBe("stop-if-idle");
    expect(parsed?.rev).toBe(1);
    expect(parsed?.updatedBy).toBe("cli");
  });
});

describe("writeSupervisorRecords / removeSupervisorRecords", () => {
  function buildRecords(supervisorPid: number): SupervisorRecords {
    return {
      record: {
        v: 1,
        pid: supervisorPid,
        cliVersion: "0.0.0-test",
        capabilities: ["lifecycle-policy-v1"],
        startedAt: "2026-09-24T00:00:00.000Z",
      },
      runState: {
        v: 1,
        supervisorPid,
        supervisorStartIdentity: null,
        admission: "foreground",
        origin: null,
        adopted: false,
        lastPresence: null,
        updatedAt: "2026-09-24T00:00:00.000Z",
      },
    };
  }

  it("removes both files when they name the same supervisor pid", async () => {
    const {
      writeSupervisorRecords,
      removeSupervisorRecords,
      readSupervisorRecord,
      readSupervisorRunState,
    } = await import("../lifecycle-files");

    const records = buildRecords(process.pid);
    await writeSupervisorRecords(ENVIRONMENT, records);

    expect((await readSupervisorRecord(ENVIRONMENT)).kind).toBe("valid");
    expect((await readSupervisorRunState(ENVIRONMENT)).kind).toBe("valid");

    await removeSupervisorRecords(ENVIRONMENT, process.pid);

    expect((await readSupervisorRecord(ENVIRONMENT)).kind).toBe("absent");
    expect((await readSupervisorRunState(ENVIRONMENT)).kind).toBe("absent");
  });

  it("leaves both files intact when they name a different supervisor pid", async () => {
    const {
      writeSupervisorRecords,
      removeSupervisorRecords,
      supervisorRunStatePath,
    } = await import("../lifecycle-files");
    const { supervisorRecordPath } =
      await import("@traycer/protocol/config/supervisor-record");
    const { hostHomeDir } = await import("../../store/paths");

    const otherPid = process.pid + 1;
    const records = buildRecords(otherPid);
    await writeSupervisorRecords(ENVIRONMENT, records);

    const recordPath = supervisorRecordPath(hostHomeDir(ENVIRONMENT));
    const runStatePath = supervisorRunStatePath(ENVIRONMENT);
    const fs = await import("node:fs/promises");
    const recordBefore = await fs.readFile(recordPath, "utf8");
    const runStateBefore = await fs.readFile(runStatePath, "utf8");

    await removeSupervisorRecords(ENVIRONMENT, process.pid);

    const recordAfter = await fs.readFile(recordPath, "utf8");
    const runStateAfter = await fs.readFile(runStatePath, "utf8");
    expect(recordAfter).toBe(recordBefore);
    expect(runStateAfter).toBe(runStateBefore);
  });

  it("does not throw when no supervisor files are present", async () => {
    const { removeSupervisorRecords } = await import("../lifecycle-files");
    await expect(
      removeSupervisorRecords(ENVIRONMENT, process.pid),
    ).resolves.toBeUndefined();
  });
});

describe("parseSupervisorRunStateText", () => {
  it("round-trips a valid SupervisorRunState", async () => {
    const { parseSupervisorRunStateText } = await import("../lifecycle-files");
    const state = {
      v: 1 as const,
      supervisorPid: 4242,
      supervisorStartIdentity: null,
      admission: "granted" as const,
      origin: "terminal" as const,
      adopted: true,
      lastPresence: {
        pid: 555,
        onExit: "stop" as const,
        liveness: "alive" as const,
        observedAt: "2026-09-24T00:00:00.000Z",
      },
      updatedAt: "2026-09-24T00:00:00.000Z",
    };

    const parsed = parseSupervisorRunStateText(JSON.stringify(state));
    expect(parsed).toEqual(state);
  });

  it("returns null for invalid JSON", async () => {
    const { parseSupervisorRunStateText } = await import("../lifecycle-files");
    expect(parseSupervisorRunStateText("not json {{{")).toBeNull();
  });

  it("returns null for the wrong v", async () => {
    const { parseSupervisorRunStateText } = await import("../lifecycle-files");
    expect(
      parseSupervisorRunStateText(
        JSON.stringify({
          v: 2,
          supervisorPid: 1,
          supervisorStartIdentity: null,
          admission: "foreground",
          origin: null,
          adopted: false,
          lastPresence: null,
          updatedAt: "2026-09-24T00:00:00.000Z",
        }),
      ),
    ).toBeNull();
  });

  it("returns null for missing fields", async () => {
    const { parseSupervisorRunStateText } = await import("../lifecycle-files");
    expect(
      parseSupervisorRunStateText(
        JSON.stringify({
          v: 1,
          supervisorPid: 1,
        }),
      ),
    ).toBeNull();
  });

  it("returns null for an invalid admission enum value", async () => {
    const { parseSupervisorRunStateText } = await import("../lifecycle-files");
    expect(
      parseSupervisorRunStateText(
        JSON.stringify({
          v: 1,
          supervisorPid: 1,
          supervisorStartIdentity: null,
          admission: "bogus",
          origin: null,
          adopted: false,
          lastPresence: null,
          updatedAt: "2026-09-24T00:00:00.000Z",
        }),
      ),
    ).toBeNull();
  });
});

describe("probeDesktopPresenceLiveness", () => {
  function presenceFixture(): import("@traycer/protocol/config/desktop-presence").DesktopPresence {
    return {
      v: 1,
      pid: 123,
      processStartIdentity: "abc:123",
      onExit: "stop",
      policyRev: 1,
      writtenAt: "2026-09-24T00:00:00.000Z",
    };
  }

  it("maps alive-same to alive", async () => {
    vi.doMock("../../store/process-identity", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../store/process-identity")>();
      return {
        ...actual,
        verifyProcessIdentityAsync: async () => "alive-same" as const,
      };
    });
    const { probeDesktopPresenceLiveness } = await import("../lifecycle-files");
    expect(await probeDesktopPresenceLiveness(presenceFixture())).toBe("alive");
  });

  it("maps dead to dead", async () => {
    vi.doMock("../../store/process-identity", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../store/process-identity")>();
      return {
        ...actual,
        verifyProcessIdentityAsync: async () => "dead" as const,
      };
    });
    const { probeDesktopPresenceLiveness } = await import("../lifecycle-files");
    expect(await probeDesktopPresenceLiveness(presenceFixture())).toBe("dead");
  });

  it("maps alive-different to dead", async () => {
    vi.doMock("../../store/process-identity", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../store/process-identity")>();
      return {
        ...actual,
        verifyProcessIdentityAsync: async () => "alive-different" as const,
      };
    });
    const { probeDesktopPresenceLiveness } = await import("../lifecycle-files");
    expect(await probeDesktopPresenceLiveness(presenceFixture())).toBe("dead");
  });

  it("maps indeterminate to indeterminate", async () => {
    vi.doMock("../../store/process-identity", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../store/process-identity")>();
      return {
        ...actual,
        verifyProcessIdentityAsync: async () => "indeterminate" as const,
      };
    });
    const { probeDesktopPresenceLiveness } = await import("../lifecycle-files");
    expect(await probeDesktopPresenceLiveness(presenceFixture())).toBe(
      "indeterminate",
    );
  });

  it("maps a thrown error to indeterminate", async () => {
    vi.doMock("../../store/process-identity", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../store/process-identity")>();
      return {
        ...actual,
        verifyProcessIdentityAsync: async () => {
          throw new Error("probe failed");
        },
      };
    });
    const { probeDesktopPresenceLiveness } = await import("../lifecycle-files");
    expect(await probeDesktopPresenceLiveness(presenceFixture())).toBe(
      "indeterminate",
    );
  });
});
