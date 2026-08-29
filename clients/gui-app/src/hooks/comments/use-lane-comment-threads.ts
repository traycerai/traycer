import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import { useEpicStore } from "@/hooks/use-epic-store";

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
 * {@link selectLaneCommentThreads} against the live epic store.
 *
 * Reads ambient context, so it belongs to a surface's WIRING layer. The
 * components under `components/comments/` take the result as a prop and read
 * no ambient context of their own, which is what keeps them mountable outside
 * an epic session - and what lets their tests exercise both sources without
 * standing up a store.
 */
export function useEpicLaneCommentThreads(
  artifactId: string,
): readonly CommentThreadWire[] | null {
  return useEpicStore((s) =>
    selectLaneCommentThreads(s.commentThreads.byArtifactId, artifactId),
  );
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
