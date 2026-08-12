/**
 * Snapshot frozen catalog response schemas for the three id-carrying methods,
 * plus the frozen `providers.list` REQUEST lines (that method is the one whose
 * request shape has its own freeze history - see the `native` rows below).
 *
 *   bun run protocol/scripts/compat/snapshot-frozen-catalog-lines.ts > \
 *     protocol/src/host/__tests__/__fixtures__/frozen-catalog-lines.ts
 *
 * The companion test fails if a frozen export drifts from this snapshot.
 * When a new frozen line lands (e.g. V30 with Amp), add it here and re-run.
 */
import { z } from "zod";
import {
  listAgentsResponseSchemaV10,
  listAgentsResponseSchemaV20,
  listAgentsResponseSchemaV30,
  listAgentsResponseSchemaV40,
  listAgentsResponseSchemaV50,
  listAgentsResponseSchemaV60,
} from "../../src/host/agent/shared";
import {
  listGuiHarnessesResponseSchemaV10,
  listGuiHarnessesResponseSchemaV20,
  listGuiHarnessesResponseSchemaV21,
  listGuiHarnessesResponseSchemaV30,
  listGuiHarnessesResponseSchemaV40,
  listGuiHarnessesResponseSchemaV50,
  listGuiHarnessesResponseSchemaV60,
} from "../../src/host/agent/gui/unary-schemas";
import {
  providersListRequestSchemaBeforeV70,
  providersListRequestSchemaV70,
  providersListResponseSchemaV10,
  providersListResponseSchemaV20,
  providersListResponseSchemaV30,
  providersListResponseSchemaV40,
  providersListResponseSchemaV50,
  providersListResponseSchemaV60,
  providersListResponseSchemaV70,
} from "../../src/host/provider-schemas";

function dump(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { unrepresentable: "any" });
}

// Every released line of the three id-carrying catalog methods. The v5.0 row
// of each is why this list is now exhaustive: those lines pointed at the LIVE
// canonical schema until `cli-v1.1.8`/`host-v1.1.8` shipped them, so `omp`
// silently rode a released contract and only the tag-based gate caught it.
// Pinning every frozen line makes that same class of drift fail in plain
// `bun run test`, with no tags to resolve.
const FIXTURES = {
  "agent.gui.listHarnesses@1.0": dump(listGuiHarnessesResponseSchemaV10),
  "agent.gui.listHarnesses@2.0": dump(listGuiHarnessesResponseSchemaV20),
  "agent.gui.listHarnesses@2.1": dump(listGuiHarnessesResponseSchemaV21),
  "agent.gui.listHarnesses@3.0": dump(listGuiHarnessesResponseSchemaV30),
  "agent.gui.listHarnesses@4.0": dump(listGuiHarnessesResponseSchemaV40),
  "agent.gui.listHarnesses@5.0": dump(listGuiHarnessesResponseSchemaV50),
  "agent.gui.listHarnesses@6.0": dump(listGuiHarnessesResponseSchemaV60),
  "agent.list@1.0": dump(listAgentsResponseSchemaV10),
  "agent.list@2.0": dump(listAgentsResponseSchemaV20),
  "agent.list@3.0": dump(listAgentsResponseSchemaV30),
  "agent.list@4.0": dump(listAgentsResponseSchemaV40),
  "agent.list@5.0": dump(listAgentsResponseSchemaV50),
  "agent.list@6.0": dump(listAgentsResponseSchemaV60),
  "providers.list@1.0": dump(providersListResponseSchemaV10),
  "providers.list@2.0": dump(providersListResponseSchemaV20),
  // Frozen with Amp, before `profiles` (the v4.0 cut) - pinned now that this
  // line is released, so a future `.extend()` onto the live shape leaking
  // back into this frozen export goes red locally (see the providers.list
  // #258 incident this whole gate exists to catch).
  "providers.list@3.0": dump(providersListResponseSchemaV30),
  "providers.list@4.0": dump(providersListResponseSchemaV40),
  "providers.list@5.0": dump(providersListResponseSchemaV50),
  "providers.list@6.0": dump(providersListResponseSchemaV60),
  // Pinned BEFORE the line ships - the only row here that is. Every row above
  // it was added after a released tag caught a field already riding it, so each
  // one only ever locked in drift that had already happened. v7.0 is the head
  // line, and the next major's fields are already designed, so this row is the
  // one that gets to prevent the leak instead of recording it.
  //
  // This dump is DEEP: it walks `providerProfileSchema`,
  // `providerNativeCapabilitiesSchema`, `nativeListResultSchema` and every
  // other sub-schema the frozen v7.0 shape still references live. That is what
  // makes those live references safe - growth inside one of them fails this
  // snapshot rather than quietly changing what v7.0 serializes. When it fails,
  // hand-freeze the sub-schema that grew; do not regenerate to green.
  "providers.list@7.0": dump(providersListResponseSchemaV70),
  // The REQUEST lines carry their own freeze history (`native` grew the
  // already-shipped v4.0/v5.0/v6.0 requests before `host-v1.1.10` re-pinned
  // them), and nothing pinned them locally until now - the tag-based gate was
  // the only thing that could see it. Two rows cover every line: v1.0..v6.0 all
  // share `providersListRequestSchemaBeforeV70`, and v7.0 has its own.
  "providers.list@1.0..6.0 request": dump(providersListRequestSchemaBeforeV70),
  "providers.list@7.0 request": dump(providersListRequestSchemaV70),
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
