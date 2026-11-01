import * as React from "react";
import { isTextEntryFocused } from "@/components/layout/shell/shell-gestures";
import {
  readPhonePortrait,
  subscribeToPhonePortrait,
} from "@/hooks/ui/use-mobile-layout-form";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  readVirtualKeyboardInset,
  subscribeToViewportChanges,
} from "@/hooks/ui/use-virtual-keyboard-inset";
import {
  getNativeKeyboardState,
  readNativeKeyboardInsetPx,
  subscribeNativeKeyboardState,
} from "@/lib/native-keyboard";

/**
 * Measured, on the devices in the landscape usability report, as the window's
 * raw height less the keyboard's inset: iPhone 17 194 (402 - 208), Pro Max 232
 * (440 - 208), iPhone Duo open 405 (669 - 264), iPad Pro 11 406 (834 - 428).
 *
 * The limit is the Duo's 405, the tallest that still wants the focus layout;
 * the iPad's 406 keeps its full layout. The 194 is the floor the layout has to
 * work in: two 44 rows leave it 106 of context. The top safe-area inset stays
 * in these numbers, so a reading here must keep it too.
 */
export const KEYBOARD_FOCUS_LAYOUT_HEIGHT_LIMIT_PX = 405;

const FOCUS_OWNER_ATTRIBUTE = "data-keyboard-focus-owner";

/** Spread on the element around a text entry the focus layout makes room for. */
export const KEYBOARD_FOCUS_OWNER_PROPS = { [FOCUS_OWNER_ATTRIBUTE]: "" };

/**
 * Overlay shells cover the window, so the inset comes off; Android resizes it,
 * so its height already is what is left, and it writes no inset.
 */
function readShortKeyboardViewport(): boolean {
  const nativeOpen = getNativeKeyboardState().open;
  const browserInset = readVirtualKeyboardInset();
  if (!nativeOpen && browserInset === 0) return false;
  if (readPhonePortrait()) return false;
  const covered = nativeOpen ? readNativeKeyboardInsetPx() : browserInset;
  return (
    document.documentElement.clientHeight - covered <=
    KEYBOARD_FOCUS_LAYOUT_HEIGHT_LIMIT_PX
  );
}

function subscribeToShortKeyboardViewport(onChange: () => void): () => void {
  const unsubscribeNative = subscribeNativeKeyboardState(onChange);
  const unsubscribeViewport = subscribeToViewportChanges(onChange);
  const unsubscribePortrait = subscribeToPhonePortrait(onChange);
  return () => {
    unsubscribeNative();
    unsubscribeViewport();
    unsubscribePortrait();
  };
}

function readFalse(): boolean {
  return false;
}

/**
 * The owner of the text entry that last took focus; `null` when that entry is
 * not one the layout serves. It outlives the blur on purpose: tapping Send
 * blurs the field before the click lands, and restoring the layout then would
 * move the button out from under the tap. The keyboard going down is what ends
 * the layout, and the next text entry to focus replaces the owner.
 */
let focusOwner: Element | null = null;
const focusOwnerListeners = new Set<() => void>();

function trackFocusOwner(target: EventTarget | null): void {
  if (!(target instanceof Element) || !isTextEntryFocused()) return;
  const next = target.closest(`[${FOCUS_OWNER_ATTRIBUTE}]`);
  if (next === focusOwner) return;
  focusOwner = next;
  for (const listener of [...focusOwnerListeners]) listener();
}

function handleFocusIn(event: FocusEvent): void {
  trackFocusOwner(event.target);
}

function subscribeToFocusOwner(onChange: () => void): () => void {
  if (focusOwnerListeners.size === 0) {
    document.addEventListener("focusin", handleFocusIn, true);
    trackFocusOwner(document.activeElement);
  }
  focusOwnerListeners.add(onChange);
  return () => {
    focusOwnerListeners.delete(onChange);
    if (focusOwnerListeners.size > 0) return;
    document.removeEventListener("focusin", handleFocusIn, true);
    focusOwner = null;
  };
}

function readFocusOwner(): Element | null {
  return focusOwner;
}

function readNoFocusOwner(): null {
  return null;
}

/**
 * Whether the software keyboard is up and leaves the phone shell a short
 * viewport. Phone portrait is never short: the height there is not the problem.
 */
export function useShortKeyboardViewport(): boolean {
  const phoneShell = useIsMobileViewport();
  const short = React.useSyncExternalStore(
    subscribeToShortKeyboardViewport,
    readShortKeyboardViewport,
    readFalse,
  );
  return phoneShell && short;
}

/**
 * The element the focus layout serves right now: the owner of the focused text
 * entry while the viewport is short, `null` while the full layout draws.
 */
export function useKeyboardFocusOwner(): Element | null {
  const short = useShortKeyboardViewport();
  const owner = React.useSyncExternalStore(
    subscribeToFocusOwner,
    readFocusOwner,
    readNoFocusOwner,
  );
  return short ? owner : null;
}

/** Whether the focus layout is serving something inside `scope`. */
export function useKeyboardFocusLayoutWithin(scope: Element | null): boolean {
  const owner = useKeyboardFocusOwner();
  return owner !== null && scope !== null && scope.contains(owner);
}
