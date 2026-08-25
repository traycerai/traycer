/**
 * Snapshot frozen response schemas for every method whose response embeds a
 * growing harness/provider id enum - the three canonical id-carrying catalog
 * methods, plus `epic.getChatRunSettings` (see its rows below for why "three"
 * was never the real boundary) - plus the frozen `providers.list` REQUEST lines
 * (that method is the one whose request shape has its own freeze history - see
 * the `native` rows below).
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
  providersListResponseSchemaV71,
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
  // v7.0 froze when v7.1 opened for the auth-aware enablement row fields. Up
  // to that point the 2.1-6.0 rows above were `guiHarnessOptionSchema.extend({
  // id })` - a pinned id over the LIVE body - so these dumps were only ever
  // half-frozen. They now share the hand-frozen `guiHarnessOptionBaseShapeV70`
  // and are byte-identical to what they were, which is why the freeze added
  // rows here without changing any existing one.
  "agent.gui.listHarnesses@7.0": dump(listGuiHarnessesResponseSchemaV70),
  // 7.1 froze when 8.0 opened for Reasonix. It could not simply absorb the id:
  // 7.0 is released, and `versioned-rpc.ts` refuses a minor whose response
  // grows an enum over its predecessor - so no minor of major 7 can carry an id
  // 7.0 lacks, released or not. Its dump is unchanged by that freeze.
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
  // v7.0 froze when the v1.2.0 tags shipped it; until then it pointed at the
  // live canonical schema, the same defect that let `omp` ride v5.0 and
  // `huggingface` v6.0. `agent.list` had no row for its head line at all before
  // this, which is why nothing local caught it - only the tag-based gate could.
  "agent.list@7.0": dump(listAgentsResponseSchemaV70),
  // The head line, pinned so the NEXT attempt to grow the live shape goes red
  // here rather than on the release that ships it.
  "agent.list@8.0": dump(listAgentsResponseSchema),
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
  // one only ever locked in drift that had already happened. v7.0 is the HEAD
  // line, so this row is the one that gets to prevent the leak instead of
  // recording it, and it is what mechanizes "freeze line N before N ships".
  //
  // THAT PREVENTION WORKED, and this row now dumps the FROZEN v7.0 schema
  // rather than the live one. When the auth-aware enablement fields
  // (`enablementMode`/`enablementSource`) were added to
  // `providerCliStateBaseShape`, this row went red exactly as designed; the
  // response was to hand-freeze v7.0 under the reserved `V70` names and open
  // v7.1 against live, NOT to regenerate this row. Its dump is unchanged.
  //
  // A MINOR, not the v8.0 this text used to prescribe: `versioned-rpc.ts`
  // rejects a major bump that is not a breaking change, and two optional
  // fields are not one. v8.0 remains right for the growth this text had in
  // mind (new ids/enum values on a host->client catalog payload).
  //
  // The dump is DEEP - it walks `providerProfileSchema`,
  // `providerNativeCapabilitiesSchema`, `nativeListResultSchema` and every
  // other sub-schema this line reaches, all of which `providerCliStateSchemaV70`
  // deliberately still references live - so growth ANYWHERE beneath it fails
  // this snapshot. When that happens, hand-freeze the sub-schema that grew (the
  // `*V70Preimage` shapes are the precedent); do not regenerate to green.
  "providers.list@7.0": dump(providersListResponseSchemaV70),
  // That response applied again, one line later: 7.1 dumped the live schema
  // until Reasonix, then froze under `providersListResponseSchemaV71` and 8.0
  // opened against live. Note 7.1 froze even though no tag has shipped it - a
  // released 7.0 forbids any minor of major 7 from growing the enum, so the
  // "wait for the release" reading does not apply to a MINOR. Its dump is
  // unchanged by the freeze.
  "providers.list@7.1": dump(providersListResponseSchemaV71),
  // The head line. It inherits 7.1's old job here: it dumps the LIVE schema,
  // so the FIRST attempt to grow the live shape goes red on this row rather
  // than on the release that ships the growth. Same response then applies -
  // freeze the line that stopped being head, open the next one.
  "providers.list@8.0": dump(providersListResponseSchema),
  // The REQUEST lines carry their own freeze history (`native` grew the
  // already-shipped v4.0/v5.0/v6.0 requests before `host-v1.1.10` re-pinned
  // them), and nothing pinned them locally until now - the tag-based gate was
  // the only thing that could see it. Two rows cover every line: v1.0..v6.0 all
  // share `providersListRequestSchemaBeforeV70`, and v7.0 has its own.
  // A FOURTH method, added when Reasonix found it the hard way. Its response
  // embeds the PERSISTED `guiHarnessIdSchema` - a second copy of the harness
  // enum, on a method whose name suggests no catalog at all - and it is
  // `degrade: unsupported`, so it sits outside `RELEASED_FLOOR` and every local
  // test stayed green while it silently absorbed `reasonix`. Only the tag-based
  // `protocol-compat` gate caught it.
  //
  // These two rows are what make that class fail locally from now on: 1.0 is
  // the frozen released line, 2.0 dumps LIVE so the next growth attempt goes
  // red here first. The lesson generalizes - "the three id-carrying methods" was
  // never the real boundary; grep RESPONSES for id enums.
  "epic.getChatRunSettings@1.0": dump(getChatRunSettingsResponseSchemaV10),
  "epic.getChatRunSettings@2.0": dump(getChatRunSettingsResponseSchema),
  "providers.list@1.0..6.0 request": dump(providersListRequestSchemaBeforeV70),
  // This row DOES get regenerated when a provider id is added, and it is the
  // one row here where that is the right answer rather than the forbidden one.
  // It dumps the LIVE request (which v7.0 and v8.0 both bind), and the growth
  // reaches it through `nativeListQuerySchema.providerId`. A request is a
  // client->host slot: `surface-compat.ts` scores enum growth there ADVISORY,
  // because a released client never emits the new value and a new client
  // sending it to an old host fails per-call with a clear upgrade path. The
  // row exists to make that growth VISIBLE, not to forbid it.
  //
  // The response rows are the opposite and must never be regenerated to green
  // - see `providers.list@7.0` above, and `providerManagedVersionsSchemaV70`
  // for the sub-schema freeze that kept it byte-identical when Reasonix landed.
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
