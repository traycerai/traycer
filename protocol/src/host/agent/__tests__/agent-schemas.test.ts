import { describe, expect, it } from "vitest";
import { downgradeRequestAcrossMajors } from "@traycer/protocol/framework/index";
import { agentListHarnessModelsDowngradeV2ToV1 } from "@traycer/protocol/host/agent/contracts";
import {
  guiHarnessIdSchema,
  tuiHarnessIdSchema,
} from "@traycer/protocol/host/agent/shared";
import {
  agentGuiListCommandsDowngradeV20ToV10,
  agentGuiListCommandsUpgradeV10ToV20,
  agentGuiListCommandsV10,
  agentGuiListCommandsV20,
  agentGuiListModelsDowngradeV20ToV10,
  agentGuiListModelsUpgradeV10ToV20,
  agentGuiListModelsV10,
  agentGuiListModelsV20,
  agentSelectionGuideResponseSchema,
  createAgentRequestSchema,
  hostRpcRegistry,
  getGuiAgentPlanRequestSchema,
  getGuiAgentPlanResponseSchema,
  listGuiAgentCommandsRequestSchemaV20,
  listGuiAgentModelsRequestSchemaV20,
  listHarnessModelsRequestSchemaV10,
  listHarnessModelsRequestSchemaV20,
  listHarnessModelsResponseSchema,
  listAgentsResponseSchema,
  listGuiAgentCommandsRequestSchema,
  listGuiAgentCommandsResponseSchema,
} from "@traycer/protocol/host/index";

describe("agent host schemas", () => {
  it("retains Cursor in the TUI wire schema as a compatibility value", () => {
    expect(guiHarnessIdSchema.safeParse("cursor").success).toBe(true);
    expect(tuiHarnessIdSchema.safeParse("cursor").success).toBe(true);
    expect(tuiHarnessIdSchema.options).toEqual([
      "claude",
      "codex",
      "opencode",
      "cursor",
    ]);
  });

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

  it("accepts the live agent.list v7 runConfig shape", () => {
    const response = listAgentsResponseSchema.parse({
      caller: { agentId: "agent-1", canSendMessages: true },
      scope: "user",
      agents: [
        {
          id: "agent-1",
          parentId: null,
          hostId: "host-1",
          isLocal: true,
          surface: "gui",
          harnessId: "codex",
          isSelf: true,
          title: null,
          capabilities: { readTranscript: true, sendMessage: true },
          active: false,
          folderPaths: [],
          isWorktree: false,
          runConfig: {
            model: { kind: "concrete", slug: "gpt-5.6-codex" },
            reasoningEffort: "high",
            fastMode: true,
            profileSelection: { kind: "profile", profileId: "secret" },
            provenance: { model: "explicit" },
          },
        },
      ],
    });

    expect(response.agents[0].runConfig).toEqual({
      model: { kind: "concrete", slug: "gpt-5.6-codex" },
      reasoningEffort: "high",
      fastMode: true,
    });
  });

  it("default-fills runConfig to null for a v7 host row without the field", () => {
    const response = listAgentsResponseSchema.parse({
      caller: { agentId: "agent-1", canSendMessages: true },
      scope: "user",
      agents: [
        {
          id: "agent-1",
          parentId: null,
          hostId: "host-1",
          isLocal: true,
          surface: "gui",
          harnessId: "codex",
          isSelf: true,
          title: null,
          capabilities: { readTranscript: true, sendMessage: true },
          active: false,
          folderPaths: [],
          isWorktree: false,
        },
      ],
    });

    expect(response.agents[0].runConfig).toBeNull();
    expect(response.agents[0]).toHaveProperty("runConfig", null);
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

/**
 * `agent.gui.listModels` / `agent.gui.listCommands` grow `profileId` (D09/D17/
 * D21/D25, W3-T6). Registered as a MAJOR (`@2.0`), not an additive minor -
 * same reasoning as `providersListModelProvidersRequestSchemaV20`
 * (`provider-schemas.ts`): a same-major minor mismatch is bridged by
 * re-parsing through the older minor's own non-`.strict()` schema, which
 * silently STRIPS an unrecognized key instead of rejecting it. Only a
 * cross-major bridge can fail closed on a non-null `profileId`.
 */
describe("agent.gui.listModels@2.0 profileId (D09/D17/D21/D25)", () => {
  it("the @2.0 request round-trips a non-null and a null profileId", () => {
    expect(
      listGuiAgentModelsRequestSchemaV20.parse({
        harnessId: "codex",
        workingDirectory: "/repo",
        profileId: "p1",
      }).profileId,
    ).toBe("p1");
    expect(
      listGuiAgentModelsRequestSchemaV20.parse({
        harnessId: "codex",
        workingDirectory: "/repo",
        profileId: null,
      }).profileId,
    ).toBeNull();
  });

  it("the @1.0 -> @2.0 upgrade fills profileId: null for an old client", () => {
    expect(
      agentGuiListModelsUpgradeV10ToV20.upgradeRequest({
        harnessId: "codex",
        workingDirectory: "/repo",
      }),
    ).toEqual({
      harnessId: "codex",
      workingDirectory: "/repo",
      profileId: null,
    });
  });

  it("the @2.0 -> @1.0 downgrade strips a null profileId and rejects a non-null one", () => {
    const accepted = agentGuiListModelsDowngradeV20ToV10.downgradeRequest({
      harnessId: "codex",
      workingDirectory: "/repo",
      profileId: null,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value).not.toHaveProperty("profileId");
    expect(accepted.value).toEqual({
      harnessId: "codex",
      workingDirectory: "/repo",
    });

    const refused = agentGuiListModelsDowngradeV20ToV10.downgradeRequest({
      harnessId: "codex",
      workingDirectory: "/repo",
      profileId: "p1",
    });
    expect(refused).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "DOWNGRADE_UNSUPPORTED" }),
    });
  });

  it("registers major 2 as latest with the major-1 line untouched", () => {
    expect(
      hostRpcRegistry["agent.gui.listModels"][1].versions[0].contract,
    ).toBe(agentGuiListModelsV10);
    expect(
      hostRpcRegistry["agent.gui.listModels"][2].versions[0].contract,
    ).toBe(agentGuiListModelsV20);
    expect(
      hostRpcRegistry["agent.gui.listModels"][2].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 2, minor: 0 });
    expect(
      hostRpcRegistry["agent.gui.listModels"][2].downgradePathsFromLatest[1],
    ).toBe(agentGuiListModelsDowngradeV20ToV10);
  });

  it("rejects a non-null profileId downgrade through the real registry path", () => {
    expect(
      downgradeRequestAcrossMajors(
        hostRpcRegistry["agent.gui.listModels"],
        2,
        1,
        {
          harnessId: "codex",
          workingDirectory: "/repo",
          profileId: "p1",
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
  });
});

describe("agent.gui.listCommands@2.0 profileId (D09/D17/D21/D25)", () => {
  it("the @2.0 request round-trips a non-null and a null profileId", () => {
    expect(
      listGuiAgentCommandsRequestSchemaV20.parse({
        harnessId: "codex",
        workingDirectory: "/repo",
        workingDirectories: ["/repo"],
        profileId: "p1",
      }).profileId,
    ).toBe("p1");
    expect(
      listGuiAgentCommandsRequestSchemaV20.parse({
        harnessId: "codex",
        workingDirectory: "/repo",
        workingDirectories: ["/repo"],
        profileId: null,
      }).profileId,
    ).toBeNull();
  });

  it("the @1.0 -> @2.0 upgrade fills profileId: null for an old client", () => {
    expect(
      agentGuiListCommandsUpgradeV10ToV20.upgradeRequest({
        harnessId: "codex",
        workingDirectory: "/repo",
        workingDirectories: ["/repo"],
      }),
    ).toEqual({
      harnessId: "codex",
      workingDirectory: "/repo",
      workingDirectories: ["/repo"],
      profileId: null,
    });
  });

  it("the @2.0 -> @1.0 downgrade strips a null profileId and rejects a non-null one", () => {
    const accepted = agentGuiListCommandsDowngradeV20ToV10.downgradeRequest({
      harnessId: "codex",
      workingDirectory: "/repo",
      workingDirectories: ["/repo"],
      profileId: null,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value).not.toHaveProperty("profileId");
    expect(accepted.value).toEqual({
      harnessId: "codex",
      workingDirectory: "/repo",
      workingDirectories: ["/repo"],
    });

    const refused = agentGuiListCommandsDowngradeV20ToV10.downgradeRequest({
      harnessId: "codex",
      workingDirectory: "/repo",
      workingDirectories: ["/repo"],
      profileId: "p1",
    });
    expect(refused).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "DOWNGRADE_UNSUPPORTED" }),
    });
  });

  it("registers major 2 as latest with the major-1 line untouched", () => {
    expect(
      hostRpcRegistry["agent.gui.listCommands"][1].versions[0].contract,
    ).toBe(agentGuiListCommandsV10);
    expect(
      hostRpcRegistry["agent.gui.listCommands"][2].versions[0].contract,
    ).toBe(agentGuiListCommandsV20);
    expect(
      hostRpcRegistry["agent.gui.listCommands"][2].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 2, minor: 0 });
    expect(
      hostRpcRegistry["agent.gui.listCommands"][2].downgradePathsFromLatest[1],
    ).toBe(agentGuiListCommandsDowngradeV20ToV10);
  });

  it("rejects a non-null profileId downgrade through the real registry path", () => {
    expect(
      downgradeRequestAcrossMajors(
        hostRpcRegistry["agent.gui.listCommands"],
        2,
        1,
        {
          harnessId: "codex",
          workingDirectory: "/repo",
          workingDirectories: ["/repo"],
          profileId: "p1",
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
  });
});
