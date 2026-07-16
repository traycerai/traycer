import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  getGuiAgentPlanRequestSchema,
  getGuiAgentPlanResponseSchema,
  listGuiAgentCommandsRequestSchema,
  listGuiAgentCommandsResponseSchema,
  listGuiAgentModelsRequestSchema,
  listGuiAgentModelsResponseSchema,
  listGuiHarnessesRequestSchema,
  listGuiHarnessesResponseSchema,
  listGuiHarnessesResponseSchemaV10,
  listGuiHarnessesResponseSchemaV20,
  listGuiHarnessesResponseSchemaV21,
  listGuiHarnessesResponseSchemaV30,
  guiHarnessOptionSchemaV10,
  guiHarnessOptionSchemaV21,
  guiHarnessOptionSchemaV30,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  chatSubscribeV10,
  chatSubscribeV11,
  chatSubscribeV12,
  chatSubscribeV13,
  chatSubscribeV14,
} from "@traycer/protocol/host/agent/gui/subscribe";

// ─── GUI-surface catalog (`agent.gui.*`) ──────────────────────────────────

// `agent.gui.listHarnesses` always returns the full catalog, so unguarded new
// harness ids would reach every caller. v1.0 is frozen without the ACP GUI
// harnesses; v2.0 carries them and is frozen without Amp; v3.0 carries Amp and
// is frozen without Devin/Pi; v4.0 carries Devin/Pi. Bridges drop ids an older
// caller can't decode.
export const agentGuiListHarnessesV10 = defineRpcContract({
  method: "agent.gui.listHarnesses",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listGuiHarnessesRequestSchema,
  responseSchema: listGuiHarnessesResponseSchemaV10,
});

export const agentGuiListHarnessesV20 = defineRpcContract({
  method: "agent.gui.listHarnesses",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: listGuiHarnessesRequestSchema,
  responseSchema: listGuiHarnessesResponseSchemaV20,
});

export const agentGuiListHarnessesUpgradeV1ToV2 = defineUpgradePath<
  typeof agentGuiListHarnessesV10,
  typeof agentGuiListHarnessesV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  // Request shape is identical. The frozen 2.0 row adds `availabilityPending`
  // (#147) over the frozen 1.0 row; a 1.0 host predates the background
  // availability probe, so every row it returns is already settled.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    harnesses: response.harnesses.map((harness) => ({
      ...harness,
      availabilityPending: false,
    })),
  }),
});

export const agentGuiListHarnessesV21 = defineRpcContract({
  method: "agent.gui.listHarnesses",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: listGuiHarnessesRequestSchema,
  responseSchema: listGuiHarnessesResponseSchemaV21,
});

export const agentGuiListHarnessesUpgradeV20ToV21 = defineUpgradePath<
  typeof agentGuiListHarnessesV20,
  typeof agentGuiListHarnessesV21
>({
  from: { major: 2, minor: 0 },
  to: { major: 2, minor: 1 },
  // 2.1 adds `enabled` (#178) over the frozen released 2.0 row. A host that
  // never shipped the flag only lists harnesses it considers usable, so the
  // pre-feature reading is enabled for every row it returns.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    harnesses: response.harnesses.map((harness) => ({
      ...harness,
      enabled: true,
    })),
  }),
});

// Bridges from v2.1 (the latest installed version of major 2's line) down to
// the frozen v1.0 - not from v2.0, since v2.1 supersedes it as major 2's
// latest.
export const agentGuiListHarnessesDowngradeV2ToV1 = defineDowngradePath<
  typeof agentGuiListHarnessesV21,
  typeof agentGuiListHarnessesV10
>({
  from: { major: 2, minor: 1 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop post-v1.0 GUI harnesses so a v1.0 client's strict decode never sees
  // them. The re-parse also yields the precise v1.0 type without an assertion
  // (and strips the post-1.0 row fields the frozen 1.0 shape never had).
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV10.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV10.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesV30 = defineRpcContract({
  method: "agent.gui.listHarnesses",
  schemaVersion: { major: 3, minor: 0 } as const,
  requestSchema: listGuiHarnessesRequestSchema,
  responseSchema: listGuiHarnessesResponseSchemaV30,
});

export const agentGuiListHarnessesUpgradeV2ToV3 = defineUpgradePath<
  typeof agentGuiListHarnessesV21,
  typeof agentGuiListHarnessesV30
>({
  from: { major: 2, minor: 1 },
  to: { major: 3, minor: 0 },
  // Request shape is identical; a 2.1 response without Amp is a valid v3.0
  // response (purely additive), so both upgrades are identity. Anchored at
  // 2.1 (major 2's latest installed minor) so the cross-major chain runs
  // 2.0 → 2.1 → 3.0 and the 2.1 `enabled` fill is never skipped.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentGuiListHarnessesDowngradeV3ToV2 = defineDowngradePath<
  typeof agentGuiListHarnessesV30,
  typeof agentGuiListHarnessesV21
>({
  from: { major: 3, minor: 0 },
  // Lands on 2.1, major 2's latest installed minor; a frozen-2.0 caller's
  // contract parse then strips the 2.1-only `enabled` field.
  to: { major: 2, minor: 1 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Amp so an already-shipped v2.0 client's strict decode never sees it.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV21.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV21.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV3ToV1 = defineDowngradePath<
  typeof agentGuiListHarnessesV30,
  typeof agentGuiListHarnessesV10
>({
  from: { major: 3, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop post-v1.0 GUI harnesses (ACP harnesses AND Amp) directly, so a v1.0
  // client's strict decode never sees any of them.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV10.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV10.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesV40 = defineRpcContract({
  method: "agent.gui.listHarnesses",
  schemaVersion: { major: 4, minor: 0 } as const,
  requestSchema: listGuiHarnessesRequestSchema,
  responseSchema: listGuiHarnessesResponseSchema,
});

export const agentGuiListHarnessesUpgradeV3ToV4 = defineUpgradePath<
  typeof agentGuiListHarnessesV30,
  typeof agentGuiListHarnessesV40
>({
  from: { major: 3, minor: 0 },
  to: { major: 4, minor: 0 },
  // Request shape is identical; a v3.0 response without Devin/Pi is a valid
  // v4.0 response (purely additive), so both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentGuiListHarnessesDowngradeV4ToV3 = defineDowngradePath<
  typeof agentGuiListHarnessesV40,
  typeof agentGuiListHarnessesV30
>({
  from: { major: 4, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Devin/Pi so an already-shipped v3.0 client's strict decode never
  // sees them.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV30.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV30.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV4ToV2 = defineDowngradePath<
  typeof agentGuiListHarnessesV40,
  typeof agentGuiListHarnessesV21
>({
  from: { major: 4, minor: 0 },
  // Lands on 2.1, major 2's latest installed minor; a frozen-2.0 caller's
  // contract parse then strips the 2.1-only `enabled` field.
  to: { major: 2, minor: 1 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV21.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV21.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV4ToV1 = defineDowngradePath<
  typeof agentGuiListHarnessesV40,
  typeof agentGuiListHarnessesV10
>({
  from: { major: 4, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV10.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV10.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListModelsV10 = defineRpcContract({
  method: "agent.gui.listModels",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listGuiAgentModelsRequestSchema,
  responseSchema: listGuiAgentModelsResponseSchema,
});

export const agentGuiListCommandsV10 = defineRpcContract({
  method: "agent.gui.listCommands",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listGuiAgentCommandsRequestSchema,
  responseSchema: listGuiAgentCommandsResponseSchema,
});

export const agentGuiGetPlanV10 = defineRpcContract({
  method: "agent.gui.getPlan",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: getGuiAgentPlanRequestSchema,
  responseSchema: getGuiAgentPlanResponseSchema,
});

export {
  chatSubscribeV10,
  chatSubscribeV11,
  chatSubscribeV12,
  chatSubscribeV13,
  chatSubscribeV14,
};
