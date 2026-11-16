import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentInboxCommand } from "../agent-inbox";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { callAgentHostRpc } from "../../internal/host-rpc";
import { makeCtx } from "./hook-test-helpers";

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return { ...actual, callAgentHostRpc: vi.fn() };
});

const callAgentHostRpcMock = vi.mocked(callAgentHostRpc);

beforeEach(() => {
  callAgentHostRpcMock.mockReset();
  callAgentHostRpcMock.mockResolvedValue({ messages: [], nextCursor: null });
});

describe("agent inbox", () => {
  it("rejects malformed pagination cursors as invalid user input", async () => {
    const command = buildAgentInboxCommand({
      epicId: "epic-1",
      agentId: "agent-1",
      after: "not-a-cursor",
    });

    await expect(Reflect.apply(command, null, [])).rejects.toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      details: null,
      exitCode: 1,
    });
  });

  it("reads an inbox page through the agent RPC consumer", async () => {
    const command = buildAgentInboxCommand({
      epicId: "epic-1",
      agentId: "agent-1",
      after: null,
    });

    const result = await command(makeCtx());

    expect(result).toMatchObject({
      data: { messages: [], nextCursor: null },
      human: "No recent inbox messages.",
      exitCode: 0,
    });
    expect(callAgentHostRpcMock).toHaveBeenCalledWith("agent.inbox.read", {
      epicId: "epic-1",
      agentId: "agent-1",
      after: null,
    });
  });
});
