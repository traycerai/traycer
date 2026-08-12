import { beforeEach, describe, expect, it, vi } from "vitest";
import { A2A_PERMISSION_MODE_INSTRUCTION } from "@traycer/protocol/agent/agent-selection-guide-format";
import { buildAgentSelectionGuideCommand } from "../agent-selection-guide";
import { callHostRpc } from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
import type { CommandContext } from "../../runner/runner";

vi.mock("../../internal/host-rpc", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/host-rpc")
  >("../../internal/host-rpc");
  return {
    ...actual,
    callHostRpc: vi.fn(),
  };
});

const rpcMock = vi.mocked(callHostRpc);

function makeCtx(): CommandContext {
  return {
    runtime: {
      json: true,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: noopLogger,
    },
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildAgentSelectionGuideCommand", () => {
  it("includes the canonical permission invariant in JSON and human output", async () => {
    const response = {
      status: "not_found" as const,
      message: "No agent selection guide found.",
    };
    rpcMock.mockResolvedValue(response);

    const result = await buildAgentSelectionGuideCommand({
      epicId: "epic_1",
      senderAgentId: "agent_parent",
    })(makeCtx());

    expect(result.data).toEqual({
      ...response,
      permissionModeInstruction: A2A_PERMISSION_MODE_INSTRUCTION,
    });
    expect(result.human).toContain(A2A_PERMISSION_MODE_INSTRUCTION);
  });
});
