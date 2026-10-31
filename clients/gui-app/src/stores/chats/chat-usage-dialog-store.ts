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

/**
 * Ticket 12's chat cost line: the tab strip's "Usage" context-menu item opens
 * this dialog by writing its target here, and `<ChatUsageDialog>` (mounted
 * once, host-agnostic until a target is set) reads it. A store rather than
 * component state because the trigger (tab strip) and the display (mounted
 * elsewhere so it can resolve an explicit, possibly non-active, `hostId` via
 * `useHostClientForHostId`) are not in the same subtree.
 */
export const useChatUsageDialogStore = create<ChatUsageDialogState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
