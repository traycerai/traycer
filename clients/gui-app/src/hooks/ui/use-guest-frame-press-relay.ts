import { useEffect, type RefObject } from "react";
import { attachGuestFramePressRelay } from "@/lib/guest-frame-press-relay";

/**
 * The guest-frame press relay (`lib/guest-frame-press-relay.ts`) for a frame
 * React renders: a press inside the frame `frameRef` points at counts as a
 * press on the frame element for every overlay on the page.
 */
export function useGuestFramePressRelay(
  frameRef: RefObject<Element | null>,
): void {
  useEffect(
    () => attachGuestFramePressRelay(() => frameRef.current),
    [frameRef],
  );
}
