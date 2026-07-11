import { describe, expect, it } from "vitest";

import {
  agentListDowngradeV2ToV1,
  agentListDowngradeV3ToV1,
  agentListDowngradeV3ToV2,
} from "@traycer/protocol/host/agent/contracts";
import {
  listAgentsResponseSchema,
  listAgentsResponseSchemaV10,
  listAgentsResponseSchemaV20,
} from "@traycer/protocol/host/agent/shared";
import {
  agentGuiListHarnessesDowngradeV2ToV1,
  agentGuiListHarnessesDowngradeV3ToV1,
  agentGuiListHarnessesDowngradeV3ToV2,
} from "@traycer/protocol/host/agent/gui/contracts";
import {
  guiHarnessOptionSchema,
  listGuiHarnessesResponseSchema,
  listGuiHarnessesResponseSchemaV10,
  listGuiHarnessesResponseSchemaV20,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  PROVIDER_AUTH_STATUS_SCHEMA,
  PROVIDER_AUTH_STATUS_SCHEMA_V10,
  providerCliStateSchemaV10,
  providersListResponseSchema,
  providersListResponseSchemaV10,
  providersListResponseSchemaV20,
  providersSetApiKeyResponseSchemaV10,
} from "@traycer/protocol/host/provider-schemas";
// Importing from the registry runs `defineVersionedRpcRegistry` (full structural
// + schema-compatibility validation) at module load, so this import alone
// asserts the new v2.0/v3.0 lines and their upgrade/downgrade bridges are
// well-formed.
import {
  providersAwaitLoginDowngradeV2ToV1,
  providersListDowngradeV2ToV1,
  providersListDowngradeV3ToV1,
  providersListDowngradeV3ToV2,
  providersSetApiKeyDowngradeV2ToV1,
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
  };
}

describe("post-v1.0 GUI harness non-breaking v2→v1 downgrade bridges", () => {
  it("drops post-v1.0 harnesses from agent.gui.listHarnesses for v1.0 callers", () => {
    const v2Response = listGuiHarnessesResponseSchemaV20.parse({
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
    expect(PROVIDER_AUTH_STATUS_SCHEMA_V10.safeParse("configured").success).toBe(
      false,
    );
    expect(PROVIDER_AUTH_STATUS_SCHEMA_V10.safeParse("unavailable").success).toBe(
      false,
    );

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
    const setApiKey = providersSetApiKeyDowngradeV2ToV1.downgradeResponse({
      state,
    });

    expect(setApiKey.ok).toBe(true);
    if (!setApiKey.ok) return;
    expect(setApiKey.value.state.auth.status).toBe("unknown");
    expect(() =>
      providersSetApiKeyResponseSchemaV10.parse(setApiKey.value),
    ).not.toThrow();

    const awaitLogin = providersAwaitLoginDowngradeV2ToV1.downgradeResponse({
      state,
      existingProfileId: null,
    });
    expect(awaitLogin.ok).toBe(true);
    if (!awaitLogin.ok) return;
    expect(awaitLogin.value.state?.auth.status).toBe("unknown");

    expect(
      providersAwaitLoginDowngradeV2ToV1.downgradeResponse({
        state: null,
        existingProfileId: null,
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
      providersSetApiKeyDowngradeV2ToV1.downgradeRequest({
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
      providersSetApiKeyDowngradeV2ToV1.downgradeRequest(
        requestWithFutureField,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });

    expect(
      providersSetApiKeyDowngradeV2ToV1.downgradeRequest({
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
    const v3Response = listGuiHarnessesResponseSchema.parse({
      harnesses: [harnessOption("claude"), harnessOption("cursor"), harnessOption("amp")],
    });

    const toV2 = agentGuiListHarnessesDowngradeV3ToV2.downgradeResponse(v3Response);
    expect(toV2.ok).toBe(true);
    if (!toV2.ok) return;
    expect(toV2.value.harnesses.map((harness) => harness.id)).toEqual([
      "claude",
      "cursor",
    ]);
    // The downgraded value must satisfy the frozen v2.0 schema - i.e. an
    // already-shipped v2.0 client's strict decode would accept it.
    expect(() =>
      listGuiHarnessesResponseSchemaV20.parse(toV2.value),
    ).not.toThrow();

    const toV1 = agentGuiListHarnessesDowngradeV3ToV1.downgradeResponse(v3Response);
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
    const v3Response = listAgentsResponseSchema.parse({
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

  it("drops the Amp provider from providers.list for v2.0 and v1.0 callers", () => {
    const v3Response = providersListResponseSchema.parse({
      providers: [
        providerState("cursor", "unknown"),
        providerState("amp", "unknown"),
      ],
    });

    const toV2 = providersListDowngradeV3ToV2.downgradeResponse(v3Response);
    expect(toV2.ok).toBe(true);
    if (!toV2.ok) return;
    expect(toV2.value.providers.map((provider) => provider.providerId)).toEqual([
      "cursor",
    ]);
    expect(() =>
      providersListResponseSchemaV20.parse(toV2.value),
    ).not.toThrow();

    const toV1 = providersListDowngradeV3ToV1.downgradeResponse(v3Response);
    expect(toV1.ok).toBe(true);
    if (!toV1.ok) return;
    expect(toV1.value.providers.map((provider) => provider.providerId)).toEqual([
      "cursor",
    ]);
    expect(() =>
      providersListResponseSchemaV10.parse(toV1.value),
    ).not.toThrow();
  });
});
