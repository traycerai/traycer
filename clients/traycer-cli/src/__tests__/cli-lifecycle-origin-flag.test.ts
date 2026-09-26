import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { Command, CommanderError } from "commander";
import { buildProgram } from "../index";
import * as hostApplyModule from "../commands/host-apply";
import * as hostEnsureModule from "../commands/host-ensure";
import * as hostFreePortAndRestartModule from "../commands/host-free-port-and-restart";
import * as hostInstallModule from "../commands/host-install";
import * as hostRestartModule from "../commands/host-restart";
import * as hostStopModule from "../commands/host-stop";
import * as serviceInstallModule from "../commands/service-install";
import * as serviceStartModule from "../commands/service-start";

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

// `--lifecycle-origin` (`host/lifecycle-origin.ts`) is registered on exactly
// the eight start-capable commands. On five of them it reaches the command
// builder's `lifecycleOrigin` as `hostStartOriginFromOption(opts.
// lifecycleOrigin)`: the flag's value, or `DEFAULT_HOST_START_ORIGIN`
// ("terminal") when omitted. On `restart`, `stop` and `free-port-and-restart`
// it is accepted and inert (their relaunch legs record `maintenance`), so
// Traycer Desktop can pass it on every start-capable call. Everywhere,
// `.choices(HOST_START_ORIGINS)` makes an unrecognised value a Commander parse
// error rather than a silently mislabelled start. Pinned end-to-end through
// `buildProgram()` with the spy pattern `cli-with-runner-positionals.test.ts`
// uses for `host install`.

interface OriginFlagCase {
  readonly path: readonly string[];
  /** Whether the builder receives `lifecycleOrigin` (false: accepted, inert). */
  readonly forwards: boolean;
  readonly spy: () => MockInstance;
}

function stubCommand(): () => Promise<{
  readonly data: { readonly ok: true };
  readonly human: string;
  readonly exitCode: number;
}> {
  return async () => ({ data: { ok: true }, human: "ok", exitCode: 0 });
}

const ORIGIN_FLAG_CASES: readonly OriginFlagCase[] = [
  {
    path: ["host", "ensure"],
    forwards: true,
    spy: () =>
      vi
        .spyOn(hostEnsureModule, "buildHostEnsureCommand")
        .mockImplementation(stubCommand),
  },
  {
    path: ["host", "install"],
    forwards: true,
    spy: () =>
      vi
        .spyOn(hostInstallModule, "buildHostInstallCommand")
        .mockImplementation(stubCommand),
  },
  {
    path: ["host", "apply"],
    forwards: true,
    spy: () =>
      vi
        .spyOn(hostApplyModule, "buildHostApplyCommand")
        .mockImplementation(stubCommand),
  },
  {
    path: ["host", "service", "install"],
    forwards: true,
    spy: () =>
      vi
        .spyOn(serviceInstallModule, "buildServiceInstallCommand")
        .mockImplementation(stubCommand),
  },
  {
    path: ["host", "service", "start"],
    forwards: true,
    spy: () =>
      vi
        .spyOn(serviceStartModule, "buildServiceStartCommand")
        .mockImplementation(stubCommand),
  },
  {
    path: ["host", "restart"],
    forwards: false,
    spy: () =>
      vi
        .spyOn(hostRestartModule, "buildHostRestartCommand")
        .mockImplementation(stubCommand),
  },
  {
    path: ["host", "stop"],
    forwards: false,
    spy: () =>
      vi
        .spyOn(hostStopModule, "buildHostStopCommand")
        .mockImplementation(stubCommand),
  },
  {
    path: ["host", "free-port-and-restart"],
    forwards: false,
    spy: () =>
      vi
        .spyOn(
          hostFreePortAndRestartModule,
          "buildHostFreePortAndRestartCommand",
        )
        .mockImplementation(stubCommand),
  },
];

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

describe("--lifecycle-origin on the eight start-capable commands", () => {
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

  for (const flagCase of ORIGIN_FLAG_CASES) {
    const name = flagCase.path.join(" ");

    it(`\`${name} --lifecycle-origin desktop\` is accepted${flagCase.forwards ? " and reaches the builder as lifecycleOrigin: 'desktop'" : " (inert)"}`, async () => {
      const spy = flagCase.spy();
      await parseCommand(flagCase.path, ["--lifecycle-origin", "desktop"]);
      expect(spy).toHaveBeenCalledTimes(1);
      if (flagCase.forwards) {
        expect(spy.mock.calls[0]?.[0]).toMatchObject({
          lifecycleOrigin: "desktop",
        });
      }
    });

    if (flagCase.forwards) {
      it(`\`${name}\` with no --lifecycle-origin defaults to lifecycleOrigin: 'terminal'`, async () => {
        const spy = flagCase.spy();
        await parseCommand(flagCase.path, []);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[0]).toMatchObject({
          lifecycleOrigin: "terminal",
        });
      });
    }

    it(`\`${name} --lifecycle-origin bogus\` is refused by Commander before the builder runs`, async () => {
      const spy = flagCase.spy();
      const err = await parseCommand(flagCase.path, [
        "--lifecycle-origin",
        "bogus",
      ]).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(err).toBeInstanceOf(CommanderError);
      if (err instanceof CommanderError) {
        expect(err.code).toBe("commander.invalidArgument");
      }
      expect(spy).not.toHaveBeenCalled();
    });
  }
});
