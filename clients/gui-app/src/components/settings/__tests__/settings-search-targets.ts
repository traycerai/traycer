import { act } from "@testing-library/react";
import { expect } from "vitest";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import { SETTINGS_SEARCH_ENTRIES } from "@/lib/settings-search/settings-search-entries";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

interface AnchoredTarget {
  readonly anchor: string;
  readonly expected: boolean;
}

/** Every anchored entry for `section`, with what `context` says it should show. */
function anchoredTargetsFor(
  section: SettingsSectionId,
  context: SettingsAvailabilityContext,
): ReadonlyArray<AnchoredTarget> {
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
  return anchored;
}

function targetMismatch(
  container: HTMLElement,
  anchor: string,
  expected: boolean,
  suffix: string,
): string | null {
  const targets = [
    ...container.querySelectorAll(`[data-settings-anchor="${anchor}"]`),
  ];
  const concealed = targets.filter(
    (target) => target.closest("[hidden]") !== null,
  ).length;
  const found = targets.length - concealed;
  const want = expected ? 1 : 0;
  if (found === want && concealed === 0) return null;
  return (
    `${anchor}: expected ${want} target(s)${suffix}, found ${found}` +
    (concealed === 0 ? "" : ` (+${concealed} under [hidden])`)
  );
}

function assertNoForeignAnchors(
  section: SettingsSectionId,
  container: HTMLElement,
  ownAnchors: ReadonlySet<string>,
): void {
  const foreign = [...container.querySelectorAll("[data-settings-anchor]")]
    .map((element) => element.getAttribute("data-settings-anchor") ?? "")
    .filter((anchor) => !ownAnchors.has(anchor));
  expect(
    foreign,
    `anchors rendered on ${section} that are not its indexed anchors`,
  ).toEqual([]);
}

/**
 * The DOM half of the search index's contract, for one mounted panel whose
 * anchors are all visible at once from a static mount.
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
 *
 * Not for Layout (G6): see `assertSettingsSearchTargetsByNavigation` below.
 */
export function assertSettingsSearchTargets(
  section: SettingsSectionId,
  context: SettingsAvailabilityContext,
  container: HTMLElement,
): void {
  const anchored = anchoredTargetsFor(section, context);
  const mismatches = anchored.flatMap(({ anchor, expected }) => {
    const message = targetMismatch(container, anchor, expected, "");
    return message === null ? [] : [message];
  });
  expect(mismatches).toEqual([]);
  assertNoForeignAnchors(
    section,
    container,
    new Set(anchored.map(({ anchor }) => anchor)),
  );
}

/**
 * The DOM half of the contract for a section whose anchors are not all
 * visible from one static mount - Layout (G6) shows only one tab's rows at a
 * time, behind a sticky tab bar. `assertSettingsSearchTargets` would find
 * every anchor outside the default tab concealed and call that a bug, when it
 * is exactly what the tab bar promises.
 *
 * So each anchor is judged after driving the same navigation a real search
 * result click does - `requestReveal(section, anchor)`, which the panel's own
 * tab-switching effect (`useLayoutAnchorTab`) answers by switching to that
 * anchor's tab - rather than expecting every anchor to already be on screen
 * at once. An anchor `context` marks unavailable must still resolve to zero
 * targets even after that navigation: switching to its tab does not conjure a
 * gated row. The membership check runs unchanged, because every row - visible
 * tab or not - stays mounted (`forceMount`), so a foreign anchor is exactly as
 * findable here as in the static contract.
 */
export function assertSettingsSearchTargetsByNavigation(
  section: SettingsSectionId,
  context: SettingsAvailabilityContext,
  container: HTMLElement,
): void {
  const anchored = anchoredTargetsFor(section, context);
  const mismatches = anchored.flatMap(({ anchor, expected }) => {
    act(() => {
      useSettingsSearchStore.getState().requestReveal(section, anchor);
    });
    const message = targetMismatch(
      container,
      anchor,
      expected,
      " after navigating to it",
    );
    return message === null ? [] : [message];
  });
  expect(mismatches).toEqual([]);
  assertNoForeignAnchors(
    section,
    container,
    new Set(anchored.map(({ anchor }) => anchor)),
  );
}
