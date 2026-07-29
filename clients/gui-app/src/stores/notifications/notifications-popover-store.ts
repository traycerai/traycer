import { create } from "zustand";
import {
  ALL_NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "@/lib/notifications/notification-category";

interface NotificationsPopoverState {
  readonly open: boolean;
  /** One-open-cycle banner set when a native click's origin host no longer
   * matches the active host: the center opens instead of routing/
   * acknowledging/switching. `originUnavailableHostLabel` carries the
   * resolved host label when the directory has one, `null` when it doesn't -
   * distinct from `originUnavailable` itself being `false` (banner not
   * shown at all). Cleared on every subsequent open/close transition. */
  readonly originUnavailable: boolean;
  readonly originUnavailableHostLabel: string | null;
  /** Recent-only open-session filters. Reset to defaults on every open -
   * including a programmatic fallback open - never persisted, and never
   * applied to Attention. */
  readonly unreadOnly: boolean;
  readonly categories: ReadonlySet<NotificationCategory>;
  readonly setOpen: (next: boolean) => void;
  /** Opens the center in the origin-unavailable state (see
   * `originUnavailable`) instead of a plain open. */
  readonly openWithOriginUnavailable: (hostLabel: string | null) => void;
  readonly setUnreadOnly: (next: boolean) => void;
  readonly toggleCategory: (category: NotificationCategory) => void;
  /** Explicit "reset filters" affordance for the filter-empty state - the
   * same default the session applies automatically on open, exposed so the
   * user can recover from an all-filtered-out Recent view without closing
   * and reopening the center. */
  readonly resetFilters: () => void;
}

export const useNotificationsPopoverStore = create<NotificationsPopoverState>(
  (set) => ({
    open: false,
    originUnavailable: false,
    originUnavailableHostLabel: null,
    unreadOnly: false,
    categories: ALL_NOTIFICATION_CATEGORIES,
    setOpen: (next) => {
      set(
        next
          ? {
              open: next,
              unreadOnly: false,
              categories: ALL_NOTIFICATION_CATEGORIES,
              originUnavailable: false,
              originUnavailableHostLabel: null,
            }
          : {
              open: next,
              originUnavailable: false,
              originUnavailableHostLabel: null,
            },
      );
    },
    openWithOriginUnavailable: (hostLabel) => {
      set({
        open: true,
        unreadOnly: false,
        categories: ALL_NOTIFICATION_CATEGORIES,
        originUnavailable: true,
        originUnavailableHostLabel: hostLabel,
      });
    },
    setUnreadOnly: (next) => {
      set({ unreadOnly: next });
    },
    toggleCategory: (category) => {
      set((state) => {
        const next = new Set(state.categories);
        if (next.has(category)) {
          next.delete(category);
        } else {
          next.add(category);
        }
        return { categories: next };
      });
    },
    resetFilters: () => {
      set({ unreadOnly: false, categories: ALL_NOTIFICATION_CATEGORIES });
    },
  }),
);
