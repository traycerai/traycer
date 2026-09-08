import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  getGuiAgentPlanRequestSchema,
  getGuiAgentPlanResponseSchema,
  listGuiAgentCommandsRequestSchema,
  listGuiAgentCommandsRequestSchemaV20,
  listGuiAgentCommandsResponseSchema,
  listGuiAgentCommandsResponseSchemaV10,
  listGuiAgentModelsRequestSchema,
  listGuiAgentModelsRequestSchemaV20,
  listGuiAgentModelsResponseSchema,
  listGuiAgentModelsResponseSchemaV10,
  listGuiHarnessesRequestSchema,
  listGuiHarnessesResponseSchema,
  listGuiHarnessesResponseSchemaV10,
  listGuiHarnessesResponseSchemaV20,
  listGuiHarnessesResponseSchemaV21,
  listGuiHarnessesResponseSchemaV30,
  listGuiHarnessesResponseSchemaV40,
  listGuiHarnessesResponseSchemaV50,
  listGuiHarnessesResponseSchemaV60,
  listGuiHarnessesResponseSchemaV71,
  listGuiHarnessesResponseSchemaV70,
  guiHarnessOptionSchemaV10,
  guiHarnessOptionSchemaV21,
  guiHarnessOptionSchemaV30,
  guiHarnessOptionSchemaV40,
  guiHarnessOptionSchemaV50,
  guiHarnessOptionSchemaV60,
  guiHarnessOptionSchemaV71,
  guiAgentModelOptionSchemaV10,
  guiAgentCommandOptionSchemaV10,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  chatSubscribeV10,
  chatSubscribeV11,
  chatSubscribeV12,
  chatSubscribeV13,
  chatSubscribeV14,
  chatSubscribeV15,
  chatSubscribeV16,
  chatSubscribeV17,
  chatSubscribeV18,
} from "@traycer/protocol/host/agent/gui/subscribe";

// ─── GUI-surface catalog (`agent.gui.*`) ──────────────────────────────────

// `agent.gui.listHarnesses` always returns the full catalog, so unguarded new
// harness ids would reach every caller. v1.0 is frozen without the ACP GUI
// harnesses; v2.0 carries them and is frozen without Amp; v3.0 carries Amp and
// is frozen without Devin/Pi; v4.0 carries Devin/Pi and is frozen without
// Hermes; v5.0 carries Hermes and is frozen without omp; v6.0 carries omp and
// is frozen without Hugging Face; v7.0 carries Hugging Face and is frozen
// without `authStatus`; v7.1 carries it.
// Bridges drop ids an older caller can't decode.
//
// v7.1 is a MINOR, not a new major: `authStatus` is one additive optional row
// field, and `versioned-rpc.ts` rejects a major bump that isn't a breaking
// change. The v7 -> older downgrades therefore start at 7.1 (the line's latest
// minor), which the registry validator enforces.
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
  responseSchema: listGuiHarnessesResponseSchemaV40,
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

export const agentGuiListHarnessesV50 = defineRpcContract({
  method: "agent.gui.listHarnesses",
  schemaVersion: { major: 5, minor: 0 } as const,
  requestSchema: listGuiHarnessesRequestSchema,
  // Frozen: the v1.1.8 tags shipped this line, so it must serve the v5.0 id
  // set rather than the live one. Before that release it pointed at the
  // canonical schema, which is exactly how `omp` first tried to ride v5.0.
  // The REQUEST stays live: it is a client→host slot, so widening the harness
  // enum a caller may send is not a released-peer break.
  responseSchema: listGuiHarnessesResponseSchemaV50,
});

export const agentGuiListHarnessesUpgradeV4ToV5 = defineUpgradePath<
  typeof agentGuiListHarnessesV40,
  typeof agentGuiListHarnessesV50
>({
  from: { major: 4, minor: 0 },
  to: { major: 5, minor: 0 },
  // Request shape is identical; a v4.0 response without Hermes is a valid
  // v5.0 response (purely additive), so both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentGuiListHarnessesDowngradeV5ToV4 = defineDowngradePath<
  typeof agentGuiListHarnessesV50,
  typeof agentGuiListHarnessesV40
>({
  from: { major: 5, minor: 0 },
  to: { major: 4, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Hermes so an already-shipped v4.0 client's strict decode never
  // sees it.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV40.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV40.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV5ToV3 = defineDowngradePath<
  typeof agentGuiListHarnessesV50,
  typeof agentGuiListHarnessesV30
>({
  from: { major: 5, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Devin/Pi/Hermes so an already-shipped v3.0 client's strict decode
  // never sees them.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV30.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV30.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV5ToV2 = defineDowngradePath<
  typeof agentGuiListHarnessesV50,
  typeof agentGuiListHarnessesV21
>({
  from: { major: 5, minor: 0 },
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

export const agentGuiListHarnessesDowngradeV5ToV1 = defineDowngradePath<
  typeof agentGuiListHarnessesV50,
  typeof agentGuiListHarnessesV10
>({
  from: { major: 5, minor: 0 },
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

export const agentGuiListHarnessesV60 = defineRpcContract({
  method: "agent.gui.listHarnesses",
  schemaVersion: { major: 6, minor: 0 } as const,
  requestSchema: listGuiHarnessesRequestSchema,
  // Frozen: the v1.1.9 tags shipped this line, so it must serve the v6.0 id
  // set rather than the live one. Before that release it pointed at the
  // canonical schema, which is exactly how `omp` first tried to ride v5.0 -
  // the same defect, one line later. The REQUEST stays live: it is a
  // client→host slot, so widening the harness enum a caller may send is not a
  // released-peer break.
  responseSchema: listGuiHarnessesResponseSchemaV60,
});

export const agentGuiListHarnessesUpgradeV5ToV6 = defineUpgradePath<
  typeof agentGuiListHarnessesV50,
  typeof agentGuiListHarnessesV60
>({
  from: { major: 5, minor: 0 },
  to: { major: 6, minor: 0 },
  // Request shape is identical; a v5.0 response without omp is a valid v6.0
  // response (purely additive), so both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentGuiListHarnessesDowngradeV6ToV5 = defineDowngradePath<
  typeof agentGuiListHarnessesV60,
  typeof agentGuiListHarnessesV50
>({
  from: { major: 6, minor: 0 },
  to: { major: 5, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop omp so an already-shipped v5.0 client's strict decode never sees it.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV50.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV50.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV6ToV4 = defineDowngradePath<
  typeof agentGuiListHarnessesV60,
  typeof agentGuiListHarnessesV40
>({
  from: { major: 6, minor: 0 },
  to: { major: 4, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Hermes/omp so an already-shipped v4.0 client's strict decode never
  // sees them.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV40.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV40.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV6ToV3 = defineDowngradePath<
  typeof agentGuiListHarnessesV60,
  typeof agentGuiListHarnessesV30
>({
  from: { major: 6, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Devin/Pi/Hermes/omp so an already-shipped v3.0 client's strict decode
  // never sees them.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV30.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV30.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV6ToV2 = defineDowngradePath<
  typeof agentGuiListHarnessesV60,
  typeof agentGuiListHarnessesV21
>({
  from: { major: 6, minor: 0 },
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

export const agentGuiListHarnessesDowngradeV6ToV1 = defineDowngradePath<
  typeof agentGuiListHarnessesV60,
  typeof agentGuiListHarnessesV10
>({
  from: { major: 6, minor: 0 },
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

export const agentGuiListHarnessesV70 = defineRpcContract({
  method: "agent.gui.listHarnesses",
  schemaVersion: { major: 7, minor: 0 } as const,
  requestSchema: listGuiHarnessesRequestSchema,
  // Frozen: `cli-v1.2.0-rc.1` / `host-v1.2.0-rc.1` shipped this line, so it
  // must serve the row shape those peers negotiate rather than the live one,
  // which v7.1 grew with `authStatus`. Until v7.1 opened it
  // pointed at the canonical schema, which is how the released 2.1-6.0 rows
  // ended up tracking the live body too - see `guiHarnessOptionBaseShapeV70`.
  responseSchema: listGuiHarnessesResponseSchemaV70,
});

export const agentGuiListHarnessesUpgradeV6ToV7 = defineUpgradePath<
  typeof agentGuiListHarnessesV60,
  typeof agentGuiListHarnessesV70
>({
  from: { major: 6, minor: 0 },
  to: { major: 7, minor: 0 },
  // Request shape is identical; a v6.0 response without Hugging Face is a
  // valid v7.0 response (purely additive), so both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentGuiListHarnessesV71 = defineRpcContract({
  method: "agent.gui.listHarnesses",
  schemaVersion: { major: 7, minor: 1 } as const,
  requestSchema: listGuiHarnessesRequestSchema,
  // Frozen at the v7.0 ID SET, not the live one - see
  // `listGuiHarnessesResponseSchemaV71`'s comment. 7.0 is released, and a minor
  // may not grow a response enum over its predecessor, so no minor of major 7
  // can carry a harness id 7.0 lacks. The REQUEST stays live: it is a
  // client->host slot, so widening the harness enum a caller may send is not a
  // released-peer break.
  responseSchema: listGuiHarnessesResponseSchemaV71,
});

export const agentGuiListHarnessesV80 = defineRpcContract({
  method: "agent.gui.listHarnesses",
  schemaVersion: { major: 8, minor: 0 } as const,
  requestSchema: listGuiHarnessesRequestSchema,
  responseSchema: listGuiHarnessesResponseSchema,
});

export const agentGuiListHarnessesUpgradeV71ToV80 = defineUpgradePath<
  typeof agentGuiListHarnessesV71,
  typeof agentGuiListHarnessesV80
>({
  from: { major: 7, minor: 1 },
  to: { major: 8, minor: 0 },
  // Request shape is identical; a v7.1 response without Reasonix is a valid
  // v8.0 response (purely additive), so both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentGuiListHarnessesDowngradeV8ToV7 = defineDowngradePath<
  typeof agentGuiListHarnessesV80,
  typeof agentGuiListHarnessesV71
>({
  from: { major: 8, minor: 0 },
  to: { major: 7, minor: 1 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Reasonix so an already-shipped major-7 client's strict decode never
  // sees it. Lands on 7.1, major 7's latest installed minor; a frozen-7.0
  // caller's own contract parse then strips the 7.1-only `authStatus` key.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV71.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV71.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV8ToV6 = defineDowngradePath<
  typeof agentGuiListHarnessesV80,
  typeof agentGuiListHarnessesV60
>({
  from: { major: 8, minor: 0 },
  to: { major: 6, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Hugging Face/Reasonix so an already-shipped v6.0 client's strict
  // decode never sees them.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV60.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV60.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV8ToV5 = defineDowngradePath<
  typeof agentGuiListHarnessesV80,
  typeof agentGuiListHarnessesV50
>({
  from: { major: 8, minor: 0 },
  to: { major: 5, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop omp/Hugging Face/Reasonix so an already-shipped v5.0 client's strict
  // decode never sees them.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV50.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV50.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV8ToV4 = defineDowngradePath<
  typeof agentGuiListHarnessesV80,
  typeof agentGuiListHarnessesV40
>({
  from: { major: 8, minor: 0 },
  to: { major: 4, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Hermes/omp/Hugging Face/Reasonix so an already-shipped v4.0 client's
  // strict decode never sees them.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV40.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV40.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV8ToV3 = defineDowngradePath<
  typeof agentGuiListHarnessesV80,
  typeof agentGuiListHarnessesV30
>({
  from: { major: 8, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Devin/Pi/Hermes/omp/Hugging Face/Reasonix so an already-shipped v3.0
  // client's strict decode never sees them.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV30.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV30.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV8ToV2 = defineDowngradePath<
  typeof agentGuiListHarnessesV80,
  typeof agentGuiListHarnessesV21
>({
  from: { major: 8, minor: 0 },
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

export const agentGuiListHarnessesDowngradeV8ToV1 = defineDowngradePath<
  typeof agentGuiListHarnessesV80,
  typeof agentGuiListHarnessesV10
>({
  from: { major: 8, minor: 0 },
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

export const agentGuiListHarnessesUpgradeV70ToV71 = defineUpgradePath<
  typeof agentGuiListHarnessesV70,
  typeof agentGuiListHarnessesV71
>({
  from: { major: 7, minor: 0 },
  to: { major: 7, minor: 1 },
  // 7.1 adds `authStatus` over the frozen 7.0 row. Nothing is filled: it is
  // `.optional()` precisely so "this host reports no auth verdict on the
  // catalog row" stays distinguishable from any concrete value, and a v7.0
  // host IS such a host. Filling it would fabricate a verdict the client then
  // trusts over its own `providers.list` fallback.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentGuiListHarnessesDowngradeV7ToV6 = defineDowngradePath<
  typeof agentGuiListHarnessesV71,
  typeof agentGuiListHarnessesV60
>({
  from: { major: 7, minor: 1 },
  to: { major: 6, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Hugging Face so an already-shipped v6.0 client's strict decode never
  // sees it.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV60.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV60.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV7ToV5 = defineDowngradePath<
  typeof agentGuiListHarnessesV71,
  typeof agentGuiListHarnessesV50
>({
  from: { major: 7, minor: 1 },
  to: { major: 5, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop omp/Hugging Face so an already-shipped v5.0 client's strict decode
  // never sees them.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV50.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV50.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV7ToV4 = defineDowngradePath<
  typeof agentGuiListHarnessesV71,
  typeof agentGuiListHarnessesV40
>({
  from: { major: 7, minor: 1 },
  to: { major: 4, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Hermes/omp/Hugging Face so an already-shipped v4.0 client's strict
  // decode never sees them.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV40.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV40.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV7ToV3 = defineDowngradePath<
  typeof agentGuiListHarnessesV71,
  typeof agentGuiListHarnessesV30
>({
  from: { major: 7, minor: 1 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Devin/Pi/Hermes/omp/Hugging Face so an already-shipped v3.0 client's
  // strict decode never sees them.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiHarnessesResponseSchemaV30.parse({
      harnesses: response.harnesses.filter(
        (harness) => guiHarnessOptionSchemaV30.safeParse(harness).success,
      ),
    }),
  }),
});

export const agentGuiListHarnessesDowngradeV7ToV2 = defineDowngradePath<
  typeof agentGuiListHarnessesV71,
  typeof agentGuiListHarnessesV21
>({
  from: { major: 7, minor: 1 },
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

export const agentGuiListHarnessesDowngradeV7ToV1 = defineDowngradePath<
  typeof agentGuiListHarnessesV71,
  typeof agentGuiListHarnessesV10
>({
  from: { major: 7, minor: 1 },
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

/**
 * Binds the frozen `listGuiAgentModelsResponseSchemaV10` (W3 fix pass, P2)
 * rather than the live response - see that schema's doc comment.
 */
export const agentGuiListModelsV10 = defineRpcContract({
  method: "agent.gui.listModels",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listGuiAgentModelsRequestSchema,
  responseSchema: listGuiAgentModelsResponseSchemaV10,
});

/**
 * Binds the frozen `listGuiAgentCommandsResponseSchemaV10` (W3 fix pass, P2);
 * same reasoning as `agentGuiListModelsV10` above.
 */
export const agentGuiListCommandsV10 = defineRpcContract({
  method: "agent.gui.listCommands",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listGuiAgentCommandsRequestSchema,
  responseSchema: listGuiAgentCommandsResponseSchemaV10,
});

/**
 * D09/D17/D25 (W3-T6): `profileId` on the request, so the composer's model
 * catalog answers for the profile the picker has selected instead of always
 * for the default account. The response is untouched and reused as-is.
 */
export const agentGuiListModelsV20 = defineRpcContract({
  method: "agent.gui.listModels",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: listGuiAgentModelsRequestSchemaV20,
  responseSchema: listGuiAgentModelsResponseSchema,
});

/** D09/D17/D25 (W3-T6): fills `profileId: null` - a client that predates
 *  profiles only ever meant the default account, matching
 *  `agentGuiListModelsV20`'s request contract above. */
export const agentGuiListModelsUpgradeV10ToV20 = defineUpgradePath<
  typeof agentGuiListModelsV10,
  typeof agentGuiListModelsV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => ({ ...request, profileId: null }),
  // Reparse (not cast) through the live response: the frozen `@1.0` line
  // below is a byte-for-byte hand copy today, but this is what makes a
  // future harness id land as a real type error here instead of a silent
  // cast (W3 fix pass, P2).
  upgradeResponse: (response) =>
    listGuiAgentModelsResponseSchema.parse(response),
});

/**
 * FAILS CLOSED on a non-null `profileId` rather than rewriting it to the
 * default account: serving the default account's models under a managed
 * profile's name is the exact defect this line exists to remove (D21). Same
 * shape as `providersListModelProvidersDowngradeV20ToV10`.
 */
export const agentGuiListModelsDowngradeV20ToV10 = defineDowngradePath<
  typeof agentGuiListModelsV20,
  typeof agentGuiListModelsV10
>({
  from: { major: 2, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => {
    const { profileId, ...rest } = request;
    if (profileId !== null) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "A managed profile has no representation in agent.gui.listModels@1.0",
        },
      };
    }
    return { ok: true, value: rest };
  },
  // Reparses through the frozen `@1.0` response (W3 fix pass, P2), dropping
  // any model whose `harnessId` postdates the freeze - same discipline as
  // `agentGuiListHarnessesDowngradeV7ToV1` above.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiAgentModelsResponseSchemaV10.parse({
      harnessId: response.harnessId,
      models: response.models.filter(
        (model) => guiAgentModelOptionSchemaV10.safeParse(model).success,
      ),
    }),
  }),
});

/** D09/D17/D25 (W3-T6): `profileId` on the request, so the command palette
 *  lists the selected profile's skills. Same reasoning as
 *  `agentGuiListModelsV20`. */
export const agentGuiListCommandsV20 = defineRpcContract({
  method: "agent.gui.listCommands",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: listGuiAgentCommandsRequestSchemaV20,
  responseSchema: listGuiAgentCommandsResponseSchema,
});

/** D09/D17/D25 (W3-T6): fills `profileId: null`, same reasoning as
 *  `agentGuiListModelsUpgradeV10ToV20` above. */
export const agentGuiListCommandsUpgradeV10ToV20 = defineUpgradePath<
  typeof agentGuiListCommandsV10,
  typeof agentGuiListCommandsV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => ({ ...request, profileId: null }),
  // Reparse (not cast) through the live response; see
  // `agentGuiListModelsUpgradeV10ToV20` above (W3 fix pass, P2).
  upgradeResponse: (response) =>
    listGuiAgentCommandsResponseSchema.parse(response),
});

/** Fails closed on a non-null `profileId`; see
 *  `agentGuiListModelsDowngradeV20ToV10`. */
export const agentGuiListCommandsDowngradeV20ToV10 = defineDowngradePath<
  typeof agentGuiListCommandsV20,
  typeof agentGuiListCommandsV10
>({
  from: { major: 2, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => {
    const { profileId, ...rest } = request;
    if (profileId !== null) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "A managed profile has no representation in agent.gui.listCommands@1.0",
        },
      };
    }
    return { ok: true, value: rest };
  },
  // Reparses through the frozen `@1.0` response (W3 fix pass, P2); see
  // `agentGuiListModelsDowngradeV20ToV10` above.
  downgradeResponse: (response) => ({
    ok: true,
    value: listGuiAgentCommandsResponseSchemaV10.parse({
      harnessId: response.harnessId,
      commands: response.commands.filter(
        (command) => guiAgentCommandOptionSchemaV10.safeParse(command).success,
      ),
    }),
  }),
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
  chatSubscribeV15,
  chatSubscribeV16,
  chatSubscribeV17,
  chatSubscribeV18,
};
