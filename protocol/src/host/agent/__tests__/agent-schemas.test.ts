import { describe, expect, it } from "vitest";
import { downgradeRequestAcrossMajors } from "@traycer/protocol/framework/index";
import {
  agentListDowngradeV9ToV1,
  agentListDowngradeV9ToV2,
  agentListDowngradeV9ToV3,
  agentListDowngradeV9ToV4,
  agentListDowngradeV9ToV5,
  agentListDowngradeV9ToV6,
  agentListDowngradeV9ToV7,
  agentListDowngradeV9ToV8,
  agentListHarnessModelsDowngradeV2ToV1,
  agentListDowngradeV10ToV9,
  agentListUpgradeV91ToV92,
  agentListUpgradeV92ToV100,
  agentListV92,
} from "@traycer/protocol/host/agent/contracts";
import {
  AGENT_FACING_HARNESS_IDS,
  agentSummarySchema,
  agentSummarySchemaV90,
  agentSummarySchemaV91,
  guiHarnessIdSchema,
  listAgentsResponseSchemaV91,
  listAgentsResponseSchemaV92,
  type AgentSummaryV92,
  type ListAgentsResponse,
  type ListAgentsResponseV92,
  tuiHarnessIdSchema,
} from "@traycer/protocol/host/agent/shared";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
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
            // The `@9.1` session facet: required and nullable, filled by the
            // upgrade path for an older host (the convention
            // `assertCanonicalResponseSchema` names). A GUI chat has no PTY
            // session, so `null` is its permanent answer.
            sessionState: null,
            lastExit: null,
            // The `@9.2` archive flag: required and nullable the same way.
            archived: false,
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
          sessionState: null,
          lastExit: null,
          archived: false,
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
          // The row under test is a v7 host's as far as `runConfig` goes -
          // that field's `.default(null)` backstop is what this case pins.
          // The `@9.1` facet is a different mechanism: required on the wire
          // and supplied by the upgrade path, so it is spelled out here.
          sessionState: null,
          lastExit: null,
          archived: false,
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

  // Antigravity joins the live carriers next to Reasonix without opening a
  // new protocol major, so it has to reach all three independent enums a GUI
  // harness rides - the wire `guiHarnessIdSchema`, the A2A harness allowlist
  // `AGENT_FACING_HARNESS_IDS` (which `agentFacingHarnessIdSchema`, and so
  // `agent.create`'s `harnessId`, is extracted from), and the separate
  // `providerIdSchema`, which does NOT derive from the harness enum. Each is
  // a hand-written runtime list, so an id missing from one is dropped from
  // that surface at parse time with nothing to type-check it.
  it("admits antigravity into guiHarnessIdSchema, AGENT_FACING_HARNESS_IDS, and providerIdSchema", () => {
    expect(guiHarnessIdSchema.options).toContain("antigravity");
    expect(AGENT_FACING_HARNESS_IDS).toContain("antigravity");
    expect(providerIdSchema.options).toContain("antigravity");
    expect(
      createAgentRequestSchema.safeParse({
        senderAgentId: "agent-1",
        epicId: "epic-1",
        name: null,
        surface: "gui",
        harnessId: "antigravity",
        model: "gemini-3-pro",
        agentMode: null,
        reasoningEffort: null,
        fastMode: null,
      }).success,
    ).toBe(true);
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

const V92_ROW: AgentSummaryV92 = {
  id: "agent-1",
  parentId: null,
  hostId: "host-1",
  isLocal: true,
  surface: "gui",
  harnessId: "codex",
  title: "Existing chat",
  isSelf: true,
  capabilities: { readTranscript: true, sendMessage: true },
  active: false,
  folderPaths: ["/repo"],
  isWorktree: false,
  runConfig: null,
  sessionState: null,
  lastExit: null,
  archived: true,
};

const V92_RESPONSE: ListAgentsResponseV92 = {
  caller: { agentId: "agent-1", canSendMessages: true },
  scope: "user",
  agents: [
    V92_ROW,
    { ...V92_ROW, id: "agent-2", isSelf: false, archived: null },
  ],
};

describe("agent.list@9.2 archived flag", () => {
  it("upgrades a @9.1 response by filling archived: null on every row and nothing else", () => {
    const v91 = listAgentsResponseSchemaV91.parse(V92_RESPONSE);

    const upgraded = agentListUpgradeV91ToV92.upgradeResponse(v91);

    expect(upgraded.agents).toHaveLength(2);
    expect(upgraded.agents.map((row) => row.archived)).toEqual([null, null]);
    expect(upgraded.agents).toEqual(
      v91.agents.map((row) => ({ ...row, archived: null })),
    );
    expect(upgraded.caller).toEqual(v91.caller);
    expect(upgraded.scope).toBe(v91.scope);
  });

  it("leaves the request untouched on the @9.1 -> @9.2 upgrade", () => {
    const request = {
      epicId: "epic-1",
      senderAgentId: "agent-1",
      scope: "all" as const,
    };
    expect(agentListUpgradeV91ToV92.upgradeRequest(request)).toEqual(request);
  });

  it("strips archived from a row parsed through the frozen @9.1 and @9.0 summaries", () => {
    expect(
      Object.hasOwn(agentSummarySchemaV91.parse(V92_ROW), "archived"),
    ).toBe(false);
    expect(
      Object.hasOwn(agentSummarySchemaV90.parse(V92_ROW), "archived"),
    ).toBe(false);
    // `@9.1` keeps the session facet it introduced.
    expect(agentSummarySchemaV91.parse(V92_ROW)).toHaveProperty(
      "sessionState",
      null,
    );
    for (const row of listAgentsResponseSchemaV91.parse(V92_RESPONSE).agents) {
      expect(Object.hasOwn(row, "archived")).toBe(false);
    }
  });

  it("registers @9.2 as the latest minor of agent.list major 9", () => {
    const line = hostRpcRegistry["agent.list"][9];

    expect(line.latestMinor).toBe(2);
    expect(line.versions[2].contract).toBe(agentListV92);
  });

  it("starts every major-9 downgrade bridge at @9.2 and drops archived on the way out", () => {
    const bridges = [
      agentListDowngradeV9ToV1,
      agentListDowngradeV9ToV2,
      agentListDowngradeV9ToV3,
      agentListDowngradeV9ToV4,
      agentListDowngradeV9ToV5,
      agentListDowngradeV9ToV6,
      agentListDowngradeV9ToV7,
      agentListDowngradeV9ToV8,
    ];
    expect(bridges).toHaveLength(8);

    for (const bridge of bridges) {
      expect(bridge.from).toEqual({ major: 9, minor: 2 });
      const downgraded = bridge.downgradeResponse(V92_RESPONSE);
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) throw new Error("expected the downgrade to succeed");
      expect(downgraded.value.agents.length).toBeGreaterThan(0);
      for (const row of downgraded.value.agents) {
        expect(Object.hasOwn(row, "archived")).toBe(false);
      }
    }
  });

  it("requires archived on the canonical row and accepts true, false and null", () => {
    const { archived: _omitted, ...keyless } = V92_ROW;

    expect(agentSummarySchema.safeParse(keyless).success).toBe(false);
    for (const archived of [true, false, null]) {
      expect(
        agentSummarySchema.safeParse({ ...V92_ROW, archived }).success,
      ).toBe(true);
    }
  });
});

// Major 10 opened for `commandcode`, the first harness id after `1.5.0`, and
// major 9 (whose latest minor is 9.2) froze at the id set that release
// negotiated. The hop between them is an id-only change: `archived`, which
// 9.2 put on the row, is live on 10.0 and survives the bridge.
describe("agent.list@10.0 against the frozen 9.2 line", () => {
  const V100_RESPONSE: ListAgentsResponse = {
    caller: { agentId: "agent-1", canSendMessages: true },
    scope: "user",
    agents: [
      V92_ROW,
      { ...V92_ROW, id: "agent-2", isSelf: false, archived: null },
      {
        ...V92_ROW,
        id: "agent-commandcode",
        isSelf: false,
        harnessId: "commandcode",
        archived: false,
      },
    ],
  };

  it("upgrades a @9.2 response to @10.0 unchanged", () => {
    expect(agentListUpgradeV92ToV100.from).toEqual({ major: 9, minor: 2 });
    expect(agentListUpgradeV92ToV100.upgradeResponse(V92_RESPONSE)).toBe(
      V92_RESPONSE,
    );
  });

  it("downgrades to @9.2 by dropping the commandcode row alone, archived kept", () => {
    expect(agentListDowngradeV10ToV9.to).toEqual({ major: 9, minor: 2 });
    const downgraded =
      agentListDowngradeV10ToV9.downgradeResponse(V100_RESPONSE);
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) throw new Error("expected the downgrade to succeed");
    expect(downgraded.value.agents.map((row) => row.id)).toEqual([
      "agent-1",
      "agent-2",
    ]);
    expect(downgraded.value.agents.map((row) => row.archived)).toEqual([
      true,
      null,
    ]);
    expect(() =>
      listAgentsResponseSchemaV92.parse(downgraded.value),
    ).not.toThrow();
  });
});
