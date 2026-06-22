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
