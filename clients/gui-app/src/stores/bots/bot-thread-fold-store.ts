import { create } from "zustand";

interface BotThreadFoldState {
  /** The threads shown in full, by thread id. */
  readonly unfolded: Readonly<Record<string, true>>;
  /** Shows `threadId` in full from now on. */
  readonly unfold: (threadId: string) => void;
}

/**
 * The long threads the person showed in full on the Threads page (Tracy Bots
 * T137): each stays in full for the session, however often the page is left
 * and shown again. Not persisted: a restart folds them again.
 */
export const useBotThreadFoldStore = create<BotThreadFoldState>()((set) => ({
  unfolded: {},
  unfold: (threadId) =>
    set((state) =>
      Object.hasOwn(state.unfolded, threadId)
        ? state
        : { unfolded: { ...state.unfolded, [threadId]: true } },
    ),
}));
