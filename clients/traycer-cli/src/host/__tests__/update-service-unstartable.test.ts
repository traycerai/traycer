import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE } from "@traycer/protocol/host/lifecycle-constants";

// THE automatic-path refusal: an automatic update over a service this account
// could not start again - its owner disabled it, or another Windows user owns
// the task and a host is running through it - defers before it claims,
// downloads, stops or swaps, exits the one code only this refusal returns,
// and logs each state change once at INFO - not on every level-triggered run.
//
// R3: ownership is read through the gate (`readWindowsServiceTaskOwnership`),
// not the removed `readOwnServiceRegistrationDisabled`; the not-owned axis
// additionally reads the paired `supervisor.json` / `supervisor-run.json`
// records (no process-identity probe - `readSupervisorRecord` +
// `readSupervisorRunState` from `./lifecycle-files`).

const CALLER_XML = (enabled: boolean): string =>
  `<Task><Settings><Enabled>${enabled ? "true" : "false"}</Enabled></Settings></Task>`;

type Ownership =
  | { kind: "absent" }
  | { kind: "caller"; enabled: boolean }
  | { kind: "caller-malformed" }
  | { kind: "not-owned" }
  | { kind: "not-owned-unconfirmed" };

const state = vi.hoisted(() => ({
  home: "",
  ownership: { kind: "absent" } as Ownership,
}));

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    hostHomeDir: () => state.home,
    // `hostPidMetadataPath` calls `hostHomeDir` as a SAME-MODULE internal
    // reference, which a partial `vi.mock` overriding only `hostHomeDir`
    // does not rebind - a cross-module caller (`pid-metadata.ts`) would
    // otherwise resolve the REAL user's home instead of `state.home`.
    hostPidMetadataPath: () => join(state.home, "pid.json"),
  };
});
vi.mock("../../service/platforms/windows", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/platforms/windows")>();
  return {
    ...actual,
    readWindowsServiceTaskOwnership: async () => {
      switch (state.ownership.kind) {
        case "absent":
          return { kind: "absent" as const };
        case "caller":
          return {
            kind: "caller" as const,
            xml: CALLER_XML(state.ownership.enabled),
          };
        case "caller-malformed":
          return { kind: "caller" as const, xml: "<Task></Task>" };
        case "not-owned":
          return {
            kind: "not-owned" as const,
            reason: "other-owner" as const,
            detail: "the task's principal names another account",
          };
        case "not-owned-unconfirmed":
          return {
            kind: "not-owned" as const,
            reason: "unconfirmed" as const,
            detail: "the task could not be read (access denied)",
          };
      }
    },
  };
});

import { writeFile, rm } from "node:fs/promises";
import type { ILogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import {
  readSupervisorRecord,
  readSupervisorRunState,
  type SupervisorRunAdmission,
} from "../lifecycle-files";
import { refuseUpdateOverUnstartableService } from "../update-service-unstartable";

// R5 §46: seeded through the real `hostPidMetadataPath` shape (`pid`,
// `hostId`, `version`, `websocketUrl`, `startedAt`) - a cli-v1.3.0 supervisor
// writes pid.json alone, no supervisor.json/supervisor-run.json pair, and
// still runs a host through the task.
//
// Written directly under `state.home` (the same directory
// `hostPidMetadataPath("production")` resolves to via the mocked
// `hostHomeDir`) rather than through the real `hostPidMetadataPath` helper:
// that helper calls `hostHomeDir` as a SAME-MODULE internal reference, which
// this file's partial `vi.mock("../../store/paths", ...)` does not rebind.
function pidJsonPath(): string {
  return join(state.home, "pid.json");
}
async function writePidJson(): Promise<void> {
  await writeFile(
    pidJsonPath(),
    JSON.stringify({
      pid: 4242,
      hostId: "host-1",
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:1",
      startedAt: new Date().toISOString(),
    }),
    "utf8",
  );
}
async function ensurePidJsonAbsent(): Promise<void> {
  await rm(pidJsonPath(), { force: true });
}

vi.mock("../lifecycle-files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lifecycle-files")>();
  return {
    ...actual,
    readSupervisorRecord: vi.fn(actual.readSupervisorRecord),
    readSupervisorRunState: vi.fn(actual.readSupervisorRunState),
  };
});

interface Line {
  readonly level: "debug" | "info";
  readonly message: string;
}

function recordingLogger(): { logger: ILogger; lines: Line[] } {
  const lines: Line[] = [];
  const logger: ILogger = {
    debug: (message) => void lines.push({ level: "debug", message }),
    info: (message) => void lines.push({ level: "info", message }),
    warn: () => undefined,
    error: () => undefined,
  };
  return { logger, lines };
}

async function refusal(logger: ILogger): Promise<unknown> {
  try {
    return await refuseUpdateOverUnstartableService(
      "production",
      logger,
      "host update",
    );
  } catch (error) {
    return error;
  }
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), "traycer-update-disabled-"));
  state.ownership = { kind: "absent" };
  // `readUpdateServiceState` short-circuits to "startable" on any platform
  // but win32 - this file's whole axis is unreachable without the stub.
  Object.defineProperty(process, "platform", { value: "win32" });
});
afterEach(() => {
  rmSync(state.home, { recursive: true, force: true });
  vi.mocked(readSupervisorRecord).mockClear();
  vi.mocked(readSupervisorRunState).mockClear();
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

describe("refuseUpdateOverUnstartableService: disabled axis", () => {
  it("over a disabled service throws E_SERVICE_REGISTRATION_DISABLED with the reserved exit code and deferred: true", async () => {
    state.ownership = { kind: "caller", enabled: false };
    const caught = await refusal(recordingLogger().logger);
    expect(caught).toBeInstanceOf(CliError);
    if (!(caught instanceof CliError)) throw new Error("unreachable");
    expect(caught.code).toBe(CLI_ERROR_CODES.SERVICE_REGISTRATION_DISABLED);
    expect(caught.exitCode).toBe(HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE);
    expect(caught.exitCode).toBe(79);
    expect(caught.details).toMatchObject({ deferred: true });
    expect(caught.message).toContain("Host update deferred");
    expect(caught.message).toContain("Nothing was stopped or installed");
  });

  it("over three automatic passes logs INFO exactly once, then DEBUG - and every pass still refuses", async () => {
    state.ownership = { kind: "caller", enabled: false };
    const { logger, lines } = recordingLogger();
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await refusal(logger)).toBeInstanceOf(CliError);
    }
    expect(lines.filter((line) => line.level === "info")).toHaveLength(1);
    expect(lines.filter((line) => line.level === "debug")).toHaveLength(2);
    expect(lines.map((line) => line.level)).toEqual(["info", "debug", "debug"]);
  });

  it("once the service is enabled again: no throw, and one INFO saying so; nothing more on later passes", async () => {
    state.ownership = { kind: "caller", enabled: false };
    const { logger, lines } = recordingLogger();
    await refusal(logger);
    state.ownership = { kind: "caller", enabled: true };
    expect(await refusal(logger)).toBeNull();
    expect(await refusal(logger)).toBeNull();
    const infos = lines.filter((line) => line.level === "info");
    expect(infos).toHaveLength(2);
    expect(infos[1]?.message).toContain("enabled again");
    expect(
      lines.filter((line) => line.message.includes("enabled again")),
    ).toHaveLength(1);
  });

  it("a service that was never disabled is never refused and never logs", async () => {
    state.ownership = { kind: "caller", enabled: true };
    const { logger, lines } = recordingLogger();
    expect(await refusal(logger)).toBeNull();
    expect(lines).toEqual([]);
  });

  it("an absent task is never refused and never logs", async () => {
    state.ownership = { kind: "absent" };
    const { logger, lines } = recordingLogger();
    expect(await refusal(logger)).toBeNull();
    expect(lines).toEqual([]);
  });

  it("a disabled → enabled → disabled cycle announces each state change once", async () => {
    const { logger, lines } = recordingLogger();
    state.ownership = { kind: "caller", enabled: false };
    await refusal(logger);
    state.ownership = { kind: "caller", enabled: true };
    await refusal(logger);
    state.ownership = { kind: "caller", enabled: false };
    await refusal(logger);
    await refusal(logger);
    expect(lines.map((line) => line.level)).toEqual([
      "info",
      "info",
      "info",
      "debug",
    ]);
  });

  it("an unreadable <Enabled> value (no <Settings> element) is not treated as disabled: no refusal", async () => {
    state.ownership = { kind: "caller-malformed" };
    const { logger, lines } = recordingLogger();
    expect(await refusal(logger)).toBeNull();
    expect(lines).toEqual([]);
  });

  it("carries no account identifier: not in the message, the details or any line", async () => {
    state.ownership = { kind: "caller", enabled: false };
    const { logger, lines } = recordingLogger();
    const caught = await refusal(logger);
    if (!(caught instanceof CliError)) throw new Error("unreachable");
    const everything = JSON.stringify({
      message: caught.message,
      details: caught.details,
      lines,
    });
    expect(everything).not.toMatch(/S-1-\d/);
  });
});

// R3: re-homed from the deleted `readOwnServiceRegistrationDisabled reads
// only this account's switch` block onto the real read path this refusal
// now goes through.
describe("refuseUpdateOverUnstartableService: the disabled read is this account's task alone", () => {
  it("another account's task (not-owned, no supervisor pair) is never read as disabled - it takes the not-owned branch instead", async () => {
    state.ownership = { kind: "not-owned" };
    const { logger, lines } = recordingLogger();
    expect(await refusal(logger)).toEqual({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
      message: expect.stringContaining("another Windows user"),
      details: { reason: "other-owner" },
    });
    expect(lines).toEqual([]);
  });

  it("off Windows, the caller's own disabled state is never read: no refusal, no ownership query", async () => {
    state.ownership = { kind: "caller", enabled: false };
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { logger, lines } = recordingLogger();
    expect(await refusal(logger)).toBeNull();
    expect(lines).toEqual([]);
  });
});

// The not-owned axis, gated on the supervisor's paired admission records -
// NOT a process-liveness probe (T08 ruled that out: no second probe).
describe("refuseUpdateOverUnstartableService: not-owned axis (paired supervisor admission)", () => {
  function admission(
    value: SupervisorRunAdmission | "no-pair" | "mismatched-pid",
  ): void {
    if (value === "no-pair") {
      vi.mocked(readSupervisorRecord).mockResolvedValue({ kind: "absent" });
      vi.mocked(readSupervisorRunState).mockResolvedValue({ kind: "absent" });
      return;
    }
    const pid = 4242;
    vi.mocked(readSupervisorRecord).mockResolvedValue({
      kind: "valid",
      record: {
        v: 1,
        pid,
        cliVersion: "1.0.0",
        capabilities: [],
        startedAt: new Date().toISOString(),
        startIdentity: null,
        admittedAs: "service",
      },
    });
    vi.mocked(readSupervisorRunState).mockResolvedValue({
      kind: "valid",
      record: {
        v: 1,
        supervisorPid: value === "mismatched-pid" ? pid + 1 : pid,
        supervisorStartIdentity: null,
        admission: value === "mismatched-pid" ? "granted" : value,
        origin: null,
        adopted: false,
        lastPresence: null,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  it("granted: parks the update, exit 79, E_SERVICE_TASK_NOT_OWNED", async () => {
    state.ownership = { kind: "not-owned" };
    admission("granted");
    const caught = await refusal(recordingLogger().logger);
    expect(caught).toBeInstanceOf(CliError);
    if (!(caught instanceof CliError)) throw new Error("unreachable");
    expect(caught.code).toBe(CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED);
    expect(caught.exitCode).toBe(HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE);
    expect(caught.details).toMatchObject({ deferred: true });
    expect(caught.message).not.toContain(
      "run 'traycer host service install' and then 'traycer host service start'",
    );
  });

  it("unattended: parks the update the same way as granted", async () => {
    state.ownership = { kind: "not-owned" };
    admission("unattended");
    const caught = await refusal(recordingLogger().logger);
    expect(caught).toBeInstanceOf(CliError);
    if (!(caught instanceof CliError)) throw new Error("unreachable");
    expect(caught.code).toBe(CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED);
  });

  it("foreground: not refused - the run did not go through the task", async () => {
    state.ownership = { kind: "not-owned" };
    admission("foreground");
    expect(await refusal(recordingLogger().logger)).toBeNull();
  });

  it("46e: no supervisor pair AND pid.json absent: not refused, and the swap warning is returned instead (control - stays green)", async () => {
    state.ownership = { kind: "not-owned" };
    admission("no-pair");
    await ensurePidJsonAbsent();
    expect(await refusal(recordingLogger().logger)).toEqual({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
      message: expect.any(String),
      details: { reason: "other-owner" },
    });
  });

  it("46c: a mismatched pid between the two records is an UNKNOWN admission - refused like a task-started host", async () => {
    state.ownership = { kind: "not-owned" };
    admission("mismatched-pid");
    const caught = await refusal(recordingLogger().logger);
    expect(caught).toBeInstanceOf(CliError);
    if (!(caught instanceof CliError)) throw new Error("unreachable");
    expect(caught.code).toBe(CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED);
    expect(caught.exitCode).toBe(HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE);
  });

  it("an explicit `host apply` over a granted not-owned task throws exit 1, not 79", async () => {
    state.ownership = { kind: "not-owned" };
    admission("granted");
    const { logger } = recordingLogger();
    await expect(
      refuseUpdateOverUnstartableService("production", logger, "host apply"),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
      exitCode: 1,
    });
  });

  it("46b: supervisor.json valid but supervisor-run.json absent is an UNKNOWN admission - refused", async () => {
    state.ownership = { kind: "not-owned" };
    vi.mocked(readSupervisorRecord).mockResolvedValue({
      kind: "valid",
      record: {
        v: 1,
        pid: 4242,
        cliVersion: "1.0.0",
        capabilities: [],
        startedAt: new Date().toISOString(),
        startIdentity: null,
        admittedAs: "service",
      },
    });
    vi.mocked(readSupervisorRunState).mockResolvedValue({ kind: "absent" });
    const caught = await refusal(recordingLogger().logger);
    expect(caught).toBeInstanceOf(CliError);
    if (!(caught instanceof CliError)) throw new Error("unreachable");
    expect(caught.code).toBe(CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED);
    expect(caught.exitCode).toBe(HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE);
  });

  it("46d: supervisor.json invalid (garbage JSON) is an UNKNOWN admission - refused", async () => {
    state.ownership = { kind: "not-owned" };
    vi.mocked(readSupervisorRecord).mockResolvedValue({ kind: "invalid" });
    vi.mocked(readSupervisorRunState).mockResolvedValue({ kind: "absent" });
    const caught = await refusal(recordingLogger().logger);
    expect(caught).toBeInstanceOf(CliError);
    if (!(caught instanceof CliError)) throw new Error("unreachable");
    expect(caught.code).toBe(CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED);
    expect(caught.exitCode).toBe(HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE);
  });

  it("46a: a cli-v1.3.0 supervisor - pid.json present, no supervisor pair at all - is an UNKNOWN admission, not no-host: refused, automatic exit 79", async () => {
    state.ownership = { kind: "not-owned" };
    admission("no-pair");
    await writePidJson();
    const caught = await refusal(recordingLogger().logger);
    expect(caught).toBeInstanceOf(CliError);
    if (!(caught instanceof CliError)) throw new Error("unreachable");
    expect(caught.code).toBe(CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED);
    expect(caught.exitCode).toBe(HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE);
  });

  it("46a: the same cli-v1.3.0 case, explicit `host apply`, throws exit 1", async () => {
    state.ownership = { kind: "not-owned" };
    admission("no-pair");
    await writePidJson();
    const { logger } = recordingLogger();
    await expect(
      refuseUpdateOverUnstartableService("production", logger, "host apply"),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
      exitCode: 1,
    });
  });
});

// T08 ruling 13: the same refusals, split by WHY the task is not this
// account's. A task whose owner could not be confirmed is refused exactly as
// before - same code, same exit, nothing stopped or written - but its copy
// never says "another Windows user", and `details.reason` says which.
describe("refuseUpdateOverUnstartableService: the copy follows the reason", () => {
  const UNCONFIRMED =
    "Traycer couldn't confirm that the Traycer Host task on this PC belongs to your Windows account, so it left the task alone.";

  function granted(): void {
    const pid = 4242;
    vi.mocked(readSupervisorRecord).mockResolvedValue({
      kind: "valid",
      record: {
        v: 1,
        pid,
        cliVersion: "1.0.0",
        capabilities: [],
        startedAt: new Date().toISOString(),
        startIdentity: null,
        admittedAs: "service",
      },
    });
    vi.mocked(readSupervisorRunState).mockResolvedValue({
      kind: "valid",
      record: {
        v: 1,
        supervisorPid: pid,
        supervisorStartIdentity: null,
        admission: "granted",
        origin: null,
        adopted: false,
        lastPresence: null,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  it("automatic, unconfirmed: exit 79 and the code as before, the unconfirmed copy, details.reason unconfirmed", async () => {
    state.ownership = { kind: "not-owned-unconfirmed" };
    granted();
    const caught = await refusal(recordingLogger().logger);
    if (!(caught instanceof CliError)) throw new Error("unreachable");
    expect(caught.code).toBe(CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED);
    expect(caught.exitCode).toBe(HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE);
    expect(caught.message).toBe(
      `Host update deferred: ${UNCONFIRMED} Nothing was stopped or installed. Try again, or run \`traycer host doctor\`.`,
    );
    expect(caught.message).not.toContain("another Windows user");
    expect(caught.details).toMatchObject({
      deferred: true,
      reason: "unconfirmed",
    });
  });

  it("automatic, other owner: the other-owner copy, details.reason other-owner", async () => {
    state.ownership = { kind: "not-owned" };
    granted();
    const caught = await refusal(recordingLogger().logger);
    if (!(caught instanceof CliError)) throw new Error("unreachable");
    expect(caught.message).toContain("owned by another Windows user");
    expect(caught.details).toMatchObject({
      deferred: true,
      reason: "other-owner",
    });
  });

  it("explicit `host apply`, unconfirmed: exit 1 and the code as before, the unconfirmed copy", async () => {
    state.ownership = { kind: "not-owned-unconfirmed" };
    granted();
    const caught = await refuseUpdateOverUnstartableService(
      "production",
      recordingLogger().logger,
      "host apply",
    ).then(
      () => null,
      (error: unknown) => error,
    );
    if (!(caught instanceof CliError)) throw new Error("unreachable");
    expect(caught.code).toBe(CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED);
    expect(caught.exitCode).toBe(1);
    expect(caught.message).toBe(
      `Host update not applied: ${UNCONFIRMED} Nothing was stopped or installed. Try again, or run \`traycer host doctor\`.`,
    );
    expect(caught.details).toMatchObject({ reason: "unconfirmed" });
  });

  it("no host, unconfirmed: the swap warning carries the unconfirmed copy and reason", async () => {
    state.ownership = { kind: "not-owned-unconfirmed" };
    vi.mocked(readSupervisorRecord).mockResolvedValue({ kind: "absent" });
    vi.mocked(readSupervisorRunState).mockResolvedValue({ kind: "absent" });
    await ensurePidJsonAbsent();
    expect(await refusal(recordingLogger().logger)).toEqual({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
      message: `${UNCONFIRMED} Try again, or run \`traycer host doctor\`.`,
      details: { reason: "unconfirmed" },
    });
  });

  it("the park's INFO line says the owner could not be confirmed, not that another user owns it", async () => {
    state.ownership = { kind: "not-owned-unconfirmed" };
    granted();
    const { logger, lines } = recordingLogger();
    await refusal(logger);
    const infos = lines.filter((line) => line.level === "info");
    expect(infos).toHaveLength(1);
    expect(infos[0]?.message).not.toContain("owned by another user");
    expect(infos[0]?.message).toContain("could not be confirmed");
  });
});
