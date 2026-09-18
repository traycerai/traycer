/**
 * UI state for the global chat search dialog (`app.chat-search.open`).
 *
 * Session-only and deliberately not persisted: the filters are a reading of
 * the current question, not a preference worth carrying across launches. They
 * do survive closing and reopening the dialog within a session, so a search
 * that was narrowed to "this task" is still narrowed when it is reopened.
 *
 * The query text is not here - it is the input's own state and is dropped with
 * the dialog, like the command palette's.
 */
import { create } from "zustand";
import type { ChatSearchRoleFilter } from "@traycer/protocol/host/chat-search/schemas";

export type ChatSearchScopeChoice = "current-task" | "all-accessible-tasks";

/** Date presets the dialog offers; `any` sends no date range. */
export type ChatSearchDatePreset = "any" | "day" | "week" | "month" | "year";

export interface ChatSearchState {
  readonly open: boolean;
  readonly scope: ChatSearchScopeChoice;
  readonly roleFilter: ChatSearchRoleFilter;
  readonly datePreset: ChatSearchDatePreset;
  /**
   * The instant a relative date preset is measured back from.
   *
   * Two rules, and both matter. It is re-read when the dialog OPENS, because
   * the filters outlive a close: "Past day" chosen on Monday and reopened on
   * Wednesday must mean the last day, not the last three - the label would
   * otherwise describe a window the request does not ask for. And it is then
   * FIXED while the dialog is open, because it is part of the request and so
   * of its cache key: re-reading the clock per render would mint a new key
   * mid-session and make "show more" page against a moved window.
   *
   * Every writer takes `now` rather than reading the clock here, so a test can
   * advance it.
   */
  readonly dateAnchorMs: number;
  /**
   * A query handed to the dialog by another surface, waiting for the panel to
   * pick it up. One-shot: the panel copies it into its own input state and
   * calls {@link ChatSearchState.consumeInitialQuery}, so the next ⌘⇧F opens
   * empty. Only {@link ChatSearchState.openWith} ever sets it - an open from
   * the chord or the palette leaves it `null`, which is what keeps a query
   * from one surface out of an unrelated later search.
   */
  readonly initialQuery: string | null;
  /** `now` is only read on a closed -> open transition. */
  readonly setOpen: (open: boolean, now: number) => void;
  readonly toggleOpen: (now: number) => void;
  /**
   * Open the dialog on a query another surface already has, in a scope it
   * names - the sidebar's "All tasks", History's "Open in Search chats".
   *
   * Unlike {@link ChatSearchState.setOpen} this re-anchors the date presets
   * even when the dialog is already open: it is a new search being handed
   * over, not a redundant open, and its relative window is measured from the
   * hand-off.
   */
  readonly openWith: (
    handoff: {
      readonly query: string;
      readonly scope: ChatSearchScopeChoice;
    },
    now: number,
  ) => void;
  /** Clears the parked query once the panel has read it. */
  readonly consumeInitialQuery: () => void;
  readonly setScope: (scope: ChatSearchScopeChoice) => void;
  readonly setRoleFilter: (roleFilter: ChatSearchRoleFilter) => void;
  readonly setDatePreset: (
    datePreset: ChatSearchDatePreset,
    now: number,
  ) => void;
  readonly resetForTests: () => void;
}

const INITIAL = {
  open: false,
  // User-triggered search is the cross-task surface the spec grants
  // `all-accessible-tasks` to; "this task" is the narrowing.
  scope: "all-accessible-tasks",
  roleFilter: "any",
  datePreset: "any",
  dateAnchorMs: 0,
  initialQuery: null,
} as const satisfies Pick<
  ChatSearchState,
  | "open"
  | "scope"
  | "roleFilter"
  | "datePreset"
  | "dateAnchorMs"
  | "initialQuery"
>;

/**
 * The open transition, in one place: opening re-anchors the date presets,
 * closing and a no-op write leave the anchor where it is.
 */
function openTransition(
  state: ChatSearchState,
  open: boolean,
  now: number,
): Partial<ChatSearchState> | ChatSearchState {
  if (state.open === open) return state;
  return open ? { open, dateAnchorMs: now } : { open };
}

export const useChatSearchStore = create<ChatSearchState>((set) => ({
  ...INITIAL,
  setOpen: (open, now) => set((state) => openTransition(state, open, now)),
  toggleOpen: (now) => set((state) => openTransition(state, !state.open, now)),
  openWith: (handoff, now) =>
    set({
      open: true,
      scope: handoff.scope,
      dateAnchorMs: now,
      initialQuery: handoff.query,
    }),
  consumeInitialQuery: () => set({ initialQuery: null }),
  setScope: (scope) => set({ scope }),
  setRoleFilter: (roleFilter) => set({ roleFilter }),
  setDatePreset: (datePreset, now) => set({ datePreset, dateAnchorMs: now }),
  resetForTests: () => set(INITIAL),
}));
