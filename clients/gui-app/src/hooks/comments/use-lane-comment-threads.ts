import { useCallback, useRef, useSyncExternalStore } from "react";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

/** Both sources are permanent. Poll is on the released floor; lane push is extra. */
export type CommentThreadsSource = "state-lane" | "poll";

export interface ArtifactCommentThreads {
  /** null is unknown. Empty array is zero threads. Never render those the same way. */
  readonly threads: readonly CommentThreadWire[] | null;
  /** null exactly when threads is null. */
  readonly source: CommentThreadsSource | null;
}

/** Missing key is not an empty set. noUncheckedIndexedAccess is off, so do not use ?? null. */
export function selectLaneCommentThreads(
  byArtifactId: Readonly<Record<string, readonly CommentThreadWire[]>>,
  artifactId: string,
): readonly CommentThreadWire[] | null {
  return Object.hasOwn(byArtifactId, artifactId)
    ? byArtifactId[artifactId]
    : null;
}

/** useMaybeOpenEpicHandle: shared with mobile, which is outside EpicSessionProvider. Null means the lane has said nothing. */
export function useEpicLaneCommentThreads(
  artifactId: string,
): readonly CommentThreadWire[] | null {
  const handle = useMaybeOpenEpicHandle();
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      handle === null ? () => {} : handle.store.subscribe(onStoreChange),
    [handle],
  );
  // Snapshot is the slice array or null, never a new object.
  const getSnapshot = useCallback(
    (): readonly CommentThreadWire[] | null =>
      handle === null
        ? null
        : selectLaneCommentThreads(
            handle.store.getState().commentThreads.byArtifactId,
            artifactId,
          ),
    [handle, artifactId],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Instant, not boolean, so a poll that predates the drop cannot outrank later lane rows. Read recordsTransportStatus, not the blended hostTransportStatus. */
export function useEpicLaneCommentThreadsDroppedAt(): number | null {
  const handle = useMaybeOpenEpicHandle();
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      handle === null ? () => {} : handle.store.subscribe(onStoreChange),
    [handle],
  );
  // Cache the instant in a ref so getSnapshot is stable. Stamp on the first non-live snapshot, including remount over an already-closed lane.
  const droppedAtRef = useRef<number | null>(null);
  // Bind the stamp to this handle. EpicSessionProvider can adopt a warm store; carrying the previous instant would mis-order polls vs retained rows.
  const stampedForRef = useRef<OpenEpicStoreHandle | null>(null);
  const getSnapshot = useCallback((): number | null => {
    if (stampedForRef.current !== handle) {
      stampedForRef.current = handle;
      droppedAtRef.current = null;
    }
    const live =
      handle !== null &&
      handle.store.getState().recordsTransportStatus === "open";
    if (live) droppedAtRef.current = null;
    else droppedAtRef.current ??= Date.now();
    return droppedAtRef.current;
  }, [handle]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Live lane wins. After drop, retained lane rows keep precedence until a poll answers after laneDroppedAt. */
export function resolveArtifactCommentThreads(args: {
  readonly laneThreads: readonly CommentThreadWire[] | null;
  readonly pollThreads: readonly CommentThreadWire[] | null;
  /** When the records lane stopped pushing, or null while it is up. */
  readonly laneDroppedAt: number | null;
  /** TanStack dataUpdatedAt, or null if never answered. Same clock as laneDroppedAt. */
  readonly pollUpdatedAt: number | null;
}): ArtifactCommentThreads {
  const { laneThreads, pollThreads, laneDroppedAt, pollUpdatedAt } = args;
  if (laneThreads !== null && laneDroppedAt === null) {
    return { threads: laneThreads, source: "state-lane" };
  }
  // Strictly after: a same-millisecond poll does not outrank the lane's last frame.
  const pollAnsweredAfterDrop =
    pollUpdatedAt !== null &&
    laneDroppedAt !== null &&
    pollUpdatedAt > laneDroppedAt;
  if (pollThreads !== null && (laneThreads === null || pollAnsweredAfterDrop)) {
    return { threads: pollThreads, source: "poll" };
  }
  if (laneThreads !== null) {
    return { threads: laneThreads, source: "state-lane" };
  }
  return { threads: null, source: null };
}
