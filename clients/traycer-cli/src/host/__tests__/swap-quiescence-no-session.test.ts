import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILogger } from "../../logger";
import type { Environment } from "../../runner/environment";
import type { RunOptions, RunResult } from "../../service/process-runner";
import { chatDbPathFor } from "../chat-store-survey";
import { singleChatStoreSurveyRoot } from "../chat-store-survey-roots";
import type { SwapQuiescence } from "../swap-quiescence";

// The whole systemd chain runs for real here - `linuxServiceMayRespawn`,
// `linuxUserManagerUnreachable` and the settle loop - with nothing in
// `service/` mocked. The one seam is the process runner both probes reach
// through, standing in for a `systemctl` that is or is not talking to a user
// manager. `swap-quiescence.test.ts` mocks the two probes themselves, so it
// cannot show that what a bus-less machine really answers reaches the
// refusal's reason.
interface RunnerCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunOptions;
}
const runner = vi.hoisted(() => ({
  calls: [] as RunnerCall[],
  systemdBooted: true,
  installRoot: "",
  answer: null as ((args: readonly string[]) => RunResult) | null,
  readHostPidMetadataEvidenceMock: vi.fn(),
  readHostHolderEvidenceMock: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      if (path !== "/run/systemd/system") return await actual.lstat(path);
      if (runner.systemdBooted) return await actual.lstat(runner.installRoot);
      throw Object.assign(new Error("boot marker absent"), { code: "ENOENT" });
    },
  };
});

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    hostInstallDir: () => join(runner.installRoot, "install"),
    hostPidMetadataPath: () => join(runner.installRoot, "pid.json"),
  };
});

vi.mock("../../service/process-runner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/process-runner")>();
  return {
    ...actual,
    runCommand: async (
      command: string,
      args: readonly string[],
      options: RunOptions,
    ): Promise<RunResult> => {
      runner.calls.push({ command, args, options });
      const answer = runner.answer;
      if (answer === null) throw new Error("no runner answer installed");
      return answer(args);
    },
  };
});

// Sandboxed for the reasons `swap-quiescence.test.ts` gives: left real, the
// pid and holder reads touch the operator's own `~/.traycer` and put
// filesystem I/O inside the fake-timer window.
vi.mock("../holder-record", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../holder-record")>();
  return {
    ...actual,
    readHostHolderEvidenceAt: runner.readHostHolderEvidenceMock,
  };
});
vi.mock("../pid-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadataEvidenceAt: runner.readHostPidMetadataEvidenceMock,
  };
});

const {
  observeLocalArchiveInstallQuiescence,
  observeSwapQuiescence,
  SERVICE_SETTLE_TIMEOUT_MS,
} = await import("../swap-quiescence");

const ENVIRONMENT: Environment = "production";

// The settle budget is read from the monotonic clock, which vitest does not
// fake by default.
const FAKED_TIMERS = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "Date",
  "performance",
] as const;

async function withPlatform<T>(
  platform: string,
  run: () => Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  if (original === undefined) {
    throw new Error("process.platform descriptor missing");
  }
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

const silentLogger: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function observeThroughSettleWindow(): Promise<SwapQuiescence> {
  const pending = observeSwapQuiescence(
    ENVIRONMENT,
    singleChatStoreSurveyRoot("/tmp/host-home"),
    silentLogger,
  );
  await vi.advanceTimersByTimeAsync(SERVICE_SETTLE_TIMEOUT_MS + 1_000);
  return await pending;
}

/** Both verbs of a probe that never reached a user manager answer the same. */
function answerEverythingWith(result: RunResult): void {
  runner.answer = () => result;
}

function isUserManagerVersionProbe(call: RunnerCall): boolean {
  return (
    call.command === "systemctl" &&
    call.args.join(" ") === "--user show --property=Version --value"
  );
}

/**
 * Every subprocess the chain ran was the CLI's own `systemctl`, in the CLI's
 * inherited environment, with a non-zero exit read as an answer.
 */
function expectOnlyTolerantInheritedSystemctlCalls(): void {
  expect(runner.calls.length).toBeGreaterThan(0);
  for (const call of runner.calls) {
    expect(call.command).toBe("systemctl");
    expect(call.options.env).toBeUndefined();
    expect(call.options.tolerateNonZeroExit).toBe(true);
  }
}

describe("observeSwapQuiescence with no reachable systemd user session (real probes, stubbed runner)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    runner.calls.length = 0;
    runner.answer = null;
    runner.readHostPidMetadataEvidenceMock.mockResolvedValue({
      kind: "absent",
    });
    runner.readHostHolderEvidenceMock.mockResolvedValue({ kind: "absent" });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("no bus: both systemctl calls exit 1 with 'Failed to connect to bus' -> service-manager-unreachable", async () => {
    answerEverythingWith({
      exitCode: 1,
      stdout: "",
      stderr: "Failed to connect to bus: No such file or directory",
    });

    await withPlatform("linux", async () => {
      await expect(observeThroughSettleWindow()).resolves.toEqual({
        established: false,
        reason: "service-manager-unreachable",
      });
    });

    expectOnlyTolerantInheritedSystemctlCalls();
    // The reachability question was really put, once, to the real probe.
    expect(runner.calls.filter(isUserManagerVersionProbe)).toHaveLength(1);
    expect(runner.calls.find(isUserManagerVersionProbe)).toMatchObject({
      command: "systemctl",
      args: ["--user", "show", "--property=Version", "--value"],
    });
  });

  it("an unusable bus path: both systemctl calls exit 1 with 'Argument list too long' -> service-manager-unreachable", async () => {
    answerEverythingWith({
      exitCode: 1,
      stdout: "",
      stderr:
        "Failed to connect to user scope bus via local transport: Argument list too long",
    });

    await withPlatform("linux", async () => {
      await expect(observeThroughSettleWindow()).resolves.toEqual({
        established: false,
        reason: "service-manager-unreachable",
      });
    });

    expectOnlyTolerantInheritedSystemctlCalls();
  });

  it("systemctl cannot be spawned: the runner throws -> service-manager-unreachable", async () => {
    runner.answer = () => {
      throw new Error("systemctl could not be spawned (ENOENT)");
    };

    await withPlatform("linux", async () => {
      await expect(observeThroughSettleWindow()).resolves.toEqual({
        established: false,
        reason: "service-manager-unreachable",
      });
    });

    expectOnlyTolerantInheritedSystemctlCalls();
  });

  it("systemctl times out: exitCode -1 with empty output -> service-manager-unreachable", async () => {
    answerEverythingWith({ exitCode: -1, stdout: "", stderr: "" });

    await withPlatform("linux", async () => {
      await expect(observeThroughSettleWindow()).resolves.toEqual({
        established: false,
        reason: "service-manager-unreachable",
      });
    });

    expectOnlyTolerantInheritedSystemctlCalls();
  });

  it("a reachable manager whose unit is inactive clears - the stub reaches the real probe, and reachability is never asked", async () => {
    runner.answer = (args) =>
      args.join(" ") === "--user show --property=Version --value"
        ? { exitCode: 0, stdout: "255.4\n", stderr: "" }
        : { exitCode: 3, stdout: "inactive\n", stderr: "" };

    await withPlatform("linux", async () => {
      await expect(
        observeSwapQuiescence(
          ENVIRONMENT,
          singleChatStoreSurveyRoot("/tmp/host-home"),
          silentLogger,
        ),
      ).resolves.toEqual({ established: true });
    });

    expectOnlyTolerantInheritedSystemctlCalls();
    expect(runner.calls.every((call) => call.args[1] === "is-active")).toBe(
      true,
    );
  });

  it("a reachable manager that keeps the unit activating stays service-may-respawn - reachable is not unreachable", async () => {
    runner.answer = (args) =>
      args.join(" ") === "--user show --property=Version --value"
        ? { exitCode: 0, stdout: "255.4\n", stderr: "" }
        : { exitCode: 3, stdout: "activating\n", stderr: "" };

    await withPlatform("linux", async () => {
      await expect(observeThroughSettleWindow()).resolves.toEqual({
        established: false,
        reason: "service-may-respawn",
      });
    });

    expectOnlyTolerantInheritedSystemctlCalls();
  });
});

describe("quiescence for a local archive install without service registration", () => {
  beforeEach(async () => {
    runner.installRoot = await mkdtemp(
      join(tmpdir(), "traycer-fresh-install-"),
    );
    runner.calls.length = 0;
    runner.systemdBooted = false;
    runner.readHostPidMetadataEvidenceMock.mockResolvedValue({
      kind: "absent",
    });
    runner.readHostHolderEvidenceMock.mockResolvedValue({ kind: "absent" });
    runner.answer = () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Failed to connect to bus: No such file or directory",
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(runner.installRoot, { recursive: true, force: true });
  });

  function observeInstall(): Promise<SwapQuiescence> {
    return withPlatform("linux", () =>
      observeLocalArchiveInstallQuiescence(
        ENVIRONMENT,
        singleChatStoreSurveyRoot(runner.installRoot),
        silentLogger,
      ),
    );
  }

  it("clears an empty slot when the systemd boot marker is absent", async () => {
    await expect(observeInstall()).resolves.toEqual({ established: true });
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    "pid.json",
    "holder.json",
    "install/old-host",
    "chat store",
    "boot marker",
  ])(
    "retains the unreachable-manager refusal with %s present",
    async (entry) => {
      if (entry === "boot marker") {
        runner.systemdBooted = true;
      } else {
        const path =
          entry === "chat store"
            ? chatDbPathFor(runner.installRoot, "existing-epic")
            : join(runner.installRoot, entry);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "");
      }
      vi.spyOn(performance, "now")
        .mockReturnValueOnce(0)
        .mockReturnValue(SERVICE_SETTLE_TIMEOUT_MS + 1);

      await expect(observeInstall()).resolves.toEqual({
        established: false,
        reason: "service-manager-unreachable",
      });
      expect(runner.calls.some(isUserManagerVersionProbe)).toBe(true);
    },
  );
});
