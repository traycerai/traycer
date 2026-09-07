import { useCallback, useRef, useSyncExternalStore } from "react";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

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
 * WHEN this surface's state lane stopped pushing, for
 * {@link resolveArtifactCommentThreads}'s `laneDroppedAt`. `null` means it is
 * pushing right now.
 *
 * An INSTANT rather than the boolean this used to return, and the two are not
 * different information: the lane is live exactly when there is no drop
 * instant, so `laneDroppedAt === null` is the old `laneLive`. What the instant
 * adds is the ability to ORDER the two sources once the lane is down - see the
 * resolver, where a poll answer that predates the drop must not outrank the
 * rows the lane pushed after it.
 *
 * `recordsTransportStatus === "open"` - the RECORDS lane's own liveness, not
 * the blended `hostTransportStatus`.
 *
 * It used to read the blended slot, on the reasoning that the sync pill's
 * reconnecting arm reads it too (`lib/epic-sync-pill-state.ts`) and that a
 * comment list believing the lane while the pill said reconnecting would be
 * two answers to one question. The pill and this predicate turn out to be
 * asking DIFFERENT questions: the pill asks whether the session is connected,
 * where every lane's transition counts, while this asks whether the rows
 * below are still arriving. The blended slot is last-writer-wins across lanes,
 * so a records lane reconnecting under a live status lane still reported
 * `open` here and kept stale rows ahead of a refreshed poll.
 *
 * Outside an epic session there is no lane, so this stamps a drop at mount and
 * never clears it - matching {@link useEpicLaneCommentThreads}'s `null` and
 * letting the poll, which answers for every host, win unconditionally.
 */
export function useEpicLaneCommentThreadsDroppedAt(): number | null {
  const handle = useMaybeOpenEpicHandle();
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      handle === null ? () => {} : handle.store.subscribe(onStoreChange),
    [handle],
  );
  // The store holds a STATUS, not its history, so the instant is derived here.
  // It lives in a ref rather than in state because `useSyncExternalStore`'s
  // contract is the one that wants it: `getSnapshot` must return the SAME
  // value while nothing has changed, and a fresh `Date.now()` per call would
  // loop the render forever. Caching into the ref is what makes it stable, and
  // it is the same shape React's own docs use to keep a derived snapshot's
  // identity - not a way to sneak a write into render, since every call
  // computes the same answer from the store's own state.
  //
  // The alternative, a transition effect, is what this replaced: the lint
  // forbids a synchronous `setState` in an effect body, and it is right to -
  // that shape also renders twice per drop for a value the snapshot already
  // knows.
  //
  // Stamped on the FIRST snapshot when the lane is not already pushing, not
  // only on a transition observed while mounted. A remount over a session
  // whose lane closed earlier finds a `closed` status beside a lane slice that
  // still holds rows; treating that as "never dropped" would put those rows
  // back in front of every poll, which is the same bug one layer up.
  //
  // `recordsTransportStatus`, NOT the blended `hostTransportStatus`. The
  // blended slot is written by every lane that reports a transition - correct
  // for the close policy, wrong here - so a records lane that is reconnecting
  // under a still-open status lane read `open`, and retained stale lane rows
  // went on outranking a poll that had already refreshed. The rows this
  // predicate orders come from the records lane, so its liveness is the one
  // that decides.
  const droppedAtRef = useRef<number | null>(null);
  // The handle the instant above was stamped FOR. Without it the ref outlives
  // the `useCallback` and carries one session's instant into the next.
  //
  // That used to be argued harmless - "the new store's lane slice has said
  // nothing about the artifact yet, so the resolver takes the poll on its
  // 'nothing to outrank' arm regardless". The premise is what fails:
  // `EpicSessionProvider` can adopt an already-WARM handle, whose store
  // arrives holding retained lane rows, so the new slice HAS spoken. The
  // carried instant then sits between the old handle's drop and the new one's,
  // and a poll that answered in that window is ordered as older than rows it
  // is actually newer than - which is how a thread deleted in the replacement
  // session comes back.
  const stampedForRef = useRef<OpenEpicStoreHandle | null>(null);
  const getSnapshot = useCallback((): number | null => {
    if (stampedForRef.current !== handle) {
      stampedForRef.current = handle;
      // Re-derived below from THIS handle's status, on this same call, so the
      // snapshot stays stable for the reader - the reset is never observable
      // as an intermediate value.
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

/**
 * Picks the source that has actually spoken about this artifact.
 *
 * Lane first WHILE IT IS LIVE: it is pushed, so it is the fresher of the two
 * by construction - but only while the transport pushing it is up. Otherwise
 * the poll's last successful snapshot, which is what every host can serve and
 * what a legacy connection has always used. Unknown only when NEITHER has an
 * answer - a lane silence beside a loaded poll is not unknown, and a poll
 * error beside lane rows is not unknown either.
 *
 * The drop is an ORDERING input, not a clearing one, and the distinction is
 * the whole point. Retaining lane rows across a flaky connection is a
 * documented goal (`state-subscribe.ts`), so a dropped lane still answers when
 * it is the only source with rows - the third arm below. What changes is that
 * a poll answer with a strictly newer view no longer loses to rows whose
 * pusher is gone. The two transports are separate (`/rpc` and `/stream`), and
 * mutations invalidate only the poll cache, so the window where the poll is
 * ahead is reachable rather than theoretical.
 *
 * NEWER MEANS TIMED, NOT MERELY PRESENT. The poll's arm used to fire on
 * `pollThreads !== null` alone, which reads a cache of ANY age as fresher than
 * the lane simply because it exists - and the writer that makes those two
 * disagree is a REMOTE one. Another client deleting a thread reaches this
 * surface over the lane and invalidates nothing here, because this surface did
 * not mutate; the poll cache keeps its pre-deletion snapshot for as long as
 * TanStack's stale window and focus rule allow. While the lane was up the
 * ordering hid that. The moment it dropped, the old cache was selected and the
 * deleted thread came back - a resurrection produced by a transport event, on
 * a surface where nothing had changed.
 *
 * So a retained lane keeps precedence until the poll has answered SINCE the
 * drop - and the poll has to be able to answer, which is what this rule's
 * first version got wrong. It justified having no lane-triggered refetch by
 * saying the query "already refetches on window focus and after its stale
 * window". The second half was never true: `staleTime` marks data stale, it
 * does not SCHEDULE a request, and a lane-status transition invalidates
 * nothing. On a continuously focused window with a permanently dead lane the
 * poll therefore never ran again, and this rule waited on an event that could
 * not arrive - freezing remote additions, deletions and status changes behind
 * retained rows, which is the resurrection above arriving by the other road.
 *
 * The lane's liveness now reaches the query, which polls while the lane is
 * down - see `commentThreadsShouldPoll` in `use-epic-comment-threads.ts`.
 * Retention is unchanged and still deliberate: the rows on screen remain the
 * last thing the lane said, and they hold precedence until a poll genuinely
 * answers later. What changed is that "later" is now bounded.
 *
 * Pure, and shared by every comment surface, so the sidebar, the hover preview
 * and the tile's decoration layer can never disagree about which threads exist
 * for the artifact they are all rendering.
 */
export function resolveArtifactCommentThreads(args: {
  readonly laneThreads: readonly CommentThreadWire[] | null;
  readonly pollThreads: readonly CommentThreadWire[] | null;
  /**
   * When the state lane's transport stopped pushing, or `null` while it is up.
   * See {@link useEpicLaneCommentThreadsDroppedAt}.
   */
  readonly laneDroppedAt: number | null;
  /**
   * When the poll last answered - TanStack's `dataUpdatedAt` - or `null` when
   * it never has. Compared against {@link laneDroppedAt}, so both must come
   * from the same clock; both are `Date.now()` in this renderer.
   */
  readonly pollUpdatedAt: number | null;
}): ArtifactCommentThreads {
  const { laneThreads, pollThreads, laneDroppedAt, pollUpdatedAt } = args;
  if (laneThreads !== null && laneDroppedAt === null) {
    return { threads: laneThreads, source: "state-lane" };
  }
  // Strictly after, so a poll that answered in the same millisecond as the
  // drop does not count: the lane's last frame is the later fact at that tie,
  // and the retention default is the safe side of it.
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
