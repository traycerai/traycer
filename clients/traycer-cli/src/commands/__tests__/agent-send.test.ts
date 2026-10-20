/**
 * `traycer agent send` command function.
 *
 * Pins: the `--workspace` path validation (absolute in a posix OR win32 form,
 * sent as written - neither trimmed nor resolved against this machine), the
 * dispatch choice (plain without a workspace, `agent.sendMessage@1.1`
 * required with one), and the hint appended to the host's
 * `WORKSPACE_BINDING_REQUIRED` refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import { buildAgentSendCommand } from "../agent-send";
import { callHostRpcWithDispatch } from "../../internal/host-rpc";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
    callHostRpcWithDispatch: vi.fn(),
  };
});

const rpcMock = vi.mocked(callHostRpcWithDispatch);

function makeRuntime(): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
  };
}

function makeCtx(): CommandContext {
  return {
    runtime: makeRuntime(),
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

function send(workspace: string | null) {
  return buildAgentSendCommand({
    epicId: "epic_1",
    senderAgentId: "agent_1",
    to: "agent_2",
    message: "pick this up",
    expectReply: false,
    responseId: null,
    workspace,
  })(makeCtx());
}

function rpcError(code: RpcErrorCode, message: string): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "req_1",
    method: "agent.sendMessage",
    fatalDetails: null,
  });
}

async function rejection(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof CliError)) {
    throw new Error("expected a CliError");
  }
  return error;
}

const PREV_EPIC = process.env.TRAYCER_EPIC_ID;

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ responseId: null });
  delete process.env.TRAYCER_EPIC_ID;
});

afterEach(() => {
  if (PREV_EPIC === undefined) delete process.env.TRAYCER_EPIC_ID;
  else process.env.TRAYCER_EPIC_ID = PREV_EPIC;
});

describe("agent send --workspace", () => {
  it("without --workspace sends workspace: null with the 60 s response deadline", async () => {
    const result = await send(null);

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.sendMessage",
      expect.objectContaining({
        receiverAgentId: "agent_2",
        prompt: "pick this up",
        workspace: null,
      }),
      {
        responseTimeoutMs: 60_000,
        requiredHostMethodVersion: null,
        signal: null,
        failFast: false,
      },
    );
    expect(result.exitCode).toBe(0);
  });

  it("with an absolute path sends it and requires agent.sendMessage@1.1", async () => {
    await send("/work/repo");

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.sendMessage",
      expect.objectContaining({ workspace: "/work/repo" }),
      {
        responseTimeoutMs: 60_000,
        signal: null,
        failFast: false,
        requiredHostMethodVersion: {
          method: "agent.sendMessage",
          version: { major: 1, minor: 1 },
        },
      },
    );
  });

  it("sends the path as written, without resolving it", async () => {
    await send("/work/repo");

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.sendMessage",
      expect.objectContaining({ workspace: "/work/repo" }),
      expect.anything(),
    );
  });

  // The folder may legitimately end in a space on the receiving host, so the
  // value is validated and sent byte for byte, never trimmed.
  it.each(["/srv/project ", "C:\\work "])(
    "accepts %j and sends it with the trailing space intact",
    async (value) => {
      await send(value);

      expect(rpcMock).toHaveBeenCalledTimes(1);
      expect(rpcMock).toHaveBeenCalledWith(
        "agent.sendMessage",
        expect.objectContaining({ workspace: value }),
        expect.anything(),
      );
    },
  );

  it("accepts a windows absolute path as written", async () => {
    await send("C:\\work");

    expect(rpcMock).toHaveBeenCalledWith(
      "agent.sendMessage",
      expect.objectContaining({ workspace: "C:\\work" }),
      expect.anything(),
    );
  });

  it.each(["C:\\work", "C:/work", "\\\\server\\share\\x"])(
    "accepts the windows path %j and passes it through unchanged",
    async (value) => {
      await send(value);

      expect(rpcMock).toHaveBeenCalledWith(
        "agent.sendMessage",
        expect.objectContaining({ workspace: value }),
        expect.anything(),
      );
    },
  );

  it.each([
    "relative/dir",
    "./here",
    "",
    "   ",
    " /work",
    "\\work",
    "C:work",
    "\\\\server",
  ])(
    "rejects %j as INVALID_ARGUMENT before calling the host",
    async (value) => {
      const error = await rejection(send(value));

      expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
      expect(rpcMock).not.toHaveBeenCalled();
    },
  );
});

describe("agent send WORKSPACE_BINDING_REQUIRED hint", () => {
  it("tells the person to pass --workspace when none was given", async () => {
    rpcMock.mockRejectedValue(
      rpcError("WORKSPACE_BINDING_REQUIRED", "agent has no workspace"),
    );

    const error = await rejection(send(null));

    expect(error.code).toBe(CLI_ERROR_CODES.WORKSPACE_BINDING_REQUIRED);
    expect(error.message).toContain("agent has no workspace");
    expect(error.message).toContain("Pass --workspace <path>");
    expect(error.message).not.toContain("Check that the --workspace folder");
  });

  it("tells the person to check the folder when one was given", async () => {
    rpcMock.mockRejectedValue(
      rpcError("WORKSPACE_BINDING_REQUIRED", "agent has no workspace"),
    );

    const error = await rejection(send("/work/repo"));

    expect(error.code).toBe(CLI_ERROR_CODES.WORKSPACE_BINDING_REQUIRED);
    expect(error.message).toContain(
      "Check that the --workspace folder exists on the receiving agent's host.",
    );
    expect(error.message).not.toContain("Pass --workspace <path>");
  });

  it("passes every other error through without a hint", async () => {
    rpcMock.mockRejectedValue(rpcError("WORKTREE_MISSING", "worktree gone"));

    const error = await rejection(send(null));

    expect(error.code).toBe(CLI_ERROR_CODES.WORKTREE_MISSING);
    expect(error.message).toContain("worktree gone");
    expect(error.message).not.toContain("--workspace");
  });
});

describe("agent send human output", () => {
  // A success only means the host accepted the message (a cross-host receiver
  // may be offline), so the line claims neither sent, delivered nor queued.
  it.each([
    [null, "Message accepted for agent_2"],
    ["resp_1", "Message accepted for agent_2 (responseId: resp_1)"],
  ] as const)(
    "with responseId %j says exactly %j",
    async (responseId, human) => {
      rpcMock.mockResolvedValue({ responseId });

      const result = await send(null);

      expect(result.human).toBe(human);
      expect(result.data).toEqual({ responseId });
      expect(result.human).not.toMatch(/sent|deliver|queued/i);
      expect(result.exitCode).toBe(0);
    },
  );
});
