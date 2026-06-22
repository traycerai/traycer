import type { NavigateOptions } from "@tanstack/react-router";
import { epicTabModule } from "@/stores/tabs/kinds/epic";
import { draftTabModule } from "@/stores/tabs/kinds/draft";
import { historyTabModule } from "@/stores/tabs/kinds/history";
import { settingsTabModule } from "@/stores/tabs/kinds/settings";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";
import type { HeaderTab, OpenInNewWindowDeps } from "@/stores/tabs/types";

/**
 * Registry of every tab kind. Adding a new kind:
 * 1. Implement a `TabKindModule` in `kinds/<name>.tsx`.
 * 2. Add it here under its kind key.
 * 3. `HeaderTabKind` is auto-derived from this registry - no manual union edits.
 *    `HeaderTab` and `TabNavigationIntent` still require explicit union variants
 *    in `types.ts` and `intents.ts` respectively (TypeScript cannot infer the
 *    full field shapes from the registry alone).
 *
 * All kind-dispatched behaviors (close, duplicate, navigate) go through the
 * per-concern dispatch functions exported below. Switches are centralized here
 * - consumers call `tabRequestClose(tab)`, `tabDuplicate(tab)`, etc.
 */
export const TAB_KINDS = {
  epic: epicTabModule,
  draft: draftTabModule,
  history: historyTabModule,
  settings: settingsTabModule,
} as const;

/**
 * Auto-derived union of every registered tab kind. Adding a new entry to
 * `TAB_KINDS` automatically extends this type - no manual edit required.
 */
export type HeaderTabKind = keyof typeof TAB_KINDS;

// ---------------------------------------------------------------------------
// Per-concern dispatch functions (spec D28 - all switches live here)
// ---------------------------------------------------------------------------

/**
 * Calls the per-kind `requestClose` behavior for `tab`.
 * Consumers never need to switch on `tab.kind` for close.
 */
export function tabRequestClose(tab: HeaderTab): void {
  switch (tab.kind) {
    case "epic":
      return TAB_KINDS.epic.descriptor.requestClose(tab);
    case "draft":
      return TAB_KINDS.draft.descriptor.requestClose(tab);
    case "history":
      return TAB_KINDS.history.descriptor.requestClose(tab);
    case "settings":
      return TAB_KINDS.settings.descriptor.requestClose(tab);
  }
}

/**
 * Calls the per-kind `duplicate` behavior for `tab`.
 * Returns the navigation intent to follow, or `null` if not duplicable.
 */
export function tabDuplicate(tab: HeaderTab): TabNavigationIntent | null {
  switch (tab.kind) {
    case "epic":
      return TAB_KINDS.epic.descriptor.duplicate(tab);
    case "draft":
      return TAB_KINDS.draft.descriptor.duplicate(tab);
    case "history":
      return TAB_KINDS.history.descriptor.duplicate(tab);
    case "settings":
      return TAB_KINDS.settings.descriptor.duplicate(tab);
  }
}

/**
 * Resolves the typed navigation intent for `tab`.
 * Use this instead of calling `descriptor.resolveIntent` with a switch.
 */
export function tabResolveIntent(tab: HeaderTab): TabNavigationIntent {
  switch (tab.kind) {
    case "epic":
      return TAB_KINDS.epic.descriptor.resolveIntent(tab);
    case "draft":
      return TAB_KINDS.draft.descriptor.resolveIntent(tab);
    case "history":
      return TAB_KINDS.history.descriptor.resolveIntent(tab);
    case "settings":
      return TAB_KINDS.settings.descriptor.resolveIntent(tab);
  }
}

/**
 * Builds the TanStack `NavigateOptions` for `intent`.
 * Route-shape knowledge stays in one file per kind.
 */
export function tabRouteOptions(intent: TabNavigationIntent): NavigateOptions {
  switch (intent.kind) {
    case "epic":
      return TAB_KINDS.epic.descriptor.routeOptions(intent);
    case "draft":
      return TAB_KINDS.draft.descriptor.routeOptions(intent);
    case "history":
      return TAB_KINDS.history.descriptor.routeOptions(intent);
    case "settings":
      return TAB_KINDS.settings.descriptor.routeOptions(intent);
  }
}

/**
 * Performs per-kind store activation for `intent` (e.g. `setActiveTab`,
 * `setActiveDraft`). Mirrors `tabRouteOptions` for side effects.
 */
export function tabActivate(intent: TabNavigationIntent): void {
  switch (intent.kind) {
    case "epic":
      return TAB_KINDS.epic.descriptor.activate(intent);
    case "draft":
      return TAB_KINDS.draft.descriptor.activate(intent);
    case "history":
      return TAB_KINDS.history.descriptor.activate(intent);
    case "settings":
      return TAB_KINDS.settings.descriptor.activate(intent);
  }
}

/**
 * Returns `true` when closing `tab` should prompt the user first
 * (e.g., an epic tab with unsynced edits). Returns `false` when the
 * close is safe to perform silently. Drives bulk-close skip logic
 * and the single-close confirmation prompt.
 */
export function tabRequiresCloseConfirm(tab: HeaderTab): boolean {
  switch (tab.kind) {
    case "epic":
      return TAB_KINDS.epic.descriptor.requiresCloseConfirm(tab);
    case "draft":
      return TAB_KINDS.draft.descriptor.requiresCloseConfirm(tab);
    case "history":
      return TAB_KINDS.history.descriptor.requiresCloseConfirm(tab);
    case "settings":
      return TAB_KINDS.settings.descriptor.requiresCloseConfirm(tab);
  }
}

/**
 * Returns the epic id associated with `tab` when the tab is an epic tab,
 * `null` otherwise. Used by the unsynced-close dialog to subscribe to epic
 * registry changes without leaking kind knowledge into the dialog component.
 */
export function tabEpicId(tab: HeaderTab): string | null {
  switch (tab.kind) {
    case "epic":
      return tab.epicId;
    case "draft":
    case "history":
    case "settings":
      return null;
  }
}

/**
 * Opens `tab` in a new desktop window via the per-kind descriptor's
 * `openInNewWindow` method. Caller MUST guard on `tab.canOpenInNewWindow`
 * first - kinds that do not support new-window (e.g., draft) implement
 * the method as a no-op for exhaustiveness.
 *
 * The kind-specific logic (ownership MOVE for epic, `requestNew(route)`
 * for system tabs) lives in the kind module's descriptor. This dispatch
 * is mechanical delegation only.
 */
export function tabOpenInNewWindow(
  tab: HeaderTab,
  deps: OpenInNewWindowDeps,
): void {
  switch (tab.kind) {
    case "epic":
      return TAB_KINDS.epic.descriptor.openInNewWindow(tab, deps);
    case "draft":
      return TAB_KINDS.draft.descriptor.openInNewWindow(tab, deps);
    case "history":
      return TAB_KINDS.history.descriptor.openInNewWindow(tab, deps);
    case "settings":
      return TAB_KINDS.settings.descriptor.openInNewWindow(tab, deps);
  }
}

/**
 * Returns `true` when the strip should highlight `tab` for the current
 * `pathname`. Delegates to the kind's `matchesPath` so each kind owns
 * its own activeness logic (exact match vs prefix for sub-routes).
 */
export function tabMatchesPath(tab: HeaderTab, pathname: string): boolean {
  switch (tab.kind) {
    case "epic":
      return TAB_KINDS.epic.descriptor.matchesPath(tab, pathname);
    case "draft":
      return TAB_KINDS.draft.descriptor.matchesPath(tab, pathname);
    case "history":
      return TAB_KINDS.history.descriptor.matchesPath(tab, pathname);
    case "settings":
      return TAB_KINDS.settings.descriptor.matchesPath(tab, pathname);
  }
}
