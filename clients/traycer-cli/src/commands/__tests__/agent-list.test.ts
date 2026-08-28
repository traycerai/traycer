import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentListCommand } from "../agent-list";
import { callHostRpc } from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
import type { CommandContext } from "../../runner/runner";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
  noopLogger: loggerMock,
}));

vi.mock("../../internal/host-rpc", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/host-rpc")
  >("../../internal/host-rpc");
  return { ...actual, callHostRpc: vi.fn() };
});

const rpcMock = vi.mocked(callHostRpc);

const LEGACY_LIST_RESPONSE = {
  caller: { agentId: "agent-parent", canSendMessages: true },
  scope: "user" as const,
  agents: [
    {
      id: "agent-parent",
      parentId: null,
      hostId: "host-1",
      isLocal: true,
      surface: "gui" as const,
      harnessId: "codex" as const,
      isSelf: true,
      title: "Parent",
      capabilities: { readTranscript: true, sendMessage: true },
      active: false,
      folderPaths: ["/repo"],
      isWorktree: false,
    },
  ],
};

const LEGACY_HUMAN_OUTPUT = `Agents in epic (relative to you):
You:
agent-parent [self] "Parent" gui/codex dir: /repo

Legend:
[self]: this agent, i.e. the caller of agent.list
"<title>": the agent's chat/session title (omitted when untitled)
R: the agent has a readable transcript
S: the agent can be sent messages to
R/S: the agent has a readable transcript and can be sent messages to
-: no available action
dir: <path>: the working directory the agent runs in
worktree: <path>: the agent runs in a dedicated git worktree`;

const EXPECTED_DEFAULT_FILLED_DATA = {
  ...LEGACY_LIST_RESPONSE,
  agents: [{ ...LEGACY_LIST_RESPONSE.agents[0], runConfig: null }],
};

function makeCtx(json: boolean): CommandContext {
  return {
    runtime: {
      json,
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

function buildCommand() {
  return buildAgentListCommand({
    epicId: "epic-1",
    senderAgentId: "agent-parent",
    all: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agent list run config", () => {
  it("returns structured runConfig and renders its tokens from the single agent.list call", async () => {
    rpcMock.mockResolvedValue({
      ...LEGACY_LIST_RESPONSE,
      agents: [
        {
          ...LEGACY_LIST_RESPONSE.agents[0],
          runConfig: {
            model: { kind: "concrete", slug: "gpt-5.6-codex" },
            reasoningEffort: "high",
            fastMode: true,
          },
        },
      ],
    });

    const result = await buildCommand()(makeCtx(false));

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("agent.list", {
      epicId: "epic-1",
      senderAgentId: "agent-parent",
      scope: "user",
    });
    expect(result.data).toMatchObject({
      agents: [
        {
          runConfig: {
            model: { kind: "concrete", slug: "gpt-5.6-codex" },
            reasoningEffort: "high",
            fastMode: true,
          },
        },
      ],
    });
    expect(result.human).toContain(
      "gui/codex model: gpt-5.6-codex effort: high fast",
    );
  });

  it("keeps human output byte-identical for a v7 host row without runConfig", async () => {
    rpcMock.mockResolvedValue(LEGACY_LIST_RESPONSE);

    const result = await buildCommand()(makeCtx(false));

    expect(result.human).toBe(LEGACY_HUMAN_OUTPUT);
    expect(result.data).toEqual(EXPECTED_DEFAULT_FILLED_DATA);
  });

  it("keeps JSON output byte-identical after default-fill for a v7 host row without runConfig", async () => {
    rpcMock.mockResolvedValue(LEGACY_LIST_RESPONSE);

    const result = await buildCommand()(makeCtx(true));

    expect(JSON.stringify(result.data)).toBe(
      JSON.stringify(EXPECTED_DEFAULT_FILLED_DATA),
    );
  });

  it("keeps human and JSON output byte-identical for a bridged v6 response", async () => {
    rpcMock.mockResolvedValue(LEGACY_LIST_RESPONSE);

    const humanResult = await buildCommand()(makeCtx(false));
    const jsonResult = await buildCommand()(makeCtx(true));

    expect(humanResult.human).toBe(LEGACY_HUMAN_OUTPUT);
    expect(JSON.stringify(jsonResult.data)).toBe(
      JSON.stringify(EXPECTED_DEFAULT_FILLED_DATA),
    );
  });
});
