/**
 * Intent shapes + factories for the tab-navigation seam.
 *
 * Carved out of `lib/tab-navigation.ts` so per-kind descriptors
 * (`stores/tabs/kinds/*.tsx`) can build intents without forming a
 * module-eval cycle with `navigateToTabIntent` and the registry's
 * per-concern dispatch fns (`tabResolveIntent`, `tabActivate`,
 * `tabRouteOptions`) that themselves need the descriptor registry.
 */
import type { SettingsSectionId } from "@/lib/settings-sections";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

export interface EpicRouteFocus {
  readonly focusedAt: number | undefined;
  readonly focusArtifactId: string | undefined;
  readonly focusThreadId: string | undefined;
  readonly migrationSource: "phase" | undefined;
}

export type TabNavigationIntent =
  | {
      readonly kind: "epic";
      readonly epicId: string;
      readonly tabId: string;
      readonly focus: EpicRouteFocus;
      /**
       * Store-prepared pane/tile target for a CROSS-ROUTE opener that already
       * mutated the target tab's canvas before navigating (the canvas store
       * is global and keyed by tabId, so preparing a background tab is
       * valid). `null` for every plain tab-switch intent (duplicate, close,
       * command palette, etc.) - those intentionally wipe nested search and
       * let route-sync canonicalization refill it from the tab's own current
       * focus. Only `existingEpicTabIntentWithNestedFocus` sets this.
       */
      readonly nestedFocus: NestedFocusTarget | null;
    }
  | { readonly kind: "draft"; readonly draftId: string }
  | { readonly kind: "history" }
  | { readonly kind: "settings"; readonly section: SettingsSectionId };

const DEFAULT_EPIC_FOCUS: EpicRouteFocus = {
  focusedAt: undefined,
  focusArtifactId: undefined,
  focusThreadId: undefined,
  migrationSource: undefined,
};

export function existingEpicTabIntent(input: {
  readonly epicId: string;
  readonly tabId: string;
  readonly focus: EpicRouteFocus | undefined;
}): Extract<TabNavigationIntent, { kind: "epic" }> {
  return {
    kind: "epic",
    epicId: input.epicId,
    tabId: input.tabId,
    focus: input.focus ?? DEFAULT_EPIC_FOCUS,
    nestedFocus: null,
  };
}

/**
 * Cross-route variant of `existingEpicTabIntent`: carries a store-prepared
 * nested focus target (pane/tile) so a single top-level navigation commits
 * both the header-tab switch and the canvas focus atomically, instead of
 * wiping nested search and relying on route-sync canonicalization to
 * self-heal it back in on a later pass. Callers already sitting on the
 * target epic/tab route should use `useEpicNestedFocusNavigation` directly
 * instead of this factory.
 */
export function existingEpicTabIntentWithNestedFocus(input: {
  readonly epicId: string;
  readonly tabId: string;
  readonly focus: EpicRouteFocus | undefined;
  readonly nestedFocus: NestedFocusTarget | null;
}): Extract<TabNavigationIntent, { kind: "epic" }> {
  return {
    kind: "epic",
    epicId: input.epicId,
    tabId: input.tabId,
    focus: input.focus ?? DEFAULT_EPIC_FOCUS,
    nestedFocus: input.nestedFocus,
  };
}

export function openOrFocusEpicIntent(input: {
  readonly epicId: string;
  readonly focus: EpicRouteFocus | undefined;
}): Extract<TabNavigationIntent, { kind: "epic" }> {
  const tabId = useEpicCanvasStore
    .getState()
    .resolveTargetTabForEpic(input.epicId, undefined);
  return existingEpicTabIntent({
    epicId: input.epicId,
    tabId,
    focus: input.focus,
  });
}

export function draftTabIntent(
  draftId: string,
): Extract<TabNavigationIntent, { kind: "draft" }> {
  return { kind: "draft", draftId };
}

export function historyTabIntent(): Extract<
  TabNavigationIntent,
  { kind: "history" }
> {
  return { kind: "history" };
}

export function settingsTabIntent(
  section: SettingsSectionId,
): Extract<TabNavigationIntent, { kind: "settings" }> {
  return { kind: "settings", section };
}
