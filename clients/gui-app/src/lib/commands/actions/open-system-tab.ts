/**
 * Canonical actions for opening / focusing a system tab (history,
 * settings). Mirrors the `new-epic.ts` pattern: pure store mutations
 * here; navigation is the caller's job.
 *
 * The action returns the typed intent the caller should navigate to, so the
 * trigger surface (header button, palette item, keybinding) keeps its
 * own navigation strategy (TanStack `useNavigate`, `KeybindingRouter`,
 * etc.) without this module taking a router dependency.
 */
import { useTabsStore } from "@/stores/tabs/store";
import {
  historyTabIntent,
  settingsSectionFromPath,
  settingsTabIntent,
  type TabNavigationIntent,
} from "@/lib/tab-navigation";
import {
  defaultHistoryTabName,
  historyDefaultPath,
} from "@/stores/tabs/kinds/history";
import {
  defaultSettingsTabName,
  normalizeSettingsPath,
  settingsDefaultPath,
  settingsSectionPath,
} from "@/stores/tabs/kinds/settings";
import type { SettingsSectionId } from "@/lib/settings-sections";

/**
 * Ensure the History tab exists (or focus it) and return the path the
 * caller should navigate to. The remembered `lastPath` is preserved
 * across sessions; new opens land at it when present.
 */
export function ensureHistoryTab(): TabNavigationIntent {
  const store = useTabsStore.getState();
  const existing = store.systemTabs.history;
  const target = existing?.lastPath ?? historyDefaultPath();
  store.openSystemTab({
    kind: "history",
    name: defaultHistoryTabName(),
    lastPath: target,
  });
  return historyTabIntent();
}

export interface OpenSettingsOpts {
  /** When non-null, navigate to this sub-section and remember it. */
  readonly subSection: SettingsSectionId | null;
  /**
   * When true, ignore the existing `lastPath` and snap back to
   * `/settings/general`. Used by the UserMenu "Settings" trigger.
   */
  readonly resetToGeneral: boolean;
}

/**
 * Ensure the Settings tab exists and return the path the caller should
 * navigate to. Resolution order:
 *  1. `opts.subSection` - explicit target wins.
 *  2. `opts.resetToGeneral` - snap to `/settings/general`.
 *  3. Existing `lastPath` - focus the tab where it left off.
 *  4. Default `/settings/general`.
 */
export function ensureSettingsTab(opts: OpenSettingsOpts): TabNavigationIntent {
  const store = useTabsStore.getState();
  const existing = store.systemTabs.settings;
  const target = resolveSettingsTarget(
    opts,
    normalizeSettingsPath(existing?.lastPath ?? null),
  );
  store.openSystemTab({
    kind: "settings",
    name: defaultSettingsTabName(),
    lastPath: target,
  });
  return settingsTabIntent(settingsSectionFromPath(target));
}

function resolveSettingsTarget(
  opts: OpenSettingsOpts,
  rememberedPath: string | null,
): string {
  if (opts.subSection !== null) return settingsSectionPath(opts.subSection);
  if (opts.resetToGeneral) return settingsDefaultPath();
  if (rememberedPath !== null) return rememberedPath;
  return settingsDefaultPath();
}
