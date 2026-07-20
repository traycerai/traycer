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
import { buildProgram, extractActionPositionals } from "../index";
import * as hostInstallModule from "../commands/host-install";
import * as hostUpdateModule from "../commands/host-update";

// `host install` accepts a registry version via the `--release`
// flag (defaults to `latest`) or a local archive via `--from`; the
// two are mutually exclusive. We pin two layers of behaviour:
//
// 1. `extractActionPositionals` - the unit boundary that converts
//    commander's loose `(...positional, opts, command)` args into the
//    typed positional slice. Still exercised exhaustively because the
//    helper is shared with other commands that DO use positionals.
//
// 2. End-to-end: parse a `host install` invocation through
//    `buildProgram()` with `installHostModule` mocked, and assert
//    that `buildHostInstallCommand` is called with the right
//    `versionRequest` + `fromPath` combination - including the
//    mutex rejection when both flags are supplied.

describe("extractActionPositionals", () => {
  it("returns [] when no positionals were declared (opts + command only)", () => {
    const opts = { json: true };
    const cmd = {};
    expect(extractActionPositionals([opts, cmd])).toEqual([]);
  });

  it("returns one positional for a single-argument command", () => {
    const opts = {};
    const cmd = {};
    expect(extractActionPositionals(["1.4.2", opts, cmd])).toEqual(["1.4.2"]);
  });

  it("preserves `undefined` for an optional positional that was not supplied", () => {
    const opts = {};
    const cmd = {};
    expect(extractActionPositionals([undefined, opts, cmd])).toEqual([
      undefined,
    ]);
  });

  it("preserves multiple positionals in order", () => {
    const opts = {};
    const cmd = {};
    expect(extractActionPositionals(["a", "b", "c", opts, cmd])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("coerces non-string entries to `undefined` so callers can guard with typeof", () => {
    const opts = {};
    const cmd = {};
    // Commander never passes non-strings/undefined for positionals,
    // but the unit boundary should be defensive.
    expect(extractActionPositionals([42, opts, cmd])).toEqual([undefined]);
  });

  it("returns [] when the actionArgs array is malformed (length < 2)", () => {
    expect(extractActionPositionals([])).toEqual([]);
    expect(extractActionPositionals(["just-one"])).toEqual([]);
  });
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

describe("traycer host install - --release / --from handling", () => {
  // `runCommand` calls `process.exit(...)` once the command completes.
  // We swap it out for a throw so commander's `parseAsync` resolves
  // cleanly and we can assert on the spy. The throw payload is harmless
  // because we re-suppress it inside the helper.
  let exitSpy: MockInstance;
  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code: string | number | null | undefined): never => {
        throw new Error(`__test_exit_${code ?? 0}`);
      });
  });
  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function setupSpy(): MockInstance {
    // Replace the real install pipeline with a no-op that captures the
    // args. We can't run the real installer in a unit test (it would
    // touch the filesystem, registry, and OS service).
    return vi
      .spyOn(hostInstallModule, "buildHostInstallCommand")
      .mockImplementation(() => async () => ({
        data: { ok: true },
        human: "ok",
        exitCode: 0,
      }));
  }

  async function parseHostInstall(argv: readonly string[]): Promise<void> {
    const program = buildProgram();
    program.exitOverride();
    const install = expectCommand(program, ["host", "install"]);
    install.exitOverride();
    try {
      await program.parseAsync(argv as string[], { from: "user" });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("__test_exit_")) {
        return;
      }
      throw err;
    }
  }

  it("forwards the explicit --release value to buildHostInstallCommand", async () => {
    const spy = setupSpy();
    await parseHostInstall(["host", "install", "--release", "1.4.2", "--json"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      versionRequest: "1.4.2",
      fromPath: null,
    });
    spy.mockRestore();
  });

  it("forwards `latest` when --release is set to it explicitly", async () => {
    const spy = setupSpy();
    await parseHostInstall([
      "host",
      "install",
      "--release",
      "latest",
      "--json",
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      versionRequest: "latest",
      fromPath: null,
    });
    spy.mockRestore();
  });

  it("defaults `versionRequest` to `latest` when neither --release nor --from is supplied", async () => {
    const spy = setupSpy();
    await parseHostInstall(["host", "install", "--json"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      versionRequest: "latest",
      fromPath: null,
    });
    spy.mockRestore();
  });

  it("forwards --from <path> with a placeholder versionRequest the command body ignores", async () => {
    const spy = setupSpy();
    await parseHostInstall([
      "host",
      "install",
      "--from",
      "/tmp/host.tgz",
      "--json",
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      versionRequest: "latest",
      fromPath: "/tmp/host.tgz",
    });
    spy.mockRestore();
  });

  it("routes the --release + --from mutual-exclusion error through the runner (exit 1, never builds the install pipeline)", async () => {
    const spy = setupSpy();
    await parseHostInstall([
      "host",
      "install",
      "--release",
      "1.4.2",
      "--from",
      "/tmp/host.tgz",
      "--json",
    ]);
    // The check now lives inside the returned CommandFn, so the runner
    // catches it (CliError → NDJSON error envelope → process.exit(1))
    // instead of letting a raw throw escape parseAsync. The install
    // pipeline is never built.
    expect(spy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    spy.mockRestore();
  });

  it("accepts runner flags interleaved with the --release flag", async () => {
    const spy = setupSpy();
    await parseHostInstall([
      "host",
      "install",
      "--no-progress",
      "--release",
      "1.4.2",
      "--json",
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      versionRequest: "1.4.2",
    });
    spy.mockRestore();
  });
});

describe("traycer host update - --release handling", () => {
  let exitSpy: MockInstance;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code: string | number | null | undefined): never => {
        throw new Error(`__test_exit_${code ?? 0}`);
      });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("normalizes an empty --release value to the stable latest pointer", async () => {
    const updateSpy = vi
      .spyOn(hostUpdateModule, "buildHostUpdateCommand")
      .mockImplementation(() => async () => ({
        data: { ok: true },
        human: "ok",
        exitCode: 0,
      }));
    const program = buildProgram();
    program.exitOverride();

    try {
      await program.parseAsync(["host", "update", "--release", "", "--json"], {
        from: "user",
      });
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith("__test_exit_"))) {
        throw err;
      }
    }

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toMatchObject({
      versionRequest: "latest",
      force: false,
    });
  });
});
