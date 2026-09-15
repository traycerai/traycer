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
   * When the date preset was chosen. A preset is measured back from here
   * rather than from each render's clock, so the request - and its cache key -
   * stays put while the dialog is open.
   */
  readonly dateAnchorMs: number;
  readonly setOpen: (open: boolean) => void;
  readonly toggleOpen: () => void;
  readonly setScope: (scope: ChatSearchScopeChoice) => void;
  readonly setRoleFilter: (roleFilter: ChatSearchRoleFilter) => void;
  readonly setDatePreset: (datePreset: ChatSearchDatePreset) => void;
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
} as const satisfies Pick<
  ChatSearchState,
  "open" | "scope" | "roleFilter" | "datePreset" | "dateAnchorMs"
>;

export const useChatSearchStore = create<ChatSearchState>((set) => ({
  ...INITIAL,
  setOpen: (open) => set((state) => (state.open === open ? state : { open })),
  toggleOpen: () => set((state) => ({ open: !state.open })),
  setScope: (scope) => set({ scope }),
  setRoleFilter: (roleFilter) => set({ roleFilter }),
  setDatePreset: (datePreset) => set({ datePreset, dateAnchorMs: Date.now() }),
  resetForTests: () => set(INITIAL),
}));
