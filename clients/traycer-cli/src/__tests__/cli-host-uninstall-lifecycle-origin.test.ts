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
import { Command, CommanderError } from "commander";
import { buildProgram } from "../index";
import * as hostUninstallModule from "../commands/host-uninstall";
import { hostHomeDir } from "../store/paths";

// `host uninstall --all --lifecycle-origin desktop` sibling to
// `cli-lifecycle-origin-flag.test.ts` (read for the program-build and
// module-spy pattern only - that file is off-limits to edit, owned by
// another agent in this same family; this is a NEW file for `host uninstall`
// specifically, per an earlier redirect).
//
// `host uninstall` is NOT one of `cli-lifecycle-origin-flag.test.ts`'s eight
// start-capable commands and has no `--lifecycle-origin` option registered
// at all today (verified by reading `../index.ts`'s `host uninstall`
// registration in full: it only reads `opts.all`, and
// `buildHostUninstallCommand` is called with `{ all: opts.all === true }`
// alone). This suite is written against the target design from the sibling
// `host-uninstall-foreground.test.ts` task: `HostUninstallArgs` gains
// `lifecycleOrigin`, and the CLI registers `--lifecycle-origin` on
// `host uninstall` the same way it already does on the eight start-capable
// commands (`.choices(HOST_START_ORIGINS)`, so an unrecognised value is a
// Commander parse error, not a silently mislabelled request).
//
// Test 1 is expected RED on current code: Commander rejects the unknown
// `--lifecycle-origin` option on `host uninstall` (`error:
// unknown option '--lifecycle-origin'`) before `buildHostUninstallCommand`
// is ever reached, so the spy is never called.

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// This test exercises the real runner through Commander. Its logger is not
// part of the `--lifecycle-origin` contract, and must not append to a live
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
      joinPath(
        actual.tmpdir(),
        "traycer-cli-host-uninstall-lifecycle-origin-test-home-",
      ),
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

function stubCommand(): () => Promise<{
  readonly data: { readonly ok: true };
  readonly human: string;
  readonly exitCode: number;
}> {
  return async () => ({ data: { ok: true }, human: "ok", exitCode: 0 });
}

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

describe("host uninstall --lifecycle-origin", () => {
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

  // Test 1 (RED expected): `host uninstall --all --lifecycle-origin desktop`
  // must reach `buildHostUninstallCommand` with
  // `{ all: true, lifecycleOrigin: "desktop" }`. RED on current code:
  // `--lifecycle-origin` is not a registered option on `host uninstall`, so
  // Commander refuses the argv before the builder is ever invoked.
  it("`host uninstall --all --lifecycle-origin desktop` reaches the builder as { all: true, lifecycleOrigin: 'desktop' }", async () => {
    const spy = vi
      .spyOn(hostUninstallModule, "buildHostUninstallCommand")
      .mockImplementation(stubCommand);

    await parseCommand(
      ["host", "uninstall"],
      ["--all", "--lifecycle-origin", "desktop"],
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      all: true,
      lifecycleOrigin: "desktop",
    });
  });

  // Test 2 (control): with no `--lifecycle-origin` flag at all, it reaches
  // the builder with `lifecycleOrigin: "terminal"` (the default).
  it("`host uninstall --all` with no --lifecycle-origin reaches the builder as lifecycleOrigin: 'terminal'", async () => {
    const spy = vi
      .spyOn(hostUninstallModule, "buildHostUninstallCommand")
      .mockImplementation(stubCommand);

    await parseCommand(["host", "uninstall"], ["--all"]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      all: true,
      lifecycleOrigin: "terminal",
    });
  });
});
