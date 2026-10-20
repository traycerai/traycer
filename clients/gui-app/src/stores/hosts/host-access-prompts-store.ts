import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Two one-time prompts on a host's Overview, remembered per host id on this
 * desktop (the wire carries no "asked" flag, so another desktop, or this one
 * after its storage is cleared, asks again):
 *
 * - the Remote access question, answered by On or Not now;
 * - "Your settings moved to Personal. Review what changed.", dismissed.
 */
interface HostAccessPromptsStore {
  readonly remoteAccessAnswered: Readonly<Partial<Record<string, true>>>;
  readonly movedNoticeDismissed: Readonly<Partial<Record<string, true>>>;
  readonly answerRemoteAccess: (hostId: string) => void;
  readonly dismissMovedNotice: (hostId: string) => void;
}

export const useHostAccessPromptsStore = create<HostAccessPromptsStore>()(
  persist(
    (set) => ({
      remoteAccessAnswered: {},
      movedNoticeDismissed: {},
      answerRemoteAccess: (hostId) => {
        set((state) => ({
          remoteAccessAnswered: {
            ...state.remoteAccessAnswered,
            [hostId]: true,
          },
        }));
      },
      dismissMovedNotice: (hostId) => {
        set((state) => ({
          movedNoticeDismissed: {
            ...state.movedNoticeDismissed,
            [hostId]: true,
          },
        }));
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.hostAccessPrompts)),
      partialize: (state) => ({
        remoteAccessAnswered: state.remoteAccessAnswered,
        movedNoticeDismissed: state.movedNoticeDismissed,
      }),
    },
  ),
);
