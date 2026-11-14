import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentInboxCommand } from "../agent-inbox";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { callAgentHostRpc } from "../../internal/host-rpc";

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return { ...actual, callAgentHostRpc: vi.fn() };
});

const callAgentHostRpcMock = vi.mocked(callAgentHostRpc);

beforeEach(() => {
  vi.unstubAllEnvs();
  callAgentHostRpcMock.mockReset();
  callAgentHostRpcMock.mockResolvedValue({ messages: [], nextCursor: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("defaults epicId and agentId from the agent's environment", async () => {
    vi.stubEnv("TRAYCER_EPIC_ID", "epic-from-agent-environment");
    vi.stubEnv("TRAYCER_AGENT_ID", "agent-from-agent-environment");

    await Reflect.apply(
      buildAgentInboxCommand({ epicId: null, agentId: null, after: null }),
      null,
      [],
    );

    expect(callAgentHostRpcMock).toHaveBeenCalledWith("agent.inbox.read", {
      epicId: "epic-from-agent-environment",
      agentId: "agent-from-agent-environment",
      after: null,
    });
  });
});
