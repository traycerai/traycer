/**
 * `OFFICE_VIEW_IDS` used to be DERIVED - `Object.keys(OFFICE_VIEWS).filter(isOfficeViewId)`
 * - specifically so that registering a view was one edit (the union and the
 * registry) and enrolling it in every shared `describe.each` was none. Moving
 * the array to `office-view-vocabulary.ts`, a leaf module the registry no
 * longer derives it from, made it WRITTEN DOWN instead - and a written-down
 * array can miss an id, duplicate one, or list them in the wrong order with
 * nothing catching it: `OFFICE_VIEWS` only guarantees every id in the union
 * has an entry, never that the array names every entry once each, in the
 * registry's own order.
 *
 * This is the property the derivation gave away for free, restored as a case:
 * an id added to the union and registered in `OFFICE_VIEWS` but forgotten in
 * the array fails here instead of silently sitting out the picker and every
 * suite that walks the array rather than the registry.
 */
import { describe, expect, it } from "vitest";
import {
  OFFICE_VIEW_CHOICES,
  OFFICE_VIEW_IDS,
} from "@/lib/comm-graph/office/office-view-vocabulary";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";

describe("OFFICE_VIEW_IDS vs the registry", () => {
  it("names every registered view exactly once, in the registry's own order", () => {
    // `toEqual` on the arrays, not a set comparison - ORDER is pinned too,
    // because it is what the picker lists in and what every shared
    // `describe.each` enumerates.
    expect(OFFICE_VIEW_IDS).toEqual(Object.keys(OFFICE_VIEWS));
  });

  it("lists Auto first, then every view in that same order", () => {
    expect(OFFICE_VIEW_CHOICES).toEqual(["auto", ...OFFICE_VIEW_IDS]);
  });
});
