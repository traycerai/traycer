import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  createAgentRequestSchema,
  createAgentRequestSchemaV20,
  createAgentRequestSchemaV30,
  createAgentResponseSchema,
  agentSelectionGuideRequestSchema,
  agentSelectionGuideResponseSchema,
  agentSelectionGuideGlobalGetRequestSchema,
  agentSelectionGuideGlobalGetResponseSchema,
  agentSelectionGuideGlobalOnboardingDraftGetRequestSchema,
  agentSelectionGuideGlobalOnboardingDraftGetResponseSchema,
  agentSelectionGuideGlobalResetRequestSchema,
  agentSelectionGuideGlobalResetResponseSchema,
  agentSelectionGuideGlobalSetRequestSchema,
  agentSelectionGuideGlobalSetResponseSchema,
  getAgentTranscriptRequestSchema,
  getAgentTranscriptResponseSchema,
  listHarnessModelsRequestSchemaV10,
  listHarnessModelsRequestSchemaV20,
  listHarnessModelsResponseSchema,
  listAgentsRequestSchema,
  listAgentsResponseSchema,
  listAgentsResponseSchemaV10,
  listAgentsResponseSchemaV20,
  listAgentsResponseSchemaV30,
  listAgentsResponseSchemaV40,
  listAgentsResponseSchemaV50,
  listAgentsResponseSchemaV60,
  listAgentsResponseSchemaV70,
  agentSummarySchemaV10,
  agentSummarySchemaV20,
  agentSummarySchemaV30,
  agentSummarySchemaV40,
  agentSummarySchemaV50,
  agentSummarySchemaV60,
  agentSummarySchemaV70,
  sendAgentMessageRequestSchema,
  sendAgentMessageResponseSchema,
  stopAgentRequestSchema,
  stopAgentResponseSchema,
  forkAgentRequestSchema,
  forkAgentResponseSchema,
} from "@traycer/protocol/host/agent/shared";

// ─── Agent-to-agent unary surface ─────────────────────────────────────────

export const agentCreateV10 = defineRpcContract({
  method: "agent.create",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: createAgentRequestSchema,
  responseSchema: createAgentResponseSchema,
});

export const agentCreateV20 = defineRpcContract({
  method: "agent.create",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: createAgentRequestSchemaV20,
  responseSchema: createAgentResponseSchema,
});

export const agentCreateV30 = defineRpcContract({
  method: "agent.create",
  schemaVersion: { major: 3, minor: 0 } as const,
  requestSchema: createAgentRequestSchemaV30,
  responseSchema: createAgentResponseSchema,
});

/**
 * A v1.0 caller's nullable `profileId` maps onto the new selection model at the boundary the multi-profile decision log calls compatibility-only: `null` is legacy sender inheritance (`inherit_sender`), a non-null string.
 */
export const agentCreateUpgradeV10ToV20 = defineUpgradePath<
  typeof agentCreateV10,
  typeof agentCreateV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => {
    const { profileId, ...rest } = request;
    return {
      ...rest,
      profileSelection:
        profileId === null
          ? { kind: "inherit_sender" as const }
          : { kind: "profile" as const, profileId },
    };
  },
  upgradeResponse: (response) => response,
});

/**
 * Projects the frozen v2.0 request back onto the frozen v1.0 wire for an old host.
 * `ambient` and `last_used` fail because v1.0 cannot represent their profile semantics.
 */
export const agentCreateDowngradeV20ToV10 = defineDowngradePath<
  typeof agentCreateV20,
  typeof agentCreateV10
>({
  from: { major: 2, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => {
    const { profileSelection, ...rest } = request;
    if (profileSelection.kind === "last_used") {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Creating an agent with the last-used provider profile requires a newer Traycer host. Choose a specific profile, or upgrade the host.",
        },
      };
    }
    if (profileSelection.kind === "ambient") {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Creating an agent with the ambient provider login requires a newer Traycer host - the frozen v1.0 wire cannot distinguish an explicit ambient choice from inheriting the sender's profile. Choose a specific profile, or upgrade the host.",
        },
      };
    }
    return {
      ok: true,
      value: createAgentRequestSchema.parse({
        ...rest,
        profileId:
          profileSelection.kind === "profile"
            ? profileSelection.profileId
            : null,
      }),
    };
  },
  downgradeResponse: (response) => ({ ok: true, value: response }),
});

/** Released v2 callers did not carry a permission choice. */
export const agentCreateUpgradeV20ToV30 = defineUpgradePath<
  typeof agentCreateV20,
  typeof agentCreateV30
>({
  from: { major: 2, minor: 0 },
  to: { major: 3, minor: 0 },
  upgradeRequest: (request) => ({ ...request, permissionMode: null }),
  upgradeResponse: (response) => response,
});

export const agentCreateDowngradeV30ToV20 = defineDowngradePath<
  typeof agentCreateV30,
  typeof agentCreateV20
>({
  from: { major: 3, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: () => ({
    ok: false,
    error: {
      code: "DOWNGRADE_UNSUPPORTED",
      message:
        "Selecting an agent permission mode requires a newer Traycer host. Upgrade the host before creating this agent.",
    },
  }),
  downgradeResponse: (response) => ({ ok: true, value: response }),
});

export const agentCreateDowngradeV30ToV10 = defineDowngradePath<
  typeof agentCreateV30,
  typeof agentCreateV10
>({
  from: { major: 3, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: () => ({
    ok: false,
    error: {
      code: "DOWNGRADE_UNSUPPORTED",
      message:
        "Selecting an agent permission mode requires a newer Traycer host. Upgrade the host before creating this agent.",
    },
  }),
  downgradeResponse: (response) => ({ ok: true, value: response }),
});

export const agentSelectionGuideV10 = defineRpcContract({
  method: "agent.selectionGuide",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentSelectionGuideRequestSchema,
  responseSchema: agentSelectionGuideResponseSchema,
});

export const agentSelectionGuideGlobalGetV10 = defineRpcContract({
  method: "agent.selectionGuide.getGlobal",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentSelectionGuideGlobalGetRequestSchema,
  responseSchema: agentSelectionGuideGlobalGetResponseSchema,
});

export const agentSelectionGuideGlobalOnboardingDraftGetV10 = defineRpcContract(
  {
    method: "agent.selectionGuide.getGlobalOnboardingDraft",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: agentSelectionGuideGlobalOnboardingDraftGetRequestSchema,
    responseSchema: agentSelectionGuideGlobalOnboardingDraftGetResponseSchema,
  },
);

export const agentSelectionGuideGlobalSetV10 = defineRpcContract({
  method: "agent.selectionGuide.setGlobal",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentSelectionGuideGlobalSetRequestSchema,
  responseSchema: agentSelectionGuideGlobalSetResponseSchema,
});

export const agentSelectionGuideGlobalResetV10 = defineRpcContract({
  method: "agent.selectionGuide.resetGlobalToDefault",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentSelectionGuideGlobalResetRequestSchema,
  responseSchema: agentSelectionGuideGlobalResetResponseSchema,
});

export const agentListHarnessModelsV10 = defineRpcContract({
  method: "agent.listHarnessModels",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listHarnessModelsRequestSchemaV10,
  responseSchema: listHarnessModelsResponseSchema,
});

export const agentListHarnessModelsV20 = defineRpcContract({
  method: "agent.listHarnessModels",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: listHarnessModelsRequestSchemaV20,
  responseSchema: listHarnessModelsResponseSchema,
});

export const agentListHarnessModelsUpgradeV1ToV2 = defineUpgradePath<
  typeof agentListHarnessModelsV10,
  typeof agentListHarnessModelsV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentListHarnessModelsDowngradeV2ToV1 = defineDowngradePath<
  typeof agentListHarnessModelsV20,
  typeof agentListHarnessModelsV10
>({
  from: { major: 2, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => {
    if (request.epicId === null || request.senderAgentId === null) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "agent.listHarnessModels without epic and sender agent context requires a newer Traycer host.",
        },
      };
    }
    return {
      ok: true,
      value: {
        epicId: request.epicId,
        senderAgentId: request.senderAgentId,
        harnessId: request.harnessId,
      },
    };
  },
  downgradeResponse: (response) => ({ ok: true, value: response }),
});

export const agentListV10 = defineRpcContract({
  method: "agent.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listAgentsRequestSchema,
  responseSchema: listAgentsResponseSchemaV10,
});

export const agentListV20 = defineRpcContract({
  method: "agent.list",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: listAgentsRequestSchema,
  responseSchema: listAgentsResponseSchemaV20,
});

export const agentListUpgradeV1ToV2 = defineUpgradePath<
  typeof agentListV10,
  typeof agentListV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentListDowngradeV2ToV1 = defineDowngradePath<
  typeof agentListV20,
  typeof agentListV10
>({
  from: { major: 2, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop post-v1.0 GUI harness agents so a v1.0 client's strict decode never
  // sees one. The re-parse yields the precise v1.0 type without an assertion.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV10.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV10.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListV30 = defineRpcContract({
  method: "agent.list",
  schemaVersion: { major: 3, minor: 0 } as const,
  requestSchema: listAgentsRequestSchema,
  responseSchema: listAgentsResponseSchemaV30,
});

export const agentListUpgradeV2ToV3 = defineUpgradePath<
  typeof agentListV20,
  typeof agentListV30
>({
  from: { major: 2, minor: 0 },
  to: { major: 3, minor: 0 },
  // A v2.0 response without Amp agents is a valid v3.0 response (purely additive), and the request shape is identical - both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentListDowngradeV3ToV2 = defineDowngradePath<
  typeof agentListV30,
  typeof agentListV20
>({
  from: { major: 3, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Amp agents so an already-shipped v2.0 client's strict decode never
  // sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV20.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV20.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV3ToV1 = defineDowngradePath<
  typeof agentListV30,
  typeof agentListV10
>({
  from: { major: 3, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop post-v1.0 GUI harness agents (ACP harnesses AND Amp) directly, so a
  // v1.0 client's strict decode never sees any of them.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV10.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV10.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListV40 = defineRpcContract({
  method: "agent.list",
  schemaVersion: { major: 4, minor: 0 } as const,
  requestSchema: listAgentsRequestSchema,
  responseSchema: listAgentsResponseSchemaV40,
});

export const agentListUpgradeV3ToV4 = defineUpgradePath<
  typeof agentListV30,
  typeof agentListV40
>({
  from: { major: 3, minor: 0 },
  to: { major: 4, minor: 0 },
  // A v3.0 response without Devin/Pi agents is a valid v4.0 response (purely additive), and the request shape is identical - both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentListDowngradeV4ToV3 = defineDowngradePath<
  typeof agentListV40,
  typeof agentListV30
>({
  from: { major: 4, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Devin/Pi agents so an already-shipped v3.0 client's strict decode
  // never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV30.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV30.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV4ToV2 = defineDowngradePath<
  typeof agentListV40,
  typeof agentListV20
>({
  from: { major: 4, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV20.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV20.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV4ToV1 = defineDowngradePath<
  typeof agentListV40,
  typeof agentListV10
>({
  from: { major: 4, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV10.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV10.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListV50 = defineRpcContract({
  method: "agent.list",
  schemaVersion: { major: 5, minor: 0 } as const,
  requestSchema: listAgentsRequestSchema,
  // Frozen: the v1.1.8 tags shipped this line, so it must serve the v5.0 harness id set rather than the live one.
  responseSchema: listAgentsResponseSchemaV50,
});

export const agentListUpgradeV4ToV5 = defineUpgradePath<
  typeof agentListV40,
  typeof agentListV50
>({
  from: { major: 4, minor: 0 },
  to: { major: 5, minor: 0 },
  // A v4.0 response without Hermes agents is a valid v5.0 response (purely additive), and the request shape is identical - both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentListDowngradeV5ToV4 = defineDowngradePath<
  typeof agentListV50,
  typeof agentListV40
>({
  from: { major: 5, minor: 0 },
  to: { major: 4, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Hermes agents so an already-shipped v4.0 client's strict decode
  // never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV40.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV40.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV5ToV3 = defineDowngradePath<
  typeof agentListV50,
  typeof agentListV30
>({
  from: { major: 5, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Devin/Pi/Hermes agents so an already-shipped v3.0 client's strict
  // decode never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV30.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV30.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV5ToV2 = defineDowngradePath<
  typeof agentListV50,
  typeof agentListV20
>({
  from: { major: 5, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV20.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV20.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV5ToV1 = defineDowngradePath<
  typeof agentListV50,
  typeof agentListV10
>({
  from: { major: 5, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV10.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV10.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListV60 = defineRpcContract({
  method: "agent.list",
  schemaVersion: { major: 6, minor: 0 } as const,
  requestSchema: listAgentsRequestSchema,
  // Frozen: the v1.1.9 tags shipped this line, so it must serve the v6.0 harness id set rather than the live one.
  responseSchema: listAgentsResponseSchemaV60,
});

export const agentListUpgradeV5ToV6 = defineUpgradePath<
  typeof agentListV50,
  typeof agentListV60
>({
  from: { major: 5, minor: 0 },
  to: { major: 6, minor: 0 },
  // A v5.0 response without omp agents is a valid v6.0 response (purely additive), and the request shape is identical - both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentListDowngradeV6ToV5 = defineDowngradePath<
  typeof agentListV60,
  typeof agentListV50
>({
  from: { major: 6, minor: 0 },
  to: { major: 5, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop omp agents so an already-shipped v5.0 client's strict decode never
  // sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV50.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV50.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV6ToV4 = defineDowngradePath<
  typeof agentListV60,
  typeof agentListV40
>({
  from: { major: 6, minor: 0 },
  to: { major: 4, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Hermes/omp agents so an already-shipped v4.0 client's strict decode
  // never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV40.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV40.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV6ToV3 = defineDowngradePath<
  typeof agentListV60,
  typeof agentListV30
>({
  from: { major: 6, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Devin/Pi/Hermes/omp agents so an already-shipped v3.0 client's strict
  // decode never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV30.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV30.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV6ToV2 = defineDowngradePath<
  typeof agentListV60,
  typeof agentListV20
>({
  from: { major: 6, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV20.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV20.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV6ToV1 = defineDowngradePath<
  typeof agentListV60,
  typeof agentListV10
>({
  from: { major: 6, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV10.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV10.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListV70 = defineRpcContract({
  method: "agent.list",
  schemaVersion: { major: 7, minor: 0 } as const,
  requestSchema: listAgentsRequestSchema,
  // Frozen: the v1.2.0 tags shipped this line, so it must serve the v7.0 harness id set rather than the live one.
  responseSchema: listAgentsResponseSchemaV70,
});

export const agentListUpgradeV6ToV7 = defineUpgradePath<
  typeof agentListV60,
  typeof agentListV70
>({
  from: { major: 6, minor: 0 },
  to: { major: 7, minor: 0 },
  // The request shape is identical.
  // Parses through the FROZEN v7.0 shape, not the live one: the target of this hop is `agentListV70`, and a hop that parses through a schema wider than its own target is how a fill silently starts producing values the.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => listAgentsResponseSchemaV70.parse(response),
});

export const agentListDowngradeV7ToV6 = defineDowngradePath<
  typeof agentListV70,
  typeof agentListV60
>({
  from: { major: 7, minor: 0 },
  to: { major: 6, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Hugging Face agents so an already-shipped v6.0 client's strict decode
  // never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV60.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV60.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV7ToV5 = defineDowngradePath<
  typeof agentListV70,
  typeof agentListV50
>({
  from: { major: 7, minor: 0 },
  to: { major: 5, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop omp/Hugging Face agents so an already-shipped v5.0 client's strict
  // decode never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV50.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV50.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV7ToV4 = defineDowngradePath<
  typeof agentListV70,
  typeof agentListV40
>({
  from: { major: 7, minor: 0 },
  to: { major: 4, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Hermes/omp/Hugging Face agents so an already-shipped v4.0 client's
  // strict decode never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV40.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV40.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV7ToV3 = defineDowngradePath<
  typeof agentListV70,
  typeof agentListV30
>({
  from: { major: 7, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Devin/Pi/Hermes/omp/Hugging Face agents so an already-shipped v3.0
  // client's strict decode never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV30.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV30.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV7ToV2 = defineDowngradePath<
  typeof agentListV70,
  typeof agentListV20
>({
  from: { major: 7, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV20.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV20.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV7ToV1 = defineDowngradePath<
  typeof agentListV70,
  typeof agentListV10
>({
  from: { major: 7, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV10.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV10.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListV80 = defineRpcContract({
  method: "agent.list",
  schemaVersion: { major: 8, minor: 0 } as const,
  requestSchema: listAgentsRequestSchema,
  responseSchema: listAgentsResponseSchema,
});

export const agentListUpgradeV7ToV8 = defineUpgradePath<
  typeof agentListV70,
  typeof agentListV80
>({
  from: { major: 7, minor: 0 },
  to: { major: 8, minor: 0 },
  // The request shape is identical, and a v7.0 response without Reasonix agents is a valid v8.0 response (purely additive) - both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentListDowngradeV8ToV7 = defineDowngradePath<
  typeof agentListV80,
  typeof agentListV70
>({
  from: { major: 8, minor: 0 },
  to: { major: 7, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Reasonix agents so an already-shipped v7.0 client's strict decode
  // never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV70.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV70.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV8ToV6 = defineDowngradePath<
  typeof agentListV80,
  typeof agentListV60
>({
  from: { major: 8, minor: 0 },
  to: { major: 6, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Hugging Face/Reasonix agents so an already-shipped v6.0 client's
  // strict decode never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV60.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV60.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV8ToV5 = defineDowngradePath<
  typeof agentListV80,
  typeof agentListV50
>({
  from: { major: 8, minor: 0 },
  to: { major: 5, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop omp/Hugging Face/Reasonix agents so an already-shipped v5.0 client's
  // strict decode never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV50.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV50.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV8ToV4 = defineDowngradePath<
  typeof agentListV80,
  typeof agentListV40
>({
  from: { major: 8, minor: 0 },
  to: { major: 4, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Hermes/omp/Hugging Face/Reasonix agents so an already-shipped v4.0
  // client's strict decode never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV40.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV40.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV8ToV3 = defineDowngradePath<
  typeof agentListV80,
  typeof agentListV30
>({
  from: { major: 8, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Devin/Pi/Hermes/omp/Hugging Face/Reasonix agents so an
  // already-shipped v3.0 client's strict decode never sees one.
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV30.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV30.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV8ToV2 = defineDowngradePath<
  typeof agentListV80,
  typeof agentListV20
>({
  from: { major: 8, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV20.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV20.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentListDowngradeV8ToV1 = defineDowngradePath<
  typeof agentListV80,
  typeof agentListV10
>({
  from: { major: 8, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: listAgentsResponseSchemaV10.parse({
      ...response,
      agents: response.agents.filter(
        (agent) => agentSummarySchemaV10.safeParse(agent).success,
      ),
    }),
  }),
});

export const agentSendMessageV10 = defineRpcContract({
  method: "agent.sendMessage",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: sendAgentMessageRequestSchema,
  responseSchema: sendAgentMessageResponseSchema,
});

export const agentGetTranscriptV10 = defineRpcContract({
  method: "agent.getTranscript",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: getAgentTranscriptRequestSchema,
  responseSchema: getAgentTranscriptResponseSchema,
});

export const agentStopV10 = defineRpcContract({
  method: "agent.stop",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: stopAgentRequestSchema,
  responseSchema: stopAgentResponseSchema,
});

/**
 * Brand-new v1.0 method - an old host simply lacks it, so a caller gets per-call "host too old, upgrade" guidance instead of a fatal handshake mismatch (see `degrade: { kind: "unsupported" }` in `registry.ts`).
 */
export const agentForkV10 = defineRpcContract({
  method: "agent.fork",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: forkAgentRequestSchema,
  responseSchema: forkAgentResponseSchema,
});
