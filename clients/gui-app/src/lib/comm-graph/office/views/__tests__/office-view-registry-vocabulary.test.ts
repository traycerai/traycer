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
  OFFICE_VIEW_LABELS,
} from "@/lib/comm-graph/office/office-view-vocabulary";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";

describe("OFFICE_VIEW_IDS vs the registry", () => {
  it("names every registered view exactly once, in the registry's own order", () => {
    // `toEqual` on the arrays, not a set comparison - ORDER is pinned too,
    // because it is what the picker lists in and what every shared
    // `describe.each` enumerates.
    expect(OFFICE_VIEW_IDS).toEqual(Object.keys(OFFICE_VIEWS));
  });

  it("offers exactly the four supported choices, Auto and the retired views excluded", () => {
    // The renderer registry retains legacy layouts; the picker offers only
    // these four choices. Keep this expectation independent of the registry.
    expect(OFFICE_VIEW_CHOICES).toEqual([
      "floor",
      "building",
      "mission-control",
      "campus",
    ]);
  });
});

/**
 * `OFFICE_VIEW_LABELS` is a second copy of each view's display name, kept in
 * the leaf vocabulary module so Appearance Settings can read the words
 * without evaluating the registry and every planner, measurer and painter it
 * pulls in. A second copy is a drift risk on its own - this is the case that
 * removes it: a label edited on one side and not the other fails here rather
 * than only showing up as Settings and the office disagreeing on what to call
 * a view.
 */
describe("OFFICE_VIEW_LABELS vs the registry", () => {
  it("matches the registry's own label for every view", () => {
    for (const id of OFFICE_VIEW_IDS) {
      expect(OFFICE_VIEW_LABELS[id]).toBe(OFFICE_VIEWS[id].label);
    }
  });
});
