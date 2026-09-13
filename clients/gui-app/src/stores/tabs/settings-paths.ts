/**
 * The settings routes a tab path may name, for `store.ts`'s
 * `isValidSystemTabPath` and `desktop-tabs-persistence.ts`'s
 * `isSettingsRoutePath` alike. One module because the two validators answering
 * differently is the failure this shape rules out: they read the same persisted
 * path, so a section listed for one and not the other is a route that survives a
 * restart on one surface and is dropped on the other.
 *
 * Hand-maintained, and NOT derived from `SETTINGS_SECTIONS`, because it also has
 * to accept `service`, the retired id that `settings.service.tsx` still
 * redirects, and because a persisted path from an older build is exactly the
 * input this guards. The cost of hand-maintaining it is that a new section can
 * be forgotten here and silently stop being recognised as a settings route -
 * `devices` was, from the day it was added until `app-diagnostics` arrived and
 * the omission was noticed next to it; `link-phone` was, until the two copies
 * of this set were folded into one; and `app-notifications` was, until the set
 * was finally compared against the section table entry by entry. Three misses,
 * each found by eye, which is why the comparison is no longer left to one:
 * `__tests__/settings-kind.test.ts` asserts every `SETTINGS_SECTIONS` id is in
 * here. Containment only - the `service` alias belongs to no section, so this
 * set is a superset by construction and equality would fail on it.
 */
export const SETTINGS_PATHS = new Set([
  "agents",
  "app-diagnostics",
  "app-notifications",
  "appearance",
  "devices",
  "diagnostics",
  "fallback",
  "general",
  "host",
  "keybindings",
  "layout",
  "link-phone",
  "notifications",
  "opening-behavior",
  "providers",
  "service",
  "shell",
  "usage",
  "worktrees",
]);
