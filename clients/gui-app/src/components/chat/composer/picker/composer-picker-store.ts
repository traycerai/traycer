import { createStore, type StoreApi } from "zustand/vanilla";
import {
  ROOT_MENTION_STEP,
  type MentionFlowStep,
  type MentionMenuEntry,
} from "@/lib/composer/mentions";
import type { MentionPreview, SlashCommand } from "@/lib/composer/types";

export type ComposerPickerKind = "mention" | "slash";

export interface ComposerPickerRange {
  readonly from: number;
  readonly to: number;
}

export type ComposerPickerItem =
  | {
      readonly id: string;
      readonly kind: "mention";
      readonly entry: MentionMenuEntry;
    }
  | {
      readonly id: string;
      readonly kind: "slash";
      readonly command: SlashCommand;
    };

/**
 * Uniform preview lookup for either picker item shape - the side preview
 * panel reads the active item via this instead of branching on `kind` itself.
 */
export function pickerItemPreview(
  item: ComposerPickerItem,
): MentionPreview | null {
  if (item.kind === "mention") return item.entry.preview;
  return item.command.preview;
}

export type ComposerPickerCommit = (item: ComposerPickerItem) => void;

export type ComposerPickerClientRect = () => DOMRect | null;

export interface ComposerPickerState {
  readonly open: boolean;
  readonly kind: ComposerPickerKind | null;
  readonly range: ComposerPickerRange | null;
  readonly query: string;
  readonly step: MentionFlowStep;
  readonly items: ReadonlyArray<ComposerPickerItem>;
  readonly itemsForQuery: string | null;
  readonly itemsForStepId: string | null;
  readonly activeIndex: number;
  readonly loading: boolean;
  /**
   * Background-refetch indicator, distinct from `loading`: true while a
   * mention/slash query is refetching behind `placeholderData` (prior results
   * still shown), so the menu header can show a subtle spinner without the
   * list collapsing the way the full `loading` state implies.
   */
  readonly fetching: boolean;
  readonly commit: ComposerPickerCommit | null;
  /**
   * Latest viewport rect of the suggestion range (trigger char + query).
   * Tiptap rebuilds the closure on every view update; we keep the function
   * itself in the store so the menu can read the freshest rect via
   * `getState().clientRect?.()` without subscribing.
   */
  readonly clientRect: ComposerPickerClientRect | null;
  /**
   * Known slash commands for this composer's harness as a map of lowercased
   * name → canonical name, or null until the command catalog has loaded.
   * Populated eagerly by `useComposerPickerItems` so the paste handler can
   * validate a pasted `/command` against real commands (and reuse the catalog's
   * canonical casing) without the popover ever opening. This is catalog data,
   * not transient popover state, so it survives open/close/reset.
   */
  readonly knownSlashCommands: ReadonlyMap<string, string> | null;
}

export interface ComposerPickerActions {
  readonly openPicker: (input: {
    readonly kind: ComposerPickerKind;
    readonly range: ComposerPickerRange;
    readonly query: string;
    readonly commit: ComposerPickerCommit;
    readonly clientRect: ComposerPickerClientRect | null;
  }) => void;
  readonly updateRange: (input: {
    readonly range: ComposerPickerRange;
    readonly query: string;
    readonly clientRect: ComposerPickerClientRect | null;
  }) => void;
  readonly setStep: (step: MentionFlowStep) => void;
  readonly setItems: (input: {
    readonly kind: ComposerPickerKind;
    readonly query: string;
    readonly step: MentionFlowStep;
    readonly items: ReadonlyArray<ComposerPickerItem>;
    readonly loading: boolean;
  }) => void;
  readonly setLoading: (input: {
    readonly kind: ComposerPickerKind;
    readonly query: string;
    readonly step: MentionFlowStep;
    readonly loading: boolean;
  }) => void;
  readonly setFetching: (fetching: boolean) => void;
  readonly setActiveIndex: (index: number) => void;
  readonly moveActive: (direction: 1 | -1) => void;
  readonly commitActiveItem: () => boolean;
  readonly setKnownSlashCommands: (
    commands: ReadonlyMap<string, string> | null,
  ) => void;
  readonly close: () => void;
  readonly reset: () => void;
}

export type ComposerPickerStoreState = ComposerPickerState &
  ComposerPickerActions;

export type ComposerPickerStore = StoreApi<ComposerPickerStoreState>;

const INITIAL_STATE: ComposerPickerState = {
  open: false,
  kind: null,
  range: null,
  query: "",
  step: ROOT_MENTION_STEP,
  items: [],
  itemsForQuery: null,
  itemsForStepId: null,
  activeIndex: 0,
  loading: false,
  fetching: false,
  commit: null,
  clientRect: null,
  knownSlashCommands: null,
};

function stepIdOf(step: MentionFlowStep): string {
  if (step.kind === "root") return "root";
  return `${step.providerId}:${step.stepId}:${step.workspacePath ?? ""}`;
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

function nextIndex(index: number, length: number, direction: 1 | -1): number {
  if (length === 0) return 0;
  return (clampIndex(index, length) + direction + length) % length;
}

export function createComposerPickerStore(): ComposerPickerStore {
  return createStore<ComposerPickerStoreState>((set, get) => ({
    ...INITIAL_STATE,

    openPicker: ({ kind, range, query, commit, clientRect }) => {
      set({
        open: true,
        kind,
        range,
        query,
        step: ROOT_MENTION_STEP,
        items: [],
        itemsForQuery: null,
        itemsForStepId: null,
        activeIndex: 0,
        loading: false,
        fetching: false,
        commit,
        clientRect,
      });
    },

    updateRange: ({ range, query, clientRect }) => {
      const previous = get();
      const sameRange =
        previous.range !== null &&
        previous.range.from === range.from &&
        previous.range.to === range.to &&
        previous.query === query;
      // Always refresh `clientRect`: even when the range is identical the
      // closure may be stale after a view.update, and `autoUpdate` reads
      // through it for live positioning.
      if (sameRange) {
        if (clientRect !== null && previous.clientRect !== clientRect) {
          set({ clientRect });
        }
        return;
      }
      set({
        range,
        query,
        activeIndex: 0,
        clientRect: clientRect ?? previous.clientRect,
      });
    },

    setStep: (step) => {
      const previous = get();
      if (stepIdOf(previous.step) === stepIdOf(step)) return;
      set({
        step,
        items: [],
        itemsForQuery: null,
        itemsForStepId: null,
        activeIndex: 0,
        loading: false,
        fetching: false,
      });
    },

    setItems: ({ kind, query, step, items, loading }) => {
      const previous = get();
      if (
        !previous.open ||
        previous.kind !== kind ||
        previous.query !== query ||
        stepIdOf(previous.step) !== stepIdOf(step)
      ) {
        return;
      }
      set({
        items,
        itemsForQuery: query,
        itemsForStepId: stepIdOf(step),
        loading,
        activeIndex: clampIndex(previous.activeIndex, items.length),
      });
    },

    setLoading: ({ kind, query, step, loading }) => {
      const previous = get();
      if (
        !previous.open ||
        previous.kind !== kind ||
        previous.query !== query ||
        stepIdOf(previous.step) !== stepIdOf(step)
      ) {
        return;
      }
      if (previous.loading === loading) return;
      set({ loading });
    },

    setFetching: (fetching) => {
      if (get().fetching === fetching) return;
      set({ fetching });
    },

    setActiveIndex: (index) => {
      const previous = get();
      const clamped = clampIndex(index, previous.items.length);
      if (clamped === previous.activeIndex) return;
      set({ activeIndex: clamped });
    },

    moveActive: (direction) => {
      const previous = get();
      const next = nextIndex(
        previous.activeIndex,
        previous.items.length,
        direction,
      );
      if (next === previous.activeIndex) return;
      set({ activeIndex: next });
    },

    commitActiveItem: () => {
      const state = get();
      if (!state.open || state.commit === null) return false;
      if (state.activeIndex < 0 || state.activeIndex >= state.items.length) {
        return false;
      }
      state.commit(state.items[state.activeIndex]);
      return true;
    },

    setKnownSlashCommands: (commands) => {
      if (get().knownSlashCommands === commands) return;
      set({ knownSlashCommands: commands });
    },

    // `close`/`reset` clear transient popover state but preserve the loaded
    // command catalog - it is host/harness data, not per-popover-session state.
    close: () => {
      set((previous) => ({
        ...INITIAL_STATE,
        knownSlashCommands: previous.knownSlashCommands,
      }));
    },

    reset: () => {
      set((previous) => ({
        ...INITIAL_STATE,
        knownSlashCommands: previous.knownSlashCommands,
      }));
    },
  }));
}
