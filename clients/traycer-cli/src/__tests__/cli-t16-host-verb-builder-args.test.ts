import { rmSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { Command } from "commander";
import { buildProgram } from "../index";
import * as hostInstallModule from "../commands/host-install";
import * as hostLifecycleModule from "../commands/host-lifecycle";
import * as hostRestartModule from "../commands/host-restart";
import * as hostStopModule from "../commands/host-stop";
import { refreshServiceDefinitionUnderContender } from "../commands/service-refresh";
import { hostHomeDir } from "../store/paths";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// This test exercises the real runner through Commander. Its logger is not
// part of the flag-forwarding contract, and must not append to a live
// per-environment CLI log as a side effect.
vi.mock("../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

// HOME is redirected to a private temp dir BEFORE anything reads it:
// `store/paths` binds `homedir()` at module load, so without this the suite
// would resolve this machine's REAL `~/.traycer`.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-cli-t16-verb-builder-args-test-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

beforeAll(() => {
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

function findSubcommand(parent: Command, name: string): Command | null {
  for (const child of parent.commands) {
    if (child.name() === name) return child;
  }
  return null;
}

async function parseCommand(
  path: readonly string[],
  argv: readonly string[],
): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  let cursor: Command = program;
  for (const segment of path) {
    const next = findSubcommand(cursor, segment);
    if (next === null) {
      throw new Error(`command '${path.join(" ")}' not found`);
    }
    next.exitOverride();
    cursor = next;
  }
  await program.parseAsync([...path, ...argv, "--json"], { from: "user" });
}

function stubCommand(): () => Promise<{
  readonly data: { readonly ok: true };
  readonly human: string;
  readonly exitCode: number;
}> {
  return async () => ({ data: { ok: true }, human: "ok", exitCode: 0 });
}

// Each start-capable verb's builder-argument contract, pinned through
// `buildProgram()` end to end (the spy pattern `cli-lifecycle-origin-flag.
// test.ts` / `cli-with-runner-positionals.test.ts` use).
describe("host verb --if-idle / mode builder arguments", () => {
  let exitSpy: MockInstance;
  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code: string | number | null | undefined): never => {
        throw new Error(`__test_exit_${code ?? 0}`);
      });
  });
  afterEach(() => {
    process.exitCode = undefined;
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("`host stop --if-idle` reaches buildHostStopCommand as { ifIdle: true, force: false }", async () => {
    const spy = vi
      .spyOn(hostStopModule, "buildHostStopCommand")
      .mockImplementation(stubCommand);
    await parseCommand(["host", "stop"], ["--if-idle"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      ifIdle: true,
      force: false,
    });
  });

  it("`host restart --if-idle` reaches buildHostRestartCommand as { ifIdle: true }", async () => {
    const spy = vi
      .spyOn(hostRestartModule, "buildHostRestartCommand")
      .mockImplementation(stubCommand);
    await parseCommand(["host", "restart"], ["--if-idle"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ ifIdle: true });
  });

  it("`host install --if-idle` reaches buildHostInstallCommand as { ifIdle: true }", async () => {
    const spy = vi
      .spyOn(hostInstallModule, "buildHostInstallCommand")
      .mockImplementation(() => async () => ({
        data: { ok: true },
        human: "ok",
        exitCode: 0,
      }));
    await parseCommand(["host", "install"], ["--if-idle"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ ifIdle: true });
  });

  it("`host lifecycle set linked` reaches buildHostLifecycleSetCommand as { mode: 'linked', refreshServiceDefinition: refreshServiceDefinitionUnderContender }", async () => {
    const spy = vi
      .spyOn(hostLifecycleModule, "buildHostLifecycleSetCommand")
      .mockImplementation(stubCommand);
    await parseCommand(["host", "lifecycle", "set"], ["linked"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]?.mode).toBe("linked");
    // Identity, not just equality: the real refresher, not a lookalike.
    expect(spy.mock.calls[0]?.[0]?.refreshServiceDefinition).toBe(
      refreshServiceDefinitionUnderContender,
    );
  });
});
