import {
  createContext,
  use,
  useCallback,
  useEffect,
  type EffectCallback,
} from "react";

export interface PaneSurfaceActivity {
  readonly visible: boolean;
  readonly focused: boolean;
}

/** Subscribers refit when this flips back to `true` instead of remounting - a remount would discard xterm
 * scrollback. */
export const PaneVisibilityContext = createContext<boolean>(true);

export const PaneSurfaceActivityContext = createContext<PaneSurfaceActivity>({
  visible: true,
  focused: true,
});

/** The `SurfacePresentationBoundary` toggles this node's visibility with pane focus, so those portals stay
 * mounted (their typed state survives) yet never cover a focused split partner. */
export const PanePortalContainerContext = createContext<HTMLElement | null>(
  null,
);

export function usePanePortalContainer(): HTMLElement | null {
  return use(PanePortalContainerContext);
}

/** A stable getter that reports whether the surrounding pane is focused right now, read from a live DOM
 * attribute rather than a captured render value. */
export const PaneFocusProbeContext = createContext<() => boolean>(() => true);

export function usePaneFocusProbe(): () => boolean {
  return use(PaneFocusProbeContext);
}

/** Composes a Radix `onCloseAutoFocus` handler that kills the focus-restore at its source when the content is
 * unmounting because its pane lost focus. */
export function usePaneCloseAutoFocusGuard(
  onCloseAutoFocus: ((event: Event) => void) | undefined,
): (event: Event) => void {
  const isPaneFocused = usePaneFocusProbe();
  return useCallback(
    (event: Event) => {
      if (!isPaneFocused()) {
        event.preventDefault();
        return;
      }
      onCloseAutoFocus?.(event);
    },
    [isPaneFocused, onCloseAutoFocus],
  );
}

/** Save/restore (rather than a bare toggle) keeps it correct if a handler triggers a nested blur. */
let presentationLossBlurActive = false;

export function runPresentationLossBlur(blur: () => void): void {
  const previous = presentationLossBlurActive;
  presentationLossBlurActive = true;
  try {
    blur();
  } finally {
    presentationLossBlurActive = previous;
  }
}

export function isPresentationLossBlur(): boolean {
  return presentationLossBlurActive;
}

/** Defaults to `true` outside a provider so surfaces rendered without the host (tests, isolated stories) behave
 * as if visible. */
export function usePaneVisible(): boolean {
  return use(PaneVisibilityContext);
}

/** `true` only for the visible surface that owns global pane effects. */
export function usePaneFocused(): boolean {
  const focused = use(PaneSurfaceActivityContext).focused;
  const visible = usePaneVisible();
  return focused && visible;
}

/** That unmount runs Radix FocusScope's close-autofocus which - for a native/deep-link focus transfer, where
 * Radix's own handler does not `preventDefault`. */
export function usePaneAwareContentGuard(
  onCloseAutoFocus: ((event: Event) => void) | undefined,
): {
  readonly paneFocused: boolean;
  readonly handleCloseAutoFocus: (event: Event) => void;
} {
  const paneFocused = usePaneFocused();
  const handleCloseAutoFocus = usePaneCloseAutoFocusGuard(onCloseAutoFocus);
  return { paneFocused, handleCloseAutoFocus };
}

/** Runs an effect only while the surrounding pane is focused. This is the canonical gate for pane-local global
 * ownership: shortcuts, find, DOM focus, modal registration, and active-only toasts. */
export function useActivePaneEffect(effect: EffectCallback): void {
  const paneFocused = usePaneFocused();

  useEffect(() => {
    if (!paneFocused) return;
    return effect();
  }, [effect, paneFocused]);
}

/** Runs geometry, repaint, and independent-scroll synchronization while visible. */
export function useVisiblePaneEffect(effect: EffectCallback): void {
  const paneVisible = usePaneVisible();

  useEffect(() => {
    if (!paneVisible) return;
    return effect();
  }, [effect, paneVisible]);
}

export function useVisiblePaneValue<T>(visibleValue: T, hiddenValue: T): T {
  const paneVisible = usePaneVisible();
  return paneVisible ? visibleValue : hiddenValue;
}

export function useFocusedPaneValue<T>(focusedValue: T, blurredValue: T): T {
  const paneFocused = usePaneFocused();
  return paneFocused ? focusedValue : blurredValue;
}

/** Keeps document-portalled pane dialogs owned by the focused surface only. */
export function useFocusedPaneModalOpen(open: boolean): boolean {
  return useFocusedPaneValue(open, false);
}
