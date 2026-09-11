import { expect } from "vitest";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import { SETTINGS_SEARCH_ENTRIES } from "@/lib/settings-search/settings-search-entries";
import type { SettingsSectionId } from "@/lib/settings-sections";

/**
 * The DOM half of the search index's contract, for one mounted panel.
 *
 * Every anchored entry for `section` must resolve to exactly as many elements
 * as its own `availableWhen(context)` promises: ONE when available — a result
 * that lands must light exactly one thing, never zero and never an ambiguous
 * two — and ZERO when not. The zero half is what catches a row wrongly left
 * `alwaysAvailable` while its panel gates it, which is the drift that shipped
 * dead results; a suite that only ever mounts a fully bridged shell can never
 * see it.
 *
 * `context` must describe the shell the panel was actually mounted in. The
 * failure lists every mismatching anchor at once, so one run shows the whole
 * drift rather than the first row of it.
 */
export function assertSettingsSearchTargets(
  section: SettingsSectionId,
  context: SettingsAvailabilityContext,
  container: HTMLElement,
): void {
  const anchored = SETTINGS_SEARCH_ENTRIES.flatMap((entry) =>
    entry.section === section && entry.anchor !== null
      ? [{ anchor: entry.anchor, expected: entry.availableWhen(context) }]
      : [],
  );
  // A section with no anchored entries would pass vacuously, which reads as
  // coverage it is not.
  expect(anchored.length, `no anchored entries for ${section}`).toBeGreaterThan(
    0,
  );
  const mismatches = anchored.flatMap(({ anchor, expected }) => {
    const found = container.querySelectorAll(
      `[data-settings-anchor="${anchor}"]`,
    ).length;
    const want = expected ? 1 : 0;
    return found === want
      ? []
      : [`${anchor}: expected ${want} target(s), found ${found}`];
  });
  expect(mismatches).toEqual([]);
}
