import { LAYOUT_REGION_LIST } from "@/components/layout-editor/regions/region-facts";
import { SURFACE_GROUPS } from "@/components/layout-editor/regions/region-grammar";
import type { RegionId } from "@/lib/layout/region-id";
import type { SettingsSearchEntry } from "@/lib/settings-search/settings-definitions";

/**
 * One settings-search result per layout region, generated from the registry.
 *
 * Generated rather than written out, because the registry already IS the one
 * description of a region's name, the surface it lives on and the words a
 * reader reaches for - a second copy in a `*.definitions.ts` collection could
 * only drift from it, and a region added without one would be unfindable.
 *
 * Every entry has `anchor: null` and carries the region in `launch`. It is not
 * an anchor result: there is no per-region element on the page to scroll to,
 * and `launch` is what the result acts on - the editor, opened on that region.
 *
 * A region its shell gate leaves out of this shell is left out here too, by
 * that same declared gate (`shellGate`): the Microphone where dictation is
 * refused, the Minimap where its rail is never drawn.
 */
export const LAYOUT_LAUNCH_ENTRIES: ReadonlyArray<SettingsSearchEntry> =
  LAYOUT_REGION_LIST.map((region) => ({
    section: "layout",
    anchor: null,
    launch: region.id,
    kind: "setting",
    availableWhen: region.shellGate,
    label: region.name,
    description: region.where,
    group: surfaceLabel(region.surface),
    keywords: [...region.keywords],
  }));

/**
 * The one way to find a region's ROW on the full-width page.
 *
 * A region is a row of its surface card's list now (L-95), and every list row
 * already carries its own id - so the row a result or the width-gate redirect
 * has to land on is `[data-sortable-id="<regionId>"]`, which is stable because
 * the registry's ids are. The two readings of Usage and resources are sections
 * rather than list rows, and carry `data-region-section` instead. It is NOT a `data-settings-anchor`: those are the
 * search index's own tokens, one per indexed entry, and a region's result is a
 * LAUNCH entry that opens the editor rather than scrolling this page (see
 * `SETTINGS.md` § Launch results).
 *
 * Scoped by the caller to the panel it is looking inside, because the docked
 * inspector draws the same row ids for whichever region is selected and the
 * two can be on screen together in a split.
 */
export function layoutRegionRowSelector(regionId: RegionId): string {
  return `[data-sortable-id="${regionId}"], [data-region-section="${regionId}"]`;
}

function surfaceLabel(surface: string): string {
  return (
    SURFACE_GROUPS.find((group) => group.id === surface)?.label ?? "Layout"
  );
}
