import { create } from "zustand";
import type { HookDraft } from "@/components/settings/panels/notification-hook-draft";

/**
 * A hook draft that survived its editor's unmount.
 *
 * The honest-state gate unmounts the hooks section whenever the scoped host
 * stops being reachable — which is correct for everything else the section
 * holds, but a TRANSIENT same-host disconnect (restart, sleep, relay blip)
 * was discarding minutes of typed hook configuration with it. This store is
 * the parking spot: the editor writes its open state here on unmount, and
 * the next mount FOR THE SAME HOST picks it back up.
 *
 * Keyed by `hostId` so the guarantee the section's remount key buys is
 * preserved exactly: a REAL host switch must destroy the draft (a draft is
 * armed against one machine's hooks file), and a restore only ever happens
 * onto the host the draft was typed for.
 *
 * Deliberately NOT persisted, and holding at most one entry: the one
 * Settings surface can only have one editor open, and a draft that outlived
 * an app relaunch would be the stale-intent problem this surface exists to
 * prevent.
 */
export interface RetainedHookDraft {
  readonly hostId: string;
  readonly editor:
    | { readonly kind: "add" }
    | { readonly kind: "edit"; readonly hookId: string };
  readonly draft: HookDraft;
}

interface NotificationHookDraftState {
  readonly retained: RetainedHookDraft | null;
  readonly retain: (value: RetainedHookDraft) => void;
  readonly clear: () => void;
}

export const useNotificationHookDraftStore = create<NotificationHookDraftState>(
  (set) => ({
    retained: null,
    retain: (value) => set({ retained: value }),
    clear: () => set({ retained: null }),
  }),
);
