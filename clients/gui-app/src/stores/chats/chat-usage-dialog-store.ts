import { create } from "zustand";

export interface ChatUsageDialogTarget {
  readonly hostId: string;
  readonly chatId: string;
  readonly chatTitle: string;
}

interface ChatUsageDialogState {
  /** The chat the dialog is currently open for, or `null` when closed. Global (not tab-scoped) - the dialog is opened from the tab strip's context menu, which sits outside any one tab's own `TabHostProvider`. */
  readonly target: ChatUsageDialogTarget | null;
  readonly open: (target: ChatUsageDialogTarget) => void;
  readonly close: () => void;
}

export const useChatUsageDialogStore = create<ChatUsageDialogState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
