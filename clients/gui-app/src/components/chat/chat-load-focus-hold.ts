import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  usePaneActivationFocusIntent,
  type PaneActivationFocusIntent,
} from "@/components/epic-canvas/pane-activation";

const TEXT_ENTRY_SELECTOR = [
  "input:not([type='button']):not([type='checkbox']):not([type='radio']):not([type='submit']):not([type='reset'])",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
].join(",");

const OVERLAY_SELECTOR = [
  "[role='menu']",
  "[role='listbox']",
  "[role='dialog']",
  "[role='alertdialog']",
  "[data-radix-popper-content-wrapper]",
].join(",");

/**
 * Whether focus sits in something the reader is in the middle of using
 * outside `surface`: a field they are typing in, an open menu or popover, or
 * the trigger of one that keeps focus on its trigger while open (the resource
 * monitor's popover does).
 * Focus on a plain control (the sidebar row that opened the chat) or on an
 * ancestor of the surface (the pane container route sync focuses) is not held.
 */
function focusIsHeldOutside(surface: Element | null): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body) return false;
  if (surface !== null) {
    if (surface.contains(active) || active.contains(surface)) return false;
  }
  return (
    active.matches(TEXT_ENTRY_SELECTOR) ||
    active.closest(OVERLAY_SELECTOR) !== null ||
    active.closest("[aria-expanded='true']") !== null
  );
}

/**
 * Keeps a chat's first transcript from taking focus away from what the reader
 * started doing while it loaded.
 *
 * The composer mounts with the transcript and focuses itself, which is right
 * when the reader is still waiting on the chat and wrong once they have moved
 * on: taking focus closes the menu they opened and ends the rename they were
 * typing. A press or key in the active tile's window while it loads arms the
 * hold; the next one after the load releases it, so a later pane switch
 * focuses the composer as before. The gesture that opened the chat lands
 * before the tile is active and never arms it.
 */
export function useChatLoadFocusHold(input: {
  readonly loaded: boolean;
  readonly active: boolean;
  readonly surface: { readonly current: Element | null };
}): PaneActivationFocusIntent {
  const { loaded, active, surface } = input;
  const parent = usePaneActivationFocusIntent();
  const armsHoldRef = useRef(active && !loaded);
  const heldRef = useRef(false);

  useLayoutEffect(() => {
    armsHoldRef.current = active && !loaded;
  }, [active, loaded]);

  useEffect(() => {
    const onInteraction = (): void => {
      heldRef.current = armsHoldRef.current;
    };
    document.addEventListener("pointerdown", onInteraction, true);
    document.addEventListener("keydown", onInteraction, true);
    return () => {
      document.removeEventListener("pointerdown", onInteraction, true);
      document.removeEventListener("keydown", onInteraction, true);
    };
  }, []);

  return useMemo(
    () => ({
      mark: parent.mark,
      shouldYieldAutoFocus: () =>
        parent.shouldYieldAutoFocus() ||
        (heldRef.current && focusIsHeldOutside(surface.current)),
    }),
    [parent, surface],
  );
}
