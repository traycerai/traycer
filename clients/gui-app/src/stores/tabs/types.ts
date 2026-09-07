import type { ComponentType, ReactNode } from "react";
import type { NavigateOptions } from "@tanstack/react-router";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";
import type { TAB_KINDS } from "@/stores/tabs/registry";
import type { DesktopWindowsBridge } from "@/lib/windows/types";
import type { DraftNewWindowFlow } from "@/components/layout/hooks/use-draft-open-in-new-window";
import type { EpicNewWindowFlow } from "@/components/layout/hooks/use-epic-open-in-new-window";

/**
 * Type-only re-import so this file uses the SAME source-of-truth for kind keys as the public
 * `HeaderTabKind` export in `registry.ts`.
 */
type HeaderTabKind = keyof typeof TAB_KINDS;

export interface TabRef {
  readonly kind: HeaderTabKind;
  readonly id: string;
}

/** System (singleton, app-global) tab record. Held in the tabs store. */
export interface SystemTab {
  readonly id: string;
  readonly kind: "history" | "settings";
  readonly name: string;
  readonly lastPath: string | null;
}

export type TabIcon = ComponentType<{ className: string | undefined }>;

/** Canonical, render-ready tab projected by `useHeaderTabs`. The strip iterates this. */
export type HeaderTab =
  | {
      readonly kind: "epic";
      readonly id: string;
      readonly epicId: string;
      /**
       * The host serving this epic's session, or `null` when no session is live for it (a background tab
       * past the MRU cap, or a cold boot before the provider has acquired one).
       */
      readonly hostId: string | null;
      readonly route: string;
      readonly name: string;
      readonly icon: TabIcon | null;
      readonly canClose: boolean;
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
 * Per-kind module - bundles the `build` factory and the behavior descriptor for one
 * `HeaderTabKind`.
 */
export interface TabKindModule<K extends HeaderTabKind, Source> {
  readonly kind: K;
  readonly build: (source: Source) => Extract<HeaderTab, { kind: K }>;
  readonly descriptor: TabKindDescriptor<K>;
}

/** Static surface capabilities which every registered tab kind must declare. */
export interface TabSurfaceCapabilities {
  readonly splitEligibility: "eligible" | "ineligible";
  readonly duplication: "allowed" | "forbidden";
  readonly singleton: "per-instance" | "per-window";
  readonly newWindow: "copy" | "move" | "none";
  readonly readinessScope: "none" | "default-host" | "tab-host";
  readonly durableState: {
    readonly owner: "epic-canvas" | "landing-draft" | "tabs-store";
    readonly eviction: "reconstruct";
  };
}

export interface TabSurfaceDescriptor<
  K extends HeaderTabKind,
> extends TabSurfaceCapabilities {
  readonly render: (tab: Extract<HeaderTab, { kind: K }>) => ReactNode;
  readonly canonicalRoute: (tab: Extract<HeaderTab, { kind: K }>) => string;
}

/** Behavior-only descriptor for a single `HeaderTabKind`. */
export interface TabKindDescriptor<K extends HeaderTabKind> {
  readonly kind: K;
  /** Exhaustive per-kind surface policy consumed by split layout code. */
  readonly surface: TabSurfaceDescriptor<K>;
  /**
   * Performs duplication and returns the intent to navigate to, or null if duplication is not
   * possible for this tab instance. Only called when `tab.canDuplicate` is true.
   */
  readonly duplicate: (
    tab: Extract<HeaderTab, { kind: K }>,
  ) => TabNavigationIntent | null;
  /** Resolves the typed navigation intent the strip should execute when the tab is activated. */
  readonly resolveIntent: (
    tab: Extract<HeaderTab, { kind: K }>,
  ) => TabNavigationIntent;
  readonly routeOptions: (
    intent: Extract<TabNavigationIntent, { kind: K }>,
  ) => NavigateOptions;
  /**
   * Mirrors `routeOptions` for store activation. Per-kind side effects (e.g., `setActiveTab`,
   * `setActiveDraft`) live here so the seam doesn't need to know about each store.
   */
  readonly activate: (
    intent: Extract<TabNavigationIntent, { kind: K }>,
  ) => void;
  /** Kind-specific close. */
  readonly requestClose: (tab: Extract<HeaderTab, { kind: K }>) => void;
  readonly requiresCloseConfirm: (
    tab: Extract<HeaderTab, { kind: K }>,
  ) => boolean;
  /**
   * Opens this tab in a new desktop window. Caller MUST first guard on `tab.canOpenInNewWindow` - a
   * kind that does not support new-window implements this as a no-op for exhaustiveness.
   */
  readonly openInNewWindow: (
    tab: Extract<HeaderTab, { kind: K }>,
    deps: OpenInNewWindowDeps,
  ) => void;
  readonly matchesPath: (
    tab: Extract<HeaderTab, { kind: K }>,
    pathname: string,
  ) => boolean;
}

/** Runtime dependencies the per-kind `openInNewWindow` may consume: */
export interface OpenInNewWindowDeps {
  readonly bridge: DesktopWindowsBridge;
  readonly epicFlow: EpicNewWindowFlow;
  readonly draftFlow: DraftNewWindowFlow;
}
