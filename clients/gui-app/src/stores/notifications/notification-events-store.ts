import { create } from "zustand";

export interface NotificationClickEvent {
  readonly payload: unknown;
  readonly receivedAt: number;
  readonly openPopover: boolean;
}

interface NotificationEventsState {
  readonly notificationEvent: NotificationClickEvent | null;
  readonly recordClick: (payload: unknown) => void;
  readonly recordInAppClick: (payload: unknown, receivedAt: number) => void;
  readonly clear: () => void;
}

// Sink for native notification-click payloads surfaced by `IRunnerHost`.
export const useNotificationEventsStore = create<NotificationEventsState>(
  (set) => ({
    notificationEvent: null,
    recordClick: (payload) => {
      set({
        notificationEvent: {
          payload,
          receivedAt: Date.now(),
          openPopover: true,
        },
      });
    },
    recordInAppClick: (payload, receivedAt) => {
      set({
        notificationEvent: { payload, receivedAt, openPopover: false },
      });
    },
    clear: () => {
      set({ notificationEvent: null });
    },
  }),
);
