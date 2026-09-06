import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { Command } from "commander";
import { buildProgramWithAgentRoles } from "../index";
import * as cgroupRelocationModule from "../host/cgroup-relocation";
import * as hostStopModule from "../commands/host-stop";
import * as cliLockModule from "../store/cli-lock";
import * as updateContenderModule from "../host/update-contender";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";

// `withRunner`'s cgroup relocation hook (host/cgroup-relocation.ts) has to sit
// BEFORE the command body runs, because the body is where the CLI lock,
// the update-contender claim, the dispatch ACK, and the progress marker are
// all taken - the relocated child must own every one of them and the parent
// (about to die with the host's cgroup) must own none. These tests pin that
// placement end-to-end through `buildProgram()` and real Commander parsing,
// with the relocation itself, the command body, and process teardown all
// stubbed so nothing here touches a real cgroup, spawns `systemd-run`, or
// exits the test process.

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

const exitMocks = vi.hoisted(() => ({
  calls: [] as number[],
}));

vi.mock("../runner/exit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner/exit")>();
  return {
    ...actual,
    finishAndExit: async (exitCode: number) => {
      exitMocks.calls.push(exitCode);
      // Deliberately not draining anything real: the recorder's whole job is
      // to prove WHETHER and WITH WHAT CODE the terminator was reached, not
      // to reproduce its stdio/Sentry/dispatcher teardown.
    },
  };
});

function findSubcommand(parent: Command, name: string): Command | null {
  for (const child of parent.commands) {
    if (child.name() === name) return child;
  }
  return null;
}

function expectCommand(program: Command, path: readonly string[]): Command {
  let cursor: Command = program;
  for (const segment of path) {
    const next = findSubcommand(cursor, segment);
    if (next === null) {
      throw new Error(`command '${path.join(" ")}' not found`);
    }
    cursor = next;
  }
  return cursor;
}

async function parseHostStop(argv: readonly string[]): Promise<void> {
  // `buildProgramWithAgentRoles` rather than `buildProgram`: the latter calls
  // `readFeatureSettingsSync()`, which synchronously reads the developer's real
  // `~/.traycer/cli/config.json`. Agent roles are irrelevant to `host stop`.
  const program = buildProgramWithAgentRoles(false);
  program.exitOverride();
  const stop = expectCommand(program, ["host", "stop"]);
  stop.exitOverride();
  await program.parseAsync(argv as string[], { from: "user" });
}

describe("withRunner - cgroup relocation hook", () => {
  let exitSpy: MockInstance;
  let relocationSpy: MockInstance;
  let ackSpy: MockInstance;
  let hostStopSpy: MockInstance;
  let cliLockSpy: MockInstance;
  let updateContenderSpy: MockInstance;
  let stdoutWriteSpy: MockInstance;

  beforeEach(() => {
    exitMocks.calls.length = 0;
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code: string | number | null | undefined): never => {
        throw new Error(`__test_exit_${code ?? 0}`);
      });
    relocationSpy = vi.spyOn(
      cgroupRelocationModule,
      "relocateOutOfHostCgroupIfNeeded",
    );
    // Stubbed rather than observed only: the real one writes to raw fd 3, and
    // nothing here should touch whatever that is in the test runner.
    ackSpy = vi
      .spyOn(cgroupRelocationModule, "acknowledgeRelocationEntry")
      .mockImplementation(() => undefined);
    hostStopSpy = vi
      .spyOn(hostStopModule, "buildHostStopCommand")
      .mockImplementation(() => async () => ({
        data: { stopped: true },
        human: "stopped",
        exitCode: 0,
      }));
    cliLockSpy = vi.spyOn(cliLockModule, "withCliLock");
    updateContenderSpy = vi.spyOn(
      updateContenderModule,
      "withCliUpdateContender",
    );
    stdoutWriteSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    process.exitCode = undefined;
    exitSpy.mockRestore();
    relocationSpy.mockRestore();
    ackSpy.mockRestore();
    hostStopSpy.mockRestore();
    cliLockSpy.mockRestore();
    updateContenderSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("relocated (completed, exit 0): never builds the command body, exits with the child's code", async () => {
    relocationSpy.mockResolvedValue({ kind: "completed", exitCode: 0 });

    await parseHostStop(["host", "stop"]);

    expect(hostStopSpy).not.toHaveBeenCalled();
    expect(exitMocks.calls).toEqual([0]);
  });

  it("acknowledges relocation entry before anything else the action does", async () => {
    // The relocated CLI's half of the parent's fd-3 handshake. It has to be
    // first: until it is written, every failure in this action looks to the
    // waiting parent like `systemd-run` failing to start a CLI at all.
    relocationSpy.mockResolvedValue({ kind: "not-needed" });

    await parseHostStop(["host", "stop"]);

    expect(ackSpy).toHaveBeenCalledTimes(1);
    expect(ackSpy.mock.invocationCallOrder[0]).toBeLessThan(
      relocationSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(ackSpy.mock.invocationCallOrder[0]).toBeLessThan(
      hostStopSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );

    // Ablation: in `withRunner`, move `acknowledgeRelocationEntry();` below the
    // relocation block → this test fails on the ordering assertion, and a
    // relocated CLI would only say hello after the work that can fail first.
  });

  it("relocated (completed, non-zero exit): forwards the child's exact exit code", async () => {
    relocationSpy.mockResolvedValue({ kind: "completed", exitCode: 7 });

    await parseHostStop(["host", "stop"]);

    expect(hostStopSpy).not.toHaveBeenCalled();
    expect(exitMocks.calls).toEqual([7]);
  });

  it("not-needed: the ordinary command body runs (the hook does not swallow ordinary runs)", async () => {
    relocationSpy.mockResolvedValue({ kind: "not-needed" });

    await parseHostStop(["host", "stop"]);

    expect(hostStopSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards the parsed options (optsBag), not just the command path, to the relocation predicate", async () => {
    // The whole finding this task pins is that `HOST_STOPPING_COMMANDS` now
    // reads OPTIONS, not just the command path - and that is worthless if
    // `withRunner` never hands the parsed flags to the predicate at all.
    relocationSpy.mockResolvedValue({ kind: "not-needed" });

    await parseHostStop(["host", "stop", "--json"]);

    expect(relocationSpy).toHaveBeenCalledTimes(1);
    const [commandPath, options] = relocationSpy.mock.calls[0] ?? [];
    expect(commandPath).toBe("host stop");
    expect(options).toMatchObject({ json: true });
  });

  it("relocation failure: keeps E_SERVICE_CONTROL_FAILED through the runner's error path under --json, and never builds the command body", async () => {
    const failure = cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: "could not move 'host stop' out of the host cgroup",
      details: { unit: "ai.traycer.host.service" },
      exitCode: 1,
    });
    relocationSpy.mockRejectedValue(failure);

    await parseHostStop(["host", "stop", "--json"]);

    expect(hostStopSpy).not.toHaveBeenCalled();
    // The failure keeps its code instead of decaying to E_UNEXPECTED: it is
    // rendered through the runner's normal error path (`runCommand`), which
    // writes a `result`/`error` NDJSON envelope carrying `cliErr.code`
    // verbatim rather than an entry-level generic handler that would lose it.
    const written = stdoutWriteSpy.mock.calls
      .map((call) => call[0])
      .filter((chunk): chunk is string => typeof chunk === "string")
      .join("");
    expect(written).toContain("E_SERVICE_CONTROL_FAILED");
    const errorLine = written
      .split("\n")
      .find((line) => line.includes("E_SERVICE_CONTROL_FAILED"));
    expect(errorLine).toBeDefined();
    const parsed: unknown = JSON.parse(errorLine ?? "{}");
    expect(parsed).toMatchObject({
      type: "result",
      status: "error",
      error: { code: "E_SERVICE_CONTROL_FAILED" },
    });
    expect(exitMocks.calls).toEqual([1]);

    // Ablation: in `withRunner`, change the relocation try/catch so the
    // caught error is re-thrown directly (e.g. `throw error;`) instead of
    // routed through `await runCommand(() => Promise.reject(error), flags);`
    // → this test fails: an error thrown straight out of a Commander action
    // is not caught by `runCommand`'s try/catch, so no `result`/`error`
    // NDJSON line is ever written and `toContain("E_SERVICE_CONTROL_FAILED")`
    // finds nothing.
  });

  it("relocated path: the parent takes nothing command-owned (withCliLock / withCliUpdateContender never called)", async () => {
    relocationSpy.mockResolvedValue({ kind: "completed", exitCode: 0 });

    await parseHostStop(["host", "stop"]);

    // The load-bearing half of this pin is `hostStopSpy` never running at
    // all (asserted above and again here) - `withCliLock` and
    // `withCliUpdateContender` are only ever reached from inside
    // `buildHostStopCommand`'s body, so their zero-call counts follow
    // directly from the body never running rather than from any guard of
    // their own. This assertion exists to make that chain explicit, not to
    // add independent coverage.
    expect(hostStopSpy).not.toHaveBeenCalled();
    expect(cliLockSpy).not.toHaveBeenCalled();
    expect(updateContenderSpy).not.toHaveBeenCalled();
  });

  // Ablation (ordering): in `withRunner`, move the
  // `relocation = await relocateOutOfHostCgroupIfNeeded(commandPath)` block
  // to after `await runCommand(guarded, flags)` → the "never builds the
  // command body" tests above fail: `hostStopSpy` would be called once
  // before the (too-late) relocation check ever ran.
});
