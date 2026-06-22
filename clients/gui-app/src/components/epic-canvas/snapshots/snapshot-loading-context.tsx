import type { ReactNode } from "react";
import { SnapshotErrorBanner } from "@/components/epic-canvas/snapshots/snapshot-error-banner";
import {
  SnapshotLoadingContext,
  useSnapshotLoading,
  type SnapshotLoadingContextValue,
} from "@/components/epic-canvas/snapshots/snapshot-loading-context-value";

interface SnapshotLoadingProviderProps {
  readonly value: SnapshotLoadingContextValue;
  readonly children: ReactNode;
}

export function SnapshotLoadingProvider(props: SnapshotLoadingProviderProps) {
  return (
    <SnapshotLoadingContext.Provider value={props.value}>
      {props.children}
    </SnapshotLoadingContext.Provider>
  );
}

interface SnapshotGateProps {
  readonly skeleton: ReactNode;
  readonly children: ReactNode;
}

export function SnapshotGate(props: SnapshotGateProps) {
  const { snapshotLoaded, snapshotFetchError } = useSnapshotLoading();
  if (snapshotFetchError !== null) {
    return (
      <SnapshotErrorBanner error={snapshotFetchError} className={undefined} />
    );
  }
  if (!snapshotLoaded) return props.skeleton;
  return props.children;
}
