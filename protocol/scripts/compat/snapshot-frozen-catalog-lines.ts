/**
 * Snapshot frozen response schemas for every method whose response embeds a growing harness/provider id enum - the three canonical id-carrying catalog methods, plus `epic.getChatRunSettings` (see its rows below for why.
 * When a new frozen line lands (e.g.
 */
import { z } from "zod";
import {
  listAgentsResponseSchemaV10,
  listAgentsResponseSchemaV20,
  listAgentsResponseSchemaV30,
  listAgentsResponseSchemaV40,
  listAgentsResponseSchemaV50,
  listAgentsResponseSchemaV60,
  listAgentsResponseSchemaV70,
  listAgentsResponseSchema,
} from "../../src/host/agent/shared";
import {
  listGuiHarnessesResponseSchemaV10,
  listGuiHarnessesResponseSchemaV20,
  listGuiHarnessesResponseSchemaV21,
  listGuiHarnessesResponseSchemaV30,
  listGuiHarnessesResponseSchemaV40,
  listGuiHarnessesResponseSchemaV50,
  listGuiHarnessesResponseSchemaV60,
  listGuiHarnessesResponseSchemaV70,
  listGuiHarnessesResponseSchemaV71,
  listGuiHarnessesResponseSchema,
} from "../../src/host/agent/gui/unary-schemas";
import {
  getChatRunSettingsResponseSchema,
  getChatRunSettingsResponseSchemaV10,
} from "../../src/host/epic/chat-records";
import {
  providersListRequestSchema,
  providersListRequestSchemaBeforeV70,
  providersListResponseSchema,
  providersListResponseSchemaV70,
  providersListResponseSchemaV10,
  providersListResponseSchemaV20,
  providersListResponseSchemaV30,
  providersListResponseSchemaV40,
  providersListResponseSchemaV50,
  providersListResponseSchemaV60,
} from "../../src/host/provider-schemas";

function dump(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { unrepresentable: "any" });
}

// Every released line of the three id-carrying catalog methods.
// Pinning every frozen line makes that same class of drift fail in plain `bun run test`, with no tags to resolve.
const FIXTURES = {
  "agent.gui.listHarnesses@1.0": dump(listGuiHarnessesResponseSchemaV10),
  "agent.gui.listHarnesses@2.0": dump(listGuiHarnessesResponseSchemaV20),
  "agent.gui.listHarnesses@2.1": dump(listGuiHarnessesResponseSchemaV21),
  "agent.gui.listHarnesses@3.0": dump(listGuiHarnessesResponseSchemaV30),
  "agent.gui.listHarnesses@4.0": dump(listGuiHarnessesResponseSchemaV40),
  "agent.gui.listHarnesses@5.0": dump(listGuiHarnessesResponseSchemaV50),
  "agent.gui.listHarnesses@6.0": dump(listGuiHarnessesResponseSchemaV60),
  // v7.0 froze when v7.1 opened for the row's `authStatus`.
  // Up to that point the 2.1-6.0 rows above were `guiHarnessOptionSchema.extend({ id })` - a pinned id over the LIVE body - so these dumps were only ever half-frozen.
  "agent.gui.listHarnesses@7.0": dump(listGuiHarnessesResponseSchemaV70),
  // 7.1 froze when 8.0 opened for Reasonix.
  "agent.gui.listHarnesses@7.1": dump(listGuiHarnessesResponseSchemaV71),
  // The head line, pinned for the same reason `providers.list@8.0` is: growth
  // of the live row now has nothing else to fail against.
  "agent.gui.listHarnesses@8.0": dump(listGuiHarnessesResponseSchema),
  "agent.list@1.0": dump(listAgentsResponseSchemaV10),
  "agent.list@2.0": dump(listAgentsResponseSchemaV20),
  "agent.list@3.0": dump(listAgentsResponseSchemaV30),
  "agent.list@4.0": dump(listAgentsResponseSchemaV40),
  "agent.list@5.0": dump(listAgentsResponseSchemaV50),
  "agent.list@6.0": dump(listAgentsResponseSchemaV60),
  // v7.0 froze when the v1.2.0 tags shipped it; until then it pointed at the live canonical schema, the same defect that let `omp` ride v5.0 and `huggingface` v6.0.
  "agent.list@7.0": dump(listAgentsResponseSchemaV70),
  // The head line, pinned so the NEXT attempt to grow the live shape goes red
  // here rather than on the release that ships it.
  "agent.list@8.0": dump(listAgentsResponseSchema),
  "providers.list@1.0": dump(providersListResponseSchemaV10),
  "providers.list@2.0": dump(providersListResponseSchemaV20),
  // Frozen with Amp, before `profiles` (the v4.0 cut) - pinned now that this line is released, so a future `.extend()` onto the live shape leaking back into this frozen export goes red locally (see the providers.list
  "providers.list@3.0": dump(providersListResponseSchemaV30),
  "providers.list@4.0": dump(providersListResponseSchemaV40),
  "providers.list@5.0": dump(providersListResponseSchemaV50),
  "providers.list@6.0": dump(providersListResponseSchemaV60),
  // v7.0 is pinned before ship. When this snapshot goes red, hand-freeze the sub-schema that grew; do not regenerate to green.
  "providers.list@7.0": dump(providersListResponseSchemaV70),
  // The head line.
  // Same response then applies - freeze the line that stopped being head, open the next one.
  "providers.list@8.0": dump(providersListResponseSchema),
  // The REQUEST lines carry their own freeze history (`native` grew the already-shipped v4.0/v5.0/v6.0 requests before `host-v1.1.10` re-pinned them), and nothing pinned them locally until now - the tag-based gate was the.
  // The lesson generalizes - "the three id-carrying methods" was never the real boundary; grep RESPONSES for id enums.
  "epic.getChatRunSettings@1.0": dump(getChatRunSettingsResponseSchemaV10),
  "epic.getChatRunSettings@2.0": dump(getChatRunSettingsResponseSchema),
  "providers.list@1.0..6.0 request": dump(providersListRequestSchemaBeforeV70),
  // `providers.list@7.0` - This row DOES get regenerated when a provider id is added, and it is the one row here where that is the right answer rather than the forbidden one.
  // The response rows are the opposite and must never be regenerated to green - see `providers.list@7.0` above, and `providerManagedVersionsSchemaV70` for the sub-schema freeze that kept it byte-identical when Reasonix.
  "providers.list@7.0 request": dump(providersListRequestSchema),
};

const HEADER =
  "// AUTO-GENERATED by protocol/scripts/compat/snapshot-frozen-catalog-lines.ts - do not edit by hand.\n" +
  "// Frozen catalog response schemas for the three id-carrying methods. The\n" +
  "// companion test fails if a frozen export drifts from this snapshot.\n";

process.stdout.write(
  `${HEADER}export const FROZEN_CATALOG_LINE_SNAPSHOTS = ${JSON.stringify(
    { formatVersion: 1, fixtures: FIXTURES },
    null,
    2,
  )} as const;\n`,
);
