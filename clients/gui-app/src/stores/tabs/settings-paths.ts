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
 * the omission was noticed next to it.
 */
export const SETTINGS_PATHS = new Set([
  "agents",
  "app-diagnostics",
  "appearance",
  "devices",
  "diagnostics",
  "general",
  "host",
  "keybindings",
  "layout",
  "notifications",
  "opening-behavior",
  "providers",
  "service",
  "shell",
  "usage",
  "worktrees",
]);
