import { create } from "zustand";
import type { SettingsSectionId } from "@/lib/settings-sections";
import type {
  OpenSettingsModalOpts,
  SettingsRuleDraft,
} from "@/stores/tabs/system-overlay-types";

/**
 * What an `openSettings` call asked for beyond the section: a tab inside it,
 * and a prepared rule.
 *
 * A store rather than a route param because Settings has three entry points
 * and only two of them are routes. The phone navigates to
 * `/settings/<section>`, an open Settings tab navigates to the same path, and
 * the desktop modal is not a route at all (its section lives in
 * `useSettingsSectionStore`). `openSettings` arms this before any of the three
 * navigates, so whichever surface mounts the section reads the same intent.
 * It is the `useProvidersFocusStore` shape, one level up.
 *
 * ONE-SHOT, and that is the page's half of the contract: the page applies the
 * intent once (selects the tab, appends the draft) and calls
 * {@link acknowledgeSettingsOpenIntent} with its `id`. Without that, a draft
 * would be appended again every time the page remounted. `id` increases on
 * every arm, so the same tab and draft opened twice are two intents, and an
 * acknowledgement of an older one never clears a newer one.
 *
 * Not persisted: a prepared rule is only ever a proposal, and one that
 * outlived a reload would appear in a section the user did not just ask for.
 */
export interface SettingsOpenIntent {
  readonly id: number;
  readonly section: SettingsSectionId;
  readonly tab: string | null;
  readonly draft: SettingsRuleDraft | null;
  /** The machine to scope Settings to first ({@link OpenSettingsModalOpts}). */
  readonly hostId: string | null;
}

interface SettingsOpenIntentState {
  readonly intent: SettingsOpenIntent | null;
  readonly lastId: number;
}

export const useSettingsOpenIntentStore = create<SettingsOpenIntentState>(
  () => ({ intent: null, lastId: 0 }),
);

/**
 * Records what an `openSettings` call asked for, replacing whatever an earlier
 * call left unconsumed.
 *
 * A call with no tab, no draft and no host CLEARS the pending intent rather
 * than leaving it: the user has since asked for Settings without one, and a
 * draft from an earlier card must not surface under a later, unrelated open.
 * So does a call with no section, which names no page to deliver to.
 */
export function armSettingsOpenIntent(opts: OpenSettingsModalOpts): void {
  const { section, tab, draft, hostId } = opts;
  if (section === null || (tab === null && draft === null && hostId === null)) {
    useSettingsOpenIntentStore.setState({ intent: null });
    return;
  }
  const id = useSettingsOpenIntentStore.getState().lastId + 1;
  useSettingsOpenIntentStore.setState({
    intent: { id, section, tab, draft, hostId },
    lastId: id,
  });
}

/** Clears the intent the page applied, and only that one. */
export function acknowledgeSettingsOpenIntent(id: number): void {
  const { intent } = useSettingsOpenIntentStore.getState();
  if (intent === null || intent.id !== id) return;
  useSettingsOpenIntentStore.setState({ intent: null });
}

/**
 * The pending intent for `section`, or `null` when there is none or it names
 * another section.
 */
export function useSettingsOpenIntent(
  section: SettingsSectionId,
): SettingsOpenIntent | null {
  return useSettingsOpenIntentStore((state) =>
    state.intent !== null && state.intent.section === section
      ? state.intent
      : null,
  );
}

/** Test-only: drops any pending intent and restarts the id sequence. */
export function resetSettingsOpenIntentForTests(): void {
  useSettingsOpenIntentStore.setState({ intent: null, lastId: 0 });
}
