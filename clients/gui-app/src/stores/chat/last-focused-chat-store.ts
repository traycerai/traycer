import { create } from "zustand";

/**
 * Which chat the user was last typing in, per Task.
 *
 * Recorded on composer focus, which is the only signal that means "this is the
 * conversation I am working in". The open-epic store's `lastFocusedArtifactId`
 * cannot answer this: it tracks the last focused TILE of any kind, so opening
 * a terminal immediately overwrites it - and a terminal is exactly what the
 * user has just focused when they select output to quote.
 *
 * Deliberately session-scoped (not persisted): a stale "last used" chat from a
 * previous launch is a worse default than the Task's most recent chat, which
 * the resolver falls back to.
 */
interface LastFocusedChatStore {
  readonly chatIdByEpicId: Partial<Record<string, string>>;
  readonly recordFocusedChat: (epicId: string, chatId: string) => void;
}

export const useLastFocusedChatStore = create<LastFocusedChatStore>()(
  (set, get) => ({
    chatIdByEpicId: {},
    recordFocusedChat: (epicId, chatId) => {
      if (get().chatIdByEpicId[epicId] === chatId) return;
      set((state) => ({
        chatIdByEpicId: { ...state.chatIdByEpicId, [epicId]: chatId },
      }));
    },
  }),
);

export function readLastFocusedChatId(epicId: string): string | null {
  return useLastFocusedChatStore.getState().chatIdByEpicId[epicId] ?? null;
}

export function recordFocusedChat(epicId: string, chatId: string): void {
  useLastFocusedChatStore.getState().recordFocusedChat(epicId, chatId);
}
