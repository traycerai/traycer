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
import * as hostUninstallModule from "../commands/host-uninstall";

// `host uninstall --force` is the forced STOP, accepted with or without
// `--all`: both forms stop a running host before removing the bytes. The setup mirrors `cli-with-runner-relocation`:
// the relocation hook and the process terminator are stubbed so the real
// runner runs from inside a Traycer host's cgroup too.

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
    },
  };
});

function findSubcommand(parent: Command, name: string): Command | null {
  for (const child of parent.commands) {
    if (child.name() === name) return child;
  }
  return null;
}

async function parseHostUninstall(argv: readonly string[]): Promise<void> {
  // `buildProgramWithAgentRoles` rather than `buildProgram`: the latter reads
  // the developer's real `~/.traycer/cli/config.json`.
  const program = buildProgramWithAgentRoles(false);
  program.exitOverride();
  let cursor: Command = program;
  for (const segment of ["host", "uninstall"]) {
    const next = findSubcommand(cursor, segment);
    if (next === null) throw new Error(`command '${segment}' not found`);
    next.exitOverride();
    cursor = next;
  }
  await program.parseAsync(["host", "uninstall", ...argv, "--json"], {
    from: "user",
  });
}

function stubCommand(): () => Promise<{
  readonly data: { readonly ok: true };
  readonly human: string;
  readonly exitCode: number;
}> {
  return async () => ({ data: { ok: true }, human: "ok", exitCode: 0 });
}

describe("host uninstall --force", () => {
  let stdout: string;
  let stdoutSpy: MockInstance;
  let buildSpy: MockInstance;

  beforeEach(() => {
    exitMocks.calls.length = 0;
    stdout = "";
    vi.spyOn(
      cgroupRelocationModule,
      "relocateOutOfHostCgroupIfNeeded",
    ).mockResolvedValue({ kind: "not-needed" });
    vi.spyOn(
      cgroupRelocationModule,
      "acknowledgeRelocationEntry",
    ).mockImplementation(() => undefined);
    buildSpy = vi
      .spyOn(hostUninstallModule, "buildHostUninstallCommand")
      .mockImplementation(stubCommand);
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk);
        return true;
      });
  });

  afterEach(() => {
    process.exitCode = undefined;
    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("accepts --force without --all and builds the command with force", async () => {
    await parseHostUninstall(["--force"]);

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy.mock.calls[0]?.[0]).toMatchObject({
      all: false,
      force: true,
    });
    expect(exitMocks.calls).toEqual([0]);
    expect(stdout).not.toContain("E_INVALID_ARGUMENT");
  });

  it("still dispatches --all --force to the uninstall command", async () => {
    await parseHostUninstall(["--all", "--force"]);

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy.mock.calls[0]?.[0]).toMatchObject({
      all: true,
      force: true,
    });
    expect(exitMocks.calls).toEqual([0]);
    expect(stdout).not.toContain("E_INVALID_ARGUMENT");
  });
});

describe("host uninstall --all help", () => {
  function optionDescription(long: string): string {
    const program = buildProgramWithAgentRoles(false);
    const host = findSubcommand(program, "host");
    const uninstall = host === null ? null : findSubcommand(host, "uninstall");
    if (uninstall === null) throw new Error("command 'host uninstall' missing");
    const option = uninstall.options.find(
      (candidate) => candidate.long === long,
    );
    if (option === undefined) throw new Error(`option '${long}' missing`);
    return option.description;
  }

  function allOptionDescription(): string {
    return optionDescription("--all");
  }

  it("says the stop is cooperative on macOS and Linux", () => {
    expect(allOptionDescription()).toContain(
      "On macOS and Linux the stop is cooperative: if the host does not stop, its install is kept and the command fails, naming --force.",
    );
  });

  it("says that on Windows the stop ends the host's process tree", () => {
    expect(allOptionDescription()).toContain(
      "On Windows the stop ends the host's process tree, so running terminal sessions and in-flight agent work are lost.",
    );
  });

  it("describes --force without naming a signal", () => {
    const description = optionDescription("--force");
    expect(description).not.toContain("SIGKILL");
    expect(description).toContain("Stop the host even if it is not responding");
    expect(description).toContain(
      "Running terminal sessions and in-flight agent work are killed.",
    );
  });
});
