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
 * two — and ZERO when not. The zero half is what catches a definition wrongly
 * left `alwaysAvailable` while its panel gates it; a suite that only ever
 * mounts a fully bridged shell can never see it. A target inside a `[hidden]`
 * ancestor counts as missing: it exists, but nothing can be revealed there.
 *
 * The other direction is membership: every anchor the panel renders must be an
 * anchored entry of THIS section. A definition from another section's
 * collection rendered here would otherwise send its results to the wrong page.
 * It sees anchors only — a foreign definition with no anchor renders nothing
 * this can find.
 *
 * `context` must describe the shell the panel was actually mounted in. The
 * failure lists every mismatching anchor at once, so one run shows the whole
 * drift rather than the first row of it. jsdom does no layout, so "visible"
 * here means present and not under `[hidden]` — never CSS visibility.
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
    const targets = [
      ...container.querySelectorAll(`[data-settings-anchor="${anchor}"]`),
    ];
    const concealed = targets.filter(
      (target) => target.closest("[hidden]") !== null,
    ).length;
    const found = targets.length - concealed;
    const want = expected ? 1 : 0;
    if (found === want && concealed === 0) return [];
    return [
      `${anchor}: expected ${want} target(s), found ${found}` +
        (concealed === 0 ? "" : ` (+${concealed} under [hidden])`),
    ];
  });
  expect(mismatches).toEqual([]);

  const ownAnchors = new Set(anchored.map(({ anchor }) => anchor));
  const foreign = [...container.querySelectorAll("[data-settings-anchor]")]
    .map((element) => element.getAttribute("data-settings-anchor") ?? "")
    .filter((anchor) => !ownAnchors.has(anchor));
  expect(
    foreign,
    `anchors rendered on ${section} that are not its indexed anchors`,
  ).toEqual([]);
}
