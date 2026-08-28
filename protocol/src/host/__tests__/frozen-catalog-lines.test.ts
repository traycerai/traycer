import { describe, expect, it } from "vitest";
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
} from "@traycer/protocol/host/agent/shared";
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
} from "@traycer/protocol/host/agent/gui/unary-schemas";
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
} from "@traycer/protocol/host/provider-schemas";
import {
  getChatRunSettingsResponseSchema,
  getChatRunSettingsResponseSchemaV10,
} from "@traycer/protocol/host/epic/chat-records";
import { FROZEN_CATALOG_LINE_SNAPSHOTS } from "./__fixtures__/frozen-catalog-lines";

/**
 * Defense-in-depth for the freeze discipline: frozen catalog response schemas
 * must not silently grow new harness/provider ids. The protocol-compat gate
 * catches released-line growth across tags; this test catches local drift of
 * the frozen zod exports in plain `bun run test` without tags.
 *
 * When intentionally freezing a new line (e.g. V30 before opening v4.0), add
 * the export here and regenerate:
 *   bun run protocol/scripts/compat/snapshot-frozen-catalog-lines.ts > \
 *     protocol/src/host/__tests__/__fixtures__/frozen-catalog-lines.ts
 */

function dump(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { unrepresentable: "any" });
}

const LIVE_FROZEN_EXPORTS = {
  "agent.gui.listHarnesses@1.0": listGuiHarnessesResponseSchemaV10,
  "agent.gui.listHarnesses@2.0": listGuiHarnessesResponseSchemaV20,
  "agent.gui.listHarnesses@2.1": listGuiHarnessesResponseSchemaV21,
  "agent.gui.listHarnesses@3.0": listGuiHarnessesResponseSchemaV30,
  "agent.gui.listHarnesses@4.0": listGuiHarnessesResponseSchemaV40,
  "agent.gui.listHarnesses@5.0": listGuiHarnessesResponseSchemaV50,
  "agent.gui.listHarnesses@6.0": listGuiHarnessesResponseSchemaV60,
  // v7.0 froze when v7.1 opened for the auth-aware enablement row fields.
  // Until then the 2.1-6.0 rows above pinned only the id over a LIVE body, so
  // they were half-frozen; they now share the hand-frozen
  // `guiHarnessOptionBaseShapeV70` and dump exactly as they did before.
  "agent.gui.listHarnesses@7.0": listGuiHarnessesResponseSchemaV70,
  // 7.1 froze when 8.0 opened for Reasonix - a released 7.0 forbids ANY minor
  // of major 7 from growing the id enum (`versioned-rpc.ts` refuses it), so
  // 7.1 could not absorb the id even though no tag has shipped 7.1 itself.
  "agent.gui.listHarnesses@7.1": listGuiHarnessesResponseSchemaV71,
  // The head line, pinned for the same reason `providers.list@8.0` is.
  "agent.gui.listHarnesses@8.0": listGuiHarnessesResponseSchema,
  "agent.list@1.0": listAgentsResponseSchemaV10,
  "agent.list@2.0": listAgentsResponseSchemaV20,
  "agent.list@3.0": listAgentsResponseSchemaV30,
  "agent.list@4.0": listAgentsResponseSchemaV40,
  "agent.list@5.0": listAgentsResponseSchemaV50,
  "agent.list@6.0": listAgentsResponseSchemaV60,
  // v7.0 froze when the v1.2.0 tags shipped it. Until then it pointed at the
  // live schema and `agent.list` had NO head-line row here at all, so nothing
  // local could have caught the growth - only the tag-based gate.
  "agent.list@7.0": listAgentsResponseSchemaV70,
  // The head line, pinned so the next growth attempt fails here first.
  "agent.list@8.0": listAgentsResponseSchema,
  "providers.list@1.0": providersListResponseSchemaV10,
  "providers.list@2.0": providersListResponseSchemaV20,
  "providers.list@3.0": providersListResponseSchemaV30,
  "providers.list@4.0": providersListResponseSchemaV40,
  "providers.list@5.0": providersListResponseSchemaV50,
  "providers.list@6.0": providersListResponseSchemaV60,
  // v7.0 was pinned here while it was still the head line, so that growth of
  // the live shape would fail on its FIRST attempt rather than on the release
  // that shipped it. That is what happened: the auth-aware enablement fields
  // turned this row red, v7.0 was hand-frozen under the reserved `V70` names,
  // and a 7.1 opened against live. This row was NOT regenerated - it names the
  // frozen schema now and its dump is unchanged. It stayed unchanged when
  // those same two fields were later REMOVED and took 7.1 with them: a freeze
  // records what a line served, so undoing the growth that triggered it does
  // not un-freeze it.
  "providers.list@7.0": providersListResponseSchemaV70,
  // The head line now, holding v7.0's old job: it names the LIVE schema, so
  // the next attempt to grow it fails here first. Same response - freeze the
  // line that stopped being head, open the next one, do not regenerate.
  //
  // There is no `providers.list@7.1` row because there is no such line: the
  // enablement pair was its entire delta over 7.0 and both were removed. This
  // list and the snapshot's key set are held equal below, so deleting a row
  // here without deleting the fixture (or the reverse) fails rather than
  // silently narrowing what is guarded.
  "providers.list@8.0": providersListResponseSchema,
  // The fourth method (see the snapshot script for why it is here): its
  // response carries the PERSISTED harness enum, it is off the released floor,
  // and nothing local guarded it until Reasonix grew it and only the tag gate
  // noticed.
  "epic.getChatRunSettings@1.0": getChatRunSettingsResponseSchemaV10,
  "epic.getChatRunSettings@2.0": getChatRunSettingsResponseSchema,
  "providers.list@1.0..6.0 request": providersListRequestSchemaBeforeV70,
  "providers.list@7.0 request": providersListRequestSchema,
} as const;

describe("frozen catalog line snapshots", () => {
  it("covers every live frozen export", () => {
    expect(Object.keys(LIVE_FROZEN_EXPORTS).sort()).toEqual(
      Object.keys(FROZEN_CATALOG_LINE_SNAPSHOTS.fixtures).sort(),
    );
  });

  Object.entries(LIVE_FROZEN_EXPORTS).forEach(([key, schema]) => {
    it(`${key} still serializes byte-identically to the committed snapshot`, () => {
      const current = dump(schema);
      const expected =
        FROZEN_CATALOG_LINE_SNAPSHOTS.fixtures[
          key as keyof typeof FROZEN_CATALOG_LINE_SNAPSHOTS.fixtures
        ];
      expect(current).toEqual(expected);
    });
  });
});
