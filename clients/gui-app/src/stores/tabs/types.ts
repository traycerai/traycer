import type { ComponentType } from "react";
import type { NavigateOptions } from "@tanstack/react-router";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";
import type { TAB_KINDS } from "@/stores/tabs/registry";
import type { DesktopWindowsBridge } from "@/lib/windows/types";
import type { EpicNewWindowFlow } from "@/components/layout/hooks/use-epic-open-in-new-window";

/**
 * Type-only re-import so this file uses the SAME source-of-truth for kind
 * keys as the public `HeaderTabKind` export in `registry.ts`. Type-only
 * imports are erased at runtime, so there is no runtime cycle even though
 * `registry.ts` imports values from this module.
 */
type HeaderTabKind = keyof typeof TAB_KINDS;

export interface TabRef {
  readonly kind: HeaderTabKind;
  readonly id: string;
}

/**
 * System (singleton, app-global) tab record. Held in the tabs store.
 * Epic and draft tabs are NOT stored here - their data lives in the
 * epic-canvas / landing-draft stores. Only the strip order is unified
 * across all kinds via `stripOrder` in the tabs store.
 */
export interface SystemTab {
  readonly id: string;
  readonly kind: "history" | "settings";
  readonly name: string;
  readonly lastPath: string | null;
}

export type TabIcon = ComponentType<{ className: string | undefined }>;

/**
 * Canonical, render-ready tab projected by `useHeaderTabs`. The strip
 * iterates this. Each variant is fully self-contained - all display
 * fields (`name`, `icon`, `canDuplicate`, `canOpenInNewWindow`) are
 * baked in at build time by the kind module's `build()` factory.
 * Behavioral delegation (close, duplicate, navigate) goes through the
 * per-concern dispatch fns (`tabRequestClose`, `tabDuplicate`,
 * `tabResolveIntent`, `tabRouteOptions`, `tabActivate`) in the registry.
 */
export type HeaderTab =
  | {
      readonly kind: "epic";
      readonly id: string;
      readonly epicId: string;
      readonly route: string;
      readonly name: string;
      readonly icon: TabIcon | null;
      readonly canDuplicate: boolean;
      readonly canOpenInNewWindow: boolean;
    }
  | {
      readonly kind: "draft";
      readonly id: string;
      readonly route: string;
      readonly name: string;
      readonly icon: TabIcon | null;
      readonly canDuplicate: boolean;
      readonly canOpenInNewWindow: boolean;
    }
  | {
      readonly kind: "history";
      readonly id: "history";
      readonly route: string;
      readonly name: string;
      readonly icon: TabIcon | null;
      readonly canDuplicate: boolean;
      readonly canOpenInNewWindow: boolean;
      readonly lastPath: string | null;
    }
  | {
      readonly kind: "settings";
      readonly id: "settings";
      readonly route: string;
      readonly name: string;
      readonly icon: TabIcon | null;
      readonly canDuplicate: boolean;
      readonly canOpenInNewWindow: boolean;
      readonly lastPath: string | null;
    };

export interface TabContextMenuCtx {
  readonly tab: HeaderTab;
  readonly canCloseOtherTabs: boolean;
  readonly closeOtherTabs: () => void;
  readonly canOpenInNewWindow: boolean;
  readonly requestOpenInNewWindow: () => void;
}

export interface TabCloseCtx {
  readonly navigateToNeighbor: () => void;
}

/**
 * Per-kind module - bundles the `build` factory and the behavior
 * descriptor for one `HeaderTabKind`. Register new kinds by adding one
 * file to `kinds/` and one entry to `TAB_KINDS` in `registry.ts`.
 */
export interface TabKindModule<K extends HeaderTabKind, Source> {
  readonly kind: K;
  /**
   * Constructs the fully-populated `HeaderTab` variant for this kind
   * from the source store record. All display fields (`name`, `icon`,
   * `canDuplicate`, `canOpenInNewWindow`) are baked in here so consumers
   * never need to call back into the descriptor for static data.
   */
  readonly build: (source: Source) => Extract<HeaderTab, { kind: K }>;
  readonly descriptor: TabKindDescriptor<K>;
}

/**
 * Behavior-only descriptor for a single `HeaderTabKind`. Static display
 * data (`name`, `icon`, `canDuplicate`, `canOpenInNewWindow`) belongs on
 * the `HeaderTab` variant - it is baked in by the kind module's `build()`
 * and read directly from `tab.*` in the strip and other consumers.
 *
 * The descriptor carries only operations that require runtime logic:
 * close, duplicate, intent resolution, route options, and activation.
 *
 * Generic over `K` so methods receive the narrowed tab type. Callers
 * invoke behaviors through the per-concern dispatch fns in `registry.ts`
 * (`tabRequestClose`, `tabDuplicate`, etc.) rather than reaching for the
 * descriptor directly - the dispatch fns own the kind switch so consumer
 * code stays kind-agnostic.
 */
export interface TabKindDescriptor<K extends HeaderTabKind> {
  readonly kind: K;
  /**
   * Performs duplication and returns the intent to navigate to, or null
   * if duplication is not possible for this tab instance. Only called
   * when `tab.canDuplicate` is true.
   */
  readonly duplicate: (
    tab: Extract<HeaderTab, { kind: K }>,
  ) => TabNavigationIntent | null;
  /**
   * Resolves the typed navigation intent the strip should execute when
   * the tab is activated. Callers must route through the tab-navigation
   * adapter so store activation happens before TanStack navigation.
   */
  readonly resolveIntent: (
    tab: Extract<HeaderTab, { kind: K }>,
  ) => TabNavigationIntent;
  /**
   * Builds the TanStack `NavigateOptions` for an intent of this kind.
   * Called via the `tabRouteOptions` dispatch fn in `registry.ts` -
   * kind-specific route shape stays in one file per kind.
   */
  readonly routeOptions: (
    intent: Extract<TabNavigationIntent, { kind: K }>,
  ) => NavigateOptions;
  /**
   * Mirrors `routeOptions` for store activation. Per-kind side effects
   * (e.g., `setActiveTab`, `setActiveDraft`) live here so the seam
   * doesn't need to know about each store.
   */
  readonly activate: (
    intent: Extract<TabNavigationIntent, { kind: K }>,
  ) => void;
  /** Kind-specific close. */
  readonly requestClose: (tab: Extract<HeaderTab, { kind: K }>) => void;
  /**
   * Returns `true` when closing this tab should prompt the user first
   * (e.g., an epic tab with unsynced edits). Returns `false` when the
   * close is safe to perform silently. Drives the bulk-close skip
   * behavior in `closeOtherTabs` and the single-close prompt decision
   * in `useUnsyncedCloseDialog`.
   */
  readonly requiresCloseConfirm: (
    tab: Extract<HeaderTab, { kind: K }>,
  ) => boolean;
  /**
   * Opens this tab in a new desktop window. Caller MUST first guard on
   * `tab.canOpenInNewWindow` - kinds that do not support new-window
   * (e.g. draft) implement this as a no-op for exhaustiveness.
   *
   * Receives runtime dependencies (`bridge`, `epicFlow`) the kind needs;
   * unused fields are ignored. The strip dispatches through the
   * `tabOpenInNewWindow` seam in `registry.ts`, which delegates to this
   * method per kind so kind-specific logic stays in the kind module.
   */
  readonly openInNewWindow: (
    tab: Extract<HeaderTab, { kind: K }>,
    deps: OpenInNewWindowDeps,
  ) => void;
  /**
   * Returns `true` when the strip should highlight `tab` as the active
   * tab given the current `pathname`. Most kinds compare against
   * `tab.route` for an exact match, but kinds with sub-routes (e.g.
   * settings) implement a prefix check so the tab stays highlighted as
   * the user navigates between sub-sections without waiting for the
   * `lastPath`-driven projector to catch up.
   */
  readonly matchesPath: (
    tab: Extract<HeaderTab, { kind: K }>,
    pathname: string,
  ) => boolean;
}

/**
 * Runtime dependencies the per-kind `openInNewWindow` may consume:
 *  - `bridge` is the desktop windows IPC seam (`requestNew` for stateless
 *    kinds like history/settings).
 *  - `epicFlow` carries the epic-specific MOVE flow (ownership claim +
 *    unsynced-edits gate). Other kinds ignore this field.
 */
export interface OpenInNewWindowDeps {
  readonly bridge: DesktopWindowsBridge;
  readonly epicFlow: EpicNewWindowFlow;
}
