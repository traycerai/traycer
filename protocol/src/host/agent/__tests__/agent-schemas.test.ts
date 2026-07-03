import { describe, expect, it } from "vitest";
import { downgradeRequestAcrossMajors } from "@traycer/protocol/framework/index";
import { agentListHarnessModelsDowngradeV2ToV1 } from "@traycer/protocol/host/agent/contracts";
import {
  agentSelectionGuideResponseSchema,
  createAgentRequestSchema,
  hostRpcRegistry,
  getGuiAgentPlanRequestSchema,
  getGuiAgentPlanResponseSchema,
  listHarnessModelsRequestSchemaV10,
  listHarnessModelsRequestSchemaV20,
  listHarnessModelsResponseSchema,
  listAgentsResponseSchema,
  listGuiAgentCommandsRequestSchema,
  listGuiAgentCommandsResponseSchema,
} from "@traycer/protocol/host/index";

describe("agent host schemas", () => {
  it("accepts the agent.gui.listCommands request and response shapes", () => {
    expect(
      listGuiAgentCommandsRequestSchema.parse({
        harnessId: "codex",
        workingDirectory: "/repo",
        workingDirectories: ["/repo", "/repo/packages/app"],
      }),
    ).toEqual({
      harnessId: "codex",
      workingDirectory: "/repo",
      workingDirectories: ["/repo", "/repo/packages/app"],
    });

    expect(
      listGuiAgentCommandsResponseSchema.parse({
        harnessId: "codex",
        commands: [
          {
            harnessId: "codex",
            name: "frontend-design",
            description: "Build polished frontend interfaces",
            argumentHint: "<scope>",
            kind: "skill",
            metadata: { path: "/repo/.agents/skills/frontend-design/SKILL.md" },
          },
        ],
      }),
    ).toMatchObject({
      harnessId: "codex",
      commands: [{ name: "frontend-design", kind: "skill" }],
    });
  });

  it("defaults agent.listHarnessModels context fields to null", () => {
    expect(
      listHarnessModelsRequestSchemaV20.parse({
        harnessId: "codex",
      }),
    ).toEqual({
      epicId: null,
      senderAgentId: null,
      harnessId: "codex",
    });
  });

  it("keeps agent.listHarnessModels v1.0 request context required", () => {
    expect(
      listHarnessModelsRequestSchemaV10.safeParse({
        epicId: null,
        senderAgentId: null,
        harnessId: "codex",
      }).success,
    ).toBe(false);
    expect(
      listHarnessModelsRequestSchemaV10.parse({
        epicId: "epic-1",
        senderAgentId: "agent-1",
        harnessId: "codex",
      }),
    ).toEqual({
      epicId: "epic-1",
      senderAgentId: "agent-1",
      harnessId: "codex",
    });
  });

  it("downgrades contextual agent.listHarnessModels v2.0 requests to v1.0", () => {
    expect(
      agentListHarnessModelsDowngradeV2ToV1.downgradeRequest({
        epicId: "epic-1",
        senderAgentId: "agent-1",
        harnessId: "codex",
      }),
    ).toEqual({
      ok: true,
      value: {
        epicId: "epic-1",
        senderAgentId: "agent-1",
        harnessId: "codex",
      },
    });
  });

  it("downgrades contextual agent.listHarnessModels through the host registry", () => {
    expect(
      downgradeRequestAcrossMajors(
        hostRpcRegistry["agent.listHarnessModels"],
        2,
        1,
        {
          epicId: "epic-1",
          senderAgentId: "agent-1",
          harnessId: "codex",
        },
      ),
    ).toEqual({
      ok: true,
      value: {
        epicId: "epic-1",
        senderAgentId: "agent-1",
        harnessId: "codex",
      },
    });
  });

  it("rejects no-context agent.listHarnessModels v2.0 downgrades", () => {
    expect(
      agentListHarnessModelsDowngradeV2ToV1.downgradeRequest({
        epicId: null,
        senderAgentId: null,
        harnessId: "codex",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });
    expect(
      agentListHarnessModelsDowngradeV2ToV1.downgradeRequest({
        epicId: "epic-1",
        senderAgentId: null,
        harnessId: "codex",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });
  });

  it("rejects no-context agent.listHarnessModels registry downgrades", () => {
    expect(
      downgradeRequestAcrossMajors(
        hostRpcRegistry["agent.listHarnessModels"],
        2,
        1,
        {
          epicId: null,
          senderAgentId: null,
          harnessId: "codex",
        },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });
  });

  it("registers agent.gui.listCommands at version 1.0", () => {
    expect(
      hostRpcRegistry["agent.gui.listCommands"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
  });

  it("accepts and registers the agent.gui.getPlan contract", () => {
    expect(
      getGuiAgentPlanRequestSchema.parse({
        epicId: "epic-1",
        chatId: "chat-1",
        planId: "plan-1",
      }),
    ).toEqual({
      epicId: "epic-1",
      chatId: "chat-1",
      planId: "plan-1",
    });

    expect(
      getGuiAgentPlanResponseSchema.parse({
        planId: "plan-1",
        markdown: "# Plan",
        source: {
          harnessId: "codex",
          sessionId: "session-1",
          turnId: "turn-1",
          kind: "codex",
        },
        planStatus: "ready",
        contentHash: "f".repeat(64),
        unavailableReason: null,
      }),
    ).toMatchObject({
      planId: "plan-1",
      markdown: "# Plan",
      contentHash: "f".repeat(64),
    });

    expect(
      hostRpcRegistry["agent.gui.getPlan"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
  });

  it("accepts the agent.create request shape", () => {
    expect(
      createAgentRequestSchema.parse({
        senderAgentId: "agent-1",
        epicId: "epic-1",
        name: "Review agent",
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: null,
        reasoningEffort: null,
        fastMode: null,
      }),
    ).toMatchObject({
      senderAgentId: "agent-1",
      name: "Review agent",
      surface: "gui",
      harnessId: "codex",
      model: "gpt-5.4",
    });

    expect(
      createAgentRequestSchema.parse({
        senderAgentId: "agent-1",
        epicId: "epic-1",
        surface: null,
        harnessId: "claude",
        model: "opus-4.7",
        agentMode: null,
        reasoningEffort: "high",
        fastMode: null,
        workspace: {
          entries: [
            {
              path: "/Users/example/.traycer/worktrees/traycerai__traycer/feature-a2a-child",
              workspacePath: "/repo",
            },
            // `workspacePath` defaults to null when omitted (an existing folder
            // bound as-is, no worktree).
            { path: "/repo/packages/app" },
          ],
        },
      }),
    ).toMatchObject({
      senderAgentId: "agent-1",
      name: null,
      surface: null,
      harnessId: "claude",
      model: "opus-4.7",
      workspace: {
        entries: [
          {
            path: "/Users/example/.traycer/worktrees/traycerai__traycer/feature-a2a-child",
            workspacePath: "/repo",
          },
          { path: "/repo/packages/app", workspacePath: null },
        ],
      },
    });
  });

  it("accepts the agent.list response shape", () => {
    expect(
      listAgentsResponseSchema.parse({
        caller: {
          agentId: "agent-1",
          canSendMessages: true,
        },
        scope: "user",
        agents: [
          {
            id: "agent-1",
            parentId: null,
            hostId: "host-1",
            isLocal: true,
            surface: "gui",
            harnessId: "codex",
            title: "Existing chat",
            isSelf: true,
            capabilities: {
              readTranscript: true,
              sendMessage: true,
            },
            active: false,
            folderPaths: ["/repo"],
            isWorktree: false,
          },
        ],
      }),
    ).toMatchObject({
      caller: { agentId: "agent-1" },
      agents: [{ id: "agent-1", surface: "gui", isLocal: true }],
    });
  });

  it("accepts the agent selection/config response shapes", () => {
    expect(
      agentSelectionGuideResponseSchema.parse({
        status: "found",
        sources: [
          {
            kind: "workspace",
            workspacePath: "/repo",
            path: "/repo/.traycer/agent-selection-guide.md",
            priority: 2,
            content: "Use review agents for review work.",
          },
          {
            kind: "global",
            path: "/home/.traycer/agent-selection-guide.md",
            priority: 1,
            content: "Use implementation agents for implementation work.",
          },
        ],
      }),
    ).toMatchObject({
      status: "found",
      sources: [{ kind: "workspace" }, { kind: "global" }],
    });

    expect(
      listHarnessModelsResponseSchema.parse({
        harnessId: "codex",
        models: [
          {
            id: "opus-4.7",
            reasoningEfforts: ["low", "medium", "high"],
            fastModeAvailable: false,
          },
          {
            id: "gpt-5.5",
            reasoningEfforts: ["low", "medium", "high"],
            fastModeAvailable: true,
          },
        ],
      }),
    ).toMatchObject({
      harnessId: "codex",
      models: [{ id: "opus-4.7" }, { id: "gpt-5.5", fastModeAvailable: true }],
    });
  });

  it("registers agent A2A methods at version 1.0", () => {
    expect(
      hostRpcRegistry["agent.create"][1].versions[0].contract.schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["agent.selectionGuide"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["agent.listHarnessModels"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["agent.listHarnessModels"][2].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 2, minor: 0 });
    expect(
      hostRpcRegistry["agent.list"][1].versions[0].contract.schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
  });
});
