/**
 * WHICH OFFICES EXIST, and what a person can choose - the names alone, with no
 * way to draw any of them.
 *
 * A LEAF ON PURPOSE: this module imports nothing, and nothing that imports it
 * pays for a renderer. The registry in `views/office-view.ts` pulls in every
 * planner, measurer and painter for all six views, so a module that only needs
 * to know the NAMES - the settings store validating a persisted default, the
 * tile schema parsing a saved choice, a `Select` listing its options - used to
 * evaluate that whole graph to read one array of strings.
 *
 * The registry imports the ids from here rather than deriving them from its own
 * keys, which inverts the dependency but not the guarantee: `OFFICE_VIEWS` is
 * typed `Record<OfficeViewId, OfficeView>`, so a view in this union with no
 * entry there does not compile, and `office-view-registry-vocabulary.test.ts`
 * pins the ARRAY against those keys in order - the ordering the picker lists in
 * and every shared `describe.each` enumerates. Registering a view is still one
 * edit to the union, one to the registry, and none to the tests.
 */

/**
 * Which office a layout is a layout OF. The union is the set of views that
 * SHIP: a view is named here and registered in `views/office-view.ts`
 * together, so the picker, the persisted choice and the shared suites all
 * follow one list and a half-registered view cannot exist.
 */
export type OfficeViewId =
  | "floor"
  | "towers"
  | "building"
  | "mission-control"
  | "campus"
  | "city";

/**
 * The registry's order, which is the order the picker lists and every shared
 * suite enumerates.
 */
export const OFFICE_VIEW_IDS: ReadonlyArray<OfficeViewId> = [
  "floor",
  "towers",
  "building",
  "mission-control",
  "campus",
  "city",
];

/**
 * What a tile's view setting can be: a view, or `"auto"` - which is a choice
 * about how to choose, not a seventh office.
 */
export type OfficeViewChoice = "auto" | OfficeViewId;

/**
 * Auto first, then every view in registry order - what a control offering the
 * choice lists, and the same order the tile's own picker uses because both
 * read this rather than a second list that would drift from it.
 */
export const OFFICE_VIEW_CHOICES: ReadonlyArray<OfficeViewChoice> = [
  "auto",
  ...OFFICE_VIEW_IDS,
];

/**
 * ONE guard, because there is one vocabulary.
 *
 * Both controls that offer the choice - the tile's picker and the Appearance
 * default - take a `string` back from their primitive and have to narrow it.
 * They used to do it separately, which is a way for two controls to disagree
 * about what a view is the moment a name is added or the sentinel changes.
 */
export function isOfficeViewChoice(value: string): value is OfficeViewChoice {
  return OFFICE_VIEW_CHOICES.some((choice) => choice === value);
}
