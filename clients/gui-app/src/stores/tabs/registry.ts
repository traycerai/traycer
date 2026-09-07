import type { NavigateOptions } from "@tanstack/react-router";
import { epicTabModule } from "@/stores/tabs/kinds/epic";
import { draftTabModule } from "@/stores/tabs/kinds/draft";
import { historyTabModule } from "@/stores/tabs/kinds/history";
import { settingsTabModule } from "@/stores/tabs/kinds/settings";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";
import type {
  HeaderTab,
  OpenInNewWindowDeps,
  TabSurfaceCapabilities,
  TabSurfaceDescriptor,
} from "@/stores/tabs/types";

/** Registry of every tab kind. Adding a new kind: */
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

/** Compile-time audit over the existing registry itself. */
export const TAB_KINDS_SURFACE_CONTRACT = TAB_KINDS satisfies Record<
  HeaderTabKind,
  { readonly descriptor: { readonly surface: TabSurfaceCapabilities } }
>;

/** Runtime guard for persisted layout sanitization. */
export function isRegisteredTabKind(kind: string): kind is HeaderTabKind {
  return Object.hasOwn(TAB_KINDS, kind);
}

/**
 * Surface-policy dispatch. This composes with the established behavioral
 * descriptor rather than creating a parallel split-view registry.
 */
export function tabSurfaceDescriptor(
  kind: "epic",
): TabSurfaceDescriptor<"epic">;
export function tabSurfaceDescriptor(
  kind: "draft",
): TabSurfaceDescriptor<"draft">;
export function tabSurfaceDescriptor(
  kind: "history",
): TabSurfaceDescriptor<"history">;
export function tabSurfaceDescriptor(
  kind: "settings",
): TabSurfaceDescriptor<"settings">;
export function tabSurfaceDescriptor(
  kind: HeaderTabKind,
):
  | TabSurfaceDescriptor<"epic">
  | TabSurfaceDescriptor<"draft">
  | TabSurfaceDescriptor<"history">
  | TabSurfaceDescriptor<"settings">;
export function tabSurfaceDescriptor(
  kind: HeaderTabKind,
):
  | TabSurfaceDescriptor<"epic">
  | TabSurfaceDescriptor<"draft">
  | TabSurfaceDescriptor<"history">
  | TabSurfaceDescriptor<"settings"> {
  switch (kind) {
    case "epic":
      return TAB_KINDS.epic.descriptor.surface;
    case "draft":
      return TAB_KINDS.draft.descriptor.surface;
    case "history":
      return TAB_KINDS.history.descriptor.surface;
    case "settings":
      return TAB_KINDS.settings.descriptor.surface;
  }
}

// --------------------------------------------------------------------------- Per-concern dispatch
// functions (spec D28 - all switches live here)

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

/** Opens `tab` in a new desktop window via the per-kind descriptor's `openInNewWindow` method. */
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
