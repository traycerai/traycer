import { createContext, use } from "react";
import type { SnapshotFetchError } from "@/stores/epics/open-epic/store";

export interface SnapshotLoadingContextValue {
  readonly snapshotLoaded: boolean;
  readonly snapshotFetchError: SnapshotFetchError | null;
}

export const SnapshotLoadingContext =
  createContext<SnapshotLoadingContextValue | null>(null);

export function useSnapshotLoading(): SnapshotLoadingContextValue {
  const ctx = use(SnapshotLoadingContext);
  if (ctx === null) {
    throw new Error(
      "useSnapshotLoading must be used inside <SnapshotLoadingProvider>",
    );
  }
  return ctx;
}
