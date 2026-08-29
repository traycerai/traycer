import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, CommandFn } from "../../runner/runner";

// Ticket 07 §5.2.8 — the Commander → builder bridge for `--ack-nonce`.
//
// This file exists because the equivalent gap was a certified HIGH in Ticket 05
// and must not be recreated. Every acceptance suite for a flag constructs the
// builder DIRECTLY, which is the layer BELOW the wiring — so the one line that
// maps a Commander option onto a builder argument had no detector at all.
// Hard-coding those mappings to a constant left 83/83 green while the shipped
// binary dropped the flag on the floor.
//
// Asserting the option EXISTS, or that `--help` mentions it, does not
// discriminate: an option can parse perfectly and still never reach the
// builder. What discriminates is capturing what the callback actually passes.

const captured = vi.hoisted(() => ({ args: [] as unknown[] }));

const noopCommand: CommandFn = async () => ({
  data: null,
  human: null,
  exitCode: 0,
});

vi.mock("../host-update", () => ({
  buildHostUpdateCommand: (args: unknown) => {
    captured.args.push(args);
    return noopCommand;
  },
}));

// Only `runCommand` is replaced — it owns `process.exit`, so without this
// `parseAsync` would tear down the test process instead of returning. The
// command tree, the option definitions, and the callback under test are real.
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
  captured.args = [];
});

describe("--ack-nonce reaches the builder through the Commander bridge", () => {
  // SEAM PROOF, asserted first. Every capture-based assertion below reads
  // `captured.args`; if the mock were not on the path the callback imports,
  // that array would stay empty and the assertions would fail for the WRONG
  // reason — a later edit could then "fix" them by loosening the expectation.
  it("SEAM: parsing `host update` reaches the mocked builder exactly once", async () => {
    await buildProgram().parseAsync(["host", "update"], { from: "user" });
    expect(captured.args).toHaveLength(1);
  });

  it("forwards the nonce, with every other field intact", async () => {
    await buildProgram().parseAsync(
      ["host", "update", "--ack-nonce", "nonce-abcdefgh"],
      { from: "user" },
    );
    // The FULL argument object, not just the one field. The bridge's job is to
    // translate every option, and a test watching one field would not notice a
    // sibling being dropped or crossed over in the same callback.
    expect(captured.args).toEqual([
      { force: false, versionRequest: null, ackNonce: "nonce-abcdefgh" },
    ]);
  });

  // The NEGATIVE CONTROL, and it is load-bearing rather than decorative: a
  // bridge hard-coded to some constant nonce would satisfy the test above while
  // breaking every ordinary invocation. The pair pins the MAPPING, not a value.
  it("forwards null when the flag is absent", async () => {
    await buildProgram().parseAsync(["host", "update"], { from: "user" });
    expect(captured.args).toEqual([
      { force: false, versionRequest: null, ackNonce: null },
    ]);
  });

  it("carries the nonce alongside the other options, not instead of them", async () => {
    // A dispatch really does arrive with more than one flag set. Pinned so a
    // bridge that handles the nonce by rebuilding the args object cannot drop
    // its siblings unnoticed.
    await buildProgram().parseAsync(
      ["host", "update", "--force", "--ack-nonce", "nonce-abcdefgh"],
      { from: "user" },
    );
    expect(captured.args).toEqual([
      { force: true, versionRequest: null, ackNonce: "nonce-abcdefgh" },
    ]);
  });
});
