import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  listAgentsResponseSchemaV10,
  listAgentsResponseSchemaV20,
} from "@traycer/protocol/host/agent/shared";
import {
  listGuiHarnessesResponseSchemaV10,
  listGuiHarnessesResponseSchemaV20,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  providersListResponseSchemaV10,
  providersListResponseSchemaV20,
  providersListResponseSchemaV30,
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
  "agent.list@1.0": listAgentsResponseSchemaV10,
  "agent.list@2.0": listAgentsResponseSchemaV20,
  "providers.list@1.0": providersListResponseSchemaV10,
  "providers.list@2.0": providersListResponseSchemaV20,
  "providers.list@3.0": providersListResponseSchemaV30,
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
