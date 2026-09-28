import { describe, expect, it } from "vitest";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import {
  regionRowAvailable,
  type AnyGrammarRow,
} from "@/components/layout-editor/regions/region-facts";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * `regionRowAvailable` is the one gate both hosts route through for what a
 * narrow (mobile-viewport-width) page can honor: `RegionSection`'s dock rows
 * and `SurfaceSection`'s detail-row disclosure both call it directly, and
 * `order-group-list.tsx`'s own narrow arrays exist for the SAME reason one
 * layer down (a toolbar cluster fixed to its two device-local members).
 * Real registry rows, not hand-built fixtures: the point is that THESE rows,
 * as the app actually declares them, are the ones the gate names.
 */

function rowOf(regionId: RegionId, kind: string): AnyGrammarRow {
  const row = LAYOUT_REGIONS[regionId].rows.find(
    (entry) => entry.kind === kind,
  );
  if (row === undefined) throw new Error(`no such row: ${regionId}/${kind}`);
  return row;
}

/** Model has two `style`-kind rows (Style, Reasoning control) - by `key`. */
function styleRowOf(regionId: RegionId, key: string): AnyGrammarRow {
  const row = LAYOUT_REGIONS[regionId].rows.find(
    (entry) => entry.kind === "style" && entry.key === key,
  );
  if (row === undefined)
    throw new Error(`no such row: ${regionId}/style/${key}`);
  return row;
}

describe("regionRowAvailable", () => {
  it("keeps every row when the viewport is not narrow", () => {
    expect(
      regionRowAvailable(
        "usageLimits",
        rowOf("usageLimits", "position-host"),
        false,
      ),
    ).toBe(true);
    expect(regionRowAvailable("model", rowOf("model", "style"), false)).toBe(
      true,
    );
    expect(
      regionRowAvailable(
        "attachImage",
        rowOf("attachImage", "position-order"),
        false,
      ),
    ).toBe(true);
  });

  it("drops every region's Position-host row narrow - which bar it lives in is not device-local", () => {
    expect(
      regionRowAvailable(
        "usageLimits",
        rowOf("usageLimits", "position-host"),
        true,
      ),
    ).toBe(false);
  });

  it("drops the toolbar clusters' own reorder narrow, but leaves the dock's alone", () => {
    expect(
      regionRowAvailable(
        "attachImage",
        rowOf("attachImage", "position-order"),
        true,
      ),
    ).toBe(false);
    expect(
      regionRowAvailable("model", rowOf("model", "position-order"), true),
    ).toBe(false);
    // A different position-order GROUP (the dock) is a different row kind's
    // group entirely - only the two toolbar clusters lose their reorder.
    expect(
      regionRowAvailable(
        "runningAgents",
        rowOf("runningAgents", "position-order"),
        true,
      ),
    ).toBe(true);
  });

  it("drops Model's own style row narrow, but leaves another region's style alone", () => {
    expect(regionRowAvailable("model", rowOf("model", "style"), true)).toBe(
      false,
    );
    expect(
      regionRowAvailable("contextUsage", rowOf("contextUsage", "style"), true),
    ).toBe(true);
  });

  it("keeps Model's Reasoning control row narrow - the compact toolbar's chip has no style choice, but its footer draws the same picker", () => {
    expect(
      regionRowAvailable(
        "model",
        styleRowOf("model", "reasoningControl"),
        true,
      ),
    ).toBe(true);
    // Contrast with the row the gate DOES drop, keyed by "style".
    expect(
      regionRowAvailable("model", styleRowOf("model", "style"), true),
    ).toBe(false);
  });
});
