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
// The mounted runtime bridge (`RunnerHostBridges`) subscribes through
// `useNotificationClick` and routes each payload here. The mounted
// `NotificationFocusBridge` then parses `notificationEvent` and drives a
// real TanStack Router navigation so shell-owned code stays out of the
// runner.
//
// `receivedAt` advances on every click so a repeat click of the same
// payload still triggers an observable navigation (the timestamp becomes a
// search param and the routed view re-renders).
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
