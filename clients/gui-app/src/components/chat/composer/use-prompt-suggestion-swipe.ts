import { useCallback, useRef, type PointerEvent } from "react";
import {
  classifyDirectionalIntent,
  commitsDirectionalGesture,
  type DirectionalCommitLimits,
} from "@/components/layout/shell/shell-gestures";

/**
 * Rightward travel that accepts: a short deliberate drag, or a flick that
 * reaches the speed first. The editor is at most a phone's width, so the
 * distance arm has to be one a thumb covers without crossing the screen.
 */
const ACCEPT_SWIPE_COMMIT: DirectionalCommitLimits = {
  commitPx: 40,
  velocityPxPerMs: 0.5,
};

/**
 * The editor class that reserves the horizontal axis for the swipe below. A
 * web view arbitrates every touch against its own panning first and cancels
 * the pointer sequence once it takes the drag, so without this the moves stop
 * arriving on a real touch screen. Vertical stays the browser's, which keeps
 * the chat scrolling and the drag that puts the keyboard away.
 */
export const PROMPT_SUGGESTION_SWIPE_EDITOR_CLASSNAME = "touch-pan-y";

interface SwipeTracking {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  /** The classifier has claimed this drag; stop re-asking it. */
  activated: boolean;
}

export interface PromptSuggestionSwipeHandlers {
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
}

/**
 * Swipe right over the composer to accept the suggestion: touch's stand-in for
 * →, which a soft keyboard does not have, travelling the same way the key
 * points.
 *
 * A TAP IS NOT AN ACCEPT. Tapping the composer is how a phone user starts
 * typing, so a tap that filled the draft would hand them a prompt they then
 * have to delete before writing their own. The tap keeps its ordinary job -
 * focus, caret, keyboard - and the suggestion stays the placeholder under it.
 *
 * The pointer is unclaimed until the motion declares an axis
 * (`classifyDirectionalIntent`), which is what leaves a tap a tap and a
 * vertical drag a scroll. Once it activates the classifier is never consulted
 * again, and the swipe accepts on the move that crosses the commit threshold:
 * nothing travels with the finger here, so the fill itself is the only
 * feedback there is, and holding it back to the release would make a completed
 * swipe look like one that had not registered.
 *
 * Touch pointers only. A horizontal mouse or pen drag over the editor is a
 * text selection, and those devices have the → key.
 */
export function usePromptSuggestionSwipe(
  suggestedPrompt: string | null,
  onAcceptSuggestion: (suggestion: string) => boolean,
): PromptSuggestionSwipeHandlers {
  const trackingRef = useRef<SwipeTracking | null>(null);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      // Every contact starts a fresh gesture, and a second finger landing ends
      // the first one's: a pinch is not a swipe, and touch pointer ids are
      // reused, so a tracker left behind would be matched by the next contact.
      trackingRef.current = null;
      if (suggestedPrompt === null) return;
      if (event.pointerType !== "touch") return;
      if (!event.isPrimary) return;
      trackingRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
        activated: false,
      };
    },
    [suggestedPrompt],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const tracking = trackingRef.current;
      if (tracking === null) return;
      if (event.pointerId !== tracking.pointerId) return;
      // The offer can be withdrawn under the finger: the turn it predicted for
      // starts, or a banner goes up. A swipe begun over it is owed nothing.
      if (suggestedPrompt === null) {
        trackingRef.current = null;
        return;
      }
      const gesture = {
        primaryPx: event.clientX - tracking.x,
        crossPx: event.clientY - tracking.y,
        elapsedMs: event.timeStamp - tracking.at,
      };
      if (!tracking.activated) {
        const intent = classifyDirectionalIntent(gesture);
        if (intent === "fail") {
          trackingRef.current = null;
          return;
        }
        if (intent === "wait") return;
        tracking.activated = true;
      }
      if (!commitsDirectionalGesture(gesture, ACCEPT_SWIPE_COMMIT)) return;
      trackingRef.current = null;
      onAcceptSuggestion(suggestedPrompt);
    },
    [suggestedPrompt, onAcceptSuggestion],
  );

  const onPointerEnd = useCallback(() => {
    trackingRef.current = null;
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
  };
}
