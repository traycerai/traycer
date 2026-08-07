import { describe, expect, it } from "vitest";

import {
  agentListDowngradeV2ToV1,
  agentListDowngradeV3ToV1,
  agentListDowngradeV3ToV2,
  agentListDowngradeV4ToV1,
  agentListDowngradeV4ToV2,
  agentListDowngradeV4ToV3,
  agentListDowngradeV5ToV1,
  agentListDowngradeV5ToV2,
  agentListDowngradeV5ToV3,
  agentListDowngradeV5ToV4,
  agentListDowngradeV6ToV1,
  agentListDowngradeV6ToV2,
  agentListDowngradeV6ToV3,
  agentListDowngradeV6ToV4,
  agentListDowngradeV6ToV5,
  agentListDowngradeV7ToV1,
  agentListDowngradeV7ToV2,
  agentListDowngradeV7ToV3,
  agentListDowngradeV7ToV4,
  agentListDowngradeV7ToV5,
  agentListDowngradeV7ToV6,
} from "@traycer/protocol/host/agent/contracts";
import {
  listAgentsResponseSchema,
  listAgentsResponseSchemaV10,
  listAgentsResponseSchemaV20,
  listAgentsResponseSchemaV30,
  listAgentsResponseSchemaV40,
  listAgentsResponseSchemaV50,
  listAgentsResponseSchemaV60,
} from "@traycer/protocol/host/agent/shared";
import {
  agentGuiListHarnessesDowngradeV2ToV1,
  agentGuiListHarnessesDowngradeV3ToV1,
  agentGuiListHarnessesDowngradeV3ToV2,
  agentGuiListHarnessesDowngradeV4ToV1,
  agentGuiListHarnessesDowngradeV4ToV2,
  agentGuiListHarnessesDowngradeV4ToV3,
  agentGuiListHarnessesDowngradeV5ToV1,
  agentGuiListHarnessesDowngradeV5ToV2,
  agentGuiListHarnessesDowngradeV5ToV3,
  agentGuiListHarnessesDowngradeV5ToV4,
  agentGuiListHarnessesDowngradeV6ToV1,
  agentGuiListHarnessesDowngradeV6ToV2,
  agentGuiListHarnessesDowngradeV6ToV3,
  agentGuiListHarnessesDowngradeV6ToV4,
  agentGuiListHarnessesDowngradeV6ToV5,
  agentGuiListHarnessesDowngradeV7ToV1,
  agentGuiListHarnessesDowngradeV7ToV2,
  agentGuiListHarnessesDowngradeV7ToV3,
  agentGuiListHarnessesDowngradeV7ToV4,
  agentGuiListHarnessesDowngradeV7ToV5,
  agentGuiListHarnessesDowngradeV7ToV6,
} from "@traycer/protocol/host/agent/gui/contracts";
import {
  guiHarnessOptionSchema,
  listGuiHarnessesResponseSchema,
  listGuiHarnessesResponseSchemaV10,
  listGuiHarnessesResponseSchemaV20,
  listGuiHarnessesResponseSchemaV21,
  listGuiHarnessesResponseSchemaV30,
  listGuiHarnessesResponseSchemaV40,
  listGuiHarnessesResponseSchemaV50,
  listGuiHarnessesResponseSchemaV60,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  PROVIDER_AUTH_STATUS_SCHEMA,
  PROVIDER_AUTH_STATUS_SCHEMA_V10,
  providerCliStateSchemaV10,
  providersListResponseSchema,
  providersListResponseSchemaV10,
  providersListResponseSchemaV20,
  providersListResponseSchemaV30,
  providersListResponseSchemaV40,
  providersListResponseSchemaV50,
  providersListResponseSchemaV60,
  providersSetApiKeyResponseSchemaV10,
} from "@traycer/protocol/host/provider-schemas";
// Importing from the registry runs `defineVersionedRpcRegistry` (full structural
// + schema-compatibility validation) at module load, so this import alone
// asserts the new v2.0/v3.0/v4.0/v5.0/v6.0/v7.0 lines and their upgrade/downgrade
// bridges are well-formed.
import {
  providersAwaitLoginDowngradeV21ToV10,
  providersListDowngradeV2ToV1,
  providersListDowngradeV4ToV1,
  providersListDowngradeV4ToV2,
  providersListDowngradeV4ToV3,
  providersListDowngradeV5ToV1,
  providersListDowngradeV5ToV2,
  providersListDowngradeV5ToV3,
  providersListDowngradeV5ToV4,
  providersListDowngradeV6ToV1,
  providersListDowngradeV6ToV2,
  providersListDowngradeV6ToV3,
  providersListDowngradeV6ToV4,
  providersListDowngradeV6ToV5,
  providersListDowngradeV8ToV1,
  providersListDowngradeV8ToV2,
  providersListDowngradeV8ToV3,
  providersListDowngradeV8ToV4,
  providersListDowngradeV8ToV5,
  providersListDowngradeV8ToV6,
  providersSetApiKeyDowngradeV21ToV10,
} from "@traycer/protocol/host/registry";

function harnessOption(id: string) {
  return guiHarnessOptionSchema.parse({
    id,
    label: id,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
  });
}

function agentSummary(id: string, harnessId: string | null) {
  return {
    id,
    parentId: null,
    hostId: "host-1",
    isLocal: true,
    surface: "gui",
    harnessId,
    isSelf: false,
    title: id,
    capabilities: { readTranscript: true, sendMessage: true },
    active: false,
    folderPaths: [],
    isWorktree: false,
  };
}

function providerState(providerId: string, status: string) {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status, badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
    },
  };
}

describe("post-v1.0 GUI harness non-breaking v2→v1 downgrade bridges", () => {
  it("drops post-v1.0 harnesses from agent.gui.listHarnesses for v1.0 callers", () => {
    // The v2→v1 bridge is anchored at 2.1, major 2's latest installed minor.
    const v2Response = listGuiHarnessesResponseSchemaV21.parse({
      harnesses: [
        harnessOption("claude"),
        harnessOption("grok"),
        harnessOption("qwen"),
        harnessOption("kiro"),
        harnessOption("kimi"),
        harnessOption("droid"),
        harnessOption("copilot"),
        harnessOption("kilocode"),
        harnessOption("cursor"),
      ],
    });

    const result =
      agentGuiListHarnessesDowngradeV2ToV1.downgradeResponse(v2Response);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.harnesses.map((harness) => harness.id)).toEqual([
      "claude",
      "cursor",
    ]);
    // The downgraded value must satisfy the frozen v1.0 schema - i.e. a real
    // v1.0 client's strict decode would accept it.
    expect(() =>
      listGuiHarnessesResponseSchemaV10.parse(result.value),
    ).not.toThrow();
  });

  it("drops post-v1.0 providers from providers.list for v1.0 callers", () => {
    const v2Response = providersListResponseSchemaV20.parse({
      providers: [
        providerState("cursor", "unknown"),
        providerState("grok", "unknown"),
        providerState("qwen", "unknown"),
        providerState("kiro", "unknown"),
        providerState("kimi", "unknown"),
        providerState("droid", "unknown"),
        providerState("copilot", "unknown"),
        providerState("kilocode", "unknown"),
      ],
    });

    const result = providersListDowngradeV2ToV1.downgradeResponse(v2Response);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.providers.map((provider) => provider.providerId),
    ).toEqual(["cursor"]);
    expect(() =>
      providersListResponseSchemaV10.parse(result.value),
    ).not.toThrow();
  });

  it("widens provider auth in v2 and downgrades new statuses for v1.0 callers", () => {
    expect(PROVIDER_AUTH_STATUS_SCHEMA.safeParse("configured").success).toBe(
      true,
    );
    expect(PROVIDER_AUTH_STATUS_SCHEMA.safeParse("unavailable").success).toBe(
      true,
    );
    expect(
      PROVIDER_AUTH_STATUS_SCHEMA_V10.safeParse("configured").success,
    ).toBe(false);
    expect(
      PROVIDER_AUTH_STATUS_SCHEMA_V10.safeParse("unavailable").success,
    ).toBe(false);

    const v2Response = providersListResponseSchemaV20.parse({
      providers: [
        providerState("cursor", "configured"),
        providerState("grok", "unavailable"),
      ],
    });

    expect(providersListResponseSchemaV10.safeParse(v2Response).success).toBe(
      false,
    );
    const result = providersListDowngradeV2ToV1.downgradeResponse(v2Response);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providers).toHaveLength(1);
    expect(result.value.providers[0]?.providerId).toBe("cursor");
    expect(result.value.providers[0]?.auth.status).toBe("unknown");
    expect(() =>
      providersListResponseSchemaV10.parse(result.value),
    ).not.toThrow();
  });

  it("downgrades provider-state mutation responses for v1.0 callers", () => {
    const state = providersListResponseSchema.parse({
      providers: [providerState("cursor", "unavailable")],
    }).providers[0];
    const setApiKey = providersSetApiKeyDowngradeV21ToV10.downgradeResponse({
      state,
    });

    expect(setApiKey.ok).toBe(true);
    if (!setApiKey.ok) return;
    expect(setApiKey.value.state.auth.status).toBe("unknown");
    expect(() =>
      providersSetApiKeyResponseSchemaV10.parse(setApiKey.value),
    ).not.toThrow();

    const awaitLogin = providersAwaitLoginDowngradeV21ToV10.downgradeResponse({
      state,
      existingProfileId: null,
      codeRejected: false,
    });
    expect(awaitLogin.ok).toBe(true);
    if (!awaitLogin.ok) return;
    expect(awaitLogin.value.state?.auth.status).toBe("unknown");

    expect(
      providersAwaitLoginDowngradeV21ToV10.downgradeResponse({
        state: null,
        existingProfileId: null,
        codeRejected: false,
      }),
    ).toEqual({ ok: true, value: { state: null } });
  });

  it("rejects post-v1.0 provider mutation requests during v2→v1 downgrade", () => {
    expect(
      providerCliStateSchemaV10.safeParse({
        ...providerState("cursor", "unknown"),
        futureField: true,
      }).success,
    ).toBe(false);

    expect(
      providersSetApiKeyDowngradeV21ToV10.downgradeRequest({
        providerId: "grok",
        apiKey: "grok-key",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });

    const requestWithFutureField = Object.freeze({
      providerId: "cursor",
      apiKey: "cursor-key",
      futureField: true,
    });

    expect(
      providersSetApiKeyDowngradeV21ToV10.downgradeRequest(
        requestWithFutureField,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });

    expect(
      providersSetApiKeyDowngradeV21ToV10.downgradeRequest({
        providerId: "cursor",
        apiKey: "cursor-key",
      }),
    ).toEqual({
      ok: true,
      value: { providerId: "cursor", apiKey: "cursor-key" },
    });
  });

  it("drops post-v1.0 agents from agent.list for v1.0 callers", () => {
    const v2Response = listAgentsResponseSchemaV20.parse({
      caller: { agentId: "self", canSendMessages: true },
      scope: "all",
      agents: [
        agentSummary("a-claude", "claude"),
        agentSummary("a-grok", "grok"),
        agentSummary("a-qwen", "qwen"),
        agentSummary("a-kiro", "kiro"),
        agentSummary("a-kilocode", "kilocode"),
        agentSummary("a-kimi", "kimi"),
        agentSummary("a-droid", "droid"),
        agentSummary("a-copilot", "copilot"),
        agentSummary("a-null", null),
      ],
    });

    const result = agentListDowngradeV2ToV1.downgradeResponse(v2Response);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agents.map((agent) => agent.id)).toEqual([
      "a-claude",
      "a-null",
    ]);
    // A real v1.0 client's strict decode must accept the result.
    expect(() => listAgentsResponseSchemaV10.parse(result.value)).not.toThrow();
  });
});

describe("post-v2.0 Amp non-breaking v3→v2 / v3→v1 downgrade bridges", () => {
  it("drops Amp from agent.gui.listHarnesses for v2.0 and v1.0 callers", () => {
    const v3Response = listGuiHarnessesResponseSchemaV30.parse({
      harnesses: [
        harnessOption("claude"),
        harnessOption("cursor"),
        harnessOption("amp"),
      ],
    });

    const toV2 =
      agentGuiListHarnessesDowngradeV3ToV2.downgradeResponse(v3Response);
    expect(toV2.ok).toBe(true);
    if (!toV2.ok) return;
    expect(toV2.value.harnesses.map((harness) => harness.id)).toEqual([
      "claude",
      "cursor",
    ]);
    expect(() =>
      listGuiHarnessesResponseSchemaV20.parse(toV2.value),
    ).not.toThrow();

    const toV1 =
      agentGuiListHarnessesDowngradeV3ToV1.downgradeResponse(v3Response);
    expect(toV1.ok).toBe(true);
    if (!toV1.ok) return;
    expect(toV1.value.harnesses.map((harness) => harness.id)).toEqual([
      "claude",
      "cursor",
    ]);
    expect(() =>
      listGuiHarnessesResponseSchemaV10.parse(toV1.value),
    ).not.toThrow();
  });

  it("drops Amp agents from agent.list for v2.0 and v1.0 callers", () => {
    const v3Response = listAgentsResponseSchemaV30.parse({
      caller: { agentId: "self", canSendMessages: true },
      scope: "all",
      agents: [
        agentSummary("a-claude", "claude"),
        agentSummary("a-amp", "amp"),
        agentSummary("a-null", null),
      ],
    });

    const toV2 = agentListDowngradeV3ToV2.downgradeResponse(v3Response);
    expect(toV2.ok).toBe(true);
    if (!toV2.ok) return;
    expect(toV2.value.agents.map((agent) => agent.id)).toEqual([
      "a-claude",
      "a-null",
    ]);
    expect(() => listAgentsResponseSchemaV20.parse(toV2.value)).not.toThrow();

    const toV1 = agentListDowngradeV3ToV1.downgradeResponse(v3Response);
    expect(toV1.ok).toBe(true);
    if (!toV1.ok) return;
    expect(toV1.value.agents.map((agent) => agent.id)).toEqual([
      "a-claude",
      "a-null",
    ]);
    expect(() => listAgentsResponseSchemaV10.parse(toV1.value)).not.toThrow();
  });

  it("drops the Amp provider from providers.list for v3.0, v2.0, and v1.0 callers", () => {
    const liveResponse = providersListResponseSchema.parse({
      providers: [
        providerState("cursor", "unknown"),
        providerState("amp", "unknown"),
      ],
    });

    const toV3 = providersListDowngradeV8ToV3.downgradeResponse(liveResponse);
    expect(toV3.ok).toBe(true);
    if (!toV3.ok) return;
    expect(toV3.value.providers.map((provider) => provider.providerId)).toEqual(
      ["cursor", "amp"],
    );
    expect(() =>
      providersListResponseSchemaV30.parse(toV3.value),
    ).not.toThrow();

    const toV2 = providersListDowngradeV8ToV2.downgradeResponse(liveResponse);
    expect(toV2.ok).toBe(true);
    if (!toV2.ok) return;
    expect(toV2.value.providers.map((provider) => provider.providerId)).toEqual(
      ["cursor"],
    );
    expect(() =>
      providersListResponseSchemaV20.parse(toV2.value),
    ).not.toThrow();

    const toV1 = providersListDowngradeV8ToV1.downgradeResponse(liveResponse);
    expect(toV1.ok).toBe(true);
    if (!toV1.ok) return;
    expect(toV1.value.providers.map((provider) => provider.providerId)).toEqual(
      ["cursor"],
    );
    expect(() =>
      providersListResponseSchemaV10.parse(toV1.value),
    ).not.toThrow();
  });
});

describe("post-v3.0 Devin/Pi downgrade bridges (agent.gui.listHarnesses/agent.list v4, providers.list v4.0)", () => {
  it("drops Devin/Pi from agent.gui.listHarnesses for v3.0, v2.0, and v1.0 callers", () => {
    const v4Response = listGuiHarnessesResponseSchemaV40.parse({
      harnesses: [
        harnessOption("claude"),
        harnessOption("cursor"),
        harnessOption("amp"),
        harnessOption("devin"),
        harnessOption("pi"),
      ],
    });

    const toV3 =
      agentGuiListHarnessesDowngradeV4ToV3.downgradeResponse(v4Response);
    expect(toV3.ok).toBe(true);
    if (!toV3.ok) return;
    expect(toV3.value.harnesses.map((harness) => harness.id)).toEqual([
      "claude",
      "cursor",
      "amp",
    ]);
    expect(() =>
      listGuiHarnessesResponseSchemaV30.parse(toV3.value),
    ).not.toThrow();

    const toV2 =
      agentGuiListHarnessesDowngradeV4ToV2.downgradeResponse(v4Response);
    expect(toV2.ok).toBe(true);
    if (!toV2.ok) return;
    expect(toV2.value.harnesses.map((harness) => harness.id)).toEqual([
      "claude",
      "cursor",
    ]);
    expect(() =>
      listGuiHarnessesResponseSchemaV20.parse(toV2.value),
    ).not.toThrow();

    const toV1 =
      agentGuiListHarnessesDowngradeV4ToV1.downgradeResponse(v4Response);
    expect(toV1.ok).toBe(true);
    if (!toV1.ok) return;
    expect(toV1.value.harnesses.map((harness) => harness.id)).toEqual([
      "claude",
      "cursor",
    ]);
    expect(() =>
      listGuiHarnessesResponseSchemaV10.parse(toV1.value),
    ).not.toThrow();
  });

  it("drops Devin/Pi agents from agent.list for v3.0, v2.0, and v1.0 callers", () => {
    const v4Response = listAgentsResponseSchemaV40.parse({
      caller: { agentId: "self", canSendMessages: true },
      scope: "all",
      agents: [
        agentSummary("a-claude", "claude"),
        agentSummary("a-amp", "amp"),
        agentSummary("a-devin", "devin"),
        agentSummary("a-pi", "pi"),
        agentSummary("a-null", null),
      ],
    });

    const toV3 = agentListDowngradeV4ToV3.downgradeResponse(v4Response);
    expect(toV3.ok).toBe(true);
    if (!toV3.ok) return;
    expect(toV3.value.agents.map((agent) => agent.id)).toEqual([
      "a-claude",
      "a-amp",
      "a-null",
    ]);
    expect(() => listAgentsResponseSchemaV30.parse(toV3.value)).not.toThrow();

    const toV2 = agentListDowngradeV4ToV2.downgradeResponse(v4Response);
    expect(toV2.ok).toBe(true);
    if (!toV2.ok) return;
    expect(toV2.value.agents.map((agent) => agent.id)).toEqual([
      "a-claude",
      "a-null",
    ]);
    expect(() => listAgentsResponseSchemaV20.parse(toV2.value)).not.toThrow();

    const toV1 = agentListDowngradeV4ToV1.downgradeResponse(v4Response);
    expect(toV1.ok).toBe(true);
    if (!toV1.ok) return;
    expect(toV1.value.agents.map((agent) => agent.id)).toEqual([
      "a-claude",
      "a-null",
    ]);
    expect(() => listAgentsResponseSchemaV10.parse(toV1.value)).not.toThrow();
  });

  it("drops Devin/Pi from providers.list for v3.0, v2.0, and v1.0 callers", () => {
    const v4Response = providersListResponseSchemaV40.parse({
      providers: [
        providerState("cursor", "unknown"),
        providerState("amp", "unknown"),
        providerState("devin", "unknown"),
        providerState("pi", "unknown"),
      ],
    });

    const toV3 = providersListDowngradeV4ToV3.downgradeResponse(v4Response);
    expect(toV3.ok).toBe(true);
    if (!toV3.ok) return;
    expect(toV3.value.providers.map((provider) => provider.providerId)).toEqual(
      ["cursor", "amp"],
    );
    expect(() =>
      providersListResponseSchemaV30.parse(toV3.value),
    ).not.toThrow();

    const toV2 = providersListDowngradeV4ToV2.downgradeResponse(v4Response);
    expect(toV2.ok).toBe(true);
    if (!toV2.ok) return;
    expect(toV2.value.providers.map((provider) => provider.providerId)).toEqual(
      ["cursor"],
    );
    expect(() =>
      providersListResponseSchemaV20.parse(toV2.value),
    ).not.toThrow();

    const toV1 = providersListDowngradeV4ToV1.downgradeResponse(v4Response);
    expect(toV1.ok).toBe(true);
    if (!toV1.ok) return;
    expect(toV1.value.providers.map((provider) => provider.providerId)).toEqual(
      ["cursor"],
    );
    expect(() =>
      providersListResponseSchemaV10.parse(toV1.value),
    ).not.toThrow();
  });
});

describe("post-v5.0 omp/Hugging Face non-breaking downgrade bridges", () => {
  // These three catalog methods all had to open a new major when the v1.1.9
  // tags froze their previous line: `huggingface` cannot ride a released
  // version, so the live shape sits on v7.0 and every older caller gets it
  // filtered out.
  it("drops Hugging Face from agent.gui.listHarnesses for every released caller down to v1.0", () => {
    const v7Response = listGuiHarnessesResponseSchema.parse({
      harnesses: [
        harnessOption("claude"),
        harnessOption("cursor"),
        harnessOption("amp"),
        harnessOption("devin"),
        harnessOption("pi"),
        harnessOption("hermes"),
        harnessOption("omp"),
        harnessOption("huggingface"),
      ],
    });

    // v6.0 shipped with omp, so it keeps omp and loses only Hugging Face.
    const toV6 =
      agentGuiListHarnessesDowngradeV7ToV6.downgradeResponse(v7Response);
    expect(toV6.ok).toBe(true);
    if (!toV6.ok) return;
    expect(toV6.value.harnesses.map((harness) => harness.id)).toEqual([
      "claude",
      "cursor",
      "amp",
      "devin",
      "pi",
      "hermes",
      "omp",
    ]);
    expect(() =>
      listGuiHarnessesResponseSchemaV60.parse(toV6.value),
    ).not.toThrow();

    const toV5 =
      agentGuiListHarnessesDowngradeV7ToV5.downgradeResponse(v7Response);
    expect(toV5.ok).toBe(true);
    if (!toV5.ok) return;
    expect(toV5.value.harnesses.map((harness) => harness.id)).toEqual([
      "claude",
      "cursor",
      "amp",
      "devin",
      "pi",
      "hermes",
    ]);
    expect(() =>
      listGuiHarnessesResponseSchemaV50.parse(toV5.value),
    ).not.toThrow();

    const toV4 =
      agentGuiListHarnessesDowngradeV7ToV4.downgradeResponse(v7Response);
    expect(toV4.ok).toBe(true);
    if (!toV4.ok) return;
    expect(toV4.value.harnesses.map((harness) => harness.id)).toEqual([
      "claude",
      "cursor",
      "amp",
      "devin",
      "pi",
    ]);
    expect(() =>
      listGuiHarnessesResponseSchemaV40.parse(toV4.value),
    ).not.toThrow();

    const toV3 =
      agentGuiListHarnessesDowngradeV7ToV3.downgradeResponse(v7Response);
    expect(toV3.ok).toBe(true);
    if (!toV3.ok) return;
    expect(toV3.value.harnesses.map((harness) => harness.id)).toEqual([
      "claude",
      "cursor",
      "amp",
    ]);
    expect(() =>
      listGuiHarnessesResponseSchemaV30.parse(toV3.value),
    ).not.toThrow();

    const toV2 =
      agentGuiListHarnessesDowngradeV7ToV2.downgradeResponse(v7Response);
    expect(toV2.ok).toBe(true);
    if (!toV2.ok) return;
    expect(toV2.value.harnesses.map((harness) => harness.id)).toEqual([
      "claude",
      "cursor",
    ]);
    expect(() =>
      listGuiHarnessesResponseSchemaV20.parse(toV2.value),
    ).not.toThrow();

    const toV1 =
      agentGuiListHarnessesDowngradeV7ToV1.downgradeResponse(v7Response);
    expect(toV1.ok).toBe(true);
    if (!toV1.ok) return;
    expect(toV1.value.harnesses.map((harness) => harness.id)).toEqual([
      "claude",
      "cursor",
    ]);
    expect(() =>
      listGuiHarnessesResponseSchemaV10.parse(toV1.value),
    ).not.toThrow();
  });

  it("drops Hugging Face agents from agent.list for every released caller down to v1.0", () => {
    const v7Response = listAgentsResponseSchema.parse({
      caller: { agentId: "self", canSendMessages: true },
      scope: "all",
      agents: [
        agentSummary("a-claude", "claude"),
        agentSummary("a-amp", "amp"),
        agentSummary("a-devin", "devin"),
        agentSummary("a-pi", "pi"),
        agentSummary("a-hermes", "hermes"),
        agentSummary("a-omp", "omp"),
        agentSummary("a-hf", "huggingface"),
        agentSummary("a-null", null),
      ],
    });

    // v6.0 shipped with omp, so an omp agent row survives; only Hugging Face
    // goes.
    const toV6 = agentListDowngradeV7ToV6.downgradeResponse(v7Response);
    expect(toV6.ok).toBe(true);
    if (!toV6.ok) return;
    expect(toV6.value.agents.map((agent) => agent.id)).toEqual([
      "a-claude",
      "a-amp",
      "a-devin",
      "a-pi",
      "a-hermes",
      "a-omp",
      "a-null",
    ]);
    expect(() => listAgentsResponseSchemaV60.parse(toV6.value)).not.toThrow();

    const toV5 = agentListDowngradeV7ToV5.downgradeResponse(v7Response);
    expect(toV5.ok).toBe(true);
    if (!toV5.ok) return;
    expect(toV5.value.agents.map((agent) => agent.id)).toEqual([
      "a-claude",
      "a-amp",
      "a-devin",
      "a-pi",
      "a-hermes",
      "a-null",
    ]);
    expect(() => listAgentsResponseSchemaV50.parse(toV5.value)).not.toThrow();

    const toV4 = agentListDowngradeV7ToV4.downgradeResponse(v7Response);
    expect(toV4.ok).toBe(true);
    if (!toV4.ok) return;
    expect(toV4.value.agents.map((agent) => agent.id)).toEqual([
      "a-claude",
      "a-amp",
      "a-devin",
      "a-pi",
      "a-null",
    ]);
    expect(() => listAgentsResponseSchemaV40.parse(toV4.value)).not.toThrow();

    const toV3 = agentListDowngradeV7ToV3.downgradeResponse(v7Response);
    expect(toV3.ok).toBe(true);
    if (!toV3.ok) return;
    expect(toV3.value.agents.map((agent) => agent.id)).toEqual([
      "a-claude",
      "a-amp",
      "a-null",
    ]);
    expect(() => listAgentsResponseSchemaV30.parse(toV3.value)).not.toThrow();

    const toV2 = agentListDowngradeV7ToV2.downgradeResponse(v7Response);
    expect(toV2.ok).toBe(true);
    if (!toV2.ok) return;
    expect(toV2.value.agents.map((agent) => agent.id)).toEqual([
      "a-claude",
      "a-null",
    ]);
    expect(() => listAgentsResponseSchemaV20.parse(toV2.value)).not.toThrow();

    const toV1 = agentListDowngradeV7ToV1.downgradeResponse(v7Response);
    expect(toV1.ok).toBe(true);
    if (!toV1.ok) return;
    expect(toV1.value.agents.map((agent) => agent.id)).toEqual([
      "a-claude",
      "a-null",
    ]);
    expect(() => listAgentsResponseSchemaV10.parse(toV1.value)).not.toThrow();
  });

  it("drops Hugging Face from providers.list for every released caller down to v1.0", () => {
    // `cli-v1.1.9` shipped v6.0, so `huggingface` could not join it and every
    // v6.0-and-older caller must have it filtered out. Driven from the LATEST
    // major (v8.0 opened for the Model Providers tab); v7.0 carries the id,
    // which is why the 8.0 -> 7.0 hop below keeps it.
    const v7Response = providersListResponseSchema.parse({
      providers: [
        providerState("cursor", "unknown"),
        providerState("amp", "unknown"),
        providerState("devin", "unknown"),
        providerState("pi", "unknown"),
        providerState("hermes", "unknown"),
        providerState("omp", "unknown"),
        providerState("huggingface", "unknown"),
      ],
    });

    const toV6 = providersListDowngradeV8ToV6.downgradeResponse(v7Response);
    expect(toV6.ok).toBe(true);
    if (!toV6.ok) return;
    expect(toV6.value.providers.map((provider) => provider.providerId)).toEqual(
      ["cursor", "amp", "devin", "pi", "hermes", "omp"],
    );
    expect(() =>
      providersListResponseSchemaV60.parse(toV6.value),
    ).not.toThrow();

    const toV5 = providersListDowngradeV8ToV5.downgradeResponse(v7Response);
    expect(toV5.ok).toBe(true);
    if (!toV5.ok) return;
    expect(toV5.value.providers.map((provider) => provider.providerId)).toEqual(
      ["cursor", "amp", "devin", "pi", "hermes"],
    );
    expect(() =>
      providersListResponseSchemaV50.parse(toV5.value),
    ).not.toThrow();

    const toV4 = providersListDowngradeV8ToV4.downgradeResponse(v7Response);
    expect(toV4.ok).toBe(true);
    if (!toV4.ok) return;
    expect(toV4.value.providers.map((provider) => provider.providerId)).toEqual(
      ["cursor", "amp", "devin", "pi"],
    );
    expect(() =>
      providersListResponseSchemaV40.parse(toV4.value),
    ).not.toThrow();

    const toV3 = providersListDowngradeV8ToV3.downgradeResponse(v7Response);
    expect(toV3.ok).toBe(true);
    if (!toV3.ok) return;
    expect(toV3.value.providers.map((provider) => provider.providerId)).toEqual(
      ["cursor", "amp"],
    );
    expect(() =>
      providersListResponseSchemaV30.parse(toV3.value),
    ).not.toThrow();

    const toV2 = providersListDowngradeV8ToV2.downgradeResponse(v7Response);
    expect(toV2.ok).toBe(true);
    if (!toV2.ok) return;
    expect(toV2.value.providers.map((provider) => provider.providerId)).toEqual(
      ["cursor"],
    );
    expect(() =>
      providersListResponseSchemaV20.parse(toV2.value),
    ).not.toThrow();

    const toV1 = providersListDowngradeV8ToV1.downgradeResponse(v7Response);
    expect(toV1.ok).toBe(true);
    if (!toV1.ok) return;
    expect(toV1.value.providers.map((provider) => provider.providerId)).toEqual(
      ["cursor"],
    );
    expect(() =>
      providersListResponseSchemaV10.parse(toV1.value),
    ).not.toThrow();
  });
});
