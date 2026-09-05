/**
 * Electron's window-open details carry no user-activation flag, so main keeps
 * its own browser-process input timeline instead of trusting anything the page
 * can synthesize. A native popup (OAuth/GSI sign-in) is allowed only when a
 * real input landed on the opener within {@link BROWSER_VIEW_POPUP_GESTURE_WINDOW_MS}.
 */
const ACTIVATING_INPUT_TYPES: ReadonlySet<string> = new Set([
  "mouseDown",
  "mouseUp",
  "keyDown",
  "rawKeyDown",
  "char",
  "touchStart",
  "touchEnd",
  "gestureTap",
  "pointerDown",
  "pointerUp",
]);

/** GSI opens its popup after async work but still inside this window of a click. */
export const BROWSER_VIEW_POPUP_GESTURE_WINDOW_MS = 1_000;

interface GesturePopupWebContents {
  readonly on: NodeJS.EventEmitter["on"];
  readonly off: NodeJS.EventEmitter["off"];
}

export interface BrowserViewPopupGesture {
  /** Single-use: one observed click cannot be replayed into a second popup. */
  consume(): boolean;
  /**
   * Non-consuming check for a recent gesture. Used by the external-scheme
   * hand-off, where a real click authorizes the safe fast-path launch but must
   * NOT steal the click a concurrent popup open still needs to consume.
   */
  peek(): boolean;
  dispose(): void;
}

export function trackBrowserViewPopupGesture(
  opener: GesturePopupWebContents,
  now: () => number,
): BrowserViewPopupGesture {
  let lastGestureAt: number | null = null;
  const onInputEvent = (
    _event: unknown,
    input: { readonly type: unknown },
  ): void => {
    if (
      typeof input.type === "string" &&
      ACTIVATING_INPUT_TYPES.has(input.type)
    ) {
      lastGestureAt = now();
    }
  };
  let attached = false;
  try {
    opener.on("input-event", onInputEvent);
    attached = true;
  } catch {
    // Fail closed: an unobservable input stream never counts as a gesture.
  }
  return {
    consume: (): boolean => {
      const observedAt = lastGestureAt;
      lastGestureAt = null;
      return (
        attached &&
        observedAt !== null &&
        now() - observedAt <= BROWSER_VIEW_POPUP_GESTURE_WINDOW_MS
      );
    },
    peek: (): boolean =>
      attached &&
      lastGestureAt !== null &&
      now() - lastGestureAt <= BROWSER_VIEW_POPUP_GESTURE_WINDOW_MS,
    dispose: (): void => {
      lastGestureAt = null;
      if (!attached) return;
      attached = false;
      try {
        opener.off("input-event", onInputEvent);
      } catch {
        // Opener already gone; the listener died with its webContents.
      }
    },
  };
}
