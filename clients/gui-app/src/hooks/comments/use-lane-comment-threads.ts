import { useCallback, useSyncExternalStore } from "react";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";

/**
 * Which of the two sources answered for an artifact.
 *
 * Both are real, permanent sources - not a new path and a legacy one.
 * `epic.listCommentThreads` is on the released floor, so EVERY host serves the
 * poll; only lane-serving hosts also push records. A poll answer is the normal
 * case, not the degraded one.
 */
export type CommentThreadsSource = "state-lane" | "poll";

export interface ArtifactCommentThreads {
  /**
   * `null` is UNKNOWN: neither source has said anything about this artifact.
   * An empty array is a real answer - "this artifact has zero threads" - and
   * the two must never render the same way. A surface that shows "no comments"
   * off `null` asserts something no frame said.
   */
  readonly threads: readonly CommentThreadWire[] | null;
  /** `null` exactly when {@link threads} is `null`. */
  readonly source: CommentThreadsSource | null;
}

/**
 * The lane slice's answer for one artifact, or `null` when it has none.
 *
 * A MISSING key is not an empty thread set - see the `CommentThreadsSlice` doc
 * comment. On a legacy connection every key is missing, permanently, because
 * `epic.subscribe@1` carries no comment records at all; that is the field's
 * true value there, not a placeholder.
 *
 * Pure and separate from the hook below so this distinction - the whole point
 * of the slice - is pinnable without a store fixture.
 */
export function selectLaneCommentThreads(
  byArtifactId: Readonly<Record<string, readonly CommentThreadWire[]>>,
  artifactId: string,
): readonly CommentThreadWire[] | null {
  // `noUncheckedIndexedAccess` is off, so `?? null` on the index read would be
  // flagged as an unnecessary condition AND would collapse a real empty array
  // into the same answer as a missing key.
  return Object.hasOwn(byArtifactId, artifactId)
    ? byArtifactId[artifactId]
    : null;
}

/**
 * {@link selectLaneCommentThreads} against the live epic store, or `null` when
 * this surface has no epic session at all.
 *
 * Reads ambient context, so it belongs to a surface's WIRING layer. The
 * components under `components/comments/` take the result as a prop and read
 * no ambient context of their own, which is what keeps them mountable outside
 * an epic session - and what lets their tests exercise both sources without
 * standing up a store.
 *
 * `useMaybeOpenEpicHandle` rather than `useEpicStore`, which THROWS outside a
 * provider. `CommentSidebarPanel` is deliberately shared between the desktop
 * left panel and the mobile switcher's comments category, and only the first
 * of those is inside an `EpicSessionProvider` today - so a hook that throws
 * takes the whole mobile surface down rather than degrading it.
 *
 * Returning `null` is not a special case invented for that: `null` is already
 * this function's word for "the lane has said nothing about this artifact",
 * and no epic session is the purest instance of it. The poll is on the
 * released floor and answers for every host, so the surface renders comments
 * from the source it would have used anyway. Same resolution, and the same
 * reasoning, as `use-chat-write-route.ts`'s session tolerance.
 */
export function useEpicLaneCommentThreads(
  artifactId: string,
): readonly CommentThreadWire[] | null {
  const handle = useMaybeOpenEpicHandle();
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      handle === null ? () => {} : handle.store.subscribe(onStoreChange),
    [handle],
  );
  // Returns either the array the slice already holds or `null` - never a fresh
  // object - so `useSyncExternalStore` sees a stable snapshot.
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

/**
 * Picks the source that has actually spoken about this artifact.
 *
 * Lane first when present: it is pushed, so it is the fresher of the two by
 * construction. Otherwise the poll's last successful snapshot, which is what
 * every host can serve and what a legacy connection has always used. Unknown
 * only when NEITHER has an answer - a lane silence beside a loaded poll is not
 * unknown, and a poll error beside lane rows is not unknown either.
 *
 * Pure, and shared by every comment surface, so the sidebar, the hover preview
 * and the tile's decoration layer can never disagree about which threads exist
 * for the artifact they are all rendering.
 */
export function resolveArtifactCommentThreads(args: {
  readonly laneThreads: readonly CommentThreadWire[] | null;
  readonly pollThreads: readonly CommentThreadWire[] | null;
}): ArtifactCommentThreads {
  if (args.laneThreads !== null) {
    return { threads: args.laneThreads, source: "state-lane" };
  }
  if (args.pollThreads !== null) {
    return { threads: args.pollThreads, source: "poll" };
  }
  return { threads: null, source: null };
}
