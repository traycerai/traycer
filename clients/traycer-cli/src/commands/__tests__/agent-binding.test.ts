import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import {
  callHostRpc,
  callHostRpcAtEndpoint,
  resolveEndpoint,
} from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import { buildAgentBindingCommand } from "../agent-binding";

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
  return {
    ...actual,
    callHostRpc: vi.fn(),
    callHostRpcAtEndpoint: vi.fn(),
    resolveEndpoint: vi.fn(),
  };
});

const rpcMock = vi.mocked(callHostRpc);
const rpcAtEndpointMock = vi.mocked(callHostRpcAtEndpoint);
const resolveEndpointMock = vi.mocked(resolveEndpoint);
const endpoint = {
  hostId: "host-local",
  websocketUrl: "ws://127.0.0.1:9000/rpc",
};

const response = {
  agentId: "agent-target",
  surface: "gui" as const,
  harnessId: "claude",
  profileSelection: { kind: "ambient" as const },
  harnessSessionId: "session-123",
};

function agentSummary(overrides: Record<string, unknown> | undefined) {
  return {
    id: "agent-target",
    parentId: "agent-caller",
    hostId: "host-local",
    isLocal: true,
    surface: "tui" as const,
    harnessId: "claude",
    isSelf: false,
    title: "Sensitive title discarded by projection",
    capabilities: { readTranscript: true, sendMessage: true },
    active: true,
    folderPaths: ["/private/workspace"],
    isWorktree: false,
    runConfig: null,
    ...(overrides ?? {}),
  };
}

function agentList(overrides: Record<string, unknown> | undefined) {
  return {
    caller: { agentId: "agent-caller", canSendMessages: true },
    scope: "user" as const,
    agents: [agentSummary(overrides)],
  };
}

function tuiRecord(overrides: Record<string, unknown> | undefined) {
  return {
    origin: "registry" as const,
    tuiAgentId: "agent-target",
    ownerUserId: "user-private",
    hostId: "host-local",
    harnessId: "claude",
    harnessSessionId: "native-session-456",
    parentId: "agent-caller",
    title: "Sensitive title discarded by projection",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    workspaceFolders: ["/private/workspace"],
    workspaceMode: null,
    model: "sensitive-model",
    reasoningEffort: null,
    agentMode: "regular" as const,
    profileId: "profile-work",
    terminalAgentArgs: "--private-arg",
    terminalShellCommand: null,
    terminalShellArgs: null,
    revision: 1,
    docResident: false,
    ...(overrides ?? {}),
  };
}

function cloudTuiRecord() {
  return {
    origin: "cloud" as const,
    tuiAgentId: "agent-cloud",
    ownerUserId: "user-private",
    hostId: "host-remote",
    harnessId: "codex",
    parentId: null,
    title: "Remote agent",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    revision: 1,
  };
}

function makeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
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
  return buildAgentBindingCommand({
    epicId: "epic-1",
    senderAgentId: "agent-caller",
    agentId: "agent-target",
  });
}

function hostError(
  code: "E_HOST_UNSUPPORTED" | "E_AGENT_NOT_FOUND" | "E_AGENT_NOT_LOCAL",
  message: string,
): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "request-1",
    method: "agent.getNativeSessionBinding",
    fatalDetails:
      code === "E_HOST_UNSUPPORTED"
        ? {
            code,
            reason: message,
            incompatibleMethods: null,
            upgradeGuidance: {
              clientShouldUpgrade: false,
              hostShouldUpgrade: true,
            },
          }
        : null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockReset();
  rpcAtEndpointMock.mockReset();
  resolveEndpointMock.mockReset();
  resolveEndpointMock.mockResolvedValue(endpoint);
});

describe("agent binding", () => {
  it("sends the exact epic, sender, and target ids to the native-binding RPC", async () => {
    rpcMock.mockResolvedValue(response);

    await buildCommand()(makeCtx());

    expect(resolveEndpointMock).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("agent.getNativeSessionBinding", {
      epicId: "epic-1",
      senderAgentId: "agent-caller",
      agentId: "agent-target",
    });
  });

  it("returns the canonical DTO and formats an ambient binding", async () => {
    rpcMock.mockResolvedValue(response);

    const result = await buildCommand()(makeCtx());

    expect(result.data).toEqual(response);
    expect(result.human).toBe(
      "Agent: agent-target\nSurface: gui\nHarness: claude\nProfile: ambient\nNative session: session-123",
    );
  });

  it("formats a managed profile and a pending native-session observation", async () => {
    rpcMock.mockResolvedValue({
      ...response,
      surface: "tui",
      harnessId: "codex",
      profileSelection: { kind: "profile", profileId: "profile-work" },
      harnessSessionId: null,
    });

    const result = await buildCommand()(makeCtx());

    expect(result.human).toContain("Surface: tui");
    expect(result.human).toContain("Profile: profile-work");
    expect(result.human).toContain("Native session: not observed yet");
  });

  it("strips fields outside the canonical response projection", async () => {
    rpcMock.mockResolvedValue({
      ...response,
      email: "private@example.com",
      token: "secret",
      transcript: "private prompt",
    } as typeof response);

    const result = await buildCommand()(makeCtx());

    expect(result.data).toEqual(response);
    expect(result.data).not.toHaveProperty("email");
    expect(result.data).not.toHaveProperty("token");
    expect(result.data).not.toHaveProperty("transcript");
  });

  it("maps an old host to actionable per-call upgrade guidance", async () => {
    rpcMock.mockRejectedValueOnce(
      hostError(
        "E_HOST_UNSUPPORTED",
        "This host does not support 'agent.getNativeSessionBinding'. Upgrade the host to use this feature.",
      ),
    );
    rpcAtEndpointMock.mockResolvedValueOnce(agentList({ surface: "gui" }));

    const error = await buildCommand()(makeCtx()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.HOST_UNSUPPORTED,
      details: {
        hostShouldUpgrade: true,
        method: "agent.getNativeSessionBinding",
      },
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcAtEndpointMock).toHaveBeenCalledTimes(1);
  });

  it("recovers an observed TUI binding from released Host record reads", async () => {
    rpcMock.mockRejectedValueOnce(
      hostError(
        "E_HOST_UNSUPPORTED",
        "This host does not support 'agent.getNativeSessionBinding'.",
      ),
    );
    rpcAtEndpointMock
      .mockResolvedValueOnce(agentList(undefined))
      .mockResolvedValueOnce({ tuiAgents: [tuiRecord(undefined)] });

    const result = await buildCommand()(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("agent.getNativeSessionBinding", {
      epicId: "epic-1",
      senderAgentId: "agent-caller",
      agentId: "agent-target",
    });
    expect(rpcAtEndpointMock).toHaveBeenNthCalledWith(
      1,
      "agent.list",
      {
        epicId: "epic-1",
        senderAgentId: "agent-caller",
        scope: "user",
      },
      endpoint,
    );
    expect(rpcAtEndpointMock).toHaveBeenNthCalledWith(
      2,
      "epic.listTuiAgents",
      {
        epicId: "epic-1",
        hasDocReplica: false,
      },
      endpoint,
    );
    expect(result.data).toEqual({
      agentId: "agent-target",
      surface: "tui",
      harnessId: "claude",
      profileSelection: { kind: "profile", profileId: "profile-work" },
      harnessSessionId: "native-session-456",
    });
    expect(result.data).not.toHaveProperty("workspaceFolders");
    expect(result.data).not.toHaveProperty("terminalAgentArgs");
    expect(result.data).not.toHaveProperty("title");
    expect([
      ...rpcMock.mock.calls.map(([method]) => method),
      ...rpcAtEndpointMock.mock.calls.map(([method]) => method),
    ]).toEqual([
      "agent.getNativeSessionBinding",
      "agent.list",
      "epic.listTuiAgents",
    ]);
  });

  it("ignores unrelated cloud replicas in the released Host record read", async () => {
    rpcMock.mockRejectedValueOnce(
      hostError(
        "E_HOST_UNSUPPORTED",
        "This host does not support 'agent.getNativeSessionBinding'.",
      ),
    );
    rpcAtEndpointMock
      .mockResolvedValueOnce(agentList(undefined))
      .mockResolvedValueOnce({
        tuiAgents: [cloudTuiRecord(), tuiRecord(undefined)],
      });

    const result = await buildCommand()(makeCtx());

    expect(result.data).toMatchObject({
      agentId: "agent-target",
      harnessId: "claude",
      harnessSessionId: "native-session-456",
    });
  });

  it("recovers a pending ambient TUI binding", async () => {
    rpcMock.mockRejectedValueOnce(
      hostError(
        "E_HOST_UNSUPPORTED",
        "This host does not support 'agent.getNativeSessionBinding'.",
      ),
    );
    rpcAtEndpointMock
      .mockResolvedValueOnce(agentList({ harnessId: "codex" }))
      .mockResolvedValueOnce({
        tuiAgents: [
          tuiRecord({
            harnessId: "codex",
            harnessSessionId: null,
            profileId: null,
          }),
        ],
      });

    const result = await buildCommand()(makeCtx());

    expect(result.data).toMatchObject({
      harnessId: "codex",
      profileSelection: { kind: "ambient" },
      harnessSessionId: null,
    });
    expect(result.human).toContain("Native session: not observed yet");
  });

  it.each([
    ["missing", { agents: [] }, CLI_ERROR_CODES.AGENT_NOT_FOUND],
    [
      "cross-host",
      agentList({ isLocal: false }),
      CLI_ERROR_CODES.AGENT_NOT_LOCAL,
    ],
  ])(
    "preserves the non-enumerating %s refusal in the released Host fallback",
    async (_case, listed, expectedCode) => {
      rpcMock.mockRejectedValueOnce(
        hostError(
          "E_HOST_UNSUPPORTED",
          "This host does not support 'agent.getNativeSessionBinding'.",
        ),
      );
      rpcAtEndpointMock.mockResolvedValueOnce(
        "agents" in listed
          ? {
              caller: {
                agentId: "agent-caller",
                canSendMessages: true,
              },
              scope: "user",
              ...listed,
            }
          : listed,
      );

      const error = await buildCommand()(makeCtx()).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({ code: expectedCode });
      expect(rpcMock).toHaveBeenCalledTimes(1);
      expect(rpcAtEndpointMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["record host", undefined, undefined, { hostId: "host-other" }],
    ["endpoint host", { hostId: "host-other" }, undefined, undefined],
    ["doc-resident row", undefined, undefined, { docResident: true }],
    ["harness", undefined, undefined, { harnessId: "codex" }],
  ])(
    "rejects inconsistent released Host %s metadata",
    async (_case, endpointOverrides, targetOverrides, recordOverrides) => {
      if (endpointOverrides !== undefined) {
        resolveEndpointMock.mockResolvedValueOnce({
          ...endpoint,
          ...endpointOverrides,
        });
      }
      rpcMock.mockRejectedValueOnce(
        hostError(
          "E_HOST_UNSUPPORTED",
          "This host does not support 'agent.getNativeSessionBinding'.",
        ),
      );
      rpcAtEndpointMock
        .mockResolvedValueOnce(agentList(targetOverrides))
        .mockResolvedValueOnce({
          tuiAgents: [tuiRecord(recordOverrides)],
        });

      const error = await buildCommand()(makeCtx()).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({ code: CLI_ERROR_CODES.HOST_INCOMPATIBLE });
    },
  );

  it("maps a target deleted between released Host reads to not found", async () => {
    rpcMock.mockRejectedValueOnce(
      hostError(
        "E_HOST_UNSUPPORTED",
        "This host does not support 'agent.getNativeSessionBinding'.",
      ),
    );
    rpcAtEndpointMock
      .mockResolvedValueOnce(agentList(undefined))
      .mockResolvedValueOnce({ tuiAgents: [] })
      .mockResolvedValueOnce(agentList({ id: "agent-other" }));

    const error = await buildCommand()(makeCtx()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: CLI_ERROR_CODES.AGENT_NOT_FOUND });
    expect(rpcAtEndpointMock.mock.calls.map(([method]) => method)).toEqual([
      "agent.list",
      "epic.listTuiAgents",
      "agent.list",
    ]);
  });

  it.each([
    [
      "agent summaries",
      agentList(undefined),
      { tuiAgents: [tuiRecord(undefined)] },
    ],
    [
      "TUI records",
      agentList(undefined),
      { tuiAgents: [tuiRecord(undefined), tuiRecord({ revision: 2 })] },
    ],
  ])("rejects duplicate released Host %s", async (kind, listed, tuiAgents) => {
    const duplicatedAgentList =
      kind === "agent summaries"
        ? {
            ...listed,
            agents: [
              agentSummary(undefined),
              agentSummary({ title: "duplicate" }),
            ],
          }
        : listed;
    rpcMock.mockRejectedValueOnce(
      hostError(
        "E_HOST_UNSUPPORTED",
        "This host does not support 'agent.getNativeSessionBinding'.",
      ),
    );
    rpcAtEndpointMock
      .mockResolvedValueOnce(duplicatedAgentList)
      .mockResolvedValueOnce(tuiAgents);

    const error = await buildCommand()(makeCtx()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: CLI_ERROR_CODES.HOST_INCOMPATIBLE });
  });

  it.each([
    ["empty session", { harnessSessionId: "" }],
    ["reserved ambient profile", { profileId: "ambient" }],
  ])(
    "maps a malformed released Host %s projection to incompatibility",
    async (_case, recordOverrides) => {
      rpcMock.mockRejectedValueOnce(
        hostError(
          "E_HOST_UNSUPPORTED",
          "This host does not support 'agent.getNativeSessionBinding'.",
        ),
      );
      rpcAtEndpointMock
        .mockResolvedValueOnce(agentList(undefined))
        .mockResolvedValueOnce({
          tuiAgents: [tuiRecord(recordOverrides)],
        });

      const error = await buildCommand()(makeCtx()).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({ code: CLI_ERROR_CODES.HOST_INCOMPATIBLE });
    },
  );

  it.each([
    ["E_AGENT_NOT_FOUND", CLI_ERROR_CODES.AGENT_NOT_FOUND],
    ["E_AGENT_NOT_LOCAL", CLI_ERROR_CODES.AGENT_NOT_LOCAL],
  ] as const)("preserves the host's %s refusal", async (wireCode, cliCode) => {
    rpcMock.mockRejectedValue(hostError(wireCode, "Agent is unavailable."));

    const error = await buildCommand()(makeCtx()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: cliCode });
  });
});
