import type { QuickVerbId } from "@/components/layout-editor/regions/region-grammar";
import type { RegionId } from "@/lib/layout/region-id";

/** What the right-click menu on a customizable element says (L-19). */

/**
 * The one verb a region's menu offers right now, beside "Customize layout...".
 *
 * One, not the registry's whole list: the menu is a shortcut for the obvious
 * move and the editor is where the rest live. A hidden region can only be
 * shown; a shown one is hidden where it can be, else offered its other size.
 * Every verb here changes a value and is reversed by the toast; a move is a
 * drag on the canvas, so the menu reaches it through "Customize layout...",
 * which opens the editor on this very region (L-19, L-72).
 */
export function offeredQuickVerbs(
  verbs: ReadonlyArray<QuickVerbId>,
  state: { readonly hidden: boolean; readonly chip: boolean },
): ReadonlyArray<QuickVerbId> {
  const candidates: ReadonlyArray<QuickVerbId> = state.hidden
    ? ["show"]
    : ["hide", state.chip ? "full" : "chip"];
  const verb = candidates.find((candidate) => verbs.includes(candidate));
  return verb === undefined ? [] : [verb];
}

/**
 * What the context menu calls a verb, with the region named where it reads
 * better. Access's size is "Icon only / Icon and label", the words its form
 * control uses; "chip" is only a dock member's word (C11).
 */
export function quickVerbLabel(
  verb: QuickVerbId,
  regionId: RegionId,
  regionName: string,
): string {
  switch (verb) {
    case "hide":
      return `Hide ${regionName}`;
    case "show":
      return `Show ${regionName}`;
    case "chip":
      if (disclosureRegion(regionId)) return `Close ${regionName}`;
      return regionId === "access" ? "Show icon only" : "Show as chip";
    case "full":
      if (disclosureRegion(regionId)) return `Open ${regionName}`;
      return regionId === "access" ? "Show icon and label" : "Show as full row";
  }
}

/** The two transcript regions whose sizes are Open and Closed. */
function disclosureRegion(regionId: RegionId): boolean {
  return regionId === "toolActivity" || regionId === "thinking";
}

/** What the toast says afterwards, which undoes the verb. */
export function quickVerbToast(
  verb: QuickVerbId,
  regionId: RegionId,
  regionName: string,
): string {
  switch (verb) {
    case "hide":
      return `${regionName} hidden`;
    case "show":
      return `${regionName} shown`;
    case "chip":
      if (disclosureRegion(regionId)) return `${regionName} closed`;
      return regionId === "access"
        ? `${regionName} shows its icon only`
        : `${regionName} is a chip`;
    case "full":
      if (disclosureRegion(regionId)) return `${regionName} open`;
      return regionId === "access"
        ? `${regionName} shows its icon and label`
        : `${regionName} is a full row`;
  }
}
