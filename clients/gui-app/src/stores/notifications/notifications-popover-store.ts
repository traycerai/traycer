import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
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
  /** Recent-only filters, persisted: the center reopens the way the user
   * last filtered it, across opens and relaunches, on every shell. Never
   * applied to Attention. `resetFilters` remains the explicit way back to
   * the default view. */
  readonly unreadOnly: boolean;
  readonly categories: ReadonlySet<NotificationCategory>;
  readonly setOpen: (next: boolean) => void;
  /** Opens the center in the origin-unavailable state (see
   * `originUnavailable`) instead of a plain open. */
  readonly openWithOriginUnavailable: (hostLabel: string | null) => void;
  readonly setUnreadOnly: (next: boolean) => void;
  readonly toggleCategory: (category: NotificationCategory) => void;
  /** Explicit "reset filters" affordance for the filter-empty state, and -
   * now that the filters persist - the only way the view returns to its
   * default; opening the center never resets them. */
  readonly resetFilters: () => void;
}

const NOTIFICATIONS_FILTER_PERSIST_KEY = persistKey(
  STORE_KEYS.notificationsFilter,
);

// Widened read-only view so an `unknown` rehydrated value can be membership-
// tested without a cast (`ReadonlySet` is covariant in its element reads).
const CATEGORY_NAMES: ReadonlySet<string> = ALL_NOTIFICATION_CATEGORIES;

function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === "string" && CATEGORY_NAMES.has(value);
}

/**
 * Restores the persisted filter slice, defaulting any missing or malformed
 * field rather than rejecting the record wholesale. Unknown category strings
 * (a removed category from an older build) are dropped; an explicitly empty
 * persisted set is honored - the filter-empty state owns its own recovery
 * affordance (`resetFilters`).
 */
function restorePersistedFilters(persisted: unknown): {
  readonly unreadOnly: boolean;
  readonly categories: ReadonlySet<NotificationCategory>;
} {
  if (persisted === null || typeof persisted !== "object") {
    return { unreadOnly: false, categories: ALL_NOTIFICATION_CATEGORIES };
  }
  const record: Record<string, unknown> = { ...persisted };
  const categories = Array.isArray(record.categories)
    ? new Set(record.categories.filter(isNotificationCategory))
    : ALL_NOTIFICATION_CATEGORIES;
  return {
    unreadOnly: record.unreadOnly === true,
    categories,
  };
}

export const useNotificationsPopoverStore = create<NotificationsPopoverState>()(
  persist(
    (set) => ({
      open: false,
      originUnavailable: false,
      originUnavailableHostLabel: null,
      unreadOnly: false,
      categories: ALL_NOTIFICATION_CATEGORIES,
      setOpen: (next) => {
        // Open/close transitions touch only the open-cycle state; the filter
        // slice is durable and survives both directions.
        set({
          open: next,
          originUnavailable: false,
          originUnavailableHostLabel: null,
        });
      },
      openWithOriginUnavailable: (hostLabel) => {
        set({
          open: true,
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
    {
      ...basePersistOptions(NOTIFICATIONS_FILTER_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      // A `Set` does not survive JSON, so the persisted record carries the
      // categories as an array; `merge` rebuilds the Set (validating each
      // entry) on rehydrate. Only the filter slice persists - open-cycle
      // state and actions come from the initializer.
      partialize: (state) => ({
        unreadOnly: state.unreadOnly,
        categories: [...state.categories],
      }),
      merge: (persisted, current) => ({
        ...current,
        ...restorePersistedFilters(persisted),
      }),
    },
  ),
);
