/**
 * Ticket 21 slice 3: dedicated physical DOM identity for hosted tile
 * surface records, per design-review finding 4.
 *
 * Portal events follow the React tree, not the physical pane tree, so a
 * hosted record needs its own attributes rather than reusing
 * `[data-group-id]` - that attribute is the pane-geometry authority
 * (`lib/keybindings/tile-geometry.ts`), and duplicating it on a transformed
 * record would create a second, conflicting geometry source for spatial
 * keyboard navigation. Do not add `data-group-id` here.
 *
 * Wiring these attributes into the four broken lookup paths (chat keyboard
 * ownership, command-to-composer, route focus, deferred pane-activation
 * containment) is slice 4's "host-aware activation/focus resolution" per
 * the design's own slice table - this module and `hosted-tile-resolver.ts`
 * are the infrastructure slice 4 wires in, not the wiring itself.
 */
export const HOSTED_TILE_INSTANCE_ID_ATTRIBUTE = "data-hosted-tile-instance-id";
export const HOSTED_TILE_PANE_ID_ATTRIBUTE = "data-hosted-canvas-pane-id";
export const HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE = "data-hosted-view-tab-id";

export const HOSTED_TILE_RECORD_SELECTOR = `[${HOSTED_TILE_INSTANCE_ID_ATTRIBUTE}]`;

export interface HostedTileOwnership {
  readonly instanceId: string;
  readonly paneId: string;
  /** The owning top-level (`"epic"` kind) tab id. */
  readonly viewTabId: string;
}
