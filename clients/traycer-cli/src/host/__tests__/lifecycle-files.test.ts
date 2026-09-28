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

beforeEach(async () => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-lifecycle-files-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  const { hostHomeDir } = await import("../../store/paths");
  expect(hostHomeDir("production").startsWith(workHome)).toBe(true);
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
  vi.doUnmock("node:fs/promises");
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

    await removeSupervisorRecords(ENVIRONMENT, process.pid, "all");

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

    await removeSupervisorRecords(ENVIRONMENT, process.pid, "all");

    const recordAfter = await fs.readFile(recordPath, "utf8");
    const runStateAfter = await fs.readFile(runStatePath, "utf8");
    expect(recordAfter).toBe(recordBefore);
    expect(runStateAfter).toBe(runStateBefore);
  });

  it("does not throw when no supervisor files are present", async () => {
    const { removeSupervisorRecords } = await import("../lifecycle-files");
    await expect(
      removeSupervisorRecords(ENVIRONMENT, process.pid, "all"),
    ).resolves.toBeUndefined();
  });

  // A writer landing a NEWER record at the canonical path between the
  // claim-rename and the restore-link must win; the restore must not clobber
  // it. `link()` throws when the destination already exists, which is what
  // makes the claimed-owner's `link` a no-op restore here.
  it("restores only while the canonical name is still vacant", async () => {
    const newerRunState = {
      v: 1 as const,
      supervisorPid: process.pid + 2,
      supervisorStartIdentity: null,
      admission: "foreground" as const,
      origin: null,
      adopted: false,
      lastPresence: null,
      updatedAt: "2026-09-24T00:05:00.000Z",
    };
    const newerRunStateText = `${JSON.stringify(newerRunState, null, 2)}\n`;

    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        link: async (existingPath: string, newPath: string) => {
          if (newPath.endsWith("supervisor-run.json")) {
            await actual.writeFile(newPath, newerRunStateText);
          }
          return actual.link(existingPath, newPath);
        },
      };
    });

    const {
      writeSupervisorRecords,
      removeSupervisorRecords,
      supervisorRunStatePath,
      readSupervisorRunState,
    } = await import("../lifecycle-files");

    const otherPid = process.pid + 1;
    await writeSupervisorRecords(ENVIRONMENT, buildRecords(otherPid));

    await removeSupervisorRecords(ENVIRONMENT, process.pid, "all");

    const fs = await import("node:fs/promises");
    const runStatePath = supervisorRunStatePath(ENVIRONMENT);
    expect(await fs.readFile(runStatePath, "utf8")).toBe(newerRunStateText);
    expect((await readSupervisorRunState(ENVIRONMENT)).kind).toBe("valid");
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

describe("removeSupervisorRecords keep-run-state", () => {
  // A valid start identity (`isProcessStartIdentity`) is required, or the
  // run-state record fails to parse and the byte-equality assertion below
  // would hold whether or not `keep-run-state` actually skipped the removal.
  it("removes supervisor.json only and leaves supervisor-run.json byte-identical", async () => {
    const {
      writeSupervisorRecords,
      removeSupervisorRecords,
      readSupervisorRecord,
      readSupervisorRunState,
      supervisorRunStatePath,
    } = await import("../lifecycle-files");
    const { readProcessStartIdentity } =
      await import("../../store/process-identity");
    const identity = await readProcessStartIdentity(process.pid);
    if (identity === null) throw new Error("cannot read own start identity");
    await writeSupervisorRecords(ENVIRONMENT, {
      record: {
        v: 1,
        pid: process.pid,
        cliVersion: "0.0.0-test",
        capabilities: ["lifecycle-policy-v1"],
        startedAt: "2026-09-24T00:00:00.000Z",
      },
      runState: {
        v: 1,
        supervisorPid: process.pid,
        supervisorStartIdentity: identity,
        admission: "unattended",
        origin: null,
        adopted: true,
        lastPresence: null,
        updatedAt: "2026-09-24T00:00:00.000Z",
      },
    });
    expect((await readSupervisorRunState(ENVIRONMENT)).kind).toBe("valid");
    const fs = await import("node:fs/promises");
    const runStatePath = supervisorRunStatePath(ENVIRONMENT);
    const before = await fs.readFile(runStatePath, "utf8");

    await removeSupervisorRecords(ENVIRONMENT, process.pid, "keep-run-state");

    expect((await readSupervisorRecord(ENVIRONMENT)).kind).toBe("absent");
    expect(await fs.readFile(runStatePath, "utf8")).toBe(before);
  });
});

describe("markSupervisorRunOwed", () => {
  // A record the run-state parser accepts: the mark never rewrites a record
  // it cannot parse (a malformed start identity fails the schema).
  function runState(supervisorPid: number): SupervisorRecords["runState"] {
    return {
      v: 1,
      supervisorPid,
      supervisorStartIdentity: null,
      admission: "unattended",
      origin: null,
      adopted: true,
      lastPresence: null,
      updatedAt: "2026-09-24T00:00:00.000Z",
    };
  }

  function supervisorRecord(pid: number): SupervisorRecords["record"] {
    return {
      v: 1,
      pid,
      cliVersion: "0.0.0-test",
      capabilities: ["lifecycle-policy-v1"],
      startedAt: "2026-09-24T00:00:00.000Z",
    };
  }

  it("marks the run state this supervisor published, keeping every field", async () => {
    const {
      writeSupervisorRecords,
      markSupervisorRunOwed,
      readSupervisorRunState,
      supervisorRunStatePath,
    } = await import("../lifecycle-files");
    await writeSupervisorRecords(ENVIRONMENT, {
      record: supervisorRecord(4242),
      runState: runState(4242),
    });

    await markSupervisorRunOwed(ENVIRONMENT, 4242);

    const fs = await import("node:fs/promises");
    const raw: unknown = JSON.parse(
      await fs.readFile(supervisorRunStatePath(ENVIRONMENT), "utf8"),
    );
    expect(raw).toMatchObject({ owesSuccessor: true });
    const read = await readSupervisorRunState(ENVIRONMENT);
    expect(read).toEqual({ kind: "valid", record: runState(4242) });
  });

  it("leaves a successor's run state byte-identical: a record naming another pid is not this exit's to mark", async () => {
    const {
      writeSupervisorRecords,
      markSupervisorRunOwed,
      supervisorRunStatePath,
    } = await import("../lifecycle-files");
    await writeSupervisorRecords(ENVIRONMENT, {
      record: supervisorRecord(5151),
      runState: runState(5151),
    });
    const fs = await import("node:fs/promises");
    const path = supervisorRunStatePath(ENVIRONMENT);
    const before = await fs.readFile(path, "utf8");

    await markSupervisorRunOwed(ENVIRONMENT, 4242);

    expect(await fs.readFile(path, "utf8")).toBe(before);
    expect(
      (await fs.readdir(dirname(path))).filter((name) =>
        name.endsWith(".owed"),
      ),
    ).toEqual([]);
  });

  it("is a no-op when there is no run state", async () => {
    const { markSupervisorRunOwed, supervisorRunStatePath } =
      await import("../lifecycle-files");
    await markSupervisorRunOwed(ENVIRONMENT, 4242);
    const fs = await import("node:fs/promises");
    await expect(
      fs.stat(supervisorRunStatePath(ENVIRONMENT)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("writeSupervisorRecords stamps supervisor.json's startIdentity from the run state", () => {
  async function readRawSupervisorRecordJson(): Promise<unknown> {
    const { supervisorRecordPath } =
      await import("@traycer/protocol/config/supervisor-record");
    const { hostHomeDir } = await import("../../store/paths");
    const fs = await import("node:fs/promises");
    const text = await fs.readFile(
      supervisorRecordPath(hostHomeDir(ENVIRONMENT)),
      "utf8",
    );
    const raw: unknown = JSON.parse(text);
    return raw;
  }

  it("stamps supervisor.json's startIdentity from runState.supervisorStartIdentity", async () => {
    const { writeSupervisorRecords } = await import("../lifecycle-files");
    const identity = "darwin:Sun Jul 6 12:00:00 2026";
    await writeSupervisorRecords(ENVIRONMENT, {
      record: {
        v: 1,
        pid: process.pid,
        cliVersion: "0.0.0-test",
        capabilities: ["lifecycle-policy-v1"],
        startedAt: "2026-09-24T00:00:00.000Z",
      },
      runState: {
        v: 1,
        supervisorPid: process.pid,
        supervisorStartIdentity: identity,
        admission: "foreground",
        origin: null,
        adopted: false,
        lastPresence: null,
        updatedAt: "2026-09-24T00:00:00.000Z",
      },
    });

    expect(await readRawSupervisorRecordJson()).toHaveProperty(
      "startIdentity",
      identity,
    );
  });

  it("stamps a null startIdentity, with the key present", async () => {
    const { writeSupervisorRecords } = await import("../lifecycle-files");
    await writeSupervisorRecords(ENVIRONMENT, {
      record: {
        v: 1,
        pid: process.pid,
        cliVersion: "0.0.0-test",
        capabilities: ["lifecycle-policy-v1"],
        startedAt: "2026-09-24T00:00:00.000Z",
      },
      runState: {
        v: 1,
        supervisorPid: process.pid,
        supervisorStartIdentity: null,
        admission: "foreground",
        origin: null,
        adopted: false,
        lastPresence: null,
        updatedAt: "2026-09-24T00:00:00.000Z",
      },
    });

    const raw = await readRawSupervisorRecordJson();
    expect(raw).toHaveProperty("startIdentity", null);
  });
});

// "The desktop leaves a host that a person started in a
// terminal untouched; the mode governs the service run only." `admittedAs`
// on `supervisor.json` is how a reader (the desktop) tells a mode-governed
// run from a person's own terminal start, stamped from the run state's
// `admission` this CLI already tracks privately: `granted` and `unattended`
// both collapse to `"service"` (a labelled, mode-governed start - an
// explicit admission proof or a service-manager relaunch), and `foreground`
// stays `"foreground"` (never parked). Read via raw JSON / `toHaveProperty`
// so this runs unmodified on current bytes, where the field does not exist
// yet - vitest does not type-check.
describe("writeSupervisorRecords stamps supervisor.json's admittedAs from the run state's admission", () => {
  async function readRawSupervisorRecordJson(): Promise<unknown> {
    const { supervisorRecordPath } =
      await import("@traycer/protocol/config/supervisor-record");
    const { hostHomeDir } = await import("../../store/paths");
    const fs = await import("node:fs/promises");
    const text = await fs.readFile(
      supervisorRecordPath(hostHomeDir(ENVIRONMENT)),
      "utf8",
    );
    const raw: unknown = JSON.parse(text);
    return raw;
  }

  const admissionCases: ReadonlyArray<{
    readonly admission: "granted" | "unattended" | "foreground";
    readonly expectedAdmittedAs: "service" | "foreground";
  }> = [
    { admission: "granted", expectedAdmittedAs: "service" },
    { admission: "unattended", expectedAdmittedAs: "service" },
    { admission: "foreground", expectedAdmittedAs: "foreground" },
  ];

  for (const testCase of admissionCases) {
    it(`stamps admittedAs "${testCase.expectedAdmittedAs}" from admission "${testCase.admission}"`, async () => {
      const { writeSupervisorRecords } = await import("../lifecycle-files");
      await writeSupervisorRecords(ENVIRONMENT, {
        record: {
          v: 1,
          pid: process.pid,
          cliVersion: "0.0.0-test",
          capabilities: ["lifecycle-policy-v1"],
          startedAt: "2026-09-24T00:00:00.000Z",
        },
        runState: {
          v: 1,
          supervisorPid: process.pid,
          supervisorStartIdentity: null,
          admission: testCase.admission,
          origin: null,
          adopted: false,
          lastPresence: null,
          updatedAt: "2026-09-24T00:00:00.000Z",
        },
      });

      expect(await readRawSupervisorRecordJson()).toHaveProperty(
        "admittedAs",
        testCase.expectedAdmittedAs,
      );
    });
  }
});

describe("readInheritableRunOwnership", () => {
  const PREDECESSOR_PID = 424_242;

  /** A well-formed token: the schema drops a malformed one to `null`. */
  async function validIdentity(): Promise<string> {
    const { readProcessStartIdentity } =
      await import("../../store/process-identity");
    const identity = await readProcessStartIdentity(process.pid);
    if (identity === null) throw new Error("cannot read own start identity");
    return identity;
  }

  interface ProbeCall {
    readonly pid: number;
    readonly startedAtMs: number | null;
    readonly startIdentity: string | null;
  }

  /**
   * A predecessor that exited owing a successor, made the way the supervisor
   * makes it: both records published, then the owed mark its exit writes
   * (`markSupervisorRunOwed`), then `removeSupervisorRecords(...,
   * "keep-run-state")` - the run state kept and marked, `supervisor.json`
   * gone. Without the mark the kept file alone proves nothing (a SIGKILL
   * leaves one too), which `readInheritableRunOwnership` must refuse
   * (`lifecycle-files-owed-exit.test.ts`) - so every row here that inherits,
   * or that refuses for some OTHER reason, starts from this footprint.
   */
  async function writePredecessor(input: {
    readonly adopted: boolean;
    readonly identity: string | null;
  }): Promise<void> {
    const {
      writeSupervisorRecords,
      markSupervisorRunOwed,
      removeSupervisorRecords,
    } = await import("../lifecycle-files");
    await writeSupervisorRecords(ENVIRONMENT, {
      record: {
        v: 1,
        pid: PREDECESSOR_PID,
        cliVersion: "0.0.0-test",
        capabilities: ["lifecycle-policy-v1"],
        startedAt: "2026-09-24T00:00:00.000Z",
      },
      runState: {
        v: 1,
        supervisorPid: PREDECESSOR_PID,
        supervisorStartIdentity: input.identity,
        admission: "unattended",
        origin: null,
        adopted: input.adopted,
        lastPresence: {
          pid: 777,
          onExit: "stop",
          liveness: "alive",
          observedAt: "2026-09-24T00:00:00.000Z",
        },
        updatedAt: "2026-09-24T00:00:00.000Z",
      },
    });
    await markSupervisorRunOwed(ENVIRONMENT, PREDECESSOR_PID);
    await removeSupervisorRecords(
      ENVIRONMENT,
      PREDECESSOR_PID,
      "keep-run-state",
    );
  }

  function mockProbe(
    calls: ProbeCall[],
    verdict:
      | "alive-same"
      | "alive-different"
      | "dead"
      | "indeterminate"
      | "throw",
  ): void {
    vi.doMock("../../store/process-identity", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../store/process-identity")>();
      return {
        ...actual,
        verifyProcessIdentityAsync: async (target: ProbeCall) => {
          calls.push(target);
          if (verdict === "throw") throw new Error("probe failed");
          return verdict;
        },
      };
    });
  }

  it.each(["dead", "alive-different"] as const)(
    "inherits ownership when the predecessor is %s, probing its pid and start identity",
    async (verdict) => {
      const calls: ProbeCall[] = [];
      mockProbe(calls, verdict);
      const identity = await validIdentity();
      await writePredecessor({ adopted: true, identity });
      const { readInheritableRunOwnership } =
        await import("../lifecycle-files");
      const inherited = await readInheritableRunOwnership(ENVIRONMENT);
      expect(inherited).toEqual({
        adopted: true,
        lastPresence: {
          pid: 777,
          onExit: "stop",
          liveness: "alive",
          observedAt: "2026-09-24T00:00:00.000Z",
        },
      });
      expect(calls).toEqual([
        {
          pid: PREDECESSOR_PID,
          startedAtMs: null,
          startIdentity: identity,
        },
      ]);
    },
  );

  it.each(["alive-same", "indeterminate", "throw"] as const)(
    "does not inherit when the probe says %s",
    async (verdict) => {
      const calls: ProbeCall[] = [];
      mockProbe(calls, verdict);
      await writePredecessor({
        adopted: true,
        identity: await validIdentity(),
      });
      const { readInheritableRunOwnership } =
        await import("../lifecycle-files");
      expect(await readInheritableRunOwnership(ENVIRONMENT)).toBeNull();
      expect(calls).toHaveLength(1);
    },
  );

  it("does not inherit, and does not probe, when the predecessor was not adopted", async () => {
    const calls: ProbeCall[] = [];
    mockProbe(calls, "dead");
    await writePredecessor({ adopted: false, identity: await validIdentity() });
    const { readInheritableRunOwnership } = await import("../lifecycle-files");
    expect(await readInheritableRunOwnership(ENVIRONMENT)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("does not inherit, and does not probe, when the predecessor has no start identity", async () => {
    const calls: ProbeCall[] = [];
    mockProbe(calls, "dead");
    await writePredecessor({ adopted: true, identity: null });
    const { readInheritableRunOwnership } = await import("../lifecycle-files");
    expect(await readInheritableRunOwnership(ENVIRONMENT)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null for an absent or invalid run-state file", async () => {
    const calls: ProbeCall[] = [];
    mockProbe(calls, "dead");
    const { readInheritableRunOwnership, supervisorRunStatePath } =
      await import("../lifecycle-files");
    expect(await readInheritableRunOwnership(ENVIRONMENT)).toBeNull();
    const path = supervisorRunStatePath(ENVIRONMENT);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json {");
    expect(await readInheritableRunOwnership(ENVIRONMENT)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  /** `supervisor.json` naming `pid`, through the real serializer - never
   * hand-written JSON. */
  async function writeSupervisorJsonNaming(pid: number): Promise<void> {
    const { serializeSupervisorRecord } =
      await import("@traycer/protocol/config/supervisor-record");
    const { supervisorRecordPath } =
      await import("@traycer/protocol/config/supervisor-record");
    const { hostHomeDir } = await import("../../store/paths");
    const path = supervisorRecordPath(hostHomeDir(ENVIRONMENT));
    writeFileSync(
      path,
      serializeSupervisorRecord({
        v: 1,
        pid,
        cliVersion: "0.0.0-test",
        capabilities: ["lifecycle-policy-v1"],
        startedAt: "2026-09-24T00:00:00.000Z",
        startIdentity: null,
        admittedAs: null,
      }),
    );
  }

  // An owed exit removes `supervisor.json` on its way out
  // (`removeSupervisorRecords(..., "keep-run-state")`); a predecessor that
  // was killed, crashed or lost its session never reaches that step and
  // leaves BOTH files, still naming itself. `readInheritableRunOwnership`
  // must not inherit from that shape.
  it("a predecessor killed before its exit (supervisor.json still names it) is not inherited", async () => {
    mockProbe([], "dead");
    const identity = await validIdentity();
    await writePredecessor({ adopted: true, identity });
    await writeSupervisorJsonNaming(PREDECESSOR_PID);
    const { readInheritableRunOwnership } = await import("../lifecycle-files");
    expect(await readInheritableRunOwnership(ENVIRONMENT)).toBeNull();
  });

  // A `supervisor.json` naming a DIFFERENT pid than the
  // run state's predecessor is just as much evidence the predecessor never
  // reached its own exit cleanup (a second supervisor's live record, or a
  // stale one from a third process) - never inherited either.
  it("a supervisor.json naming a pid other than the run state's predecessor is not inherited either", async () => {
    mockProbe([], "dead");
    const identity = await validIdentity();
    await writePredecessor({ adopted: true, identity });
    await writeSupervisorJsonNaming(PREDECESSOR_PID + 1);
    const { readInheritableRunOwnership } = await import("../lifecycle-files");
    expect(await readInheritableRunOwnership(ENVIRONMENT)).toBeNull();
  });

  // A stop exit that DID reach `removeSupervisorRecords`
  // but whose run-state half of the removal failed (`rename` rejects) is the
  // same observable shape as a never-attempted removal: `supervisor.json`
  // gone, `supervisor-run.json` left behind. Nothing a successor may inherit
  // survives it either.
  it("a stop exit whose run-state removal failed leaves nothing a successor inherits", async () => {
    const identity = await validIdentity();
    const { writeSupervisorRecords, supervisorRunStatePath } =
      await import("../lifecycle-files");
    await writeSupervisorRecords(ENVIRONMENT, {
      record: {
        v: 1,
        pid: PREDECESSOR_PID,
        cliVersion: "0.0.0-test",
        capabilities: ["lifecycle-policy-v1"],
        startedAt: "2026-09-24T00:00:00.000Z",
      },
      runState: {
        v: 1,
        supervisorPid: PREDECESSOR_PID,
        supervisorStartIdentity: identity,
        admission: "unattended",
        origin: null,
        adopted: true,
        lastPresence: {
          pid: 777,
          onExit: "stop",
          liveness: "alive",
          observedAt: "2026-09-24T00:00:00.000Z",
        },
        updatedAt: "2026-09-24T00:00:00.000Z",
      },
    });
    const runStatePath = supervisorRunStatePath(ENVIRONMENT);

    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        rename: (oldPath: string, newPath: string) => {
          if (oldPath === runStatePath) {
            const busy = new Error("resource busy");
            return Promise.reject(Object.assign(busy, { code: "EBUSY" }));
          }
          return actual.rename(oldPath, newPath);
        },
      };
    });
    vi.resetModules();
    const { removeSupervisorRecords: removeSupervisorRecordsUnderFailure } =
      await import("../lifecycle-files");

    // `supervisor.json` removes cleanly; `supervisor-run.json`'s rename
    // rejects, so `removeIfOwned` gives up and leaves it in place.
    await removeSupervisorRecordsUnderFailure(
      ENVIRONMENT,
      PREDECESSOR_PID,
      "all",
    );

    mockProbe([], "dead");
    vi.resetModules();
    const { readInheritableRunOwnership } = await import("../lifecycle-files");
    expect(await readInheritableRunOwnership(ENVIRONMENT)).toBeNull();
  });
});
