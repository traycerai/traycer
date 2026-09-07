import { create } from "zustand";

/**
 * Which chat the user was last typing in, per Task. Recorded on composer focus, which is the only
 * signal that means "this is the conversation I am working in".
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
