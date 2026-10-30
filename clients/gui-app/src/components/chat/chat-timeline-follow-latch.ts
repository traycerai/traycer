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

/** Where a write that takes the view to the end should land. While the DOM
 *  lags the size the list laid out, its position adjustment holds padding
 *  past the content for a frame, written inline on the content container
 *  (the timeline sets none there itself); an offset inside it paints an
 *  empty viewport. Then the end is the list's own, and the write never
 *  moves the view back from where the list put it. */
export function chatTimelineEndScrollTop(
  list: LegendListRef,
  node: HTMLElement,
): number {
  const domEnd = Math.max(0, node.scrollHeight - node.clientHeight);
  const content = node.querySelector<HTMLElement>(
    `:scope > .${LEGEND_LIST_CONTENT_CONTAINER_CLASS}`,
  );
  if (content === null || content.style.paddingBottom === "") return domEnd;
  const listEnd = list.getState().contentLength - node.clientHeight;
  return Math.max(node.scrollTop, Math.min(domEnd, listEnd));
}

/**
 * What moved the view, which decides what a contact's reference owes it.
 *
 *  - `offset`: a write of the offset itself, which the list makes to hold
 *    content still as it grows. The content moved with it, so a reference
 *    measured against the content (a finger's, against its row and the
 *    element on the edge) has already netted it out and must not be moved
 *    again.
 *  - `range`: a write that moves the view only by changing what the scroller
 *    can reach, so the browser clamps it onto the new end. **No content
 *    position moves**, so there is nothing to net against and every
 *    reference owes it, the finger's included.
 */
type ChatTimelineScrollerMoveCause = "offset" | "range";

/** A write to the scroll node, announced as it lands: the offset before and
 *  after it, the end before it, the offset it asked for within the scroll
 *  range, and what moved the view. iOS holds back a write made while a finger
 *  is down and lands it after the lift, so `to` can fall short of
 *  `intended`. */
interface ChatTimelineScrollerMove {
  readonly from: number;
  readonly fromEnd: number;
  readonly to: number;
  readonly intended: number;
  readonly cause: ChatTimelineScrollerMoveCause;
}

/** Dispatched on the scroll node for every write the app or the list makes to
 *  it. `@legendapp/list` (patched) announces each of its own. */
export const CHAT_TIMELINE_SCROLLER_MOVED_EVENT = "legend-list-scroller-moved";

/** Writes a scroll node and announces the write, as the list announces its
 *  own. On the transcript's, the latch reads a movement nobody announced as
 *  the reader's. `intendedTop` is the offset the write asks for. */
export function moveChatTimelineScroller(
  node: HTMLElement,
  intendedTop: number,
  move: () => void,
): void {
  const from = node.scrollTop;
  const fromEnd = node.scrollHeight - node.clientHeight;
  move();
  const detail: ChatTimelineScrollerMove = {
    from,
    fromEnd,
    to: node.scrollTop,
    intended: Math.max(0, Math.min(intendedTop, fromEnd)),
    // The app writes the offset; only the list changes the range under the
    // view (its end pad), and it says so itself.
    cause: "offset",
  };
  node.dispatchEvent(
    new CustomEvent(CHAT_TIMELINE_SCROLLER_MOVED_EVENT, { detail }),
  );
}

/** Where the view rests: iOS reports an elastic overscroll past either edge,
 *  and the browser springs it back by itself. */
function restingScrollTop(geometry: ChatTimelineScrollGeometry): number {
  return Math.max(
    0,
    Math.min(geometry.scrollTop, geometry.scrollHeight - geometry.clientHeight),
  );
}

function scrollerMoveOf(event: Event): ChatTimelineScrollerMove | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (
    typeof detail !== "object" ||
    detail === null ||
    !("from" in detail) ||
    !("fromEnd" in detail) ||
    !("to" in detail) ||
    !("intended" in detail)
  ) {
    return null;
  }
  const { from, fromEnd, to, intended } = detail;
  if (
    typeof from !== "number" ||
    typeof fromEnd !== "number" ||
    typeof to !== "number" ||
    typeof intended !== "number"
  ) {
    return null;
  }
  // Anything that does not name itself a range move is read as an offset
  // write, which is what every announcement was before the list began
  // announcing the clamp its end pad's restore causes.
  const cause: ChatTimelineScrollerMoveCause =
    "cause" in detail && detail.cause === "range" ? "range" : "offset";
  return { from, fromEnd, to, intended, cause };
}

/**
 * The clamp a viewport that just grew forces on the view, as a delta, or null
 * when this observation is not one.
 *
 * A taller viewport leaves less to scroll through, so the end comes up to meet
 * the view and the browser brings the view down onto it. Nothing writes the
 * offset and nothing announces it: the keyboard closing over a phone's
 * transcript moves a following reader off the tail without a finger moving.
 *
 * The end is computed from the content height at the REFERENCE, not the one
 * this observation sees. The clamp was forced when the viewport grew, against
 * the content as it stood then, and a row remeasuring afterwards grows the end
 * back over the clamped view - which is exactly the frame the reader is judged
 * in. Measured against the live height, the clamp would look like an offset no
 * clamp could explain, and the drop would be charged to the reader.
 *
 * The last clause is the whole of the safety argument: a reader whose own
 * scroll moved the view in the same unobserved frame does not land on the
 * clamp's offset - below it scrolling away, above it scrolling toward the end -
 * so their movement still counts as theirs.
 *
 * The viewport is tested for growth even though the clamp coming out below the
 * reference nearly implies it, because iOS WebKit's rubber-band breaks the
 * premise that implication rests on: during an overscroll bounce `scrollTop`
 * reads PAST the end, so a reference taken mid-bounce is already outside its
 * own range, and the bounce settling back onto the end would read here as a
 * clamp with no viewport change at all. The bounce is not this function's to
 * absorb - the contact machinery owns it, and a settle lands on the strict
 * end, where both observation paths reconcile before any of this is consulted.
 */
function viewportGrowthClamp(
  reference: ChatTimelineScrollGeometry,
  geometry: ChatTimelineScrollGeometry,
): number | null {
  const epsilon = CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX;
  if (geometry.clientHeight <= reference.clientHeight + epsilon) return null;
  const clamped = Math.min(
    reference.scrollTop,
    Math.max(0, reference.scrollHeight - geometry.clientHeight),
  );
  if (clamped >= reference.scrollTop - epsilon) return null;
  if (Math.abs(geometry.scrollTop - clamped) > epsilon) return null;
  return clamped - reference.scrollTop;
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
  /** The latest turn finished: a reader the end fell onto while it ran, and
   *  who still sits at the strict bottom, follows again - unless their
   *  departure was published ahead of a report of theirs that has not come,
   *  which still holds them. */
  readonly reconcileTurnAtRest: () => void;
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

/**
 * A gesture as the latch reports it onward: the intent it was given, and what
 * only the latch can say about it - whether the viewport could answer it. The
 * intent cannot carry that, because the callers that raise one (a wheel, a
 * key, a pointer) know what the reader asked for and not where the view
 * stands.
 */
export interface ChatTimelineReaderGesture extends ChatTimelineReaderGestureIntent {
  /**
   * False when the view could not move the way the gesture asked - a wheel up
   * at the top, one toward the end at the strict bottom - so it left the
   * reader exactly where they already were. True when the geometry could not
   * be measured: it cannot prove a no-op.
   */
  readonly viewportCanAnswer: boolean;
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
  /** How many rows the list held. A row the list no longer names is still
   *  the row standing last when the count has not changed - a turn re-keyed
   *  in place - and is a row the list has replaced when it has. */
  readonly rowCount: number;
}

/** What the list can say about the size of the row a lift recorded. Three
 *  answers, and `readerEndShift` compares them for equality, so they must
 *  stay distinct:
 *
 *  - a number: the list has measured that row, and this is its size;
 *  - `undefined`: the list has never measured it, so it has none to give.
 *    `sizeAtIndex` reads `sizesKnown`, which holds measured rows only, and
 *    does not fall back to the estimate the row is laid out with;
 *  - `null`: the row the lift recorded is neither the row standing last nor
 *    a turn re-keyed in place, so no row here is the one to size.
 *
 *  Collapsing `undefined` into `null` would make a lift whose row was never
 *  measured compare equal once the transcript grows past it, admitting an
 *  arrival at an end that may have moved. */
type UnreadRowSize = number | null | undefined;

/** What a gesture's end is tracked by: the block of the content it was
 *  thrown at, or the row that content sits in. Shared by the momentum a
 *  lift records and the candidate a toward-end gesture arms, which read it
 *  the same way (`readerEndShift`). */
interface ReaderEndTracking {
  readonly tailBlock: TailBlock | null;
  readonly lastRow: ListRowTop | null;
  /** How tall the list held `lastRow` when there was no tail block to
   *  capture, and null when there was one. A row that is no longer this
   *  tall has moved the end by an amount nothing can read back. */
  readonly unreadRowSize: UnreadRowSize;
}

interface ReaderEndCandidate {
  readonly readerGestureGeneration: number;
  /** As `ReaderMomentumEnd.targetContentEnd`, for the gesture's end. */
  readonly targetContentEnd: number;
  /** As `ReaderMomentumEnd.tailBlock`, for the gesture's end. */
  readonly tailBlock: TailBlock | null;
  /** As `ReaderMomentumEnd.unreadRowSize`, for the gesture's end. */
  readonly unreadRowSize: UnreadRowSize;
  /** The list's last row when the gesture began, read only when the tail
   *  block cannot be (`tailBlockShift`). Rows above the reader that the list
   *  remeasures since move it, and the list moves the reader with them, so
   *  the end the gesture headed for has moved by the same amount. */
  readonly lastRow: ListRowTop | null;
  /** The reader reached the strict bottom while a recovering transcript held
   *  reattachment off; the settle that lifts the hold lets them follow. */
  readonly reached: boolean;
}

/** The end a lifted finger's momentum can reach, and the lift it travels
 *  from. The two are read in different ways because the list moves them in
 *  different ways. */
interface ReaderMomentumEnd {
  /** Where the content that ended the transcript at the lift then stood,
   *  measured down the content and not as an offset of the view
   *  (`endScrollTopOf`). It is the content the finger was thrown at, so it
   *  moves only as that content moves - with `lastRow`, and never with a
   *  tail that grows below it. A row growing in view pushes it down without
   *  moving the view at all, which is why this end cannot be read from the
   *  writes the list announces. */
  readonly targetContentEnd: number;
  /** The last block of that content, which is what the end moves with
   *  (`tailBlockOf`). Read first; the row is the fallback. */
  readonly tailBlock: TailBlock | null;
  /** The list's last row at the lift, as `ReaderEndCandidate.lastRow`. */
  readonly lastRow: ListRowTop | null;
  /** How tall the list held that row at the lift, when it had rendered no
   *  tail block to capture; null when it had. See `readerEndShift`. */
  readonly unreadRowSize: UnreadRowSize;
  /** Where the view stood at the lift, carried with every announced write
   *  since (`noteScrollerMoved`), so it stays an offset this view can be
   *  read against. Momentum travels from the lift toward the end: a view
   *  standing where it was lifted has not travelled, however the end moved
   *  to meet it. */
  readonly liftScrollTop: number;
}

/** The offset that reaches content standing `contentEnd` down the transcript,
 *  for a view of this height. Held apart from the content because a view can
 *  change height under a reader on its way there - a keyboard opening, a
 *  phone browser's chrome collapsing as the finger flings - which moves every
 *  offset without moving a row. */
function endScrollTopOf(
  contentEnd: number,
  geometry: ChatTimelineScrollGeometry,
  shift: number,
): number {
  return Math.max(0, contentEnd + shift - geometry.clientHeight);
}

type ArmedReaderDeparture =
  | {
      readonly source: "gesture";
      readonly direction: ChatTimelineReaderScrollDirection;
      /** False when fresh issue-time geometry proves this gesture cannot move
       *  in its requested direction (for example, wheel-up at scrollTop=0). */
      readonly blocksAutomaticCorrection: boolean;
      /** Live geometry at the gesture's event, carried with every announced
       *  write since (`noteScrollerMoved`); null when unmeasurable. Its own
       *  movement is measured from here. */
      readonly geometryAtGesture: ChatTimelineScrollGeometry | null;
      /** The element a wheel was over; null for any other gesture. A nested
       *  scroller holding it may own the wheel's whole sequence. */
      readonly wheelTarget: Element | null;
      /** A wheel or relayed frame gesture away from the end: while it
       *  blocks correction, the tail moving away from the reader is their
       *  departure (`followEndIfPermitted`). */
      readonly departsOnGrowth: boolean;
    }
  | { readonly source: "owned-navigation" }
  | {
      /** A finger is on the transcript. Armed at `touchstart`, released at
       *  `touchend`/`touchcancel`, and never by a pointer edge or a strict-
       *  bottom report: iOS WebKit stops delivering `touchmove` (and fires
       *  `pointercancel` at once) when its native pan owns the touch, so the
       *  contact itself is the only reader evidence the page can count on. */
      readonly source: "touch";
      /** Fresh `scrollTop` at contact, or at the latest report the finger
       *  moved a following reader toward the end: the finger's next step is
       *  measured from here. A report that did not move past it is a tap. */
      readonly scrollTopAtStep: number;
      /** A row that started below the viewport's top edge at that step, or
       *  the last row: the list moves it with any growth above it that it
       *  compensates, so the finger's movement is the view's net of it. */
      readonly rowAtStep: ListRowTop | null;
      /** The element at the viewport's top edge at that step: the list's
       *  compensation holds it still on screen, so only the finger moves it. */
      readonly edgeAtStep: EdgeMark | null;
    }
  | null;

/** One immediate issue plus four measured reissues, each after two frames.
 *  Exhaustion ends only the current correction burst; reader intent is never
 *  inferred from a layout operation failing to settle inside this window. */
export const CHAT_TIMELINE_FOLLOW_CORRECTION_MAX_ATTEMPTS = 5;

interface ChatTimelineFollowLatchOptions {
  readonly onFollowIntentChange: ((isFollowing: boolean) => void) | undefined;
  readonly onReaderGesture:
    | ((gesture: ChatTimelineReaderGesture) => void)
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

type ReaderGestureArm = Extract<
  NonNullable<ArmedReaderDeparture>,
  { readonly source: "gesture" }
>;

/** A wheel or relayed frame gesture away from the end still awaiting its
 *  scroll: the tail moving away from its reader is their departure. */
function armDepartsOnGrowth(
  arm: ArmedReaderDeparture,
): arm is ReaderGestureArm {
  return (
    arm?.source === "gesture" &&
    arm.blocksAutomaticCorrection &&
    arm.departsOnGrowth
  );
}

/** A gesture away from the end whose scroll may still land. Following its
 *  reader would retire the arm (`setFollowIntent`), and that scroll would
 *  then read as the list's and be corrected. A gesture toward the end is
 *  the reader asking for it. */
function armAwaitsScrollAway(
  arm: ArmedReaderDeparture,
): arm is ReaderGestureArm {
  return (
    arm?.source === "gesture" &&
    arm.blocksAutomaticCorrection &&
    arm.direction === "away-from-end"
  );
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
    wheelTarget: null,
    departsOnGrowth: false,
  };
}

/** The view's distance from the end at its resting offset: an elastic
 *  overscroll and its spring back are no movement. */
function distanceFromEnd(geometry: ChatTimelineScrollGeometry): number {
  return (
    geometry.scrollHeight - geometry.clientHeight - restingScrollTop(geometry)
  );
}

/**
 * Whether strict-bottom geometry ends a gesture's arm: one that cannot move
 * the view, one whose own movement it shows - the view moved up from where
 * the gesture began and away from the end, without leaving the edge's
 * epsilon (`gestureScrollLanded`; announced writes carry where it began).
 * Nothing else is the gesture's: a clamp lowers the offset with the end,
 * growth moves the end alone, and a report queued by an earlier write,
 * or one that comes before a smooth scroll's first frame, has not moved the
 * view at all. No strict-bottom report tells a wheel whose movement the end
 * came up to absorb from one that has not moved yet: the browser applies a
 * wheel's delta to the offset of the frame it lands in, after any clamp. A
 * movable gesture with no such evidence keeps its arm until its scroll
 * reports (for a free reader, a report that shows it landed:
 * `noteFreeReportAway`), the tail grows away from a wheel's reader (their
 * departure), a nested scroller it was latched to ends its scroll
 * (`gestureScrollEndUnblocks`), a press's own pointer release ends it
 * (`completePointerPreflight`), the turn rests after a report has followed
 * it (`reconcileTurnAtRest`), or the next reader input replaces it: a
 * browser that scrolls a wheel frames after its event has no bound to wait
 * out.
 */
function strictBottomReleasesGestureArm(
  arm: ArmedReaderDeparture,
  geometry: ChatTimelineScrollGeometry,
): boolean {
  if (arm?.source !== "gesture") return false;
  if (!arm.blocksAutomaticCorrection) return true;
  return gestureScrollLanded(arm, geometry);
}

/** Whether the view stands where a gesture away from the end moves it:
 *  above its offset at the gesture, at resting offsets. Off the end that is
 *  the gesture's: the list's and the app's writes carry the offset, and a
 *  clamp only ever lands a view on the end, so the end coming toward the
 *  reader meanwhile (a pad dropping, a row below collapsing) changes
 *  nothing. On the end a clamp lowers the offset with the end, so the view
 *  must also stand farther from it than at the gesture. */
function gestureScrollLanded(
  arm: ReaderGestureArm,
  geometry: ChatTimelineScrollGeometry,
): boolean {
  const start = arm.geometryAtGesture;
  if (start === null) return false;
  if (restingScrollTop(geometry) >= restingScrollTop(start)) return false;
  return (
    !isChatTimelineAtStrictBottom(geometry) ||
    distanceFromEnd(geometry) > distanceFromEnd(start)
  );
}

/** A gesture's geometry with an announced write applied: its offset moves
 *  with the view, and its distance from the end stays the reader's. */
function geometryMovedBy(
  geometry: ChatTimelineScrollGeometry,
  delta: number,
): ChatTimelineScrollGeometry {
  return {
    ...geometry,
    scrollTop: geometry.scrollTop + delta,
    scrollHeight: geometry.scrollHeight + delta,
  };
}

/**
 * The geometry a later clamp is recognised against, moved by an announced
 * write. Not where the view IS - where the view would be from everything this
 * latch knows about, so that a movement it does not know about is still there
 * to be found as the difference between the two.
 *
 * The content height has to come out exactly, because it is what the clamp is
 * predicted from. An OFFSET write moved the content with the view, by as much.
 * A RANGE move took content away, and `fromEnd` and `to` are both ends measured
 * in the same viewport, so their difference is exactly how much - which is more
 * than the view moved whenever the view sat below the old end. Taking the
 * view's own delta for the content's there would overstate the height left, and
 * an overstated height predicts the clamp at the reference offset itself, which
 * reads as no clamp at all and charges the drop to the reader.
 */
function geometryAfterAnnouncedMove(
  geometry: ChatTimelineScrollGeometry,
  move: ChatTimelineScrollerMove,
): ChatTimelineScrollGeometry {
  const delta = move.to - move.from;
  if (move.cause === "offset") return geometryMovedBy(geometry, delta);
  return {
    ...geometry,
    scrollTop: geometry.scrollTop + delta,
    scrollHeight: geometry.scrollHeight - (move.fromEnd - move.to),
  };
}

/**
 * Whether an indeterminate gesture arm still holds its reader's follow: a
 * press (the scrollbar's) that has not scrolled yet. It arms before anything
 * moves, and the press itself says nothing about which way it will go, so
 * only its own scroll landing makes a view off the end the reader's. While it
 * blocks correction, a row that grows or an end pad that opens moves the end
 * alone and leaves the view behind it; departing on that would detach a
 * reader who never moved, whose intent is still the tail.
 *
 * With no measurable offset at the press there is nothing to measure against,
 * and the report is the first moment the reader's position is known: it
 * departs, as any gesture's backstop does.
 */
function indeterminateArmHoldsFollow(
  arm: ReaderGestureArm,
  geometry: ChatTimelineScrollGeometry,
): boolean {
  return (
    arm.direction === "indeterminate" &&
    arm.geometryAtGesture !== null &&
    !gestureScrollLanded(arm, geometry)
  );
}

/**
 * Where a press stands after this observation, or null while it stands where
 * it already did. The press is measured a step at a time, as a finger is
 * (`touchStep`), and this is what ends a step: the offset it is measured from
 * becomes this one, and its landing is measured from there.
 *
 * Two ways, each with its own answer, because each knows a different thing:
 *
 *  - The view stands past that offset, toward the end. The view really is
 *    there, so that is where the press stands, and a step away from it is
 *    the reader leaving it - which is what a single measurement from the
 *    first offset cannot see: a press that drags to the end and back has
 *    returned to the very offset it pressed at. An announced write is not
 *    one of these; it carries the offset along with the view
 *    (`noteScrollerMoved`).
 *  - The end has fallen below that offset - an end pad dropping, a row below
 *    collapsing, a pane growing. The browser brings the view down with it
 *    without announcing it, and an offset past the end is one the view can
 *    no longer hold, so keeping it would read the clamp as the press's own
 *    scroll the moment the end grew back. But a clamp only ever lands the
 *    view ON the end, so the press stands at the new end and no lower: a
 *    view below it in the same observation - one report carries the frame's
 *    whole movement, the reader's drag with the pad's drop - is the press's
 *    own scroll, and taking the view here would swallow it and yank them
 *    back to the tail.
 *
 * Ending a step departs nothing by itself. A press dragging toward the tail
 * is asking for it, and one that stops short never steps away again, so the
 * release follows it there.
 */
function pressArmReferenceAfter(
  arm: ReaderGestureArm,
  geometry: ChatTimelineScrollGeometry,
): ChatTimelineScrollGeometry | null {
  const start = arm.geometryAtGesture;
  if (start === null) return null;
  const reference = restingScrollTop(start);
  const epsilon = CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX;
  if (restingScrollTop(geometry) > reference + epsilon) return geometry;
  const end = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
  if (reference > end + epsilon) return { ...geometry, scrollTop: end };
  return null;
}

/**
 * Whether a `scrollend` ends a blocking wheel arm's wait for its scroll: one
 * from a nested scroller holding the wheel's target. The browser latched the
 * wheel's sequence to that scroller, which reached its edge, so the
 * transcript never moves for it. The transcript's own `scrollend` says
 * nothing of the kind: a clamp ahead of a smooth scroll's first frame ends
 * with one too.
 *
 * The arm then stops blocking correction but stays: a later report off the
 * end is still the reader's.
 */
function gestureScrollEndUnblocks(
  arm: ArmedReaderDeparture,
  target: EventTarget | null,
  scrollNode: HTMLElement,
): boolean {
  if (arm?.source !== "gesture" || !arm.blocksAutomaticCorrection) {
    return false;
  }
  return nestedScrollEndHoldsWheel(target, scrollNode, arm.wheelTarget);
}

/** Whether a `scrollend` is a nested scroller's that holds the element a
 *  wheel was over: that scroller owned the wheel's sequence, and it is over. */
function nestedScrollEndHoldsWheel(
  target: EventTarget | null,
  scrollNode: HTMLElement,
  wheelTarget: Element | null,
): boolean {
  return (
    target !== scrollNode &&
    target instanceof Element &&
    wheelTarget !== null &&
    scrollNode.contains(target) &&
    target.contains(wheelTarget)
  );
}

/** A departure published ahead of the report of the gesture that made it,
 *  with the element a wheel was over when a wheel made it. */
type DepartureAwaitingReport = { readonly wheelTarget: Element | null } | null;

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
  const tailBlock = tailBlockOf(input.list);
  const lastRow = lastListRowTop(input.list);
  return {
    readerGestureGeneration: input.readerGestureGeneration,
    targetContentEnd: geometry.scrollHeight,
    tailBlock,
    unreadRowSize:
      tailBlock === null ? lastRowSizeOf(input.list, lastRow) : null,
    lastRow,
    reached: false,
  };
}

/** Whether this view has reached the end a toward-end gesture asked for, with
 *  that end moved by what the list has moved the rows under it since. As the
 *  momentum's arrival reads it: an end the list may have moved by an unknown
 *  amount is not an end this view can be said to reach.
 *
 *  Both observation paths judge it here. A wheel that moves the view nothing -
 *  the viewport grew and the end came up to meet it - emits no scroll report,
 *  so a read is the only observation the arrival has, and a tail growing past
 *  it afterwards would otherwise leave the reader free at an end they
 *  reached. */
/** Whether the view has reached the end a toward-end gesture was thrown at.
 *  `unreadable` is not `short`: the end moved by an amount nothing can read
 *  back, so it can never be judged again and the caller retires it. Keeping
 *  it would let a row that returns to the size it was - a block collapsed
 *  and reopened - read as an arrival on the next observation. */
function readerEndCandidateMet(
  candidate: ReaderEndCandidate | null,
  geometry: ChatTimelineScrollGeometry,
  list: LegendListRef | null,
  readerGestureGeneration: number,
): "met" | "short" | "unreadable" {
  if (
    candidate === null ||
    candidate.readerGestureGeneration !== readerGestureGeneration
  ) {
    return "short";
  }
  const shift = readerEndShift(list, candidate);
  if (shift === null) return "unreadable";
  return geometry.scrollTop >=
    endScrollTopOf(candidate.targetContentEnd, geometry, shift) -
      CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
    ? "met"
    : "short";
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

/** The last block of the content that ended the transcript, and where it
 *  stood. The end a reader is thrown at is the end of that content, and only
 *  this block moves with it: the row's top does not, because the row can grow
 *  from the inside - an image in it resolving taller above a trailing
 *  paragraph moves the paragraph and leaves the row where it was. */
interface TailBlock {
  readonly element: Element;
  /** Its top in the list's content container's coordinates. Measured there
   *  rather than against the row, so rows above remeasuring move it too and
   *  the row's own shift needs no separate reading. */
  readonly contentTop: number;
  /** The first 64 characters of its text, in tree order, as the list's own
   *  edge anchor reads them (`edgeAnchorHead`). The list reuses row
   *  containers, and a reused one says nothing about the content this was
   *  thrown at (`tailBlockHolds`). */
  readonly head: string;
}

const TAIL_BLOCK_HEAD_LENGTH = 64;

function tailBlockHead(node: Element): string {
  // 4 | 8 is NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION, spelled as
  // values so no global is needed, as the list spells it.
  const walker = node.ownerDocument.createTreeWalker(node, 4 | 8);
  let head = "";
  for (
    let part = walker.nextNode();
    part !== null && head.length < TAIL_BLOCK_HEAD_LENGTH;
    part = walker.nextNode()
  ) {
    head += part.nodeValue ?? "";
  }
  return head.slice(0, TAIL_BLOCK_HEAD_LENGTH);
}

/** The block still holds the content it was recorded with: the head it reads
 *  now begins with the head it read then. A paragraph the reply is still
 *  writing starts shorter than the head's 64 characters, and the tokens that
 *  follow are the same content, so they extend that head rather than replace
 *  it. A recycled element's text does not begin with another message's, and
 *  one with no text at all (an image, a rule) has an empty head, which only
 *  an empty head matches - a recycled element cannot pass by having none. */
function tailBlockHolds(current: string, captured: string): boolean {
  return (
    current === captured ||
    (captured.length > 0 && current.startsWith(captured))
  );
}

function contentContainerOf(node: HTMLElement): Element | null {
  return node.querySelector(`:scope > .${LEGEND_LIST_CONTENT_CONTAINER_CLASS}`);
}

/** The last child with a box of its own; one with no box (`display: contents`,
 *  as markdown and component wrappers use) lays its children out in its place,
 *  so it is searched in its stead. */
function lastBoxedChild(parent: Element): Element | null {
  for (
    let child = parent.lastElementChild;
    child !== null;
    child = child.previousElementSibling
  ) {
    if (child.getBoundingClientRect().height > 0) return child;
    const inner = lastBoxedChild(child);
    if (inner !== null) return inner;
  }
  return null;
}

/** The tail block of the transcript's last row, as it stands now. None when
 *  the list has not rendered that row: the lowest thing laid out is then a
 *  row in the middle of the transcript, whose movement is not the end's, and
 *  the list names no container for a row it has not rendered. */
function tailBlockOf(list: LegendListRef | null): TailBlock | null {
  if (list === null) return null;
  const content = contentContainerOf(list.getScrollableNode());
  if (content === null) return null;
  const state = list.getState();
  const last = state.data.length - 1;
  if (last < 0) return null;
  // The list's own container-to-key mapping, so a spacer the app's end inset
  // renders, or a footer, is never mistaken for the last row: their tops move
  // with a tail that grows, and the end a reader was thrown at does not. It
  // answers for a rendered row only, which is the whole of that guard.
  const row: unknown = state.elementAtIndex(last);
  if (!(row instanceof HTMLElement) || !content.contains(row)) return null;
  let element: Element = row;
  for (;;) {
    const next = lastBoxedChild(element);
    if (next === null) break;
    element = next;
  }
  if (element === row && row.getBoundingClientRect().height === 0) return null;
  return {
    element,
    contentTop:
      element.getBoundingClientRect().top - content.getBoundingClientRect().top,
    head: tailBlockHead(element),
  };
}

/** How far the tail block has moved since it was recorded, and null when it
 *  cannot be told: the block is gone, or the list has reused its element for
 *  other content. The caller then falls back to the row's own shift. */
function tailBlockShift(
  list: LegendListRef | null,
  tail: TailBlock | null,
): number | null {
  if (tail === null || list === null) return null;
  const content = contentContainerOf(list.getScrollableNode());
  if (
    content === null ||
    !tail.element.isConnected ||
    !content.contains(tail.element) ||
    !tailBlockHolds(tailBlockHead(tail.element), tail.head)
  ) {
    return null;
  }
  return (
    tail.element.getBoundingClientRect().top -
    content.getBoundingClientRect().top -
    tail.contentTop
  );
}

/** How tall the list holds the transcript's last row, when that is still
 *  the row given. Read only for a lift that captured no tail block, so a
 *  row the list has not rendered is sized by the list's own estimate of it,
 *  which is exactly the number that changes when the row is measured. */
function lastRowSizeOf(
  list: LegendListRef | null,
  row: ListRowTop | null,
): UnreadRowSize {
  if (list === null || row === null) return null;
  const state = list.getState();
  const last = state.data.length - 1;
  if (last < 0) return null;
  // The row the lift recorded, named as `listRowShift` names it and in the
  // same order: by its key, and only where the key is gone entirely by the
  // row standing last under an unchanged count, which is a turn re-keyed in
  // place. A key still present but no longer last means the transcript ends
  // below the end this gesture was thrown at, and the row standing there is
  // not the one to size.
  if (state.keyAtIndex(last) === row.key) return state.sizeAtIndex(last);
  const reKeyedInPlace =
    state.positionByKey(row.key) === undefined &&
    state.data.length === row.rowCount;
  return reKeyedInPlace ? state.sizeAtIndex(last) : null;
}

/** How far the end a gesture was thrown at has moved, and null when that
 *  cannot be told - which declines arrival, as an unreadable shift does
 *  everywhere else.
 *
 *  A lift whose last row the list had not rendered captures no tail block,
 *  and the row's top alone is blind to the reply growing *inside* the row:
 *  content above its final paragraph pushes the end down while the row's
 *  top stands still. The list reports one size for that row and cannot say
 *  whether growth fell above the final paragraph, moving the end, or into
 *  it, which leaves the end's content where it was. So a row that is no
 *  longer the size it was is an end that moved by an unknown amount, and
 *  this stops guessing that it moved by nothing.
 *
 *  The cost is a reader far enough up that the list had not rendered the
 *  last row, flinging to an end that then moves: they are left to the pill
 *  rather than carried to content they never reached. A reader near the
 *  tail has that row rendered at the lift, so their end is tracked by its
 *  own block and none of this runs. */
function readerEndShift(
  list: LegendListRef | null,
  tracking: ReaderEndTracking,
): number | null {
  const moved = tailBlockShift(list, tracking.tailBlock);
  if (moved !== null) return moved;
  if (
    tracking.tailBlock === null &&
    lastRowSizeOf(list, tracking.lastRow) !== tracking.unreadRowSize
  ) {
    return null;
  }
  return listRowShift(list, tracking.lastRow);
}

function lastListRowTop(list: LegendListRef | null): ListRowTop | null {
  if (list === null) return null;
  const state = list.getState();
  const last = state.data.length - 1;
  if (last < 0) return null;
  const top = state.positionAtIndex(last);
  return typeof top === "number"
    ? { key: state.keyAtIndex(last), top, rowCount: state.data.length }
    : null;
}

function readerMomentumEndFor(
  geometry: ChatTimelineScrollGeometry,
  list: LegendListRef | null,
): ReaderMomentumEnd {
  const tailBlock = tailBlockOf(list);
  const lastRow = lastListRowTop(list);
  return {
    targetContentEnd: geometry.scrollHeight,
    tailBlock,
    lastRow,
    unreadRowSize: tailBlock === null ? lastRowSizeOf(list, lastRow) : null,
    liftScrollTop: geometry.scrollTop,
  };
}

/** How far the list has moved a row since its recorded top, and null when
 *  the list has moved it by an amount nothing left can tell. Read as zero,
 *  a move the list made is the reader's own movement, which is what
 *  follows them.
 *
 *  A row the list no longer names is still read when the list holds the
 *  same rows: a turn re-keyed in place - an optimistic row taking the
 *  server's id - leaves the row standing last where the recorded one was,
 *  and what moved the view is still there to read. Only a list that has
 *  gained or lost rows under the view moved its end for reasons of its own
 *  that no row left can account for.
 *
 *  With no row recorded at all there is nothing the list can have moved
 *  since, and the answer is zero, as it is for a row that has not moved. */
function listRowShift(
  list: LegendListRef | null,
  row: ListRowTop | null,
): number | null {
  if (list === null || row === null) return 0;
  const top = list.getState().positionByKey(row.key);
  if (top !== undefined) return top - row.top;
  const standingLast = lastListRowTop(list);
  return standingLast !== null && standingLast.rowCount === row.rowCount
    ? standingLast.top - row.top
    : null;
}

/** The first row whose top is below the viewport's top edge; the last row
 *  when one row spans the whole view. */
function touchReferenceRow(
  list: LegendListRef | null,
  geometry: ChatTimelineScrollGeometry,
): ListRowTop | null {
  if (list === null) return null;
  const state = list.getState();
  // Positions omit the list header, so a row placed past `scrollTop` starts
  // below the edge whatever the header's size.
  for (
    let index = Math.max(0, state.start);
    index < state.data.length && index <= state.end + 1;
    index += 1
  ) {
    const top = state.positionAtIndex(index);
    if (top !== undefined && top > geometry.scrollTop) {
      return {
        key: state.keyAtIndex(index),
        top,
        rowCount: state.data.length,
      };
    }
  }
  return lastListRowTop(list);
}

/** An element at or just below the scroll node's top edge, and where it sat
 *  on screen. The list keeps the element there still while it compensates
 *  a re-measure, so its movement on screen is the reader's own. */
interface EdgeMark {
  readonly element: Element;
  readonly top: number;
}

/** The first child box that crosses or follows the edge. A child with no
 *  box of its own (`display: contents`) lays its children out in its place,
 *  so they are searched in its stead. */
function edgeChild(
  parent: Element,
  edgeY: number,
): { readonly element: Element; readonly below: boolean } | null {
  for (
    let child = parent.firstElementChild;
    child !== null;
    child = child.nextElementSibling
  ) {
    const rect = child.getBoundingClientRect();
    if (rect.height === 0) {
      const inner = edgeChild(child, edgeY);
      if (inner !== null) return inner;
      continue;
    }
    if (rect.bottom > edgeY) {
      return { element: child, below: rect.top > edgeY };
    }
  }
  return null;
}

function edgeMarkOf(node: HTMLElement): EdgeMark | null {
  const edgeY = node.getBoundingClientRect().top;
  const content = node.querySelector(
    `:scope > .${LEGEND_LIST_CONTENT_CONTAINER_CLASS}`,
  );
  if (content === null) return null;
  // The list positions its row containers absolutely, in no particular DOM
  // order: the one that crosses the edge, then down through its content.
  let element: Element | null = null;
  for (const container of Array.from(content.children)) {
    const rect = container.getBoundingClientRect();
    if (rect.height > 0 && rect.top <= edgeY && rect.bottom > edgeY) {
      element = container;
      break;
    }
  }
  if (element === null) return null;
  for (;;) {
    const next = edgeChild(element, edgeY);
    if (next === null) break;
    element = next.element;
    if (next.below) break;
  }
  return { element, top: element.getBoundingClientRect().top };
}

/** How far the content has risen on screen since the mark (toward the end);
 *  null once its element is gone. */
function edgeMarkRise(mark: EdgeMark | null): number | null {
  if (mark === null || !mark.element.isConnected) return null;
  return mark.top - mark.element.getBoundingClientRect().top;
}

type ReaderTouchArm = Extract<
  NonNullable<ArmedReaderDeparture>,
  { readonly source: "touch" }
>;

function touchArmAt(
  geometry: ChatTimelineScrollGeometry,
  list: LegendListRef | null,
): ReaderTouchArm {
  const node = list?.getScrollableNode();
  return {
    source: "touch",
    scrollTopAtStep: geometry.scrollTop,
    rowAtStep: touchReferenceRow(list, geometry),
    edgeAtStep: node ? edgeMarkOf(node) : null,
  };
}

/** Which way the finger moved a following reader since the arm's step. The
 *  list can move `scrollTop` under the finger to compensate growth, so the
 *  finger's own movement has two measures, and neither alone is fooled into
 *  reading it as toward the end:
 *  - the view's movement net of the reference row's, which moves with any
 *    growth above it - but not with growth inside the row above the edge,
 *    which the list compensates too;
 *  - how far the edge element rose on screen, which the list's compensation
 *    holds still - unless the list anchored a row below it instead, whose
 *    move the reference row then shares.
 *  Toward the end when both agree; still when neither moved beyond the
 *  edge's epsilon, as under a compensation alone; away when either did, or
 *  when either is gone and there is no such measure. */
function touchStep(
  arm: ReaderTouchArm,
  geometry: ChatTimelineScrollGeometry,
  list: LegendListRef | null,
): "toward-end" | "still" | "away" {
  const row = arm.rowAtStep;
  if (list === null || row === null) return "away";
  const top = list.getState().positionByKey(row.key);
  const rise = edgeMarkRise(arm.edgeAtStep);
  if (top === undefined || rise === null) return "away";
  const net = geometry.scrollTop - arm.scrollTopAtStep - (top - row.top);
  const epsilon = CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX;
  if (net > epsilon && rise > epsilon) return "toward-end";
  if (net >= -epsilon && rise >= -epsilon) return "still";
  return "away";
}

/**
 * A finger's step with a range move applied: the view's offset moves by it,
 * the edge element's recorded place on screen moves against it (lowering the
 * offset carries the content down the screen by as much), and the reference
 * row is untouched, because a range move leaves every content position where
 * it was.
 *
 * Carried, not re-measured. A step re-armed at the live geometry would take
 * the reader's own movement into its baseline and forget it: a step at 6, an
 * own move to 5 that has not reported, then a clamp 5 -> 4, re-armed at 4,
 * reads as a reader who never moved. Carried to 5, the step still sees their
 * own pixel.
 */
/** An armed departure's references carried by a view movement that was none of
 *  the reader's, announced (`noteScrollerMoved`) or recognised
 *  (`noteViewportGrowthClamp`).
 *
 *  A gesture's geometry is a view offset and owes every such movement. A
 *  finger's references owe only a RANGE move: measured against the content,
 *  they have already netted out an offset write, which moved the content with
 *  the view. An owned navigation holds no offset of its own. */
function armCarriedBy(
  arm: ArmedReaderDeparture,
  delta: number,
  cause: ChatTimelineScrollerMoveCause,
): ArmedReaderDeparture {
  if (arm === null || arm.source === "owned-navigation") return arm;
  if (arm.source === "gesture") {
    return arm.geometryAtGesture === null
      ? arm
      : {
          ...arm,
          geometryAtGesture: geometryMovedBy(arm.geometryAtGesture, delta),
        };
  }
  return cause === "range" ? touchArmCarriedBy(arm, delta) : arm;
}

function touchArmCarriedBy(arm: ReaderTouchArm, delta: number): ReaderTouchArm {
  return {
    ...arm,
    scrollTopAtStep: arm.scrollTopAtStep + delta,
    edgeAtStep:
      arm.edgeAtStep === null
        ? null
        : { ...arm.edgeAtStep, top: arm.edgeAtStep.top - delta },
  };
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
  // Where a reader's own departure stands, until it ends: they follow again,
  // arrive at the end, gesture toward it, or the turn's rest finds them at
  // the strict bottom with no report of theirs owed. Each report of theirs off the strict bottom moves it
  // to where they are, so the list clamping its end to meet that offset is
  // not the reader returning, while one past it is. A write the app or the
  // list announces moves it with the view: that write is not the reader
  // moving either.
  const readerDepartureScrollTopRef = useRef<number | null>(null);
  // A reader detached with no report of theirs (a mount off the end, a
  // navigation's landing, a restore) owes a departure, so an end that comes
  // to them is the list's. On the strict bottom none can be taken: a detached
  // latch there is stale, and maintenance heals it. A gesture toward the end
  // forgives it, as it ends a departure.
  const departureOwedRef = useRef(!initialScrollAtEnd);
  // Whether the departure was published ahead of its gesture's report (the
  // tail moving away from a wheel up no report has followed, or a read
  // seeing a pan before its scroll event), until a report arrives. Only then
  // may a report of the reader's own still come, so only then does the turn's
  // rest leave them held at the strict bottom (`reconcileTurnAtRest`). A wheel
  // a nested scroller owned may never move the transcript: that scroller's
  // `scrollend` ends the wait instead (`handleScrollEnd`).
  const departureAwaitsReportRef = useRef<DepartureAwaitingReport>(null);
  const armedReaderDepartureRef = useRef<ArmedReaderDeparture>(null);
  const activeCorrectionRef = useRef<ActiveEndCorrection | null>(null);
  const pendingEndCorrectionScrollRef = useRef<Promise<void> | null>(null);
  const readerEndCandidateRef = useRef<ReaderEndCandidate | null>(null);
  // From a touch lift until the next reader input or owned navigation: the
  // momentum after the lift is the reader's own motion, with no touch event
  // to say where it is heading.
  const readerMomentumEndRef = useRef<ReaderMomentumEnd | null>(null);
  // Where the view would be had only the app, the list and the browser moved
  // it since the latest scroll report, or read of it. A finger landing on a
  // fling gives iOS no touch event for its whole contact, so its pan shows
  // only as scroll reports: a report above this is that pan, and so is a
  // view read above it before its report arrives. The app and the list
  // announce every write they make (`CHAT_TIMELINE_SCROLLER_MOVED_EVENT`),
  // and the browser moves the view only by clamping it onto a lower end,
  // which leaves it on the end. Null while the movement is announced reader
  // input's, until the next report or the touch's lift; from a lift a
  // held-back write may land after, until the next report; and before the
  // first.
  const expectedScrollTopRef = useRef<number | null>(null);
  // The whole geometry this latch last saw, which the ledger above keeps only
  // the offset of. A viewport growing clamps the view with nothing to announce
  // it, and the only way to know the browser did that is to compare the end
  // the content and the viewport reached then against the one they reach now
  // (`viewportGrowthClamp`).
  const lastObservedGeometryRef = useRef<ChatTimelineScrollGeometry | null>(
    null,
  );
  // A write announced under a finger read back short of what it asked for:
  // iOS holds it back and lands it after the lift, unannounced.
  const touchWriteMayLandRef = useRef(false);
  // From such a lift until the next scroll report: the offsets a late landing
  // would shift (the ledger, a published departure) are taken from that
  // report, not from the view the lift saw.
  const liftAwaitsLandingRef = useRef(false);
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
      if (isFollowing) {
        readerDepartureScrollTopRef.current = null;
        departureOwedRef.current = false;
      }
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

  // A departure a reader owes stands at the first view off the strict bottom.
  const takeOwedDeparture = useCallback(
    (geometry: ChatTimelineScrollGeometry): void => {
      if (
        !departureOwedRef.current ||
        !isChatTimelineGeometryMeasurable(geometry) ||
        isChatTimelineAtStrictBottom(geometry)
      ) {
        return;
      }
      departureOwedRef.current = false;
      readerDepartureScrollTopRef.current = geometry.scrollTop;
    },
    [],
  );

  // A view seen in passing, which a restore still in progress may yet move.
  const noteOwedDeparture = useCallback(
    (geometry: ChatTimelineScrollGeometry): void => {
      if (isCorrectionSuppressed?.() !== true) takeOwedDeparture(geometry);
    },
    [isCorrectionSuppressed, takeOwedDeparture],
  );

  // A transition that leaves the reader detached where the view stands.
  const oweDepartureAtView = useCallback((): void => {
    if (permissionRef.current) return;
    departureOwedRef.current = true;
    const node = listRef.current?.getScrollableNode();
    if (node) takeOwedDeparture(readScrollGeometry(node));
  }, [listRef, takeOwedDeparture]);

  const setExplicitFollowIntent = useCallback(
    (isFollowing: boolean): void => {
      setFollowIntent(isFollowing);
      oweDepartureAtView();
    },
    [oweDepartureAtView, setFollowIntent],
  );

  const noteReaderGesture = useCallback(
    (intent: ChatTimelineReaderGestureIntent): void => {
      readerGestureGenerationRef.current += 1;
      readerMomentumEndRef.current = null;
      expectedScrollTopRef.current = null;
      if (intent.direction === "toward-end") {
        readerDepartureScrollTopRef.current = null;
        departureOwedRef.current = false;
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
      onReaderGestureRef.current?.({
        ...intent,
        viewportCanAnswer: blocksAutomaticCorrection,
      });
    },
    [cancelActiveCorrection, listRef, supersedePendingEndCorrection],
  );

  // Whether a read of the view outside a scroll report finds it moved away
  // from the end past everything announced since the ledger's last offset:
  // a scroll the browser applied ahead of its report, which a task between
  // the two (a resize, a commit, a correction's frame) can read. The next is
  // measured from it, as from a report. The ledger is left null: only a
  // report starts it again after reader input, whose arm decides until then.
  const noteViewRead = useCallback(
    (geometry: ChatTimelineScrollGeometry): boolean => {
      const expected = expectedScrollTopRef.current;
      if (expected === null) return false;
      const resting = restingScrollTop(geometry);
      expectedScrollTopRef.current = resting;
      return resting < expected - CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX;
    },
    [],
  );

  // A following reader under no arm whose view moved away from the end,
  // unannounced, is moving it themselves - a pan no touch event announced,
  // or a wheel's scroll that outlived the arm it shared: their departure,
  // published as a delivered `touchmove` would have.
  const publishUnannouncedDeparture = useCallback(
    (geometry: ChatTimelineScrollGeometry, movedAway: boolean): boolean => {
      if (
        !movedAway ||
        !permissionRef.current ||
        armedReaderDepartureRef.current !== null ||
        ownsFreeNavigationRef.current
      ) {
        return false;
      }
      readerDepartureScrollTopRef.current = geometry.scrollTop;
      departureAwaitsReportRef.current = null;
      supersedePendingEndCorrection();
      onReaderGestureRef.current?.({
        direction: "away-from-end",
        freezeInFlightScroll: true,
        publishesReaderPosition: true,
        // The view is already off the end, unannounced: it moved.
        viewportCanAnswer: true,
      });
      setFollowIntent(false);
      return true;
    },
    [setFollowIntent, supersedePendingEndCorrection],
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

  /**
   * The browser clamping the view because the viewport grew, absorbed as the
   * announced writes above are: every reference that judges the reader against
   * a stored offset moves by what the clamp moved the view, and this
   * observation charges the reader with none of it.
   *
   * It runs before the ledger is read on every path that reads it - a scroll
   * report, a maintenance read, and a correction's validation frame - because a
   * lower offset is what the ledger turns into the reader having moved away.
   *
   * The ends a reader is headed for are left, here as at an announced write:
   * they name content, and the clamp moved none.
   */
  const noteViewportGrowthClamp = useCallback(
    (geometry: ChatTimelineScrollGeometry): void => {
      const reference = lastObservedGeometryRef.current;
      lastObservedGeometryRef.current = geometry;
      if (reference === null) return;
      const delta = viewportGrowthClamp(reference, geometry);
      if (delta === null) return;
      const departure = readerDepartureScrollTopRef.current;
      if (departure !== null) {
        readerDepartureScrollTopRef.current = departure + delta;
      }
      armedReaderDepartureRef.current = armCarriedBy(
        armedReaderDepartureRef.current,
        delta,
        "range",
      );
      // The lift a momentum travels from, as at an announced write: the clamp
      // moved the view it is read against, so travel across the clamp is the
      // same travel it was. Left behind, the clamp's own pixels would come off
      // a lifted finger's momentum and a tail regrowing over the clamp - the
      // frame this absorbs - is where that would be read.
      const momentum = readerMomentumEndRef.current;
      if (momentum !== null) {
        readerMomentumEndRef.current = {
          ...momentum,
          liftScrollTop: momentum.liftScrollTop + delta,
        };
      }
      const expected = expectedScrollTopRef.current;
      if (expected !== null) {
        expectedScrollTopRef.current = expected + delta;
      }
    },
    [],
  );

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
        // This frame reads the view and can publish a departure from it, so it
        // is a third observation of the geometry and owes the same absorption
        // the other two do - and it is the one most likely to see a viewport
        // change, running two frames after a write while the layout settles.
        noteViewportGrowthClamp(liveGeometry);
        const movedAway = noteViewRead(liveGeometry);
        if (isChatTimelineAtStrictBottom(liveGeometry)) {
          cancelActiveCorrection();
          return;
        }
        // A scroll the reader made between the frames, not yet reported: the
        // reissue would write the end over it. The view moved, so that report
        // is coming.
        if (publishUnannouncedDeparture(liveGeometry, movedAway)) {
          departureAwaitsReportRef.current = { wheelTarget: null };
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
        const end = chatTimelineEndScrollTop(list, node);
        moveChatTimelineScroller(node, end, () => {
          node.scrollTop = end;
        });
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
    [
      cancelActiveCorrection,
      createActiveCorrection,
      noteViewRead,
      noteViewportGrowthClamp,
      publishUnannouncedDeparture,
    ],
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
      oweDepartureAtView();
    },
    [cancelActiveCorrection, oweDepartureAtView, setFollowIntent],
  );

  // A correction suppression (a hydration restore's) lets a strict-bottom
  // landing follow only once that landing resolves it.
  const suppressionLetsStrictBottomFollow = useCallback(
    (): boolean =>
      isCorrectionSuppressed?.() !== true ||
      resolveSuppressedEndLanding?.() === true,
    [isCorrectionSuppressed, resolveSuppressedEndLanding],
  );

  const reconcileStrictBottom = useCallback(
    (geometry: ChatTimelineScrollGeometry, isOwnedLanding: boolean): void => {
      cancelActiveCorrection();
      const readerCandidate = readerEndCandidateRef.current;
      readerEndCandidateRef.current = null;
      const armedDeparture = armedReaderDepartureRef.current;
      // An owned free navigation's own frames can pass the strict edge (an
      // animated jump's first frame, a landing clamped at the tail), and its
      // arm may already be spent on a report that arrived late. While it owns
      // the view, its completion reconciles the geometry it settles on.
      if (ownsFreeNavigationRef.current && !isOwnedLanding) return;
      const isTouchContact = armedDeparture?.source === "touch";
      if (isTouchContact) {
        // The view is on the tail mid-contact, by the finger (streaming grew
        // it past the contact offset) or by a clamp a read saw before its
        // report: later movement is measured from here. Otherwise a drag back
        // to the original offset would read as a tap, and the lift would
        // correct the reader to the tail; and the clamp's report, with the
        // end moved again, would read as the finger leaving.
        armedReaderDepartureRef.current = touchArmAt(geometry, listRef.current);
      }
      // A finger reaching the tail is the reader's (a read under a finger
      // never gets here while a recovery holds a detached reader: the
      // maintain path leaves them first).
      if (
        !isTouchContact &&
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
      // A free reader's own scroll away may still land: the strict bottom
      // under them is not their asking for the end, and they stay free with
      // the pill until it lands, the turn rests after a report has followed
      // it (`reconcileTurnAtRest`), or their next input.
      if (
        !isOwnedLanding &&
        !permissionRef.current &&
        armAwaitsScrollAway(armedReaderDepartureRef.current)
      ) {
        return;
      }
      setFollowIntent(suppressionLetsStrictBottomFollow());
      oweDepartureAtView();
    },
    [
      cancelActiveCorrection,
      isReattachSuppressed,
      listRef,
      oweDepartureAtView,
      setFollowIntent,
      suppressionLetsStrictBottomFollow,
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
      reconcileStrictBottom(geometry, true);
      return;
    }
    setFollowIntent(false);
    oweDepartureAtView();
  }, [listRef, oweDepartureAtView, reconcileStrictBottom, setFollowIntent]);

  const cancelOwnedFreeNavigation = useCallback((): void => {
    if (!ownsFreeNavigationRef.current) return;
    ownsFreeNavigationRef.current = false;
    if (armedReaderDepartureRef.current?.source === "owned-navigation") {
      armedReaderDepartureRef.current = null;
    }
  }, []);

  const tryReattachReader = useCallback(
    (node: HTMLElement, geometry: ChatTimelineScrollGeometry): boolean => {
      const met = readerEndCandidateMet(
        readerEndCandidateRef.current,
        geometry,
        listRef.current,
        readerGestureGenerationRef.current,
      );
      if (met === "unreadable") readerEndCandidateRef.current = null;
      if (met !== "met" || isCorrectionSuppressed?.() === true) {
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
        // A report at the step's offset is not the finger moving the view:
        // the correction the contact cancelled may have left the DOM a hair
        // off the tail, and the lift resolves that as a tap. Keep the arm.
        if (
          Math.abs(geometry.scrollTop - armedDeparture.scrollTopAtStep) <=
          CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
        ) {
          return false;
        }
        // A following reader's finger is decided a step at a time. A step
        // toward the end never departs from it: the tail grew under the held
        // correction, and the lift's catch-up brings them to it. The next
        // step is measured from here, so a reversal is still their departure
        // though it stays past the contact offset. A step the list alone
        // moved is no step of the finger's. Keep the arm.
        if (permissionRef.current) {
          const step = touchStep(armedDeparture, geometry, listRef.current);
          if (step === "toward-end") {
            armedReaderDepartureRef.current = touchArmAt(
              geometry,
              listRef.current,
            );
            return false;
          }
          if (step === "still") return false;
        }
        // The finger moved the view: this is the published reader position a
        // delivered `touchmove` would have reported.
        readerDepartureScrollTopRef.current = geometry.scrollTop;
        departureAwaitsReportRef.current = null;
        supersedePendingEndCorrection();
        onReaderGestureRef.current?.({
          direction: "indeterminate",
          freezeInFlightScroll: true,
          publishesReaderPosition: true,
          // The finger moved the view, which is why this reports at all.
          viewportCanAnswer: true,
        });
      } else if (armedDeparture.source === "gesture") {
        // A press that has not scrolled is not a departure: the view sits off
        // the end because the arm held correction off while the list grew.
        if (indeterminateArmHoldsFollow(armedDeparture, geometry)) return false;
        // Backstop if arm-time geometry was unmeasurable or a later native
        // report is the first moment the reader's offset is known.
        readerDepartureScrollTopRef.current = geometry.scrollTop;
        departureAwaitsReportRef.current = null;
        supersedePendingEndCorrection();
      }
      return true;
    },
    [listRef, supersedePendingEndCorrection],
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

  // An announced write moves the ledger, a published departure and a
  // gesture's offset by what it moved the view: none of it is the reader's,
  // so a gesture whose scroll has not landed still awaits it. A view on the
  // end before it may have been clamped there since: that was the browser's.
  // A lifted finger's lift moves with it for the same reason: it is the
  // offset the view's travel is read from, so a write that moved the view
  // moved what that travel is measured against. The ends a reader is headed
  // for are left: they name content, and move only with the content they
  // name, which the list can push down by growing a row in view without
  // writing anything (`tailBlockShift`, `listRowShift`). What the arms owe
  // turns on what moved the view, which is why the write says (`armCarriedBy`).
  const noteScrollerMoved = useCallback((event: Event): void => {
    const move = scrollerMoveOf(event);
    if (move === null) return;
    if (
      armedReaderDepartureRef.current?.source === "touch" &&
      Math.abs(move.intended - move.to) > CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
    ) {
      touchWriteMayLandRef.current = true;
    }
    const delta = move.to - move.from;
    const departure = readerDepartureScrollTopRef.current;
    if (departure !== null) {
      // Exactly `to` for a departure at `from`: a reader held on the end
      // stays at no greater offset than the write's own report.
      readerDepartureScrollTopRef.current = move.to - (move.from - departure);
    }
    armedReaderDepartureRef.current = armCarriedBy(
      armedReaderDepartureRef.current,
      delta,
      move.cause,
    );
    const momentum = readerMomentumEndRef.current;
    if (momentum !== null) {
      readerMomentumEndRef.current = {
        ...momentum,
        liftScrollTop: momentum.liftScrollTop + delta,
      };
    }
    // The geometry a later clamp is recognised against moves by what this write
    // moved the view, whichever kind of write it was. It is not where the view
    // IS - it is where the view would be from everything this latch knows
    // about, so that a movement it does not know about is still there to be
    // found as the difference between the two. Snapping it onto `to` would
    // assert the whole of the view's offset as accounted for, and an unobserved
    // viewport clamp before this write - whose growth this remembered
    // `clientHeight` has not even seen - would be swallowed by that assertion
    // and charged to the reader at the next read. The content height each kind
    // of write leaves behind is in `geometryAfterAnnouncedMove`.
    const lastObserved = lastObservedGeometryRef.current;
    if (lastObserved !== null) {
      lastObservedGeometryRef.current = geometryAfterAnnouncedMove(
        lastObserved,
        move,
      );
    }
    const expected = expectedScrollTopRef.current;
    if (expected === null) return;
    const base =
      move.fromEnd - move.from <= CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
        ? move.from
        : expected;
    expectedScrollTopRef.current = base + delta;
  }, []);

  // The first report after a lift that a held-back write may land after: a
  // published departure stands where the view now is. The ledger, left null
  // at the lift, re-bases at this report too (`noteReportMovement`), and so
  // does the lift a momentum travels from: that write moved the view and is
  // the one write `noteScrollerMoved` cannot carry it by, because it was
  // announced as moving nothing and lands after the lift reads the view.
  // Credited as travel it would arrive a reader the app moved. Momentum the
  // finger did leave is not lost, only uncredited for this interval: it
  // travels from where this report leaves them.
  const noteReportAfterLiftLanding = useCallback(
    (geometry: ChatTimelineScrollGeometry): void => {
      if (!liftAwaitsLandingRef.current) return;
      liftAwaitsLandingRef.current = false;
      if (readerDepartureScrollTopRef.current !== null) {
        readerDepartureScrollTopRef.current = geometry.scrollTop;
      }
      const momentum = readerMomentumEndRef.current;
      if (momentum !== null) {
        readerMomentumEndRef.current = {
          ...momentum,
          liftScrollTop: geometry.scrollTop,
        };
      }
    },
    [],
  );

  // Whether this scroll report moved the view away from the end past
  // everything the app, the list and the browser moved it since the previous
  // one; the next is measured from it.
  const noteReportMovement = useCallback(
    (geometry: ChatTimelineScrollGeometry): boolean => {
      const expected = expectedScrollTopRef.current;
      const resting = restingScrollTop(geometry);
      expectedScrollTopRef.current = resting;
      return (
        expected !== null &&
        resting < expected - CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
      );
    },
    [],
  );

  // A detached reader whose departure is published. Whether the strict
  // bottom under them is the list's end meeting them rather than the reader
  // returning is decided at a report (`noteReportAfterDeparture`), at a read
  // (`reconcileMaintenanceAtStrictBottom`) and at the turn's rest
  // (`reconcileTurnAtRest`).
  const holdsDepartedReaderAtEnd = useCallback(
    (): boolean =>
      !permissionRef.current && readerDepartureScrollTopRef.current !== null,
    [],
  );

  // Whether strict-bottom geometry is the end come to a departed reader, by
  // shrinking onto them or clamping them: at no greater offset than their
  // departure, so they did not move toward it. They stay detached, whether
  // or not a turn runs: the end may grow back, and only their own scroll or
  // the jump to the end re-attaches them. Any greater offset is theirs,
  // however small the step: the browser only lowers the offset (a clamp), and
  // an announced write carries the departure with it.
  const endMetDepartedReader = useCallback(
    (geometry: ChatTimelineScrollGeometry): boolean => {
      const departure = readerDepartureScrollTopRef.current;
      return (
        departure !== null &&
        holdsDepartedReaderAtEnd() &&
        geometry.scrollTop <= departure
      );
    },
    [holdsDepartedReaderAtEnd],
  );

  // Whether this report is the end clamping a departed reader, which leaves
  // them held. A report at the strict bottom, at no greater offset than the
  // departure stood at before it, is the end dropping under the reader (a
  // temporary end pad reset). The departure then stands where the clamp put
  // them. One at a greater offset is the reader arriving, and follows. Any
  // report off the strict bottom is the reader's own scroll, either way: the
  // departure stands where it put them, so only an end that comes to them
  // there is the list's.
  const noteReportAfterDeparture = useCallback(
    (geometry: ChatTimelineScrollGeometry): boolean => {
      departureAwaitsReportRef.current = null;
      if (isChatTimelineAtStrictBottom(geometry)) {
        if (!endMetDepartedReader(geometry)) {
          // They arrived: they follow, though a restore may hold that off for
          // now, and nothing holds them later.
          readerDepartureScrollTopRef.current = null;
          return false;
        }
        readerDepartureScrollTopRef.current = geometry.scrollTop;
        cancelActiveCorrection();
        return true;
      }
      if (readerDepartureScrollTopRef.current !== null) {
        readerDepartureScrollTopRef.current = geometry.scrollTop;
      } else {
        noteOwedDeparture(geometry);
      }
      return false;
    },
    [cancelActiveCorrection, endMetDepartedReader, noteOwedDeparture],
  );

  // Whether a lifted finger's momentum has reached the end it was heading
  // for, by travelling there itself. The two halves are read apart because
  // the list moves them apart:
  // - the lift is where the view stood, and every write the list or the app
  //   has made since has moved it with the view (`noteScrollerMoved`), so
  //   what is left between it and this view is the reader's own travel. An
  //   end that came to a standing view is no write at all, and moves it not
  //   at all;
  // - the end is where the content the finger was thrown at then stood, and
  //   it moves with that content's row. A row growing in view pushes that
  //   content down without moving the view, so the view reaching the offset
  //   the lift recorded would be the reader stopping short of it.
  // A chunk can grow the tail after the momentum reaches the end and before
  // its scroll report, so no report reads the strict bottom: that growth is
  // below the content the reader headed for, leaves its row where it stood,
  // and this is the reader arriving all the same.
  //
  // An observation only reads them, and reads nothing when what the list
  // moved the row by is unknown: the view sitting at the end would read as a
  // reader who travelled there. A recovering or restoring transcript's
  // geometry is the list's, not where the momentum is headed: while it holds
  // reattachment or correction off, no observation arrives.
  const noteReaderMomentum = useCallback(
    (geometry: ChatTimelineScrollGeometry): boolean => {
      const momentum = readerMomentumEndRef.current;
      if (momentum === null) return false;
      if (
        isReattachSuppressed?.() === true ||
        isCorrectionSuppressed?.() === true
      ) {
        return false;
      }
      // A write the contact held back has not landed yet: the view the lift
      // read is not where it will rest, so nothing here is travel. Both the
      // maintain read and the report reach this, and only the report
      // re-bases the lift (`noteReportAfterLiftLanding`), so the guard has
      // to be here rather than at either caller.
      if (liftAwaitsLandingRef.current) return false;
      const shift = readerEndShift(listRef.current, momentum);
      // Unreadable once is unreadable for the rest of the gesture, as the
      // candidate's `unreadable` is: an end nothing can place does not
      // become placeable because the row went back to the size it was.
      if (shift === null) {
        readerMomentumEndRef.current = null;
        return false;
      }
      return (
        geometry.scrollTop >=
          endScrollTopOf(momentum.targetContentEnd, geometry, shift) -
            CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX &&
        geometry.scrollTop >
          momentum.liftScrollTop + CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
      );
    },
    [isCorrectionSuppressed, isReattachSuppressed, listRef],
  );

  // The end a lifted finger's momentum heads for: the one the lift sees,
  // unless a recovering or restoring transcript holds it (`noteReaderMomentum`).
  const noteReaderLift = useCallback((): void => {
    const node = listRef.current?.getScrollableNode();
    const geometry = node ? readScrollGeometry(node) : null;
    readerMomentumEndRef.current =
      geometry !== null &&
      isChatTimelineGeometryMeasurable(geometry) &&
      isReattachSuppressed?.() !== true &&
      isCorrectionSuppressed?.() !== true
        ? readerMomentumEndFor(geometry, listRef.current)
        : null;
  }, [isCorrectionSuppressed, isReattachSuppressed, listRef]);

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

  // A free reader's gesture away from the end awaits nothing once its scroll
  // has landed: the strict bottom they reach after it, however they reach
  // it, is theirs to follow (`reconcileStrictBottom`). The report is their
  // departure from where it landed, as a following reader's is
  // (`publishArmedDeparture`), so an end that comes up to them is the list's
  // (`endMetDepartedReader`).
  const noteFreeReportAway = useCallback(
    (geometry: ChatTimelineScrollGeometry): void => {
      const armedDeparture = armedReaderDepartureRef.current;
      if (!armAwaitsScrollAway(armedDeparture)) return;
      if (!gestureScrollLanded(armedDeparture, geometry)) return;
      armedReaderDepartureRef.current = null;
      readerDepartureScrollTopRef.current = geometry.scrollTop;
      departureAwaitsReportRef.current = null;
    },
    [],
  );

  // Where a press is measured from, as the view leaves it: the step it is
  // on ends, and the next is measured from where the view now stands
  // (`pressArmReferenceAfter`). Every path that observes the view notes it,
  // a report and a maintain read alike - a touch arm re-bases on both too
  // (`reconcileStrictBottom`), and a press's step can be the one a read sees
  // before its report.
  const notePressView = useCallback(
    (geometry: ChatTimelineScrollGeometry): void => {
      const arm = armedReaderDepartureRef.current;
      if (arm?.source !== "gesture" || arm.direction !== "indeterminate") {
        return;
      }
      const reference = pressArmReferenceAfter(arm, geometry);
      if (reference === null) return;
      armedReaderDepartureRef.current = {
        ...arm,
        geometryAtGesture: reference,
      };
    },
    [],
  );

  // A following reader's non-bottom report under their arm: the departure,
  // once the arm says it is one.
  const publishArmedReport = useCallback(
    (
      armedDeparture: NonNullable<ArmedReaderDeparture>,
      geometry: ChatTimelineScrollGeometry,
    ): void => {
      if (!publishArmedDeparture(armedDeparture, geometry)) return;
      // A touch contact is not consumed by one departure: the finger may
      // reach the strict bottom (which re-grants follow) and keep dragging,
      // and that later report is still the reader's. Only the lift ends it.
      if (armedDeparture.source !== "touch") {
        armedReaderDepartureRef.current = null;
      }
      setFollowIntent(false);
    },
    [publishArmedDeparture, setFollowIntent],
  );

  const observeLiveGeometry = useCallback((): void => {
    const node = listRef.current?.getScrollableNode();
    if (!node) return;
    const geometry = readScrollGeometry(node);
    if (!isChatTimelineGeometryMeasurable(geometry)) return;
    // Before the ledger reads this offset: a viewport that grew since the last
    // observation took the view down with the end, and that is the browser's
    // move, not the reader's.
    noteViewportGrowthClamp(geometry);
    noteReportAfterLiftLanding(geometry);
    const movedAway = noteReportMovement(geometry);
    if (noteReportAfterDeparture(geometry)) return;
    // Before the strict bottom reconciles or the arm decides: a press's drag
    // to the end is a step of its own, and the end it reaches is not where
    // the next step is measured from.
    notePressView(geometry);
    const momentumArrived = noteReaderMomentum(geometry);
    if (isChatTimelineAtStrictBottom(geometry)) {
      reconcileStrictBottom(geometry, false);
      return;
    }
    // Ahead of a correction in flight: its own writes only move the view
    // toward the end.
    if (publishUnannouncedDeparture(geometry, movedAway)) return;

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
      noteFreeReportAway(geometry);
      return;
    }
    const armedDeparture = armedReaderDepartureRef.current;
    if (armedDeparture !== null) {
      publishArmedReport(armedDeparture, geometry);
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
    noteFreeReportAway,
    noteReaderMomentum,
    noteReportAfterDeparture,
    noteReportAfterLiftLanding,
    noteReportMovement,
    noteViewportGrowthClamp,
    notePressView,
    publishArmedReport,
    publishFreeTouchWhileSuppressed,
    publishUnannouncedDeparture,
    reconcileStrictBottom,
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

  /** A toward-end gesture whose arrival only a read can see. The reader
   *  wheeled toward the end, the viewport then grew and brought the end up to
   *  them, and the wheel moved the view nothing - so no scroll report is owed
   *  and the report path never judges the candidate. Left unseen, the tail
   *  growing past the arrival leaves them free at an end they asked for and
   *  reached.
   *
   *  A recovering transcript holding reattachment off is answered as
   *  `reconcileStrictBottom` answers it: the arrival survives as reached, and
   *  the settle that lifts the hold follows it. */
  const followReaderEndArrivalOnRead = useCallback(
    (node: HTMLElement, geometry: ChatTimelineScrollGeometry): boolean => {
      const met = readerEndCandidateMet(
        readerEndCandidateRef.current,
        geometry,
        listRef.current,
        readerGestureGenerationRef.current,
      );
      if (met === "unreadable") readerEndCandidateRef.current = null;
      if (met !== "met") return false;
      if (!permissionRef.current && isReattachSuppressed?.() === true) {
        readerEndCandidateRef.current = reachedReaderEnd(
          readerEndCandidateRef.current,
          readerGestureGenerationRef.current,
        );
        return false;
      }
      return tryReattachReader(node, geometry);
    },
    [isReattachSuppressed, listRef, tryReattachReader],
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
      if (endMetDepartedReader(geometry)) {
        // The end meeting a departed reader (a temporary end pad dropped) is
        // the list's, not the reader returning. The departure stands where
        // it put them, as at the report of it (`noteReportAfterDeparture`):
        // that report may come after a write has carried the view on.
        readerDepartureScrollTopRef.current = geometry.scrollTop;
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
      reconcileStrictBottom(geometry, false);
    },
    [
      cancelActiveCorrection,
      endMetDepartedReader,
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
    // As on the report path: the clamp a grown viewport forced is absorbed
    // before this read can charge it to the reader.
    noteViewportGrowthClamp(geometry);
    const movedAway = noteViewRead(geometry);
    // A press's step, or the clamp of an end that dropped under it, can be
    // what this read sees before any report of it arrives: the view it finds
    // is where the press now stands, whichever observed it first.
    notePressView(geometry);
    const momentumArrived = noteReaderMomentum(geometry);
    if (isChatTimelineAtStrictBottom(geometry)) {
      reconcileMaintenanceAtStrictBottom(geometry);
      return;
    }
    // A scroll applied ahead of its report: correcting it would undo it. The
    // view moved, so that report is coming.
    if (publishUnannouncedDeparture(geometry, movedAway)) {
      departureAwaitsReportRef.current = { wheelTarget: null };
      return;
    }
    noteOwedDeparture(geometry);
    if (followReaderEndArrivalOnRead(node, geometry)) return;
    if (followReachedReaderEnd(list, node)) return;
    if (followReaderMomentumArrival(node, momentumArrived)) return;
    if (!permissionRef.current) return;
    if (isCorrectionSuppressed?.() === true) return;
    // Reader/free-navigation intent published before its native scroll
    // report, or a finger still on the transcript: starting a correction here
    // would inherit that gesture's generation and then mask the departure as
    // correction-owned - and under a finger iOS drops the write anyway, only
    // to land it after the lift.
    const armedDeparture = armedReaderDepartureRef.current;
    if (armDepartsOnGrowth(armedDeparture)) {
      // The tail moved away from a reader whose wheel up has not reported:
      // they are leaving it, whether the wheel's movement comes later or the
      // end came up to absorb it, and no report tells the two apart. Their
      // scroll-up holds; the tail does not drag them.
      publishArmedDeparture(armedDeparture, geometry);
      // With no report since the wheel, its scroll is still to come, and
      // would read as layout. After one, the ledger reads a later frame as
      // theirs, so no report is owed.
      departureAwaitsReportRef.current =
        expectedScrollTopRef.current === null
          ? { wheelTarget: armedDeparture.wheelTarget }
          : null;
      armedReaderDepartureRef.current = null;
      setFollowIntent(false);
      return;
    }
    if (armBlocksAutomaticCorrection(armedDeparture)) return;

    startEndCorrection(list, node);
  }, [
    followReachedReaderEnd,
    followReaderEndArrivalOnRead,
    followReaderMomentumArrival,
    isCorrectionSuppressed,
    listRef,
    noteOwedDeparture,
    noteReaderMomentum,
    notePressView,
    noteViewRead,
    noteViewportGrowthClamp,
    publishArmedDeparture,
    publishUnannouncedDeparture,
    reconcileMaintenanceAtStrictBottom,
    setFollowIntent,
    startEndCorrection,
  ]);

  const reconcileTurnAtRest = useCallback((): void => {
    // The strict bottom cannot tell a wheel whose scroll is still coming from
    // one the end absorbed, and the one still coming must be the reader's
    // departure when it lands. One no report has followed may still be
    // coming, and would read as the list's: a reader held at the strict
    // bottom with it stays held, as at any follow the latch starts itself
    // (`reconcileStrictBottom`). That is so whether the wheel's arm still
    // waits for it or the tail's growth already published the departure
    // ahead of it, as it is for a pan a read published ahead of its scroll
    // event (`departureAwaitsReportRef`); the report ends either.
    // An arm a report has followed is spent here: nothing grows past the
    // reader now to start a correction that would mask what is left of it,
    // and that report restarted the ledger, so a later frame reads as their
    // own (`publishUnannouncedDeparture`).
    if (departureAwaitsReportRef.current !== null) return;
    if (armAwaitsScrollAway(armedReaderDepartureRef.current)) {
      if (expectedScrollTopRef.current === null) return;
      armedReaderDepartureRef.current = null;
    } else if (!holdsDepartedReaderAtEnd()) {
      return;
    }
    const node = listRef.current?.getScrollableNode();
    if (!node) return;
    const geometry = readScrollGeometry(node);
    if (
      !isChatTimelineGeometryMeasurable(geometry) ||
      !isChatTimelineAtStrictBottom(geometry)
    ) {
      return;
    }
    noteViewRead(geometry);
    // Nothing will grow past them now. What still holds a detached reader at
    // the strict bottom (a suppression, a recovering transcript) still
    // decides.
    readerDepartureScrollTopRef.current = null;
    reconcileMaintenanceAtStrictBottom(geometry);
  }, [
    holdsDepartedReaderAtEnd,
    listRef,
    noteViewRead,
    reconcileMaintenanceAtStrictBottom,
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
    node.addEventListener(
      CHAT_TIMELINE_SCROLLER_MOVED_EVENT,
      noteScrollerMoved,
    );
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
      const arm = armedReaderDepartureRef.current;
      if (arm?.source === "gesture" && direction === "away-from-end") {
        armedReaderDepartureRef.current = { ...arm, departsOnGrowth: true };
      }
      if (direction === "toward-end") followEndIfPermitted();
    };
    // The wheel this handler last armed, until its dispatch ends.
    let wheelArm: {
      readonly event: WheelEvent;
      readonly arm: ArmedReaderDeparture;
    } | null = null;
    const handleWheel = (event: WheelEvent): void => {
      // A canceled wheel scrolls nothing (a history swipe's opening tick is
      // canceled before it reaches here).
      if (event.deltaY === 0 || event.defaultPrevented) return;
      const direction = event.deltaY > 0 ? "toward-end" : "away-from-end";
      // The wheel scrolls a nested element, not the transcript: no gesture
      // of the transcript's, and no arm waiting for a scroll that will not
      // come.
      if (nestedScrollerTakesWheel(event.target, node, direction)) return;
      noteWheelGesture(direction);
      const arm = armedReaderDepartureRef.current;
      if (arm?.source !== "gesture") return;
      armedReaderDepartureRef.current = {
        ...arm,
        wheelTarget: event.target instanceof Element ? event.target : null,
      };
      wheelArm = { event, arm: armedReaderDepartureRef.current };
    };
    // Last in the wheel's dispatch: a listener after ours that canceled it
    // (an ancestor's, in the bubble phase) means it scrolls nothing, and
    // the arm it left would wait for a report that never comes.
    const handleWheelDispatched = (event: WheelEvent): void => {
      const armed = wheelArm;
      if (armed?.event !== event) return;
      wheelArm = null;
      if (!event.defaultPrevented) return;
      if (armedReaderDepartureRef.current !== armed.arm) return;
      armedReaderDepartureRef.current = null;
      followEndIfPermitted();
    };
    const handleScrollEnd = (event: Event): void => {
      // A wheel whose departure the tail published ahead of its report, and
      // whose nested scroller owned its whole sequence: no report of the
      // transcript's will come, so the wait for one is over. The same
      // gesture's later wheels may have armed again since; that arm's wait
      // is over too.
      const awaiting = departureAwaitsReportRef.current;
      const endsWait =
        awaiting !== null &&
        nestedScrollEndHoldsWheel(event.target, node, awaiting.wheelTarget);
      if (endsWait) departureAwaitsReportRef.current = null;
      const arm = armedReaderDepartureRef.current;
      const unblocksArm =
        arm?.source === "gesture" &&
        gestureScrollEndUnblocks(arm, event.target, node);
      if (unblocksArm) {
        armedReaderDepartureRef.current = {
          ...arm,
          blocksAutomaticCorrection: false,
        };
      }
      if (endsWait || unblocksArm) followEndIfPermitted();
    };
    // A wheel or swipe over an agent page or MCP App happens in the frame's
    // document, so the listeners above never see it, yet it chains to this
    // node. The frame relays its direction, which arms the wheel rules. A
    // scroll chained out of a frame with no relayed gesture is the reader's
    // (only their input can chain one out; the frame's own programmatic
    // scrolls are contained in the frame); it departs like any pan.
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
      armedReaderDepartureRef.current = touchArmAt(geometry, listRef.current);
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
      const liveNode = listRef.current?.getScrollableNode();
      const liveGeometry = liveNode ? readScrollGeometry(liveNode) : null;
      // Everything up to the lift was the reader's movement, so the ledger
      // resumes from the view as it stands rather than waiting on a report
      // the contact may never have produced.
      if (
        liveGeometry !== null &&
        isChatTimelineGeometryMeasurable(liveGeometry)
      ) {
        expectedScrollTopRef.current = restingScrollTop(liveGeometry);
      }
      const armedDeparture = armedReaderDepartureRef.current;
      if (armedDeparture?.source !== "touch") return;
      if (
        permissionRef.current &&
        liveGeometry !== null &&
        isChatTimelineGeometryMeasurable(liveGeometry) &&
        !isChatTimelineAtStrictBottom(liveGeometry) &&
        Math.abs(liveGeometry.scrollTop - armedDeparture.scrollTopAtStep) >
          CHAT_TIMELINE_STRICT_BOTTOM_EPSILON_PX
      ) {
        // The finger moved the view since its last decided step, and that
        // scroll report has not arrived (or arrived before the lift could be
        // read). Decide it now, while the arm is intact: a departure is
        // published, so the next maintain trigger cannot classify it as
        // layout-owned; a following reader's drag toward the end is not one,
        // and the catch-up below follows it.
        observeLiveGeometry();
      }
      // The lift ends the contact. After a departure, follow is already off
      // and the catch-up is a no-op; after a tap it lets streaming follow
      // again and corrects any growth the contact held back.
      armedReaderDepartureRef.current = null;
      followEndIfPermitted();
      if (touchWriteMayLandRef.current) {
        // A write the contact held back may land now, unannounced: the view
        // the lift saw is not where it will rest. The next report says.
        touchWriteMayLandRef.current = false;
        expectedScrollTopRef.current = null;
        liftAwaitsLandingRef.current = true;
      }
      // Momentum may carry the reader on from here, reported only by bare
      // scroll reports.
      noteReaderLift();
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
          // Whichever way that read decided, the press is over and its arm
          // goes with it. A departure spent the arm and turned follow off,
          // so the catch-up below is a no-op; a press still following here
          // never scrolled away from the offset it was last measured from
          // (`indeterminateArmHoldsFollow` held its departure), so the view
          // sits off the end because the arm held correction off while the
          // list grew, and the correction now takes them to it.
          armedReaderDepartureRef.current = null;
          followEndIfPermitted();
          return;
        }
        // A click/release whose live geometry stayed at the strict edge was a
        // no-op and may emit no scroll event. Release only that preflight so a
        // later stream mutation can continue following normally.
        armedReaderDepartureRef.current = null;
      }
    };
    node.addEventListener("wheel", handleWheel, { passive: true });
    window.addEventListener("wheel", handleWheelDispatched, { passive: true });
    // `scrollend` does not bubble: a nested scroller's reaches this node only
    // in the capture phase.
    node.addEventListener("scrollend", handleScrollEnd, {
      capture: true,
      passive: true,
    });
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
      node.removeEventListener(
        CHAT_TIMELINE_SCROLLER_MOVED_EVENT,
        noteScrollerMoved,
      );
      node.removeEventListener("wheel", handleWheel);
      window.removeEventListener("wheel", handleWheelDispatched);
      node.removeEventListener("scrollend", handleScrollEnd, { capture: true });
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
    noteReaderLift,
    noteScrollerMoved,
    observeLiveGeometry,
    supersedePendingEndCorrection,
  ]);

  return useMemo(
    () => ({
      followEndIfPermitted,
      setFollowIntent: setExplicitFollowIntent,
      noteReaderGesture,
      beginOwnedEndNavigation,
      beginOwnedFreeNavigation,
      completeOwnedFreeNavigation,
      cancelOwnedFreeNavigation,
      completeOwnedEndNavigation,
      isAtStrictEnd,
      hasPendingEndCorrection,
      observeLiveGeometry,
      reconcileTurnAtRest,
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
      reconcileTurnAtRest,
      setExplicitFollowIntent,
    ],
  );
}
