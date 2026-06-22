import { create } from "zustand";

interface NotificationsPopoverState {
  readonly open: boolean;
  readonly setOpen: (next: boolean) => void;
}

export const useNotificationsPopoverStore = create<NotificationsPopoverState>(
  (set) => ({
    open: false,
    setOpen: (next) => {
      set({ open: next });
    },
  }),
);
