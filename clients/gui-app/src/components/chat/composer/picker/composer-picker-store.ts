import { createStore, type StoreApi } from "zustand/vanilla";
import {
  ROOT_MENTION_STEP,
  type MentionFlowStep,
  type MentionMenuEntry,
} from "@/lib/composer/mentions";
import type { MentionPreview, SlashCommand } from "@/lib/composer/types";

export type ComposerPickerKind = "mention" | "slash";

/**
 * Which commands a slash picker offers, and how it treats the ones it cannot.
 *
 * - `all` - a leading trigger: every command is selectable.
 * - `skills` - a trigger past the start: skills are selectable and native
 *   commands stay listed but disabled, because the user asked for the whole
 *   catalog and a row vanishing mid-typing reads as a bug.
 *
 * Scope follows caret position, never which character was typed: `/` and `$`
 * open the same catalog.
 */
export type ComposerSlashScope = "all" | "skills";

/**
 * Character that opened a slash picker. Purely what the user pressed - it does
 * not narrow the catalog. The menu echoes it so a row picked with `$` does not
 * read as `/name`, and the chip keeps it for the same reason; translating a
 * skill into the form a provider expects is the harness layer's job (Codex
 * takes `$name`, everything else `/name`).
 */
export type ComposerSlashTrigger = "/" | "$";

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
      /**
       * Non-null when the row is shown but not selectable - currently only
       * native provider commands offered at a non-leading caret, which the
       * Claude CLI parser only recognizes at the start of the prompt. The
       * entry stays in the list (so the catalog looks the same everywhere)
       * and the reason is surfaced in the menu instead of the row silently
       * disappearing.
       */
      readonly disabledReason: string | null;
    };

/**
 * Single place that decides whether a row can be activated or committed.
 * Keyboard navigation, hover, and commit all read through this so a disabled
 * row can never become the active index.
 */
export function pickerItemDisabledReason(
  item: ComposerPickerItem,
): string | null {
  if (item.kind === "mention") return null;
  return item.disabledReason;
}

/**
 * Disabled reason for the row the highlight currently sits on, or null when it
 * is selectable. Key-handling reads this so Enter/Tab on an inert row is
 * swallowed rather than falling through to the composer's submit handler.
 */
export function activePickerItemDisabledReason(state: {
  readonly items: ReadonlyArray<ComposerPickerItem>;
  readonly activeIndex: number;
}): string | null {
  const { items, activeIndex } = state;
  if (activeIndex < 0 || activeIndex >= items.length) return null;
  return pickerItemDisabledReason(items[activeIndex]);
}

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
  readonly slashScope: ComposerSlashScope | null;
  /** Trigger that opened this picker; null for the mention picker. */
  readonly slashTrigger: ComposerSlashTrigger | null;
  readonly range: ComposerPickerRange | null;
  readonly query: string;
  readonly step: MentionFlowStep;
  readonly items: ReadonlyArray<ComposerPickerItem>;
  readonly itemsForQuery: string | null;
  readonly itemsForStepId: string | null;
  /**
   * Scope the published `items` were built under. Part of item identity, not
   * just a render input: the scope decides each row's enabled/disabled policy,
   * so a list built under `all` is wrong the moment the caret makes the
   * position `skills`-only, even though kind, query, and step all still match.
   */
  readonly itemsForSlashScope: ComposerSlashScope | null;
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
   * True when the active kind's catalog query FAILED (currently only the
   * slash-command catalog reports this). The menu renders a "couldn't load"
   * row with a Retry action instead of claiming "no matching" results -
   * repeated provider failures must not be indistinguishable from a
   * legitimately empty catalog. `retryLoad` is the failed query's refetch,
   * kept as a closure in the store the same way `commit` / `clientRect` are;
   * it is non-null only while `loadFailed` is set.
   */
  readonly loadFailed: boolean;
  readonly retryLoad: (() => void) | null;
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
  /**
   * Which suggestion session currently owns this store.
   *
   * Several suggestion plugins (`/`, `$`, `@`) drive one store, and a single
   * ProseMirror transaction can stop one and start another - replacing `$` with
   * `/` over a selection does exactly that. Tiptap fires the new session's
   * `onStart` before the old session's `onExit`, so without an owner the
   * departing session's teardown closes the picker that just opened, leaving
   * the store shut while its plugin is still active and the menu invisible
   * until the range is abandoned. Every session-scoped write carries its id and
   * is dropped when it no longer matches.
   */
  readonly sessionId: number | null;
}

export interface ComposerPickerActions {
  readonly openPicker: (input: {
    readonly sessionId: number;
    readonly kind: ComposerPickerKind;
    readonly slashScope: ComposerSlashScope | null;
    readonly slashTrigger: ComposerSlashTrigger | null;
    readonly range: ComposerPickerRange;
    readonly query: string;
    readonly commit: ComposerPickerCommit;
    readonly clientRect: ComposerPickerClientRect | null;
  }) => void;
  readonly updateRange: (input: {
    readonly sessionId: number;
    readonly range: ComposerPickerRange;
    readonly query: string;
    readonly slashScope: ComposerSlashScope | null;
    readonly clientRect: ComposerPickerClientRect | null;
  }) => void;
  readonly setStep: (step: MentionFlowStep) => void;
  readonly setItems: (input: {
    readonly sessionId: number;
    readonly kind: ComposerPickerKind;
    readonly query: string;
    readonly slashScope: ComposerSlashScope | null;
    readonly step: MentionFlowStep;
    readonly items: ReadonlyArray<ComposerPickerItem>;
    readonly loading: boolean;
    readonly loadFailed: boolean;
    readonly retryLoad: (() => void) | null;
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
  /** Unconditional close, for callers that are not a suggestion session. */
  readonly close: () => void;
  /** Close only if `sessionId` still owns the store. See {@link ComposerPickerState.sessionId}. */
  readonly closeSession: (sessionId: number) => void;
  readonly reset: () => void;
}

export type ComposerPickerStoreState = ComposerPickerState &
  ComposerPickerActions;

export type ComposerPickerStore = StoreApi<ComposerPickerStoreState>;

const INITIAL_STATE: ComposerPickerState = {
  open: false,
  sessionId: null,
  kind: null,
  slashScope: null,
  slashTrigger: null,
  range: null,
  query: "",
  step: ROOT_MENTION_STEP,
  items: [],
  itemsForQuery: null,
  itemsForStepId: null,
  itemsForSlashScope: null,
  activeIndex: 0,
  loading: false,
  fetching: false,
  commit: null,
  loadFailed: false,
  retryLoad: null,
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

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

/**
 * First selectable index starting at `start` and scanning in `direction`,
 * wrapping once. Null when every row is disabled, which callers treat as
 * "leave the selection where it is" rather than highlighting a dead row.
 */
function findEnabledIndex(
  items: ReadonlyArray<ComposerPickerItem>,
  start: number,
  direction: 1 | -1,
): number | null {
  const length = items.length;
  if (length === 0) return null;
  const from = clampIndex(start, length);
  for (let step = 0; step < length; step += 1) {
    const candidate = wrapIndex(from + direction * step, length);
    if (pickerItemDisabledReason(items[candidate]) === null) return candidate;
  }
  return null;
}

export function createComposerPickerStore(): ComposerPickerStore {
  return createStore<ComposerPickerStoreState>((set, get) => ({
    ...INITIAL_STATE,

    openPicker: ({
      sessionId,
      kind,
      slashScope,
      slashTrigger,
      range,
      query,
      commit,
      clientRect,
    }) => {
      set({
        open: true,
        sessionId,
        kind,
        slashScope,
        slashTrigger,
        range,
        query,
        step: ROOT_MENTION_STEP,
        items: [],
        itemsForQuery: null,
        itemsForStepId: null,
        itemsForSlashScope: null,
        activeIndex: 0,
        loading: false,
        fetching: false,
        commit,
        loadFailed: false,
        retryLoad: null,
        clientRect,
      });
    },

    updateRange: ({ sessionId, range, query, slashScope, clientRect }) => {
      const previous = get();
      // A session that no longer owns the store is winding down; letting it
      // write would hand the live picker the departing session's range.
      if (previous.sessionId !== sessionId) return;
      const sameRange =
        previous.range !== null &&
        previous.range.from === range.from &&
        previous.range.to === range.to &&
        previous.query === query &&
        previous.slashScope === slashScope;
      // Always refresh `clientRect`: even when the range is identical the
      // closure may be stale after a view.update, and `autoUpdate` reads
      // through it for live positioning.
      if (sameRange) {
        if (clientRect !== null && previous.clientRect !== clientRect) {
          set({ clientRect });
        }
        return;
      }
      // A scope flip rewrites the enabled/disabled policy for every row, so the
      // published list is stale until the item hook republishes under the new
      // scope. Drop it now rather than rendering (and accepting commits on)
      // rows whose policy no longer holds for this caret position.
      const scopeChanged = previous.slashScope !== slashScope;
      set({
        range,
        query,
        slashScope,
        activeIndex: 0,
        clientRect: clientRect ?? previous.clientRect,
        items: scopeChanged ? [] : previous.items,
        itemsForQuery: scopeChanged ? null : previous.itemsForQuery,
        itemsForStepId: scopeChanged ? null : previous.itemsForStepId,
        itemsForSlashScope: scopeChanged ? null : previous.itemsForSlashScope,
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
        itemsForSlashScope: null,
        activeIndex: 0,
        loading: false,
        fetching: false,
        loadFailed: false,
        retryLoad: null,
      });
    },

    setItems: ({
      sessionId,
      kind,
      query,
      slashScope,
      step,
      items,
      loading,
      loadFailed,
      retryLoad,
    }) => {
      const previous = get();
      if (
        !previous.open ||
        // Rows belong to the session that asked for them. The remaining checks
        // compare what the list was built for, and a replacement session can
        // match every one of them, so only the id distinguishes the owner.
        previous.sessionId !== sessionId ||
        previous.kind !== kind ||
        previous.query !== query ||
        previous.slashScope !== slashScope ||
        stepIdOf(previous.step) !== stepIdOf(step)
      ) {
        return;
      }
      set({
        items,
        itemsForQuery: query,
        itemsForStepId: stepIdOf(step),
        itemsForSlashScope: slashScope,
        loading,
        loadFailed,
        retryLoad,
        activeIndex:
          findEnabledIndex(items, previous.activeIndex, 1) ??
          clampIndex(previous.activeIndex, items.length),
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

    // Navigation deliberately traverses disabled rows rather than jumping over
    // them: skipping makes the highlight look like it teleports past entries
    // the user can still see. Disabled rows highlight as inert instead, and
    // `commitActiveItem` is what refuses.
    setActiveIndex: (index) => {
      const previous = get();
      if (previous.items.length === 0) return;
      const clamped = clampIndex(index, previous.items.length);
      if (clamped === previous.activeIndex) return;
      set({ activeIndex: clamped });
    },

    moveActive: (direction) => {
      const previous = get();
      const length = previous.items.length;
      if (length === 0) return;
      const next = wrapIndex(
        clampIndex(previous.activeIndex, length) + direction,
        length,
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
      const item = state.items[state.activeIndex];
      if (pickerItemDisabledReason(item) !== null) return false;
      state.commit(item);
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

    closeSession: (sessionId) => {
      if (get().sessionId !== sessionId) return;
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
