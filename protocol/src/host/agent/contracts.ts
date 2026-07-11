import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  createAgentRequestSchema,
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
  agentSummarySchemaV10,
  agentSummarySchemaV20,
  agentSummarySchemaV30,
  sendAgentMessageRequestSchema,
  sendAgentMessageResponseSchema,
  stopAgentRequestSchema,
  stopAgentResponseSchema,
} from "@traycer/protocol/host/agent/shared";

// ─── Agent-to-agent unary surface ─────────────────────────────────────────
//
// `agent.create` mints a child agent (gui chat or tui agent) on behalf of
// the sender; `agent.list` enumerates every agent record this host's epic
// Y.Doc can see (cross-host entries included as read-only rows);
// `agent.sendMessage` is the fire-and-forget hand-off path (no streaming -
// any reply travels back as a separate `agent.sendMessage`);
// `agent.getTranscript` flattens an agent's conversation into XML-tagged
// text; and `agent.stop` halts an agent (and optionally its delegated
// subtree). Schema docs in `agent/shared.ts` are the authority on the field
// semantics.

export const agentCreateV10 = defineRpcContract({
  method: "agent.create",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: createAgentRequestSchema,
  responseSchema: createAgentResponseSchema,
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
  // A v1.0 response without ACP GUI harness agents is a valid v2.0 response
  // (they are purely additive), and the request shape is identical - both
  // upgrades are identity.
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
  // A v2.0 response without Amp agents is a valid v3.0 response (purely
  // additive), and the request shape is identical - both upgrades are
  // identity.
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
  responseSchema: listAgentsResponseSchema,
});

export const agentListUpgradeV3ToV4 = defineUpgradePath<
  typeof agentListV30,
  typeof agentListV40
>({
  from: { major: 3, minor: 0 },
  to: { major: 4, minor: 0 },
  // A v3.0 response without Devin/Pi agents is a valid v4.0 response (purely
  // additive), and the request shape is identical - both upgrades are
  // identity.
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
