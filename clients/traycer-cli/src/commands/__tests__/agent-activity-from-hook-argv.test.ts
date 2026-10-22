import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callHostRpcFastFail } from "../../internal/host-rpc";
import type { CommandContext, CommandFn } from "../../runner/runner";
import {
  restoreAgentIdentityEnv,
  restoreStdin,
  setAgentIdentityEnv,
  stubStdin,
} from "./hook-test-helpers";

vi.mock("../../internal/host-rpc", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/host-rpc")
  >("../../internal/host-rpc");
  return {
    ...actual,
    callHostRpcFastFail: vi.fn(),
  };
});

// Replaces only `runCommand` (which owns `process.exit`) with a version that
// runs the real `CommandFn` against a synthetic context, so
// `program.parseAsync(...)` drives the real argv wiring to completion.
vi.mock("../../runner/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runner/runner")>();
  return {
    ...actual,
    runCommand: async (fn: CommandFn) => {
      const { makeCtx } = await import("./hook-test-helpers");
      const ctx: CommandContext = makeCtx();
      await fn(ctx);
    },
  };
});

import { buildProgram } from "../../index";

const rpcMock = vi.mocked(callHostRpcFastFail);

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockResolvedValue({ accepted: true });
  setAgentIdentityEnv();
  stubStdin({ isTTY: true, chunks: [] });
});

afterEach(() => {
  restoreStdin();
  restoreAgentIdentityEnv();
});

describe("agent activity-from-hook trailing argv", () => {
  it("passes Codex's appended notify payload through to the stop turnId", async () => {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(
      [
        "agent",
        "activity-from-hook",
        "--provider",
        "codex",
        "--event",
        "stop",
        '{"type":"agent-turn-complete","turn-id":"t-9","thread-id":"th-9"}',
      ],
      { from: "user" },
    );

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.recordActivity",
      expect.objectContaining({
        harnessId: "codex",
        event: "stop",
        turnId: "t-9",
      }),
    );
  });

  it("still runs with no trailing argv", async () => {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(
      ["agent", "activity-from-hook", "--provider", "codex", "--event", "stop"],
      { from: "user" },
    );

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.tui.recordActivity",
      expect.objectContaining({ harnessId: "codex", turnId: null }),
    );
  });
});
