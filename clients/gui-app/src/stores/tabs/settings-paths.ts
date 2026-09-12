/**
 * Every registered settings section's PATH SEGMENT (the part after
 * `/settings/`), plus `service` - the retired id `settings.service.tsx`
 * still redirects from.
 *
 * Hand-maintained, and deliberately NOT derived from `SETTINGS_SECTIONS`
 * (`@/lib/settings-sections`): a persisted path from an older build is
 * exactly the input this guards, so deriving from the live section list
 * would make an old build's persisted route unrecognisable the moment a
 * section were renamed or removed, rather than merely unmapped.
 *
 * Shared by `store.ts` (`migrateTabsPersistedState`'s route recognition) and
 * `desktop-tabs-persistence.ts` (`legacySystemTabs`'s route recognition) -
 * two different consumers reading one allowlist, not two allowlists. It used
 * to be copied verbatim into both files, and the cost of that duplication was
 * real: a new section forgotten in ONE copy silently stopped being recognised
 * as a settings route for that consumer alone. `devices` was missing from
 * both copies for their whole lives, and `app-notifications`/`link-phone`
 * were missing the same way until the `fallback` addition found them - three
 * misses on one duplicated pair, which is the argument for keeping this as
 * ONE hand-maintained set rather than two.
 */
export const SETTINGS_PATHS: ReadonlySet<string> = new Set([
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
  "link-phone",
  "notifications",
  "opening-behavior",
  "providers",
  "service",
  "shell",
  "usage",
  "worktrees",
]);
