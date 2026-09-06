import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command, CommanderError, Option } from "commander";
import { buildProgram } from "../index";
import * as hostUpdateModule from "../commands/host-update";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// This file parses real invocations through Commander. Its logger is not part
// of the argv contract and must not append to a live per-environment CLI log.
vi.mock("../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

// The BOUND INTENT argv contract (Plan D16), pinned at the parser.
//
// `--intent` is an argv option and not an environment variable for one
// reason, and this file is that reason made executable: an intent is
// AUTHORITY, so it has to fail CLOSED on a CLI that cannot honour it. The
// trigger rides the environment for the opposite reason - it is provenance
// and must keep working on every CLI, so an old CLI ignoring it is correct.
//
// The gate that makes an intent fail closed is the EXECUTING PARSER: a
// pre-cutover Commander program rejects `--intent` as an unknown option and
// exits before the command body runs - whatever image the slot holds at that
// instant, including one the CLI's own pre-parse self-refresh
// (`refreshCliSlotBeforeCommand`, awaited in `runEntry` before
// `program.parseAsync`) has just staged. A `--version` preflight cannot
// substitute for it: that proves the image which ANSWERED, not the image that
// runs next. `allowUnknownOption` is never enabled on root, `host` or
// `update`, which is what keeps that exit reachable.

/**
 * `host update` exactly as an rc-era CLI registered it: every option this
 * command shipped BEFORE the cutover, and neither of the two new ones.
 *
 * A fixture rather than an old build, because the pin is about the SHAPE of
 * the registration (no `allowUnknownOption`, `exitOverride` routing) and an
 * old binary cannot be executed from a unit test.
 */
function buildPreCutoverProgram(action: () => void): {
  readonly program: Command;
  readonly stderr: string[];
} {
  const stderr: string[] = [];
  const program = new Command();
  program.name("traycer");
  const host = program.command("host");
  host
    .command("update")
    .description("Update the installed host to a registry version")
    .option("--release <version>", "Registry version to update to")
    .option("--allow-downgrade", "Allow an explicitly selected --release")
    .option("--force", "Update the host even if it has work in progress")
    .addOption(
      new Option(
        "--ack-nonce <nonce>",
        "Internal: correlation nonce",
      ).hideHelp(),
    )
    .action(action);
  // `applyRunnerErrorRouting`'s shape: every command in the tree overrides
  // its exit and routes Commander's own writes.
  const route = (cmd: Command): void => {
    cmd.exitOverride();
    cmd.configureOutput({
      writeErr: (str) => stderr.push(str),
      writeOut: () => {},
    });
    for (const sub of cmd.commands) route(sub);
  };
  route(program);
  return { program, stderr };
}

describe("an rc-era parser exits on --intent with nothing executed", () => {
  it("rejects `--intent` as an unknown option, exit code 1, and never runs the action", async () => {
    const action = vi.fn();
    const { program, stderr } = buildPreCutoverProgram(action);

    const err = await program
      .parseAsync(["host", "update", "--intent", "activate"], { from: "user" })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(err).toBeInstanceOf(CommanderError);
    if (!(err instanceof CommanderError)) return;
    expect(err.code).toBe("commander.unknownOption");
    // `runEntry`'s parse-failure path finishes with `err.exitCode` when it has
    // one, else 1; Commander's own unknown-option exit code is 1.
    expect(err.exitCode).toBe(1);
    expect(stderr.join("")).toContain("unknown option '--intent'");
    // The whole point: nothing was executed. A CLI that cannot honour the
    // authorization must not perform the unauthorized broader operation - a
    // plain `host update` - instead.
    expect(action).not.toHaveBeenCalled();
  });

  it("rejects `--expect-attempt` the same way", async () => {
    const action = vi.fn();
    const { program, stderr } = buildPreCutoverProgram(action);

    const err = await program
      .parseAsync(["host", "update", "--expect-attempt", "attempt-1"], {
        from: "user",
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(err).toBeInstanceOf(CommanderError);
    expect(stderr.join("")).toContain("unknown option '--expect-attempt'");
    expect(action).not.toHaveBeenCalled();
  });

  it("positive control: the same fixture accepts the options it did register", async () => {
    const action = vi.fn();
    const { program } = buildPreCutoverProgram(action);

    await program.parseAsync(["host", "update", "--force"], { from: "user" });

    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe("the shipped parser forwards the bound intent RAW to the command body", () => {
  beforeEach(() => {
    // Throwing rather than exiting: `runEntry` records `process.exitCode` and
    // lets the loop drain, so nothing on these paths should reach
    // `process.exit` at all - and a real exit would take the whole suite down.
    vi.spyOn(process, "exit").mockImplementation((): never => {
      throw new Error("__test_exit");
    });
  });

  afterEach(() => {
    // A failing command leaves this set on the vitest process itself; unset it
    // or the whole suite exits non-zero with every test green.
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  async function parseHostUpdate(argv: readonly string[]): Promise<void> {
    const program = buildProgram();
    program.exitOverride();
    for (const host of program.commands) {
      host.exitOverride();
      for (const sub of host.commands) sub.exitOverride();
    }
    await program.parseAsync(argv as string[], { from: "user" });
  }

  it("passes --intent and --expect-attempt through without narrowing them", async () => {
    const spy = vi
      .spyOn(hostUpdateModule, "buildHostUpdateCommand")
      .mockImplementation(() => async () => ({
        data: { ok: true },
        human: "ok",
        exitCode: 0,
      }));

    await parseHostUpdate([
      "host",
      "update",
      "--intent",
      "continue",
      "--expect-attempt",
      "attempt-7",
      "--release",
      "2.0.0",
      "--json",
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      intent: "continue",
      expectAttempt: "attempt-7",
      versionRequest: "2.0.0",
    });
  });

  it("hands an ILLEGAL intent to the command body verbatim - the parser does not narrow it", async () => {
    // Registered as `--intent <intent>`, so Commander accepts any value. The
    // legal-value check belongs to the body, which is the only place that can
    // report it as a CLI error a caller can read rather than a parser exit.
    const spy = vi
      .spyOn(hostUpdateModule, "buildHostUpdateCommand")
      .mockImplementation(() => async () => ({
        data: { ok: true },
        human: "ok",
        exitCode: 0,
      }));

    await parseHostUpdate([
      "host",
      "update",
      "--intent",
      "install",
      "--expect-attempt",
      "attempt-7",
      "--json",
    ]);

    expect(spy.mock.calls[0][0]).toMatchObject({ intent: "install" });
  });

  it("leaves both null when neither option is passed", async () => {
    const spy = vi
      .spyOn(hostUpdateModule, "buildHostUpdateCommand")
      .mockImplementation(() => async () => ({
        data: { ok: true },
        human: "ok",
        exitCode: 0,
      }));

    await parseHostUpdate(["host", "update", "--json"]);

    expect(spy.mock.calls[0][0]).toMatchObject({
      intent: null,
      expectAttempt: null,
    });
  });
});
