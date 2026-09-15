import { describe, expect, it } from "vitest";
import {
  downgradeRequestAcrossMajors,
  upgradeRequestToVersion,
} from "@traycer/protocol/framework/index";
import {
  agentConfigureRequestSchemaV20,
  agentConfigureRequestSchemaV61,
  agentConfigureUpgradeV60ToV61,
  agentCreateUpgradeV30ToV31,
  createAgentRequestSchemaV30,
  createAgentRequestSchemaV31,
  hostRpcRegistry,
} from "@traycer/protocol/host/index";

// ─── agent.create fixtures ──────────────────────────────────────────────────

const baseV1Request = {
  senderAgentId: "agent-1",
  epicId: "epic-1",
  name: null,
  surface: "gui" as const,
  harnessId: "codex" as const,
  model: "gpt-5.4",
  agentMode: null,
  reasoningEffort: null,
  fastMode: null,
  workspace: null,
};

const baseV2Request = {
  ...baseV1Request,
  profileSelection: { kind: "profile" as const, profileId: "profile-1" },
};

const baseV3Request = {
  ...baseV2Request,
  permissionMode: "full_access" as const,
};

const baseV31Request = {
  ...baseV3Request,
  crossTaskChatSearch: null,
};

// ─── agent.configure fixtures ───────────────────────────────────────────────

const baseConfigureV1Request = {
  epicId: "epic-1",
  senderAgentId: "agent-1",
  agentId: "agent-2",
  harnessId: "claude" as const,
  model: "opus-4.7",
  profileSelection: { kind: "profile" as const, profileId: "profile-1" },
  reasoningEffort: "high",
  fastMode: false,
};

const baseConfigureV20Request = {
  ...baseConfigureV1Request,
  permissionMode: "full_access" as const,
};

const baseConfigureV61Request = {
  ...baseConfigureV20Request,
  crossTaskChatSearch: null,
};

describe("agent.create 3.1 / agent.configure 6.1 registry wiring", () => {
  it("pins latestMinor to 1 with the {3,1} / {6,1} contracts installed", () => {
    expect(hostRpcRegistry["agent.create"][3].latestMinor).toBe(1);
    expect(
      hostRpcRegistry["agent.create"][3].versions[1].contract.schemaVersion,
    ).toEqual({ major: 3, minor: 1 });

    expect(hostRpcRegistry["agent.configure"][6].latestMinor).toBe(1);
    expect(
      hostRpcRegistry["agent.configure"][6].versions[1].contract.schemaVersion,
    ).toEqual({ major: 6, minor: 1 });
  });
});

describe("3.0 -> 3.1 / 6.0 -> 6.1 request and response upgrades", () => {
  it("fills crossTaskChatSearch: null on an upgraded agent.create request, leaving every other field unchanged, with an identity response upgrade", () => {
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["agent.create"],
      { major: 3, minor: 0 },
      { major: 3, minor: 1 },
      baseV3Request,
    );
    expect(upgraded).toEqual({ ...baseV3Request, crossTaskChatSearch: null });

    const response = { agentId: "agent-9", warnings: [] };
    expect(agentCreateUpgradeV30ToV31.upgradeResponse(response)).toBe(response);
  });

  it("fills crossTaskChatSearch: null on an upgraded agent.configure request, leaving every other field unchanged, with an identity response upgrade", () => {
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["agent.configure"],
      { major: 6, minor: 0 },
      { major: 6, minor: 1 },
      baseConfigureV20Request,
    );
    expect(upgraded).toEqual({
      ...baseConfigureV20Request,
      crossTaskChatSearch: null,
    });

    const response = {
      settings: {
        harnessId: "claude" as const,
        model: "opus-4.7",
        profileSelection: { kind: "profile" as const, profileId: "profile-1" },
        reasoningEffort: "high",
        fastMode: false,
        permissionMode: "full_access" as const,
        agentMode: "regular" as const,
      },
      warnings: [],
    };
    expect(agentConfigureUpgradeV60ToV61.upgradeResponse(response)).toBe(
      response,
    );
  });
});

describe("createAgentRequestSchemaV31 crossTaskChatSearch validation", () => {
  it("accepts true, false and null but rejects a missing key or a non-boolean value", () => {
    expect(
      createAgentRequestSchemaV31.safeParse({
        ...baseV3Request,
        crossTaskChatSearch: true,
      }).success,
    ).toBe(true);
    expect(
      createAgentRequestSchemaV31.safeParse({
        ...baseV3Request,
        crossTaskChatSearch: false,
      }).success,
    ).toBe(true);
    expect(
      createAgentRequestSchemaV31.safeParse({
        ...baseV3Request,
        crossTaskChatSearch: null,
      }).success,
    ).toBe(true);
    expect(createAgentRequestSchemaV31.safeParse(baseV3Request).success).toBe(
      false,
    );
    expect(
      createAgentRequestSchemaV31.safeParse({
        ...baseV3Request,
        crossTaskChatSearch: "true",
      }).success,
    ).toBe(false);
  });
});

describe("agentConfigureRequestSchemaV61 crossTaskChatSearch validation", () => {
  it("accepts true, false and null but rejects a missing key or a non-boolean value", () => {
    expect(
      agentConfigureRequestSchemaV61.safeParse({
        ...baseConfigureV20Request,
        crossTaskChatSearch: true,
      }).success,
    ).toBe(true);
    expect(
      agentConfigureRequestSchemaV61.safeParse({
        ...baseConfigureV20Request,
        crossTaskChatSearch: false,
      }).success,
    ).toBe(true);
    expect(
      agentConfigureRequestSchemaV61.safeParse({
        ...baseConfigureV20Request,
        crossTaskChatSearch: null,
      }).success,
    ).toBe(true);
    expect(
      agentConfigureRequestSchemaV61.safeParse(baseConfigureV20Request).success,
    ).toBe(false);
    expect(
      agentConfigureRequestSchemaV61.safeParse({
        ...baseConfigureV20Request,
        crossTaskChatSearch: 1,
      }).success,
    ).toBe(false);
  });
});

describe("same-major older-minor projection strips crossTaskChatSearch", () => {
  it("drops crossTaskChatSearch when a 3.1 create request is re-parsed through the frozen 3.0 schema", () => {
    const v31Request = { ...baseV3Request, crossTaskChatSearch: true };
    const parsed = createAgentRequestSchemaV30.parse(v31Request);
    expect(parsed).not.toHaveProperty("crossTaskChatSearch");
    expect(parsed).toEqual(baseV3Request);
  });

  it("drops crossTaskChatSearch when a 6.1 configure request is re-parsed through the 6.0 schema (agentConfigureRequestSchemaV20, used by agentConfigureV60)", () => {
    const v61Request = {
      ...baseConfigureV20Request,
      crossTaskChatSearch: true,
    };
    const parsed = agentConfigureRequestSchemaV20.parse(v61Request);
    expect(parsed).not.toHaveProperty("crossTaskChatSearch");
    expect(parsed).toEqual(baseConfigureV20Request);
  });
});

describe("cross-major downgrades", () => {
  it("downgrades a 6.1 configure request across majors to 5, dropping crossTaskChatSearch but succeeding", () => {
    const request = { ...baseConfigureV61Request, crossTaskChatSearch: true };
    const downgraded = downgradeRequestAcrossMajors(
      hostRpcRegistry["agent.configure"],
      6,
      5,
      request,
    );
    if (!downgraded.ok) throw new Error("expected an ok downgrade result");
    expect(downgraded.value).not.toHaveProperty("crossTaskChatSearch");
    expect(downgraded.value).toEqual(baseConfigureV20Request);
  });

  it("still refuses a 3.1 create request downgraded across majors to 2 with DOWNGRADE_UNSUPPORTED", () => {
    const request = { ...baseV31Request, crossTaskChatSearch: true };
    const downgraded = downgradeRequestAcrossMajors(
      hostRpcRegistry["agent.create"],
      3,
      2,
      request,
    );
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) return;
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
  });
});
