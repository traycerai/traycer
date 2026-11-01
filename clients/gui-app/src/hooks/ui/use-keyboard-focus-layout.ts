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
import {
  readSafeAreaInsets,
  subscribeToSafeAreaInsets,
} from "@/lib/safe-area-insets";

/**
 * The height left between the top safe-area inset and the keyboard, measured
 * in landscape on every device in the landscape usability report (ML7 device
 * pass) as window - top inset - keyboard inset:
 *
 * - iPhone 17: 402 - 0 - 208 = 194
 * - iPhone 17 Pro Max: 440 - 0 - 208 = 232
 * - iPad mini: 744 - 32 - 428 = 284
 * - iPad Pro 11: 834 - 32 - 428 = 374
 * - iPhone Duo open: 669 - 0 - 264 = 405
 *
 * Every one of them wants the focus layout: with the full layout the iPad Pro
 * showed 133-179 of content, less than the smaller iPad mini's focus layout
 * gives it (201). So the limit is the largest of them, the Duo's 405. Phone
 * portrait never applies, and an iPad held upright leaves far more than this.
 * The 194 is the floor the layout has to work in: two 44 rows leave it 106 of
 * context.
 */
export const KEYBOARD_FOCUS_LAYOUT_HEIGHT_LIMIT_PX = 405;

const FOCUS_OWNER_ATTRIBUTE = "data-keyboard-focus-owner";

/** Spread on the element around a text entry the focus layout makes room for. */
export const KEYBOARD_FOCUS_OWNER_PROPS = { [FOCUS_OWNER_ATTRIBUTE]: "" };

/** The native shell's keyboard: its height while open, 0 while closed. */
function readKeyboardOverlayInset(): number {
  return getNativeKeyboardState().open ? readNativeKeyboardInsetPx() : 0;
}

function readNoInset(): number {
  return 0;
}

/**
 * Overlay shells cover the window, so the inset comes off; Android resizes it,
 * so its height already is what is left, and it writes no inset. The status
 * bar's strip is not the app's either: `#root` reserves it.
 */
function readShortKeyboardViewport(): boolean {
  const nativeOpen = getNativeKeyboardState().open;
  const browserInset = readVirtualKeyboardInset();
  if (!nativeOpen && browserInset === 0) return false;
  if (readPhonePortrait()) return false;
  const covered = nativeOpen ? readNativeKeyboardInsetPx() : browserInset;
  return (
    document.documentElement.clientHeight -
      readSafeAreaInsets().top -
      covered <=
    KEYBOARD_FOCUS_LAYOUT_HEIGHT_LIMIT_PX
  );
}

function subscribeToShortKeyboardViewport(onChange: () => void): () => void {
  const unsubscribeNative = subscribeNativeKeyboardState(onChange);
  const unsubscribeViewport = subscribeToViewportChanges(onChange);
  const unsubscribePortrait = subscribeToPhonePortrait(onChange);
  const unsubscribeInsets = subscribeToSafeAreaInsets(onChange);
  return () => {
    unsubscribeNative();
    unsubscribeViewport();
    unsubscribePortrait();
    unsubscribeInsets();
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
 * The keyboard's height where it covers a window that keeps its full height
 * under it: the installed iOS app, which overlays it. A surface placed against
 * the visual viewport, as Radix places a popover, needs only this part: a
 * browser's visual viewport already ends at the keyboard, and Android's window
 * does, so it is 0 there.
 */
export function useKeyboardOverlayInset(): number {
  return React.useSyncExternalStore(
    subscribeNativeKeyboardState,
    readKeyboardOverlayInset,
    readNoInset,
  );
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

/** That element, only when it sits inside `scope`. */
export function useKeyboardFocusOwnerWithin(
  scope: Element | null,
): Element | null {
  const owner = useKeyboardFocusOwner();
  return owner !== null && scope !== null && scope.contains(owner)
    ? owner
    : null;
}

/** Whether the focus layout is serving something inside `scope`. */
export function useKeyboardFocusLayoutWithin(scope: Element | null): boolean {
  return useKeyboardFocusOwnerWithin(scope) !== null;
}
