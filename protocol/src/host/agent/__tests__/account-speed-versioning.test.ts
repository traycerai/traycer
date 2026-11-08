import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  agentCreateUpgradeV31ToV32,
  agentCreateV31,
  agentCreateV32,
  agentForkUpgradeV10ToV11,
  agentForkV10,
  agentForkV11,
  agentListHarnessModelsDowngradeV2ToV1,
  agentListHarnessModelsUpgradeV20ToV21,
  agentListHarnessModelsV20,
  agentListHarnessModelsV21,
} from "../contracts";
import {
  agentRunConfigSchema,
  agentRunConfigSchemaV102,
  createAgentRequestSchemaV31,
  createAgentRequestSchemaV32,
  forkAgentRequestSchema,
  forkAgentRequestSchemaV10,
  harnessModelSummarySchema,
  listHarnessModelsRequestSchema,
  listHarnessModelsResponseSchema,
  listHarnessModelsResponseSchemaV20,
} from "../shared";
import {
  agentGuiListModelsUpgradeV11ToV12,
  agentGuiListModelsV11,
  agentGuiListModelsV12,
} from "../gui/contracts";
import {
  listGuiAgentModelsRequestSchemaV11,
  listGuiAgentModelsRequestSchemaV12,
  listGuiAgentModelsResponseSchema,
} from "../gui/unary-schemas";

const createRequest = {
  senderAgentId: "agent-1",
  epicId: "epic-1",
  name: null,
  surface: "gui",
  harnessId: "codex",
  model: null,
  agentMode: "regular",
  reasoningEffort: null,
  fastMode: null,
  permissionMode: "full_access",
  workspace: null,
  profileSelection: { kind: "ambient" },
  routing: null,
} as const;

const guiModelsResponse = {
  harnessId: "codex",
  models: [],
} as const;

const harnessModelsResponse = {
  harnessId: "codex",
  models: [
    {
      id: "gpt-5.6-codex",
      reasoningEfforts: ["high"],
      fastModeAvailable: true,
    },
  ],
} as const;

describe("per-account speed protocol versions", () => {
  it("installs the new request heads after the released versions", () => {
    expect(hostRpcRegistry["agent.create"][3].latestMinor).toBe(2);
    expect(hostRpcRegistry["agent.create"][3].versions[2].contract).toBe(
      agentCreateV32,
    );
    expect(hostRpcRegistry["agent.create"][3].versions[1].contract).toBe(
      agentCreateV31,
    );
    expect(hostRpcRegistry["agent.fork"][1].latestMinor).toBe(1);
    expect(hostRpcRegistry["agent.fork"][1].versions[0].contract).toBe(
      agentForkV10,
    );
    expect(hostRpcRegistry["agent.fork"][1].versions[1].contract).toBe(
      agentForkV11,
    );
    expect(hostRpcRegistry["agent.listHarnessModels"][2].latestMinor).toBe(1);
    expect(
      hostRpcRegistry["agent.listHarnessModels"][2].versions[1].contract,
    ).toBe(agentListHarnessModelsV21);
    expect(hostRpcRegistry["agent.gui.listModels"][1].latestMinor).toBe(2);
    expect(
      hostRpcRegistry["agent.gui.listModels"][1].versions[2].contract,
    ).toBe(agentGuiListModelsV12);
  });

  it("keeps create@3.1 frozen and carries a named service tier only on 3.2", () => {
    const old = createAgentRequestSchemaV31.parse({
      ...createRequest,
      serviceTier: "priority",
    });
    expect(Object.hasOwn(old, "serviceTier")).toBe(false);
    expect(
      createAgentRequestSchemaV32.parse({ ...createRequest }).serviceTier,
    ).toBeUndefined();
    expect(
      createAgentRequestSchemaV32.parse({
        ...createRequest,
        serviceTier: "priority",
      }).serviceTier,
    ).toBe("priority");
    expect(
      agentCreateUpgradeV31ToV32.upgradeRequest(
        createAgentRequestSchemaV31.parse(createRequest),
      ),
    ).not.toHaveProperty("serviceTier");
  });

  it("keeps fork@1.0 frozen and adds optional tier and fast-mode intent on 1.1", () => {
    const fork = {
      epicId: "epic-1",
      senderAgentId: "agent-1",
      agentId: "agent-2",
      name: null,
      permissionMode: "full_access",
      workspace: null,
      profileSelection: { kind: "inherit" },
    } as const;
    expect(
      forkAgentRequestSchemaV10.parse({ ...fork, serviceTier: "priority" }),
    ).not.toHaveProperty("serviceTier");
    expect(
      forkAgentRequestSchemaV10.parse({ ...fork, fastMode: false }),
    ).not.toHaveProperty("fastMode");
    const omittedSpeed = forkAgentRequestSchema.parse(fork);
    expect(omittedSpeed).not.toHaveProperty("serviceTier");
    expect(omittedSpeed).not.toHaveProperty("fastMode");
    expect(
      forkAgentRequestSchema.parse({
        ...fork,
        serviceTier: "priority",
        fastMode: false,
      }),
    ).toMatchObject({ serviceTier: "priority", fastMode: false });
    expect(
      agentForkUpgradeV10ToV11.upgradeRequest(
        forkAgentRequestSchemaV10.parse(fork),
      ),
    ).not.toHaveProperty("fastMode");
  });

  it("exposes tier ids per harness model while retaining fast-mode availability", () => {
    expect(
      harnessModelSummarySchema.parse({
        ...harnessModelsResponse.models[0],
        serviceTiers: ["priority", "flex"],
      }),
    ).toEqual({
      id: "gpt-5.6-codex",
      reasoningEfforts: ["high"],
      fastModeAvailable: true,
      serviceTiers: ["priority", "flex"],
    });
    expect(
      listHarnessModelsRequestSchema.parse({
        epicId: null,
        senderAgentId: null,
        harnessId: "codex",
        profileId: "profile-work",
      }).profileId,
    ).toBe("profile-work");
    expect(
      listHarnessModelsRequestSchema.parse({
        epicId: null,
        senderAgentId: null,
        harnessId: "codex",
        profileId: null,
      }).profileId,
    ).toBeNull();
    const parsedHarnessModelsResponse =
      listHarnessModelsResponseSchemaV20.parse(harnessModelsResponse);
    expect(
      agentListHarnessModelsUpgradeV20ToV21.upgradeResponse(
        parsedHarnessModelsResponse,
      ),
    ).toEqual({
      harnessId: "codex",
      profileId: null,
      models: [{ ...harnessModelsResponse.models[0], serviceTiers: [] }],
    });
    expect(
      listHarnessModelsResponseSchemaV20.parse(harnessModelsResponse).models[0],
    ).not.toHaveProperty("serviceTiers");
    expect(
      listHarnessModelsResponseSchema.parse({
        ...harnessModelsResponse,
        profileId: "profile-work",
        models: [
          { ...harnessModelsResponse.models[0], serviceTiers: ["priority"] },
        ],
      }).profileId,
    ).toBe("profile-work");
    const oldRequest = {
      epicId: "epic-1",
      senderAgentId: "agent-1",
      harnessId: "codex",
    } as const;
    expect(
      agentListHarnessModelsDowngradeV2ToV1.downgradeRequest({
        ...oldRequest,
        profileId: null,
      }),
    ).toMatchObject({ ok: true });
    expect(
      agentListHarnessModelsDowngradeV2ToV1.downgradeRequest({
        ...oldRequest,
        profileId: "ambient",
      }),
    ).toMatchObject({ ok: true });
    expect(
      agentListHarnessModelsDowngradeV2ToV1.downgradeRequest({
        ...oldRequest,
        profileId: "profile-work",
      }),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
  });

  it("adds profile selection to GUI model catalog requests at 1.2", () => {
    const request = {
      harnessId: "codex",
      workingDirectory: null,
    } as const;
    expect(
      listGuiAgentModelsRequestSchemaV11.parse({
        ...request,
        profileId: "profile-work",
      }),
    ).not.toHaveProperty("profileId");
    expect(
      listGuiAgentModelsRequestSchemaV12.parse({
        ...request,
        profileId: "profile-work",
      }).profileId,
    ).toBe("profile-work");
    expect(
      agentGuiListModelsUpgradeV11ToV12.upgradeResponse(
        listGuiAgentModelsResponseSchema.parse(guiModelsResponse),
      ),
    ).toEqual(guiModelsResponse);
  });

  it("adds nullable serviceTier to current run configuration while preserving the released line", () => {
    const config = {
      model: { kind: "concrete", slug: "gpt-5.6-codex" },
      reasoningEffort: "high",
      fastMode: false,
    } as const;
    expect(
      agentRunConfigSchemaV102.parse({ ...config, serviceTier: "priority" }),
    ).not.toHaveProperty("serviceTier");
    expect(
      agentRunConfigSchema.parse({ ...config, serviceTier: "priority" })
        .serviceTier,
    ).toBe("priority");
    expect(
      agentRunConfigSchema.parse({ ...config, serviceTier: null }).serviceTier,
    ).toBeNull();
  });
});
