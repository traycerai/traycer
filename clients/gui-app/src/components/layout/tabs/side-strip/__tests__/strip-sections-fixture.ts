import {
  groupEntriesBySection,
  type StripSection,
  type StripSectionGroup,
} from "../strip-sections";

export function sectionsOf(
  rows: ReadonlyArray<readonly [string, StripSection]>,
): ReadonlyArray<StripSectionGroup> {
  return groupEntriesBySection(
    rows.map(([itemId, section], stripIndex) => ({
      kind: "tabs",
      itemId,
      stripIndex,
      section,
      group: null,
      members: [],
    })),
  );
}
