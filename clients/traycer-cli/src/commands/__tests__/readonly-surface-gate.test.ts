import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import type { CommandContext, CommandFn } from "../../runner/runner";
import { CLI_ERROR_CODES } from "../../runner/errors";

// This suite proves the CLI-019 capability boundary itself - not the wiring
// underneath it. Every command listed in `READONLY_REFUSED_COMMANDS` must be
// refused with E_FORBIDDEN *before* its body runs when driven end-to-end
// through the real program under `TRAYCER_AGENT_CLI_SURFACE=readonly`, and
// must NOT be refused on the full surface. The table is iterated directly
// (not copied into a parallel literal here) so a new gated entry without a
// working gate fails this suite rather than silently shipping unguarded.

// Hoisted so the mock factory below can reference it, and so every `it` can
// assert on call counts (not just the thrown error) - proof the gate ran
// BEFORE the command body did anything, not merely that the body failed for
// some other reason downstream.
const mocks = vi.hoisted(() => ({
  resolveHostAuthMock: vi.fn(async () => null),
}));

vi.mock("../../internal/host-auth", () => ({
  // Every gated command (and every read command exercised here) bottoms out
  // in `callHostRpc`/`resolveHostAuth` (or, for `worktree delete`, calls
  // `resolveHostAuth` directly) before it does anything else. Forcing "not
  // signed in" here is the single deepest-dependency mock that stops every
  // command short of a real network call, while still producing a distinct,
  // non-FORBIDDEN error on the full surface that proves the body was reached.
  resolveHostAuth: mocks.resolveHostAuthMock,
}));

beforeEach(() => {
  mocks.resolveHostAuthMock.mockClear();
});

vi.mock("../../runner/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runner/runner")>();
  return {
    ...actual,
    runCommand: async (fn: CommandFn) => {
      const ctx: CommandContext = {
        runtime: {
          json: false,
          quiet: false,
          noProgress: false,
          noBootstrap: false,
          nonInteractive: true,
          environment: "production",
          logger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
          },
        },
        output: {
          progress: () => undefined,
          human: () => undefined,
          humanRequired: () => undefined,
          emitResult: () => undefined,
          emitError: () => undefined,
        },
        progress: () => undefined,
      };
      await fn(ctx);
    },
  };
});

import { buildProgramWithAgentRoles, commanderCommandPath } from "../../index";
import {
  assertCommandAllowedOnSurface,
  MONITOR_SURFACE_NOTE,
  READONLY_REFUSED_COMMANDS,
  resolveAgentCliSurface,
} from "../../agent-surface";

// Fixture values for the agent/epic context the `agent *` commands resolve
// from env when their own `--agent-id`/`epicId` opts are omitted (see
// `resolveEpicId`/`resolveSenderAgentId` in `internal/agent-context.ts`).
// Pinned here rather than inherited from the ambient environment: this suite
// runs inside a live Traycer agent session, which already has
// `TRAYCER_AGENT_ID`/`TRAYCER_EPIC_ID` set - so without this override, a
// command reaching "resolve context from env" would silently succeed here
// and then throw "no context" in CI (or any shell without those vars),
// short-circuiting BEFORE `resolveHostAuth` and invalidating the
// `toHaveBeenCalled()` assertions below for the wrong reason. Pinning fixed
// values makes the suite's outcome independent of what happens to be running
// it.
const FIXTURE_AGENT_ID = "agent-fixture";
const FIXTURE_EPIC_ID = "epic-fixture";

const ENV_VARS_UNDER_TEST = [
  "TRAYCER_AGENT_CLI_SURFACE",
  "TRAYCER_AGENT_ID",
  "TRAYCER_EPIC_ID",
] as const;

// `await`s `run()` itself (rather than returning it from inside try/finally)
// so the env restoration in `finally` cannot race ahead of `run`'s own
// internal awaits - `run` drives a real `program.parseAsync(...)`, whose
// action dispatch is not guaranteed to complete synchronously, so restoring
// the env on the tick after the *call* to `run()` (rather than after it
// actually settles) could hand the in-flight command a clean environment
// mid-flight.
//
// `envValue` is the literal `TRAYCER_AGENT_CLI_SURFACE` value to set
// (`undefined` unsets it entirely) rather than a closed `"readonly" | "full"`
// union, so this same helper can drive the fail-closed matrix below with
// arbitrary/unrecognised values (e.g. `"restricted"`) without a second
// save/restore implementation.
async function withEnvSurface<T>(
  envValue: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const originals = Object.fromEntries(
    ENV_VARS_UNDER_TEST.map((name) => [name, process.env[name]]),
  ) as Record<(typeof ENV_VARS_UNDER_TEST)[number], string | undefined>;
  if (envValue === undefined) {
    delete process.env.TRAYCER_AGENT_CLI_SURFACE;
  } else {
    process.env.TRAYCER_AGENT_CLI_SURFACE = envValue;
  }
  process.env.TRAYCER_AGENT_ID = FIXTURE_AGENT_ID;
  process.env.TRAYCER_EPIC_ID = FIXTURE_EPIC_ID;
  try {
    return await run();
  } finally {
    for (const name of ENV_VARS_UNDER_TEST) {
      const original = originals[name];
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  }
}

function findSubcommand(parent: Command, name: string): Command | null {
  for (const child of parent.commands) {
    if (child.name() === name) return child;
  }
  return null;
}

function resolveCommand(
  program: Command,
  path: readonly string[],
): Command | null {
  let cursor: Command = program;
  for (const segment of path) {
    const next = findSubcommand(cursor, segment);
    if (next === null) return null;
    cursor = next;
  }
  return cursor;
}

async function parseAndCapture(
  program: Command,
  argv: readonly string[],
): Promise<unknown> {
  program.exitOverride();
  program.configureOutput({
    writeErr: () => undefined,
    writeOut: () => undefined,
  });
  try {
    await program.parseAsync(argv, { from: "user" });
    return null;
  } catch (err) {
    return err;
  }
}

// Extra argv tokens (Commander options, not the command path itself) needed
// so `program.parseAsync` reaches the action for every gated command. Every
// key in `READONLY_REFUSED_COMMANDS` must have an entry here or the suite
// fails loudly below - this is deliberately kept separate from the policy
// table itself, since it encodes "what does Commander require to parse", not
// "what is refused".
const REQUIRED_ARGS: Readonly<Record<string, readonly string[]>> = {
  "agent create": [],
  "agent fork": ["--agent-id", "agent-1"],
  "agent configure": [
    "--agent-id",
    "agent-1",
    "--harness",
    "claude",
    "--model",
    "model-1",
    "--profile",
    "ambient",
  ],
  "agent stop": ["--agent-id", "agent-1"],
  "agent archive": ["--agent-id", "agent-1"],
  "agent send": ["--to", "agent-1", "--message", "hi"],
  "agent role claim": ["--role", "role-1", "--scope", "scope-1"],
  // `claimId` is validated as a UUID by the protocol request schema before
  // any transport (see agent-role.ts) - an arbitrary string never reaches
  // `callHostRpc`/`resolveHostAuth` at all, which would fail the full-surface
  // "reaches the body" assertion below for the wrong reason.
  "agent role relinquish": [
    "--claim-id",
    "11111111-1111-4111-8111-111111111111",
  ],
  "worktree delete": ["--path", "/tmp/some-worktree"],
};

// Reads that stay runnable on the readonly surface: hidden from `--help`
// (a WIDER set than the capability boundary - see `agent-surface.ts`) but
// never refused at runtime.
const UNGATED_READS: ReadonlyArray<{
  readonly path: readonly string[];
  readonly args: readonly string[];
}> = [
  { path: ["agent", "list"], args: [] },
  { path: ["agent", "transcript"], args: ["--agent-id", "agent-1"] },
  { path: ["agent", "inbox"], args: [] },
  { path: ["agent", "role", "list"], args: [] },
  { path: ["worktree", "list"], args: [] },
];

describe("readonly-surface gate: table coverage is complete", () => {
  it("has a REQUIRED_ARGS entry for every key in READONLY_REFUSED_COMMANDS", () => {
    for (const commandPath of Object.keys(READONLY_REFUSED_COMMANDS)) {
      expect(
        Object.hasOwn(REQUIRED_ARGS, commandPath),
        `readonly-surface-gate.test.ts's REQUIRED_ARGS is missing an entry for '${commandPath}' - add one so this suite actually drives it`,
      ).toBe(true);
    }
  });

  it("resolves every READONLY_REFUSED_COMMANDS key to a registered command", () => {
    const program = buildProgramWithAgentRoles(true);
    for (const commandPath of Object.keys(READONLY_REFUSED_COMMANDS)) {
      const cmd = resolveCommand(program, commandPath.split(" "));
      expect(
        cmd,
        `'${commandPath}' is a READONLY_REFUSED_COMMANDS key but is not a registered command - a rename here would silently disable enforcement`,
      ).not.toBeNull();
    }
  });
});

describe("readonly-surface gate: refuses every table entry before the body runs", () => {
  for (const commandPath of Object.keys(READONLY_REFUSED_COMMANDS)) {
    it(`refuses '${commandPath}' with E_FORBIDDEN under the readonly surface, before the body runs`, async () => {
      await withEnvSurface("readonly", async () => {
        const program = buildProgramWithAgentRoles(true);
        const argv = [...commandPath.split(" "), ...REQUIRED_ARGS[commandPath]];
        const thrown = await parseAndCapture(program, argv);
        expect(thrown).toMatchObject({ code: CLI_ERROR_CODES.FORBIDDEN });
        // The load-bearing assertion: the command body's own deepest
        // dependency was never reached, so the refusal happened ahead of it
        // rather than merely producing the same-looking error downstream.
        expect(mocks.resolveHostAuthMock).not.toHaveBeenCalled();
      });
    });

    it(`does not refuse '${commandPath}' on the full surface (reaches the command body)`, async () => {
      await withEnvSurface("full", async () => {
        const program = buildProgramWithAgentRoles(true);
        const argv = [...commandPath.split(" "), ...REQUIRED_ARGS[commandPath]];
        const thrown = await parseAndCapture(program, argv);
        // Every gated command bottoms out in the mocked `resolveHostAuth`
        // returning null, which throws AUTH_NO_CREDENTIALS - proof the body
        // was reached rather than refused. Assert on "not E_FORBIDDEN" (per
        // the task) rather than the exact code, so this stays robust to
        // which specific downstream error a given command surfaces first.
        expect(thrown).not.toBeNull();
        expect(thrown).not.toMatchObject({ code: CLI_ERROR_CODES.FORBIDDEN });
        // Positive proof: the body actually ran far enough to call its
        // deepest dependency, not just "failed with a different code".
        expect(mocks.resolveHostAuthMock).toHaveBeenCalled();
      });
    });
  }
});

describe("readonly-surface gate: hidden-but-ungated reads stay runnable", () => {
  for (const { path, args } of UNGATED_READS) {
    it(`does not refuse '${path.join(" ")}' under the readonly surface`, async () => {
      await withEnvSurface("readonly", async () => {
        const program = buildProgramWithAgentRoles(true);
        const thrown = await parseAndCapture(program, [...path, ...args]);
        // Reached the body (mocked resolveHostAuth -> AUTH_NO_CREDENTIALS),
        // not refused by the capability gate.
        expect(thrown).not.toBeNull();
        expect(thrown).not.toMatchObject({ code: CLI_ERROR_CODES.FORBIDDEN });
        // Positive proof it reached the body, same as the full-surface case
        // above - these reads must stay runnable under readonly, not merely
        // fail with a code that happens not to be FORBIDDEN.
        expect(mocks.resolveHostAuthMock).toHaveBeenCalled();
      });
    });
  }
});

describe("readonly-surface gate: traycer monitor is deliberately not gated", () => {
  it("is absent from READONLY_REFUSED_COMMANDS", () => {
    expect(Object.keys(READONLY_REFUSED_COMMANDS)).not.toContain("monitor");
  });

  it("assertCommandAllowedOnSurface does not refuse 'monitor' on the readonly surface", () => {
    // Pins the decision in MONITOR_SURFACE_NOTE (CLI-021): monitor bypasses
    // `withRunner` entirely (so this gate never runs for it in practice), but
    // this asserts the same outcome directly against the policy function so a
    // future flip - adding "monitor" to the table without also routing it
    // through the runner - is caught here rather than only in production.
    expect(() =>
      assertCommandAllowedOnSurface("monitor", "readonly"),
    ).not.toThrow();
    expect(MONITOR_SURFACE_NOTE.length).toBeGreaterThan(0);
  });

  it("monitor's registered description discloses delivery acknowledgement and credential maintenance", () => {
    const program = buildProgramWithAgentRoles(true);
    const monitor = resolveCommand(program, ["monitor"]);
    expect(monitor).not.toBeNull();
    const description = monitor?.description() ?? "";
    expect(description).toContain("acknowledged as delivered");
    expect(description).toContain("stored Traycer credentials");
  });
});

describe("resolveAgentCliSurface: fails closed on any unrecognised value", () => {
  // Fail-closed, not fail-open. The prior implementation was
  // `declared === "readonly" ? "readonly" : "full"` - so a host spelling
  // drift, different casing, or a surface name a newer host knows and this
  // CLI does not would silently resolve to "full" and the whole restriction
  // would evaporate with nothing signalling it. Only the two spellings that
  // actually mean "unrestricted" - absent/empty, and the explicit "full" -
  // resolve to full; every other string, however plausible-looking, is
  // treated as a request to restrict: an unknown value must never quietly
  // re-open the mutating surface.
  it.each([
    [undefined, "full"],
    ["", "full"],
    ["full", "full"],
    ["readonly", "readonly"],
    // Casing is not normalised - these fail closed rather than matching.
    ["Readonly", "readonly"],
    ["READONLY", "readonly"],
    ["read-only", "readonly"],
    // An unknown future surface name this CLI has never heard of.
    ["limited", "readonly"],
    // Not trimmed - pins the current behaviour so a later trim is a
    // deliberate, reviewed change rather than an accidental one.
    [" full ", "readonly"],
  ] as const)(
    "TRAYCER_AGENT_CLI_SURFACE=%j resolves to %s",
    (declared, expected) => {
      expect(
        resolveAgentCliSurface({ TRAYCER_AGENT_CLI_SURFACE: declared }),
      ).toBe(expected);
    },
  );
});

describe("readonly-surface gate: fails closed end-to-end on an unrecognised surface value", () => {
  it("refuses 'agent stop' with E_FORBIDDEN before the body runs when TRAYCER_AGENT_CLI_SURFACE is unrecognised", async () => {
    await withEnvSurface("restricted", async () => {
      const program = buildProgramWithAgentRoles(true);
      const thrown = await parseAndCapture(program, [
        "agent",
        "stop",
        "--agent-id",
        "agent-1",
      ]);
      expect(thrown).toMatchObject({ code: CLI_ERROR_CODES.FORBIDDEN });
      expect(mocks.resolveHostAuthMock).not.toHaveBeenCalled();
    });
  });
});

describe("commanderCommandPath", () => {
  it("returns the space-joined path for a nested command", () => {
    const program = buildProgramWithAgentRoles(true);
    const claim = resolveCommand(program, ["agent", "role", "claim"]);
    expect(claim).not.toBeNull();
    if (claim === null) throw new Error("unreachable");
    expect(commanderCommandPath(claim)).toBe("agent role claim");
  });

  it("returns the single segment for a top-level command", () => {
    const program = buildProgramWithAgentRoles(true);
    const monitor = resolveCommand(program, ["monitor"]);
    expect(monitor).not.toBeNull();
    if (monitor === null) throw new Error("unreachable");
    expect(commanderCommandPath(monitor)).toBe("monitor");
  });
});
