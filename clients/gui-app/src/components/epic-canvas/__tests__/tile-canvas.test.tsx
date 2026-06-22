import { describe, it } from "vitest";

// TODO(canvas-tab-groups): rewrite the tile-canvas integration tests against
// the new TabGroupView. The previous suite asserted on the legacy
// `TileLeafView` (drop-overlay positions, header dropdown, single-node
// rendering). The new covers should target `tab-group-view.tsx` +
// `tab-strip.tsx` and verify: tab strip drop-zones, body edge splits,
// preview-mode promotion, top-accent on the globally-active tab,
// far-right split button, and shadcn ContextMenu close/split items.
describe.skip("tile canvas (legacy suite)", () => {
  it.skip("placeholder", () => {});
});
