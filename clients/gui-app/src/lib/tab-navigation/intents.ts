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
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

export interface EpicRouteFocus {
  readonly focusedAt: number | undefined;
  readonly focusArtifactId: string | undefined;
  readonly focusThreadId: string | undefined;
  readonly migrationSource: "phase" | undefined;
}

export type EpicPostResolvePreparation =
  | {
      readonly kind: "open-tile";
      readonly node: EpicCanvasTileRef;
    }
  | {
      readonly kind: "activate-tile";
      readonly paneId: string;
      readonly tileTabId: string;
    };

export type TabNavigationIntent =
  | {
      readonly kind: "epic";
      readonly epicId: string;
      readonly tabId: string;
      readonly focus: EpicRouteFocus;
      /**
       * Pane/tile target prepared after the controller resolves the exact tab
       * and before it issues the correlated route navigation. `null` for plain
       * tab switches, which intentionally clear nested route focus.
       */
      readonly nestedFocus: NestedFocusTarget | null;
    }
  | { readonly kind: "draft"; readonly draftId: string }
  | { readonly kind: "history" }
  | { readonly kind: "settings"; readonly section: SettingsSectionId };

/**
 * Requests that need source resolution are deliberately distinct from canonical
 * route intents. The navigation controller resolves them after taking its
 * rollback snapshot, then delegates only a canonical intent to tab descriptors.
 */
export type TabActivationIntent =
  | TabNavigationIntent
  | {
      readonly kind: "complete-epic-migration";
      readonly sourceEpicId: string;
      readonly epicId: string;
      readonly tabId: string;
      readonly focus: EpicRouteFocus;
      readonly nestedFocus: NestedFocusTarget | null;
    }
  | {
      readonly kind: "open-epic";
      readonly epicId: string;
      readonly tabId: string | null;
      readonly focus: EpicRouteFocus | undefined;
      /**
       * Title for a freshly-materialized epic tab (the row the user clicked).
       * `undefined` falls back to "Untitled epic" at resolution time.
       */
      readonly name: string | undefined;
      /**
       * When set, the controller swaps this empty draft for the resolved epic
       * AT THE DRAFT'S STRIP SLOT (the epic-list "replace empty draft in place"
       * UX). Resolution runs INSIDE the controller, after it snapshots the true
       * pre-command selection, so a rejected navigation still rolls back to the
       * tab the user actually started on. `null` for every other opener.
       */
      readonly replaceEmptyDraftId: string | null;
      /** Canvas work that needs the exact resolved tab id. */
      readonly preparation: EpicPostResolvePreparation | null;
      readonly includeNestedFocus: boolean;
    }
  | {
      readonly kind: "open-phase-migration";
      readonly phaseId: string;
      readonly name: string | undefined;
      readonly focus: EpicRouteFocus | undefined;
    }
  | { readonly kind: "new-draft"; readonly settings: ChatRunSettings | null };

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

export function draftTabIntent(
  draftId: string,
): Extract<TabNavigationIntent, { kind: "draft" }> {
  return { kind: "draft", draftId };
}

export function newDraftTabIntent(
  settings: ChatRunSettings | null,
): Extract<TabActivationIntent, { kind: "new-draft" }> {
  return { kind: "new-draft", settings };
}

export function openEpicTabIntent(input: {
  readonly epicId: string;
  readonly focus: EpicRouteFocus | undefined;
}): Extract<TabActivationIntent, { kind: "open-epic" }> {
  return {
    kind: "open-epic",
    epicId: input.epicId,
    tabId: null,
    focus: input.focus,
    name: undefined,
    replaceEmptyDraftId: null,
    preparation: null,
    includeNestedFocus: false,
  };
}

/**
 * Epic-list opener variant: carries the row's title and the id of an empty
 * draft to replace in place. The controller captures its rollback snapshot
 * BEFORE resolving/creating the epic, so a rejected navigation restores the
 * genuine prior tab rather than the just-opened epic.
 */
export function openEpicFromListIntent(input: {
  readonly epicId: string;
  readonly focus: EpicRouteFocus | undefined;
  readonly name: string | undefined;
  readonly replaceEmptyDraftId: string | null;
}): Extract<TabActivationIntent, { kind: "open-epic" }> {
  return {
    kind: "open-epic",
    epicId: input.epicId,
    tabId: null,
    focus: input.focus,
    name: input.name,
    replaceEmptyDraftId: input.replaceEmptyDraftId,
    preparation: null,
    includeNestedFocus: false,
  };
}

export function resourceEpicTabIntent(input: {
  readonly epicId: string;
  readonly tabId: string | null;
  readonly name: string | undefined;
  readonly focus: EpicRouteFocus;
  readonly preparation: EpicPostResolvePreparation;
  readonly includeNestedFocus: boolean;
}): Extract<TabActivationIntent, { kind: "open-epic" }> {
  return {
    kind: "open-epic",
    epicId: input.epicId,
    tabId: input.tabId,
    focus: input.focus,
    name: input.name,
    replaceEmptyDraftId: null,
    preparation: input.preparation,
    includeNestedFocus: input.includeNestedFocus,
  };
}

export function openExactEpicTabIntent(input: {
  readonly epicId: string;
  readonly tabId: string;
  readonly name: string | undefined;
  readonly focus: EpicRouteFocus | undefined;
}): Extract<TabActivationIntent, { kind: "open-epic" }> {
  return {
    kind: "open-epic",
    epicId: input.epicId,
    tabId: input.tabId,
    focus: input.focus,
    name: input.name,
    replaceEmptyDraftId: null,
    preparation: null,
    includeNestedFocus: false,
  };
}

export function openPhaseMigrationIntent(input: {
  readonly phaseId: string;
  readonly name: string | undefined;
  readonly focus: EpicRouteFocus | undefined;
}): Extract<TabActivationIntent, { kind: "open-phase-migration" }> {
  return {
    kind: "open-phase-migration",
    phaseId: input.phaseId,
    name: input.name,
    focus: input.focus,
  };
}

export function completeEpicMigrationIntent(input: {
  readonly sourceEpicId: string;
  readonly epicId: string;
  readonly tabId: string;
  readonly focus: EpicRouteFocus;
  readonly nestedFocus: NestedFocusTarget | null;
}): Extract<TabActivationIntent, { kind: "complete-epic-migration" }> {
  return {
    kind: "complete-epic-migration",
    sourceEpicId: input.sourceEpicId,
    epicId: input.epicId,
    tabId: input.tabId,
    focus: input.focus,
    nestedFocus: input.nestedFocus,
  };
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
