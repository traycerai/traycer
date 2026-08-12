import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  listAgentsResponseSchemaV10,
  listAgentsResponseSchemaV20,
  listAgentsResponseSchemaV30,
  listAgentsResponseSchemaV40,
  listAgentsResponseSchemaV50,
  listAgentsResponseSchemaV60,
} from "@traycer/protocol/host/agent/shared";
import {
  listGuiHarnessesResponseSchemaV10,
  listGuiHarnessesResponseSchemaV20,
  listGuiHarnessesResponseSchemaV21,
  listGuiHarnessesResponseSchemaV30,
  listGuiHarnessesResponseSchemaV40,
  listGuiHarnessesResponseSchemaV50,
  listGuiHarnessesResponseSchemaV60,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
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
} from "@traycer/protocol/host/provider-schemas";
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
  "agent.list@1.0": listAgentsResponseSchemaV10,
  "agent.list@2.0": listAgentsResponseSchemaV20,
  "agent.list@3.0": listAgentsResponseSchemaV30,
  "agent.list@4.0": listAgentsResponseSchemaV40,
  "agent.list@5.0": listAgentsResponseSchemaV50,
  "agent.list@6.0": listAgentsResponseSchemaV60,
  "providers.list@1.0": providersListResponseSchemaV10,
  "providers.list@2.0": providersListResponseSchemaV20,
  "providers.list@3.0": providersListResponseSchemaV30,
  "providers.list@4.0": providersListResponseSchemaV40,
  "providers.list@5.0": providersListResponseSchemaV50,
  "providers.list@6.0": providersListResponseSchemaV60,
  // v7.0 is pinned here while it is still the head line, so this row fails on
  // the FIRST attempt to grow the live shape rather than on the release that
  // ships the growth. The dump is deep, which is what covers the sub-schemas
  // `providerCliStateBaseShapeV70` still references live - see the freeze
  // comment on that shape for the list and for what to do when this goes red.
  "providers.list@7.0": providersListResponseSchemaV70,
  "providers.list@1.0..6.0 request": providersListRequestSchemaBeforeV70,
  "providers.list@7.0 request": providersListRequestSchemaV70,
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
