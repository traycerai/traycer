import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { SANDBOX_SCROLL_GESTURE_EVENT } from "@/lib/sandbox/bridge-host";

/** Matches the library's own strict-edge tolerance (`EDGE_POSITION_EPSILON`
 *  in `@legendapp/list`), so "at the strict bottom" means the same thing on
 *  both sides. */
export const CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX = 1;

/** The class `@legendapp/list` gives the element it sizes to the content,
 *  the scroll node's child. Not exported; the library finds it by this too. */
const LEGEND_LIST_CONTENT_CONTAINER_CLASS = "legend-list-content-container";

export interface ChatTimelineScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * A `display:none` (or not-yet-laid-out) pane reports `scrollTop=
 * scrollHeight=clientHeight=0`. That is UNKNOWN geometry, never a confirmed
 * edge - treating it as "at the bottom" would let a restored free-reading
 * position get silently overwritten the moment the pane becomes visible
 * again (fixup review P1 finding 3).
 */
export function isChatTimelineGeometryMeasurable(
  geometry: ChatTimelineScrollGeometry,
): boolean {
  return geometry.clientHeight > 0;
}

export function isChatTimelineAtStrictBottom(
  geometry: ChatTimelineScrollGeometry,
): boolean {
  return (
    geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight <=
    CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
  );
}

export interface ChatTimelineFollowLatch {
  /**
   * Reconciles fresh strict-bottom geometry, otherwise re-issues
   * `list.scrollToEnd()` iff the latch currently grants permission. Call this
   * from every real LegendList maintain trigger (data change, item resize,
   * footer/header resize, viewport resize, content-inset change) - never from
   * a component's render body.
   */
  readonly followEndIfPermitted: () => void;
  /** Explicit controller transition (pill click / navigation fallback). */
  readonly setFollowIntent: (isFollowing: boolean) => void;
  /** Cancels any app-owned correction and supersedes a pending LegendList
   *  end command before a real reader gesture. */
  readonly noteReaderGesture: (intent: ChatTimelineReaderGestureIntent) => void;
  /** Owns an explicit animated/non-animated "go live" operation. */
  readonly beginOwnedEndNavigation: () => void;
  /** Arms an explicit programmatic navigation to publish free-scrolling only
   *  if its live geometry actually leaves the strict bottom. */
  readonly beginOwnedFreeNavigation: () => void;
  /** Releases a settled no-op free navigation that never left the strict end. */
  readonly completeOwnedFreeNavigation: () => void;
  /** Releases a free navigation cancelled with no landing to decide; whatever
   *  cancelled it decides the view. */
  readonly cancelOwnedFreeNavigation: () => void;
  /** Resolves owned navigation without letting its intermediate reports flap. */
  readonly completeOwnedEndNavigation: (didLandAtEnd: boolean) => void;
  /** Fresh DOM validation for explicit-navigation settle loops. */
  readonly isAtStrictEnd: () => boolean;
  /** Whether an end correction's LegendList `scrollToEnd` is still queued or
   *  in flight - geometry the library has yet to apply. */
  readonly hasPendingEndCorrection: () => boolean;
  /** Routes every native or library scroll report through this authority. */
  readonly observeLiveGeometry: () => void;
}

export type ChatTimelineReaderScrollDirection =
  | "away-from-end"
  | "toward-end"
  | "indeterminate";

export interface ChatTimelineReaderGestureIntent {
  readonly direction: ChatTimelineReaderScrollDirection;
  readonly freezeInFlightScroll: boolean;
  readonly publishesReaderPosition: boolean;
}

interface ActiveEndCorrection {
  readonly generation: number;
  readonly readerGestureGeneration: number;
  attempts: number;
  animationFrameId: number | null;
}

interface ListRowTop {
  readonly key: string;
  readonly top: number;
}

interface ReaderEndCandidate {
  readonly readerGestureGeneration: number;
  readonly targetScrollTop: number;
  /** The list's last row when the gesture began. Rows above the reader that
   *  the list remeasures since move it, and the list moves the reader with
   *  them, so the end the gesture headed for has moved by the same amount. */
  readonly lastRow: ListRowTop | null;
  /** The reader reached the strict bottom while a recovering transcript held
   *  reattachment off; the settle that lifts the hold lets them follow. */
  readonly reached: boolean;
}

/** The end a lifted finger's momentum can reach, as the latest observation
 *  saw it. Every move of the end passes a maintain trigger or a scroll
 *  report, which records the end it sees, so the next observation can tell
 *  the momentum reached this one even after a chunk has moved it on. */
interface ReaderMomentumEnd {
  readonly targetScrollTop: number;
  /** As `ReaderEndCandidate.lastRow`: rows above that the list remeasures
   *  move the reader with them, and this end by as much. */
  readonly lastRow: ListRowTop | null;
}

type ArmedReaderDeparture =
  | {
      readonly source: "gesture";
      readonly direction: ChatTimelineReaderScrollDirection;
      /** False when fresh issue-time geometry proves this gesture cannot move
       *  in its requested direction (for example, wheel-up at scrollTop=0). */
      readonly blocksAutomaticCorrection: boolean;
      /** Live geometry at the gesture's event; null when unmeasurable. Its
       *  own movement is measured from here. */
      readonly geometryAtGesture: ChatTimelineScrollGeometry | null;
    }
  | { readonly source: "owned-navigation" }
  | {
      /** A finger is on the transcript. Armed at `touchstart`, released at
       *  `touchend`/`touchcancel`, and never by a pointer edge or a strict-
       *  bottom report: iOS WebKit stops delivering `touchmove` (and fires
       *  `pointercancel` at once) when its native pan owns the touch, so the
       *  contact itself is the only reader evidence the page can count on. */
      readonly source: "touch";
      /** Fresh `scrollTop` at contact. A later report that moved past it is
       *  the reader's; one that did not is a tap. */
      readonly scrollTopAtContact: number;
    }
  | null;

/** One immediate issue plus four measured reissues, each after two frames.
 *  Exhaustion ends only the current correction burst; reader intent is never
 *  inferred from a layout operation failing to settle inside this window. */
export const CHAT_TIMELINE_FOLLOW_CORRECTION_MAX_ATTEMPTS = 5;

interface ChatTimelineFollowLatchOptions {
  readonly onFollowIntentChange: ((isFollowing: boolean) => void) | undefined;
  readonly onReaderGesture:
    | ((intent: ChatTimelineReaderGestureIntent) => void)
    | undefined;
  readonly isCorrectionSuppressed: (() => boolean) | undefined;
  readonly resolveSuppressedEndLanding: (() => boolean) | undefined;
  /**
   * True while the transcript is structurally recovering (a void, a carried
   * skeleton, a key-sequence commit whose layout has not settled). Its
   * strict-bottom landings are the list's, not the reader's, so they must not
   * grant follow to a detached reader. Reader evidence - a touch reaching the
   * tail, a reader end candidate, explicit go-live - still grants, and a
   * reader already following is unaffected, which is what separates this from
   * `isCorrectionSuppressed`.
   */
  readonly isReattachSuppressed: (() => boolean) | undefined;
}

function readScrollGeometry(node: HTMLElement): ChatTimelineScrollGeometry {
  return {
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  };
}

function armBlocksAutomaticCorrection(arm: ArmedReaderDeparture): boolean {
  if (arm === null) return false;
  if (arm.source === "gesture") return arm.blocksAutomaticCorrection;
  return true;
}

/** The arm a gesture outside a touch contact leaves: none for one that
 *  publishes no reading position, or that continues follow. */
function readerGestureArm(
  intent: ChatTimelineReaderGestureIntent,
  continuesFollow: boolean,
  blocksAutomaticCorrection: boolean,
  geometryAtGesture: ChatTimelineScrollGeometry | null,
): ArmedReaderDeparture {
  if (!intent.publishesReaderPosition || continuesFollow) return null;
  return {
    source: "gesture",
    direction: intent.direction,
    // Unknown/hidden geometry cannot safely prove a no-op. When it is
    // measurable, an edge-directed gesture that cannot move must not strand
    // follow if no native scroll event is emitted.
    blocksAutomaticCorrection,
    geometryAtGesture,
  };
}

function distanceFromEnd(geometry: ChatTimelineScrollGeometry): number {
  return geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop;
}

/**
 * Whether strict-bottom geometry ends a gesture's arm: one that cannot move
 * the view, or one whose own movement it shows - the view moved up from
 * where the gesture began and away from the end, without leaving the edge's
 * epsilon. Nothing else is the gesture's: a clamp lowers the offset with the
 * end, growth moves the end alone, and a report queued by an earlier write,
 * or one that comes before a smooth scroll's first frame, has not moved the
 * view at all. A movable gesture with no such evidence keeps its arm until
 * its scroll reports or the next reader input replaces it: a browser that
 * scrolls a wheel frames after its event has no bound to wait out.
 */
function strictBottomReleasesGestureArm(
  arm: ArmedReaderDeparture,
  geometry: ChatTimelineScrollGeometry,
): boolean {
  if (arm?.source !== "gesture") return false;
  if (!arm.blocksAutomaticCorrection) return true;
  const start = arm.geometryAtGesture;
  return (
    start !== null &&
    geometry.scrollTop < start.scrollTop &&
    distanceFromEnd(geometry) > distanceFromEnd(start)
  );
}

/** Whether a nested scroller between the wheel's target and the transcript
 *  takes it: the browser scrolls that element, and the transcript does not
 *  move. */
function nestedScrollerTakesWheel(
  target: EventTarget | null,
  scrollNode: HTMLElement,
  direction: ChatTimelineReaderScrollDirection,
): boolean {
  for (
    let element = target instanceof Element ? target : null;
    element !== null && element !== scrollNode;
    element = element.parentElement
  ) {
    const { overflowY } = getComputedStyle(element);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (
      direction === "away-from-end"
        ? element.scrollTop > 0
        : element.scrollHeight - element.clientHeight - element.scrollTop > 0
    ) {
      return true;
    }
  }
  return false;
}

/** The end a toward-end gesture may reattach at by reaching it. None under a
 *  touch contact: the end recorded there goes stale as streaming grows the
 *  tail, and the finger crossing that old offset while still above the live
 *  end would reattach and start a correction under the finger. A contact
 *  reattaches only at the live strict end (`reconcileStrictBottom`). */
function readerEndCandidateFor(input: {
  readonly direction: ChatTimelineReaderScrollDirection;
  readonly geometry: ChatTimelineScrollGeometry | null;
  readonly arm: ArmedReaderDeparture;
  readonly readerGestureGeneration: number;
  readonly list: LegendListRef | null;
}): ReaderEndCandidate | null {
  const { geometry } = input;
  if (
    input.direction !== "toward-end" ||
    input.arm?.source === "touch" ||
    geometry === null ||
    !isChatTimelineGeometryMeasurable(geometry)
  ) {
    return null;
  }
  return {
    readerGestureGeneration: input.readerGestureGeneration,
    targetScrollTop: Math.max(0, geometry.scrollHeight - geometry.clientHeight),
    lastRow: lastListRowTop(input.list),
    reached: false,
  };
}

/** The current gesture's end candidate, marked as reached; none for an
 *  earlier gesture's. */
function reachedReaderEnd(
  candidate: ReaderEndCandidate | null,
  readerGestureGeneration: number,
): ReaderEndCandidate | null {
  if (candidate?.readerGestureGeneration !== readerGestureGeneration) {
    return null;
  }
  return { ...candidate, reached: true };
}

function lastListRowTop(list: LegendListRef | null): ListRowTop | null {
  if (list === null) return null;
  const state = list.getState();
  const last = state.data.length - 1;
  if (last < 0) return null;
  const top = state.positionAtIndex(last);
  return typeof top === "number" ? { key: state.keyAtIndex(last), top } : null;
}

function readerMomentumEndFor(
  geometry: ChatTimelineScrollGeometry,
  list: LegendListRef | null,
): ReaderMomentumEnd {
  return {
    targetScrollTop: Math.max(0, geometry.scrollHeight - geometry.clientHeight),
    lastRow: lastListRowTop(list),
  };
}

/** How far the list has moved a row since its recorded top; zero once the
 *  row is gone. */
function listRowShift(
  list: LegendListRef | null,
  row: ListRowTop | null,
): number {
  if (list === null || row === null) return 0;
  const top = list.getState().positionByKey(row.key);
  return top === undefined ? 0 : top - row.top;
}

/** Whether a report is at an offset other than the one a reader departure
 *  was published at: the departing gesture's own scroll, or anything after. */
function reportMovedFromDeparture(
  departedAtScrollTop: number | null,
  scrollTop: number,
): boolean {
  return (
    departedAtScrollTop !== null &&
    Math.abs(scrollTop - departedAtScrollTop) >
      CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
  );
}

function canReaderGestureMove(
  geometry: ChatTimelineScrollGeometry,
  direction: ChatTimelineReaderScrollDirection,
): boolean {
  if (direction === "indeterminate") return true;
  if (direction === "away-from-end") return geometry.scrollTop > 0;
  return geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop > 0;
}

/**
 * Fixup (fix-detached-streaming-yank/callback-synchronous-follow): replaces
 * the rejected render-gated `maintainScrollAtEnd` design entirely.
 *
 * The installed `@legendapp/list` source shows every one of its own
 * `doMaintainScrollAtEnd` call sites (data change, item-layout, footer-
 * layout, viewport-layout) gates on `state.props.maintainScrollAtEnd` being
 * truthy, then reads a CACHED `isWithinMaintainScrollAtEndThreshold` signal
 * that only the library's own (rAF-coalesced) scroll processing refreshes -
 * never a fresh geometry read. A previous fix tried to keep the library's
 * own `maintainScrollAtEnd` and gate the PROP value by a React-render-time
 * check; review rejected it for three independent reasons: (1) item-size,
 * footer-size, and viewport-layout measurement all call
 * `doMaintainScrollAtEnd` directly, with no intervening `ChatTimeline`
 * render to re-evaluate a render-gated prop; (2) a numeric "did scrollTop
 * decrease since some remembered baseline" heuristic is not sound bottom
 * ownership - a reader can detach, drift downward without ever reaching the
 * edge, and still read as "following" against a stale baseline; (3) mutating
 * a ref inside a `useSyncExternalStore` snapshot is impure and can retain
 * state from an abandoned/retried render.
 *
 * This version disables the library's own `maintainScrollAtEnd` UNCONDITIONALLY
 * (chat-timeline.tsx never passes it at all) - since every one of the library's
 * own call sites already no-ops when that prop is falsy, this makes
 * `doMaintainScrollAtEnd` categorically unreachable from ANY of those four
 * triggers, independent of render timing or cache freshness. Bottom-follow is
 * reimplemented here instead, owned entirely by the app:
 *
 * - `permissionRef` is the single live follow authority. Native and LegendList
 *   scroll delivery both route through the same fresh DOM geometry observer.
 *   A non-bottom report revokes permission only when publishing reader input
 *   armed it; layout-owned scroll reports retain the current intent. While a
 *   movable gesture or owned free navigation is armed, maintain callbacks
 *   cannot create a correction that races and masks its pending scroll.
 *   `initialScrollAtEnd` seeds the ref once and never resets it.
 * - An app-owned correction carries a generation and reader-gesture token.
 *   Its intermediate non-bottom scroll reports cannot revoke permission;
 *   validation reissues after two-frame measurement windows with a bounded
 *   retry budget. Wheel/touch/key/pointer intent cancels ownership before its
 *   scroll report. A movable publishing gesture also cancels any pending
 *   LegendList `scrollToEnd` so a queued end command cannot restore the tail
 *   before or after that report. Scroll direction during an owned
 *   correction is never used as reader-intent evidence because MVCP,
 *   ResizeObserver delivery, browser clamping, and content-inset compensation
 *   can all move `scrollTop` in the opposite direction without reader input.
 * - A touch arms at `touchstart`, not at `touchmove`. iOS WebKit hands the
 *   touch to its native pan and stops delivering `touchmove` to the page
 *   (`pointercancel` fires at once), and a touch that lands during a fling
 *   fires no touch or pointer event at all; the page only ever sees the
 *   `scroll` reports. With no arm those reports read as layout-owned, the
 *   latch corrects toward the tail, and because iOS ignores a `scrollTop`
 *   write while a finger is down the correction lands only after the lift -
 *   or, with permission still held, on the next message. So a finger on the
 *   transcript blocks automatic correction for as long as it is down; a
 *   report that moved past the contact offset detaches, and a lift that
 *   never moved releases the arm as a tap. A delivered `touchmove` publishes
 *   its direction without ending the contact.
 * - `followEndIfPermitted` is the one automatic path that turns permission
 *   into an actual scroll. Explicit go-live navigation declares its own
 *   ownership through the same latch and uses the same fresh-DOM authority.
 *   Every real maintain trigger funnels through `followEndIfPermitted` - see
 *   `chat-timeline.tsx`'s wiring.
 * - Both the listener and the observer skip unmeasurable geometry
 *   (`clientHeight === 0`, e.g. a `display:none` pane) rather than treating it
 *   as a confirmed edge - the permission ref is simply left as whatever it
 *   last legitimately was.
 *
 * Nothing here reads or writes `permissionRef` during render - the ref is
 * only ever touched inside an event handler (`scroll`/`ResizeObserver`
 * callback) or an effect, so there is no "which speculative render committed
 * this write" ambiguity for React to retry or abandon.
 */
export function useChatTimelineFollowLatch(
  listRef: RefObject<LegendListRef | null>,
  initialScrollAtEnd: boolean,
  hasRows: boolean,
  options: ChatTimelineFollowLatchOptions,
): ChatTimelineFollowLatch {
  const {
    onFollowIntentChange,
    onReaderGesture,
    isCorrectionSuppressed,
    resolveSuppressedEndLanding,
    isReattachSuppressed,
  } = options;
  const permissionRef = useRef(initialScrollAtEnd);
  const [scrollNode, setScrollNode] = useState<HTMLElement | null>(null);
  const onFollowIntentChangeRef = useRef(onFollowIntentChange);
  const onReaderGestureRef = useRef(onReaderGesture);
  const correctionGenerationRef = useRef(0);
  const readerGestureGenerationRef = useRef(0);
  // Where a reader's own departure was published, until a report at another
  // offset arrives. The report that published it may be the first of a
  // scroll still moving the view (a smooth wheel scroll lands over several
  // frames); until the next one, the list clamping its end to meet that
  // offset is not the reader returning.
  const readerDepartureScrollTopRef = useRef<number | null>(null);
  const armedReaderDepartureRef = useRef<ArmedReaderDeparture>(null);
  const activeCorrectionRef = useRef<ActiveEndCorrection | null>(null);
  const pendingEndCorrectionScrollRef = useRef<Promise<void> | null>(null);
  const readerEndCandidateRef = useRef<ReaderEndCandidate | null>(null);
  // From a touch lift until the next reader input or owned navigation: the
  // momentum after the lift is the reader's own motion, with no touch event
  // to say where it is heading.
  const readerMomentumEndRef = useRef<ReaderMomentumEnd | null>(null);
  const lastTouchClientYRef = useRef<number | null>(null);
  // Whether an owned free navigation still owns the view: from its begin
  // until its completion, reader input, an end navigation or unmount. Its
  // arm cannot say so - the navigation's own first report may consume it.
  const ownsFreeNavigationRef = useRef(false);

  useLayoutEffect(
    () => () => {
      ownsFreeNavigationRef.current = false;
    },
    [],
  );

  useLayoutEffect(() => {
    onFollowIntentChangeRef.current = onFollowIntentChange;
  }, [onFollowIntentChange]);

  useLayoutEffect(() => {
    onReaderGestureRef.current = onReaderGesture;
  }, [onReaderGesture]);

  const cancelActiveCorrection = useCallback((): void => {
    const correction = activeCorrectionRef.current;
    if (correction !== null && correction.animationFrameId !== null) {
      cancelAnimationFrame(correction.animationFrameId);
    }
    activeCorrectionRef.current = null;
  }, []);

  // LegendList holds a correction's scrollToEnd behind data/layout readiness,
  // and clearing retry bookkeeping does not retire it. Cancel it, and write
  // nothing: an offset command would be held the same way, then land the
  // offset read here over wherever the reader has moved since.
  //
  // A pending end correction is the command the list holds: a newer command
  // or a cancel settles it at once, and its continuation clears this record
  // before the next task. Every caller runs at the head of a reader-input
  // task or a scroll report, before any command of its own, so the cancel
  // never retires another operation's command.
  const supersedePendingEndCorrection = useCallback((): void => {
    if (pendingEndCorrectionScrollRef.current === null) return;
    pendingEndCorrectionScrollRef.current = null;
    listRef.current?.cancelPendingScroll();
  }, [listRef]);

  const setFollowIntent = useCallback(
    (isFollowing: boolean): void => {
      if (!isFollowing) cancelActiveCorrection();
      // Disarm only on an actual intent TRANSITION. An owned free navigation
      // (minimap/find/deep-link) arms departure while the viewport is still
      // latched at the bottom; an animated jump's first smooth-scroll frame
      // can report geometry still inside the strict-bottom epsilon, and that
      // report must not consume the armed flag - otherwise every subsequent
      // (genuinely departing) report reads as layout-owned and the latch
      // yanks the jump straight back to the tail.
      if (permissionRef.current === isFollowing) return;
      if (isFollowing) readerDepartureScrollTopRef.current = null;
      // A touch arm outlives intent transitions: a finger that reaches the
      // strict bottom and keeps dragging is still the reader's, and only the
      // lift says the contact is over.
      if (armedReaderDepartureRef.current?.source !== "touch") {
        armedReaderDepartureRef.current = null;
      }
      permissionRef.current = isFollowing;
      onFollowIntentChangeRef.current?.(isFollowing);
    },
    [cancelActiveCorrection],
  );

  const noteReaderGesture = useCallback(
    (intent: ChatTimelineReaderGestureIntent): void => {
      readerGestureGenerationRef.current += 1;
      readerMomentumEndRef.current = null;
      if (intent.direction === "toward-end") {
        readerDepartureScrollTopRef.current = null;
      }
      const readerGestureGeneration = readerGestureGenerationRef.current;
      ownsFreeNavigationRef.current = false;
      cancelActiveCorrection();
      const node = listRef.current?.getScrollableNode();
      const liveGeometry = node ? readScrollGeometry(node) : null;
      const geometry =
        liveGeometry !== null && isChatTimelineGeometryMeasurable(liveGeometry)
          ? liveGeometry
          : null;
      const blocksAutomaticCorrection =
        geometry === null || canReaderGestureMove(geometry, intent.direction);
      const isTouchContact =
        armedReaderDepartureRef.current?.source === "touch";
      // A gesture toward the end never departs from it: while follow holds,
      // a report short of the tail means the tail grew before the report
      // arrived. It arms no departure - replacing one armed before it, whose
      // report would now detach a reader asking for the tail - and leaves a
      // queued end command to land.
      const continuesFollow =
        permissionRef.current &&
        intent.direction === "toward-end" &&
        !isTouchContact;
      // A touch contact outlives every intent during it: neither a delivered
      // `touchmove` nor a pointer preflight ends it. Replacing it with a
      // gesture arm would let a strict-bottom report release that
      // arm, leaving the rest of the contact - which iOS may deliver as bare
      // scroll reports - unprotected. Only the lift ends the contact.
      if (!isTouchContact) {
        armedReaderDepartureRef.current = readerGestureArm(
          intent,
          continuesFollow,
          blocksAutomaticCorrection,
          geometry,
        );
      }
      readerEndCandidateRef.current = readerEndCandidateFor({
        direction: intent.direction,
        geometry,
        arm: armedReaderDepartureRef.current,
        readerGestureGeneration,
        list: listRef.current,
      });
      if (
        intent.publishesReaderPosition &&
        blocksAutomaticCorrection &&
        !continuesFollow &&
        geometry !== null
      ) {
        supersedePendingEndCorrection();
      }
      onReaderGestureRef.current?.(intent);
    },
    [cancelActiveCorrection, listRef, supersedePendingEndCorrection],
  );

  const createActiveCorrection = useCallback((): ActiveEndCorrection => {
    cancelActiveCorrection();
    const correction: ActiveEndCorrection = {
      generation: correctionGenerationRef.current + 1,
      readerGestureGeneration: readerGestureGenerationRef.current,
      attempts: 0,
      animationFrameId: null,
    };
    correctionGenerationRef.current = correction.generation;
    activeCorrectionRef.current = correction;
    return correction;
  }, [cancelActiveCorrection]);

  const startEndCorrection = useCallback(
    (list: LegendListRef, node: HTMLElement): void => {
      const correction = createActiveCorrection();

      const isCurrent = (): boolean =>
        activeCorrectionRef.current?.generation === correction.generation &&
        permissionRef.current &&
        readerGestureGenerationRef.current ===
          correction.readerGestureGeneration;

      const validateAndReissue = (): void => {
        correction.animationFrameId = null;
        if (!isCurrent()) return;
        const liveGeometry = readScrollGeometry(node);
        if (!isChatTimelineGeometryMeasurable(liveGeometry)) {
          cancelActiveCorrection();
          return;
        }
        if (isChatTimelineAtStrictBottom(liveGeometry)) {
          cancelActiveCorrection();
          return;
        }
        issue();
      };

      const scheduleValidation = (): void => {
        correction.animationFrameId = requestAnimationFrame(() => {
          if (!isCurrent()) return;
          correction.animationFrameId =
            requestAnimationFrame(validateAndReissue);
        });
      };

      const issue = (): void => {
        if (!isCurrent()) return;
        if (
          correction.attempts >= CHAT_TIMELINE_FOLLOW_CORRECTION_MAX_ATTEMPTS
        ) {
          // LegendList may still be settling a deferred web shrink, MVCP
          // adjustment, streaming row resize, or content-inset change. A
          // bounded correction is a CPU-safety mechanism, not evidence that
          // the reader left the tail. Retain permission; the final layout
          // callback (or the next stream mutation) will start a fresh burst.
          cancelActiveCorrection();
          return;
        }
        correction.attempts += 1;
        // Every caller runs before the frame paints (a resize or mutation
        // callback, a layout effect, the row-measure callback, a frame), but
        // the list holds its command until its layout has been still for two
        // frames after a data change. Land the end now so the painted frame
        // shows it; the command then brings the list's own offset along.
        node.scrollTop = node.scrollHeight - node.clientHeight;
        const pendingScroll = list.scrollToEnd({ animated: false });
        pendingEndCorrectionScrollRef.current = pendingScroll;
        const clearPendingScroll = (): void => {
          if (pendingEndCorrectionScrollRef.current === pendingScroll) {
            pendingEndCorrectionScrollRef.current = null;
          }
        };
        void pendingScroll.then(clearPendingScroll, clearPendingScroll);
        scheduleValidation();
      };

      issue();
    },
    [cancelActiveCorrection, createActiveCorrection],
  );

  const isAtStrictEnd = useCallback((): boolean => {
    const node = listRef.current?.getScrollableNode();
    if (!node) return false;
    const geometry = readScrollGeometry(node);
    return (
      isChatTimelineGeometryMeasurable(geometry) &&
      isChatTimelineAtStrictBottom(geometry)
    );
  }, [listRef]);

  const hasPendingEndCorrection = useCallback(
    (): boolean => pendingEndCorrectionScrollRef.current !== null,
    [],
  );

  const beginOwnedEndNavigation = useCallback((): void => {
    const node = listRef.current?.getScrollableNode();
    if (!node) return;
    // Explicit go-live supersedes any pending reader/free-navigation arm.
    armedReaderDepartureRef.current = null;
    readerMomentumEndRef.current = null;
    ownsFreeNavigationRef.current = false;
    setFollowIntent(true);
    createActiveCorrection();
  }, [createActiveCorrection, listRef, setFollowIntent]);

  const beginOwnedFreeNavigation = useCallback((): void => {
    cancelActiveCorrection();
    readerEndCandidateRef.current = null;
    readerMomentumEndRef.current = null;
    armedReaderDepartureRef.current = { source: "owned-navigation" };
    ownsFreeNavigationRef.current = true;
  }, [cancelActiveCorrection]);

  const completeOwnedEndNavigation = useCallback(
    (didLandAtEnd: boolean): void => {
      cancelActiveCorrection();
      setFollowIntent(didLandAtEnd);
    },
    [cancelActiveCorrection, setFollowIntent],
  );

  const reconcileStrictBottom = useCallback(
    (
      isNativeScrollReport: boolean,
      geometry: ChatTimelineScrollGeometry,
      isOwnedLanding: boolean,
    ): void => {
      cancelActiveCorrection();
      const readerCandidate = readerEndCandidateRef.current;
      readerEndCandidateRef.current = null;
      const armedDeparture = armedReaderDepartureRef.current;
      // An owned free navigation's own frames can pass the strict edge (an
      // animated jump's first frame, a landing clamped at the tail), and its
      // arm may already be spent on a report that arrived late. While it owns
      // the view, its completion reconciles the geometry it settles on.
      if (ownsFreeNavigationRef.current && !isOwnedLanding) return;
      const isTouchArrival =
        armedDeparture?.source === "touch" && isNativeScrollReport;
      if (isTouchArrival) {
        // The finger reached the tail mid-contact (streaming grew it past
        // the contact offset): later movement is measured from here, or a
        // drag back to the original offset would read as a tap and the lift
        // would correct the reader to the tail.
        armedReaderDepartureRef.current = {
          source: "touch",
          scrollTopAtContact: geometry.scrollTop,
        };
      }
      if (
        !isTouchArrival &&
        !isOwnedLanding &&
        !permissionRef.current &&
        isReattachSuppressed?.() === true
      ) {
        // A recovering transcript's clamp can land a detached reader at the
        // strict bottom for a frame. That landing is the list's, so it leaves
        // the reader detached and every arm in place; the settle that lifts
        // the suppression reconciles whatever geometry remains. A completed
        // navigation's landing is the reader's own. So is one the reader's
        // own request for the end reached: it survives as reached, and the
        // settle follows it even after the tail has grown past it.
        readerEndCandidateRef.current = reachedReaderEnd(
          readerCandidate,
          readerGestureGenerationRef.current,
        );
        return;
      }
      if (strictBottomReleasesGestureArm(armedDeparture, geometry)) {
        // A movable gesture can still be awaiting its own scroll, so
        // unchanged geometry here is no proof it stayed: a maintain
        // correction would then mask the reader's departure.
        armedReaderDepartureRef.current = null;
      }
      const isSuppressed = isCorrectionSuppressed?.() === true;
      const mayReleaseSuppression =
        isSuppressed && resolveSuppressedEndLanding?.() === true;
      const mayFollow = !isSuppressed || mayReleaseSuppression;
      setFollowIntent(mayFollow);
    },
    [
      cancelActiveCorrection,
      isCorrectionSuppressed,
      isReattachSuppressed,
      resolveSuppressedEndLanding,
      setFollowIntent,
    ],
  );

  // The landing decides. At the strict bottom - the target sat in the last
  // screenful - the reader follows again. Anywhere else they stay where the
  // navigation put them, though no report may have published the departure:
  // a landing that needed no scroll, or a tail that grew while the arm held
  // correction off. A navigation that reader input abandoned no longer owns
  // the view, so completing it changes nothing: follow stays as that input
  // left it.
  const completeOwnedFreeNavigation = useCallback((): void => {
    if (!ownsFreeNavigationRef.current) return;
    ownsFreeNavigationRef.current = false;
    if (armedReaderDepartureRef.current?.source === "owned-navigation") {
      armedReaderDepartureRef.current = null;
    }
    const node = listRef.current?.getScrollableNode();
    const geometry = node ? readScrollGeometry(node) : null;
    if (
      geometry !== null &&
      isChatTimelineGeometryMeasurable(geometry) &&
      isChatTimelineAtStrictBottom(geometry)
    ) {
      reconcileStrictBottom(false, geometry, true);
      return;
    }
    setFollowIntent(false);
  }, [listRef, reconcileStrictBottom, setFollowIntent]);

  const cancelOwnedFreeNavigation = useCallback((): void => {
    if (!ownsFreeNavigationRef.current) return;
    ownsFreeNavigationRef.current = false;
    if (armedReaderDepartureRef.current?.source === "owned-navigation") {
      armedReaderDepartureRef.current = null;
    }
  }, []);

  const tryReattachReader = useCallback(
    (node: HTMLElement, geometry: ChatTimelineScrollGeometry): boolean => {
      const readerCandidate = readerEndCandidateRef.current;
      const reachedGestureStartEnd =
        readerCandidate !== null &&
        readerCandidate.readerGestureGeneration ===
          readerGestureGenerationRef.current &&
        geometry.scrollTop >=
          readerCandidate.targetScrollTop +
            listRowShift(listRef.current, readerCandidate.lastRow) -
            CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX;
      if (!reachedGestureStartEnd || isCorrectionSuppressed?.() === true) {
        return false;
      }
      readerEndCandidateRef.current = null;
      setFollowIntent(true);
      const list = listRef.current;
      if (list) startEndCorrection(list, node);
      return true;
    },
    [isCorrectionSuppressed, listRef, setFollowIntent, startEndCorrection],
  );

  /** Whether a non-bottom report under this arm is the reader leaving the
   *  tail, with the side effects a confirmed departure carries. */
  const publishArmedDeparture = useCallback(
    (
      armedDeparture: NonNullable<ArmedReaderDeparture>,
      geometry: ChatTimelineScrollGeometry,
    ): boolean => {
      if (armedDeparture.source === "touch") {
        // A report at the contact offset is not the finger moving the view:
        // the correction the contact cancelled may have left the DOM a hair
        // off the tail, and the lift resolves that as a tap. Keep the arm.
        if (
          Math.abs(geometry.scrollTop - armedDeparture.scrollTopAtContact) <=
          CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
        ) {
          return false;
        }
        // The finger moved the view: this is the published reader position a
        // delivered `touchmove` would have reported.
        readerDepartureScrollTopRef.current = geometry.scrollTop;
        supersedePendingEndCorrection();
        onReaderGestureRef.current?.({
          direction: "indeterminate",
          freezeInFlightScroll: true,
          publishesReaderPosition: true,
        });
      } else if (armedDeparture.source === "gesture") {
        // Backstop if arm-time geometry was unmeasurable or a later native
        // report is the first moment the reader's offset is known.
        readerDepartureScrollTopRef.current = geometry.scrollTop;
        supersedePendingEndCorrection();
      }
      return true;
    },
    [supersedePendingEndCorrection],
  );

  // A free reader's finger that moved the view is their reading position too.
  // iOS delivers no `touchmove` to publish it, so while a restore still holds
  // the saved one, this report does - once: the host's release lifts the
  // suppression.
  const publishFreeTouchWhileSuppressed = useCallback(
    (geometry: ChatTimelineScrollGeometry): void => {
      const armedDeparture = armedReaderDepartureRef.current;
      if (armedDeparture?.source !== "touch") return;
      if (isCorrectionSuppressed?.() !== true) return;
      publishArmedDeparture(armedDeparture, geometry);
    },
    [isCorrectionSuppressed, publishArmedDeparture],
  );

  const noteReportAfterDeparture = useCallback(
    (geometry: ChatTimelineScrollGeometry): void => {
      if (
        reportMovedFromDeparture(
          readerDepartureScrollTopRef.current,
          geometry.scrollTop,
        )
      ) {
        readerDepartureScrollTopRef.current = null;
      }
    },
    [],
  );

  // Whether a lifted finger's momentum has reached the end the latest
  // observation saw, net of the list moving the last row since; records the
  // end this observation sees for the next. A chunk can grow the last row
  // after the momentum reaches the end and before its scroll report, so no
  // report reads the strict bottom: this is the reader arriving all the same.
  const noteReaderMomentum = useCallback(
    (geometry: ChatTimelineScrollGeometry): boolean => {
      const momentum = readerMomentumEndRef.current;
      if (momentum === null) return false;
      const list = listRef.current;
      readerMomentumEndRef.current = readerMomentumEndFor(geometry, list);
      return (
        geometry.scrollTop >=
        momentum.targetScrollTop +
          listRowShift(list, momentum.lastRow) -
          CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
      );
    },
    [listRef],
  );

  // A detached reader whose momentum arrived follows, as a reader end
  // candidate reached does (`tryReattachReader`).
  const followReaderMomentumArrival = useCallback(
    (node: HTMLElement, momentumArrived: boolean): boolean => {
      if (
        !momentumArrived ||
        permissionRef.current ||
        isCorrectionSuppressed?.() === true
      ) {
        return false;
      }
      readerMomentumEndRef.current = null;
      setFollowIntent(true);
      const list = listRef.current;
      if (list) startEndCorrection(list, node);
      return true;
    },
    [isCorrectionSuppressed, listRef, setFollowIntent, startEndCorrection],
  );

  const observeLiveGeometry = useCallback((): void => {
    const node = listRef.current?.getScrollableNode();
    if (!node) return;
    const geometry = readScrollGeometry(node);
    if (!isChatTimelineGeometryMeasurable(geometry)) return;
    noteReportAfterDeparture(geometry);
    const momentumArrived = noteReaderMomentum(geometry);
    if (isChatTimelineAtStrictBottom(geometry)) {
      reconcileStrictBottom(true, geometry, false);
      return;
    }

    const correction = activeCorrectionRef.current;
    if (
      correction !== null &&
      correction.readerGestureGeneration === readerGestureGenerationRef.current
    ) {
      return;
    }
    if (tryReattachReader(node, geometry)) return;
    if (followReaderMomentumArrival(node, momentumArrived)) return;
    if (!permissionRef.current) {
      publishFreeTouchWhileSuppressed(geometry);
      return;
    }
    const armedDeparture = armedReaderDepartureRef.current;
    if (armedDeparture !== null) {
      if (!publishArmedDeparture(armedDeparture, geometry)) return;
      // A touch contact is not consumed by one departure: the finger may
      // reach the strict bottom (which re-grants follow) and keep dragging,
      // and that later report is still the reader's. Only the lift ends it.
      if (armedDeparture.source !== "touch") {
        armedReaderDepartureRef.current = null;
      }
      setFollowIntent(false);
      return;
    }
    // A non-bottom scroll report with no publishing reader input is layout-
    // owned (MVCP, deferred row measurement, browser clamp, or inset
    // compensation). Preserve intent and immediately correct; waiting for a
    // separate maintain callback can leave the DOM parked away from the tail.
    if (isCorrectionSuppressed?.() === true) return;
    const list = listRef.current;
    if (list) startEndCorrection(list, node);
  }, [
    followReaderMomentumArrival,
    isCorrectionSuppressed,
    listRef,
    noteReaderMomentum,
    noteReportAfterDeparture,
    publishArmedDeparture,
    publishFreeTouchWhileSuppressed,
    reconcileStrictBottom,
    setFollowIntent,
    startEndCorrection,
    tryReattachReader,
  ]);

  // The reader reached the end they asked for while the transcript held
  // reattachment off. It has settled, and the tail may have grown past them
  // without a scroll report: they follow from here.
  const followReachedReaderEnd = useCallback(
    (list: LegendListRef, node: HTMLElement): boolean => {
      const readerCandidate = readerEndCandidateRef.current;
      if (
        permissionRef.current ||
        readerCandidate?.reached !== true ||
        readerCandidate.readerGestureGeneration !==
          readerGestureGenerationRef.current ||
        isCorrectionSuppressed?.() === true ||
        isReattachSuppressed?.() === true
      ) {
        return false;
      }
      readerEndCandidateRef.current = null;
      setFollowIntent(true);
      startEndCorrection(list, node);
      return true;
    },
    [
      isCorrectionSuppressed,
      isReattachSuppressed,
      setFollowIntent,
      startEndCorrection,
    ],
  );

  const reconcileMaintenanceAtStrictBottom = useCallback(
    (geometry: ChatTimelineScrollGeometry): void => {
      if (isCorrectionSuppressed?.() === true) {
        // A partial hydration restore may be temporarily clamped to its own
        // short snapshot's end. Maintenance is not reader evidence and must
        // not resolve that pending transaction; only a live scroll report can
        // validate its frozen target through `reconcileStrictBottom`.
        cancelActiveCorrection();
        return;
      }
      if (
        !permissionRef.current &&
        readerDepartureScrollTopRef.current !== null
      ) {
        // The reader's departure is published but their gesture's own scroll
        // has not reported yet: the end clamped to meet the offset it was
        // published at (a temporary end pad dropped) is the list's.
        cancelActiveCorrection();
        return;
      }
      if (!permissionRef.current && isReattachSuppressed?.() === true) {
        // Maintenance is never reader evidence, and a recovering transcript's
        // clamp is not the reader arriving: leave a detached reader detached,
        // unless their own request for the end is what brought them here.
        cancelActiveCorrection();
        readerEndCandidateRef.current = reachedReaderEnd(
          readerEndCandidateRef.current,
          readerGestureGenerationRef.current,
        );
        return;
      }
      // Maintenance can be the only observable boundary after a collapsing
      // row or end-inset change passively clamps the DOM to the strict edge.
      // Reconcile before consulting permission so a stale false latch cannot
      // leave a jump pill visible when there is no useful bottom to reach.
      // This performs no imperative navigation, preserving destructive-clamp
      // behavior while allowing subsequent streaming growth to stay latched.
      reconcileStrictBottom(false, geometry, false);
    },
    [
      cancelActiveCorrection,
      isCorrectionSuppressed,
      isReattachSuppressed,
      reconcileStrictBottom,
    ],
  );

  const followEndIfPermitted = useCallback((): void => {
    const list = listRef.current;
    const node = list?.getScrollableNode();
    if (!list || !node) return;
    const geometry = readScrollGeometry(node);
    if (!isChatTimelineGeometryMeasurable(geometry)) return;
    const momentumArrived = noteReaderMomentum(geometry);
    if (isChatTimelineAtStrictBottom(geometry)) {
      reconcileMaintenanceAtStrictBottom(geometry);
      return;
    }
    if (followReachedReaderEnd(list, node)) return;
    if (followReaderMomentumArrival(node, momentumArrived)) return;
    if (!permissionRef.current) return;
    if (isCorrectionSuppressed?.() === true) return;
    // Reader/free-navigation intent published before its native scroll
    // report, or a finger still on the transcript: starting a correction here
    // would inherit that gesture's generation and then mask the departure as
    // correction-owned - and under a finger iOS drops the write anyway, only
    // to land it after the lift.
    if (armBlocksAutomaticCorrection(armedReaderDepartureRef.current)) return;

    startEndCorrection(list, node);
  }, [
    followReachedReaderEnd,
    followReaderMomentumArrival,
    isCorrectionSuppressed,
    listRef,
    noteReaderMomentum,
    reconcileMaintenanceAtStrictBottom,
    startEndCorrection,
  ]);

  // The empty state does not mount LegendList. Re-resolve when the rendered
  // timeline crosses that boundary so the first row attaches the listener,
  // and returning to empty cleans it up.
  useLayoutEffect(() => {
    const current = listRef.current?.getScrollableNode() ?? null;
    setScrollNode((previous) => (previous === current ? previous : current));
  }, [listRef, hasRows]);

  useLayoutEffect(() => {
    const node = scrollNode;
    if (!node) return;

    node.addEventListener("scroll", observeLiveGeometry, {
      passive: true,
    });
    // A wheel toward the end may be the only sign of it: at the strict bottom
    // it moves nothing and no scroll event comes, so a detached reader there
    // follows again now; a following reader short of a tail that grew is
    // corrected now rather than at the next token.
    const noteWheelGesture = (
      direction: ChatTimelineReaderScrollDirection,
    ): void => {
      noteReaderGesture({
        direction,
        freezeInFlightScroll: true,
        publishesReaderPosition: true,
      });
      if (direction === "toward-end") followEndIfPermitted();
    };
    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return;
      const direction = event.deltaY > 0 ? "toward-end" : "away-from-end";
      // The wheel scrolls a nested element, not the transcript: no gesture
      // of the transcript's, and no arm waiting for a scroll that will not
      // come.
      if (nestedScrollerTakesWheel(event.target, node, direction)) return;
      noteWheelGesture(direction);
    };
    // A wheel or swipe over an agent page or MCP App happens in the frame's
    // document, so the listeners above never see it, yet it chains to this
    // node. The frame relays its direction; without it that scroll reads as
    // layout-owned and is corrected straight back to the tail.
    const handleFrameScrollGesture = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const direction: unknown = event.detail;
      if (direction !== "toward-end" && direction !== "away-from-end") return;
      noteWheelGesture(direction);
    };
    const handleTouchStart = (event: TouchEvent): void => {
      lastTouchClientYRef.current = event.touches.item(0)?.clientY ?? null;
      const liveNode = listRef.current?.getScrollableNode();
      const geometry = liveNode ? readScrollGeometry(liveNode) : null;
      if (geometry === null || !isChatTimelineGeometryMeasurable(geometry)) {
        return;
      }
      // The contact is the reader's, whether or not a `touchmove` follows
      // (see the hook's doc comment): cancel any correction, retire a queued
      // LegendList end command so it cannot land after the finger has moved
      // the view, and hold automatic correction until the lift. The host is
      // told at the first report that moved the view, not here - a tap
      // publishes no reading position.
      readerGestureGenerationRef.current += 1;
      ownsFreeNavigationRef.current = false;
      cancelActiveCorrection();
      readerEndCandidateRef.current = null;
      readerMomentumEndRef.current = null;
      armedReaderDepartureRef.current = {
        source: "touch",
        scrollTopAtContact: geometry.scrollTop,
      };
      supersedePendingEndCorrection();
    };
    const handleTouchMove = (event: TouchEvent): void => {
      const clientY = event.touches.item(0)?.clientY;
      const previousClientY = lastTouchClientYRef.current;
      if (clientY === undefined || previousClientY === null) return;
      lastTouchClientYRef.current = clientY;
      if (clientY === previousClientY) return;
      noteReaderGesture({
        direction: clientY < previousClientY ? "toward-end" : "away-from-end",
        freezeInFlightScroll: true,
        publishesReaderPosition: true,
      });
    };
    const clearTouch = (): void => {
      lastTouchClientYRef.current = null;
      const armedDeparture = armedReaderDepartureRef.current;
      if (armedDeparture?.source !== "touch") return;
      const liveNode = listRef.current?.getScrollableNode();
      const liveGeometry = liveNode ? readScrollGeometry(liveNode) : null;
      if (
        permissionRef.current &&
        liveGeometry !== null &&
        isChatTimelineGeometryMeasurable(liveGeometry) &&
        !isChatTimelineAtStrictBottom(liveGeometry) &&
        Math.abs(liveGeometry.scrollTop - armedDeparture.scrollTopAtContact) >
          CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
      ) {
        // The finger moved the view and its scroll report has not arrived
        // (or arrived before the lift could be read). Publish the departure
        // now, while the arm is intact, so the next maintain trigger cannot
        // classify it as layout-owned.
        observeLiveGeometry();
      }
      // The lift ends the contact. After a departure, follow is already off
      // and the catch-up is a no-op; after a tap it lets streaming follow
      // again and corrects any growth the contact held back.
      armedReaderDepartureRef.current = null;
      followEndIfPermitted();
      // Momentum may carry the reader on from here, reported only by bare
      // scroll reports.
      const endNode = listRef.current?.getScrollableNode();
      const endGeometry = endNode ? readScrollGeometry(endNode) : null;
      readerMomentumEndRef.current =
        endGeometry !== null && isChatTimelineGeometryMeasurable(endGeometry)
          ? readerMomentumEndFor(endGeometry, listRef.current)
          : null;
    };
    const completePointerPreflight = (): void => {
      const armedDeparture = armedReaderDepartureRef.current;
      if (
        armedDeparture?.source === "gesture" &&
        armedDeparture.direction === "indeterminate"
      ) {
        const liveNode = listRef.current?.getScrollableNode();
        const liveGeometry = liveNode ? readScrollGeometry(liveNode) : null;
        if (
          liveGeometry !== null &&
          isChatTimelineGeometryMeasurable(liveGeometry) &&
          !isChatTimelineAtStrictBottom(liveGeometry)
        ) {
          // A scrollbar drag can update live scrollTop before main-thread
          // pressure allows its coalesced native scroll event through. Publish
          // the already-visible departure now, while its arm is intact, so an
          // intervening ResizeObserver cannot classify it as layout-owned and
          // yank the viewport back to the tail.
          observeLiveGeometry();
          return;
        }
        // A click/release whose live geometry stayed at the strict edge was a
        // no-op and may emit no scroll event. Release only that preflight so a
        // later stream mutation can continue following normally.
        armedReaderDepartureRef.current = null;
      }
    };
    node.addEventListener("wheel", handleWheel, { passive: true });
    node.addEventListener(
      SANDBOX_SCROLL_GESTURE_EVENT,
      handleFrameScrollGesture,
    );
    node.addEventListener("touchstart", handleTouchStart, { passive: true });
    node.addEventListener("touchmove", handleTouchMove, { passive: true });
    node.addEventListener("touchend", clearTouch, { passive: true });
    node.addEventListener("touchcancel", clearTouch, { passive: true });
    node.addEventListener("pointerup", completePointerPreflight, {
      passive: true,
    });
    node.addEventListener("pointercancel", completePointerPreflight, {
      passive: true,
    });
    // Viewport-layout trigger (divider drag / pane resize): fires with no
    // ChatTimeline render at all. Like every maintain trigger, it may heal a
    // stale false latch only when fresh geometry is already at the strict
    // edge; non-bottom geometry still preserves a detached reader's position.
    // The content element is observed too: the list re-sizes it when it
    // re-estimates rows it has never measured, with no row layout callback
    // and no scroll event, and a tail moved that way is still the latch's to
    // follow.
    const resizeObserver = new ResizeObserver(() => {
      followEndIfPermitted();
    });
    resizeObserver.observe(node);
    // The list writes its new content height in a commit just after it
    // measures a grown row. That resize sits shallower than the row it
    // follows, so its observer callback comes a frame late. The style write
    // itself is seen before that frame paints.
    const contentStyleObserver = new MutationObserver(() => {
      followEndIfPermitted();
    });
    const content = node.querySelector(
      `:scope > .${LEGEND_LIST_CONTENT_CONTAINER_CLASS}`,
    );
    if (content !== null) {
      resizeObserver.observe(content);
      contentStyleObserver.observe(content, {
        attributes: true,
        attributeFilter: ["style"],
        subtree: true,
      });
    }
    followEndIfPermitted();

    return () => {
      node.removeEventListener("scroll", observeLiveGeometry);
      node.removeEventListener("wheel", handleWheel);
      node.removeEventListener(
        SANDBOX_SCROLL_GESTURE_EVENT,
        handleFrameScrollGesture,
      );
      node.removeEventListener("touchstart", handleTouchStart);
      node.removeEventListener("touchmove", handleTouchMove);
      node.removeEventListener("touchend", clearTouch);
      node.removeEventListener("touchcancel", clearTouch);
      node.removeEventListener("pointerup", completePointerPreflight);
      node.removeEventListener("pointercancel", completePointerPreflight);
      resizeObserver.disconnect();
      contentStyleObserver.disconnect();
      cancelActiveCorrection();
    };
  }, [
    scrollNode,
    cancelActiveCorrection,
    followEndIfPermitted,
    listRef,
    noteReaderGesture,
    observeLiveGeometry,
    supersedePendingEndCorrection,
  ]);

  return useMemo(
    () => ({
      followEndIfPermitted,
      setFollowIntent,
      noteReaderGesture,
      beginOwnedEndNavigation,
      beginOwnedFreeNavigation,
      completeOwnedFreeNavigation,
      cancelOwnedFreeNavigation,
      completeOwnedEndNavigation,
      isAtStrictEnd,
      hasPendingEndCorrection,
      observeLiveGeometry,
    }),
    [
      beginOwnedEndNavigation,
      beginOwnedFreeNavigation,
      cancelOwnedFreeNavigation,
      completeOwnedFreeNavigation,
      completeOwnedEndNavigation,
      followEndIfPermitted,
      hasPendingEndCorrection,
      isAtStrictEnd,
      noteReaderGesture,
      observeLiveGeometry,
      setFollowIntent,
    ],
  );
}
