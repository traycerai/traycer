import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  basePersistOptions,
  profileTabWorkspacesKey,
} from "@/lib/persist";
import type { PersistedTabStripLayout } from "@/stores/tabs/layout";

/**
 * Per-profile tab-strip snapshots.
 *
 * v1 multi-window limitation: buckets are global (one account-scoped map),
 * last-writer-wins across windows. There is no per-window isolation of
 * profile tab workspaces.
 */
export interface ProfileTabWorkspacesState {
  /** bucketKey = profile id, or "all-projects" for the null profile. */
  readonly layoutsByBucket: Readonly<Record<string, PersistedTabStripLayout>>;
  readonly saveLayout: (
    bucket: string,
    layout: PersistedTabStripLayout,
  ) => void;
  readonly dropBucket: (bucket: string) => void;
  readonly resetForTests: () => void;
}

/** Special bucket for `activeProfileId === null` ("All projects"). */
export const ALL_PROJECTS_TAB_BUCKET = "all-projects";

export function profileTabBucket(profileId: string | null): string {
  return profileId === null ? ALL_PROJECTS_TAB_BUCKET : profileId;
}

export const useProfileTabWorkspacesStore =
  create<ProfileTabWorkspacesState>()(
    persist(
      (set) => ({
        layoutsByBucket: {},
        saveLayout: (bucket, layout) => {
          set((state) => ({
            layoutsByBucket: {
              ...state.layoutsByBucket,
              [bucket]: layout,
            },
          }));
        },
        dropBucket: (bucket) => {
          set((state) => {
            if (!(bucket in state.layoutsByBucket)) return state;
            const next: Record<string, PersistedTabStripLayout> = {
              ...state.layoutsByBucket,
            };
            delete next[bucket];
            return { layoutsByBucket: next };
          });
        },
        resetForTests: () => {
          set({ layoutsByBucket: {} });
        },
      }),
      {
        ...basePersistOptions(profileTabWorkspacesKey(null)),
        storage: createJSONStorage(() => window.localStorage),
        partialize: (state) => ({
          layoutsByBucket: state.layoutsByBucket,
        }),
      },
    ),
  );
