import { describe, expect, it } from "vitest";

import { getLatestContract } from "../../framework/versioned-rpc.js";
import {
  agentConfigureResponseSchema,
  agentGetProviderProfileRateLimitsResponseSchema,
  agentListProviderProfilesResponseSchema,
} from "../agent/profiles.js";
import { listGuiHarnessesResponseSchema } from "../agent/gui/unary-schemas.js";
import { listAgentsResponseSchema } from "../agent/shared.js";
import { getChatRunSettingsResponseSchema } from "../epic/chat-records.js";
import { providersListResponseSchema } from "../provider-schemas.js";
import { providersRefreshProfileStatusResponseSchema } from "../rate-limit/schemas.js";
import { hostRpcRegistry } from "../registry.js";

/**
 * For most methods, when a release freezes a line the freeze gets its own
 * hand-listed object and the NEW head keeps the canonical base name
 * (`providersListResponseSchema`, `listAgentsResponseSchema`, ...). Writing the
 * new head as a fresh `z.object` over the same fields instead leaves the base
 * name exported, structurally identical, and backing NOTHING - so it still
 * reads like the live line at every import site while the registry has quietly
 * moved off it. Nothing type-errors, because the two objects infer the same
 * type.
 *
 * `agent.getProviderProfileRateLimits` is EXCLUDED, and the exclusion is the
 * interesting half. That method keeps its head in a suffixed
 * `...ResponseSchemaV6` and deliberately leaves
 * `agentGetProviderProfileRateLimitsResponseSchema` canonical for nothing,
 * because that distinct-but-identical object is the only falsifying fixture
 * `clients/traycer-cli/src/internal/__tests__/host-rpc.test.ts` has for proving
 * the CLI's `assertCanonicalResponseSchema` backstop actually fires. Adding a
 * row for it here would force the two objects together and silently gut that
 * test - which is exactly the mistake this comment exists to stop the next
 * person (and the author of this file) from repeating.
 *
 * FALSIFICATION RECIPE: in `agent/profiles.ts`, change `providersListV90`'s
 * `responseSchema` from `providersListResponseSchema` to an inline
 * `z.object({ ... })` over the same fields. The tree still compiles and every
 * other protocol suite stays green; this file reddens on that one row.
 * Verified against `agent.getProviderProfileRateLimits` before that row was
 * removed: 1 failed, 7 passed - the table discriminates rather than failing
 * wholesale.
 *
 * Extend the table whenever a method's head major is opened - and if the new
 * head does NOT name its base alias, say why here rather than omitting it.
 */
const HEAD_NAMES_ITS_CANONICAL_ALIAS: readonly [
  method: keyof typeof hostRpcRegistry & string,
  aliasName: string,
  alias: unknown,
][] = [
  [
    "providers.list",
    "providersListResponseSchema",
    providersListResponseSchema,
  ],
  ["agent.list", "listAgentsResponseSchema", listAgentsResponseSchema],
  [
    "agent.gui.listHarnesses",
    "listGuiHarnessesResponseSchema",
    listGuiHarnessesResponseSchema,
  ],
  [
    "agent.configure",
    "agentConfigureResponseSchema",
    agentConfigureResponseSchema,
  ],
  [
    "agent.listProviderProfiles",
    "agentListProviderProfilesResponseSchema",
    agentListProviderProfilesResponseSchema,
  ],
  // agent.getProviderProfileRateLimits is intentionally absent - see the
  // docblock above. Its exclusion is asserted below, not merely omitted.
  [
    "epic.getChatRunSettings",
    "getChatRunSettingsResponseSchema",
    getChatRunSettingsResponseSchema,
  ],
  [
    "providers.refreshProfileStatus",
    "providersRefreshProfileStatusResponseSchema",
    providersRefreshProfileStatusResponseSchema,
  ],
];

describe("the head contract names the canonical live response schema", () => {
  it.each(HEAD_NAMES_ITS_CANONICAL_ALIAS)(
    "%s's latest contract IS %s (identity, not shape)",
    (method, _aliasName, alias) => {
      const head = getLatestContract(hostRpcRegistry[method], undefined);
      // `toBe`, not `toEqual`: an equal-but-distinct object is exactly the
      // defect. Two schemas over the same fields are `toEqual`-identical and
      // still leave the base name orphaned.
      expect(head.responseSchema).toBe(alias);
    },
  );

  it("covers every method whose head major this freeze opened, minus the one documented exclusion", () => {
    // A row silently deleted from the table would make this file pass while
    // checking less, so pin the count too. Raise it deliberately when a new
    // head major is opened - never lower it to make a red row go away.
    expect(HEAD_NAMES_ITS_CANONICAL_ALIAS).toHaveLength(7);
    const methods = HEAD_NAMES_ITS_CANONICAL_ALIAS.map(([method]) => method);
    expect(new Set(methods).size).toBe(methods.length);
    for (const method of methods) {
      expect(hostRpcRegistry[method]).toBeDefined();
    }
  });

  it("agent.getProviderProfileRateLimits is excluded BECAUSE its head is deliberately not the base alias", () => {
    // Asserting the exception rather than omitting it. If someone later
    // collapses the two objects, this reddens and points at the CLI backstop
    // test that quietly loses its fixture - instead of that test degrading to
    // a tautology nobody notices.
    const head = getLatestContract(
      hostRpcRegistry["agent.getProviderProfileRateLimits"],
      undefined,
    );
    expect(head.responseSchema).not.toBe(
      agentGetProviderProfileRateLimitsResponseSchema,
    );
    // ...and the base alias still accepts what canonical accepts, which is
    // what makes it a valid negative fixture rather than a shape mismatch.
    const value = {
      rateLimits: { provider: "codex", available: false, reason: "timeout" },
      usageUpdatedAt: null,
    };
    expect(
      agentGetProviderProfileRateLimitsResponseSchema.safeParse(value).success,
    ).toBe(true);
    expect(head.responseSchema.safeParse(value).success).toBe(true);
  });
});
