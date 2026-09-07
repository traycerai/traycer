import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, CommandFn } from "../../runner/runner";

// Both Commander-to-builder bridges for `--defer-if-parked` must pass the flag through; omitting one is a silent no-op.

const captured = vi.hoisted(() => ({
  restart: [] as unknown[],
  freePort: [] as unknown[],
}));

const noopCommand: CommandFn = async () => ({
  data: null,
  human: null,
  exitCode: 0,
});

vi.mock("../host-restart", () => ({
  buildHostRestartCommand: (args: unknown) => {
    captured.restart.push(args);
    return noopCommand;
  },
}));

vi.mock("../host-free-port-and-restart", () => ({
  buildHostFreePortAndRestartCommand: (args: unknown) => {
    captured.freePort.push(args);
    return noopCommand;
  },
}));

// Only `runCommand` is replaced - it owns `process.exit`, so without this `parseAsync` would tear down the test process instead of returning.
// The command tree, the option definitions and the callbacks under test are all the real ones.
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

import { buildProgram } from "../../index";

beforeEach(() => {
  captured.restart = [];
  captured.freePort = [];
});

describe("--defer-if-parked reaches the builder through the Commander bridge", () => {
  // SEAM PROOF.
  // Every assertion below reads `captured`, so if the mock were not on the path the index callback actually imports, the arrays would stay empty and a `toEqual([...])` would fail - but it would fail for the wrong reason, and a future edit could "fix" it by loosening the assertion.
  it("SEAM: parsing a host restart invocation reaches the mocked builder exactly once", async () => {
    await buildProgram().parseAsync(["host", "restart"], { from: "user" });

    expect(captured.restart).toHaveLength(1);
  });

  // The full argument object, not just the one field.
  // The bridge's job is to translate EVERY Commander option into the builder's args, and a test that checked `deferIfParked` alone would not notice a sibling field being dropped or crossed over in the same callback.
  it("host restart forwards deferIfParked:true, with every other field intact", async () => {
    await buildProgram().parseAsync(
      ["host", "restart", "--force", "--defer-if-parked"],
      { from: "user" },
    );

    expect(captured.restart).toEqual([
      { ifIdle: false, force: true, deferIfParked: true },
    ]);
  });

  // The negative control, and it is load-bearing: a bridge hard-coded to `true` would satisfy the test above while breaking every operator-facing invocation.
  // The pair pins the mapping, not a constant.
  it("host restart forwards deferIfParked:false when the flag is absent", async () => {
    await buildProgram().parseAsync(["host", "restart", "--force"], {
      from: "user",
    });

    expect(captured.restart).toEqual([
      { ifIdle: false, force: true, deferIfParked: false },
    ]);
  });

  it("host free-port-and-restart forwards deferIfParked:true, with pid/port intact", async () => {
    await buildProgram().parseAsync(
      [
        "host",
        "free-port-and-restart",
        "--defer-if-parked",
        "--pid",
        "1234",
        "--port",
        "5678",
      ],
      { from: "user" },
    );

    expect(captured.freePort).toEqual([
      { pid: 1234, port: 5678, deferIfParked: true },
    ]);
  });

  it("host free-port-and-restart forwards deferIfParked:false when the flag is absent", async () => {
    await buildProgram().parseAsync(
      ["host", "free-port-and-restart", "--pid", "1234", "--port", "5678"],
      { from: "user" },
    );

    expect(captured.freePort).toEqual([
      { pid: 1234, port: 5678, deferIfParked: false },
    ]);
  });

  // The exact argv Desktop sends, end to end through the real command tree.
  // The tests above use the flag in isolation; this one proves the bridge survives the full invocation Desktop actually produces, which is the thing whose failure strands a host.
  it("the argv Desktop sends for a force restart arrives as deferIfParked:true", async () => {
    await buildProgram().parseAsync(
      ["host", "restart", "--force", "--defer-if-parked"],
      { from: "user" },
    );

    expect(captured.restart).toEqual([
      expect.objectContaining({ deferIfParked: true, force: true }),
    ]);
  });
});
