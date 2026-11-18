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
import {
  historyTabIntent,
  settingsSectionFromPath,
  settingsTabIntent,
  type TabNavigationIntent,
} from "@/lib/tab-navigation";
import { useTabsStore } from "@/stores/tabs/store";
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
 * Select the History route the caller should open. The navigation controller
 * materializes the system tab after recording its rollback snapshot.
 */
export function resolveHistoryTabIntent(): Extract<
  TabNavigationIntent,
  { kind: "history" }
> {
  return historyTabIntent();
}

/** Legacy store-only helper for committed deep-link synchronization. */
export function ensureHistoryTab(): TabNavigationIntent {
  const store = useTabsStore.getState();
  const target = store.systemTabs.history?.lastPath ?? historyDefaultPath();
  store.openSystemTab({
    kind: "history",
    name: defaultHistoryTabName(),
    lastPath: target,
  });
  return resolveHistoryTabIntent();
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
 * Select the Settings route the caller should open. The navigation controller
 * materializes the system tab after recording its rollback snapshot. Resolution order:
 *  1. `opts.subSection` - explicit target wins.
 *  2. `opts.resetToGeneral` - snap to `/settings/general`.
 *  3. Existing `lastPath` - focus the tab where it left off.
 *  4. Default `/settings/general`.
 */
export function resolveSettingsTabIntent(
  opts: OpenSettingsOpts,
): Extract<TabNavigationIntent, { kind: "settings" }> {
  const store = useTabsStore.getState();
  const existing = store.systemTabs.settings;
  const target = resolveSettingsTarget(
    opts,
    normalizeSettingsPath(existing?.lastPath ?? null),
  );
  return settingsTabIntent(settingsSectionFromPath(target));
}

/** Legacy store-only helper for committed deep-link synchronization. */
export function ensureSettingsTab(opts: OpenSettingsOpts): TabNavigationIntent {
  const intent = resolveSettingsTabIntent(opts);
  useTabsStore.getState().openSystemTab({
    kind: "settings",
    name: defaultSettingsTabName(),
    lastPath: settingsSectionPath(intent.section),
  });
  return intent;
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
