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

/**
 * Signals whether the epic pane the consumer lives in is the one currently
 * shown by `TopLevelTabHost`. Inactive panes stay mounted (keep-alive) but are
 * hidden with `display:none`, so size-measuring surfaces (xterm, editors)
 * read a 0x0 box while hidden. Subscribers refit when this flips back to
 * `true` instead of remounting - a remount would discard xterm scrollback.
 *
 * The provider is the raw `PaneVisibilityContext.Provider` rendered by
 * `TopLevelTabHost`; this module stays component-free so fast refresh keeps
 * working (matches the repo's `*-context-value.ts` convention).
 */
export const PaneVisibilityContext = createContext<boolean>(true);

export const PaneSurfaceActivityContext = createContext<PaneSurfaceActivity>({
  visible: true,
  focused: true,
});

/**
 * The DOM node every pane-local, kept-mounted portal (comment composer,
 * artifact-link editor) renders into. The `SurfacePresentationBoundary` toggles
 * this node's visibility with pane focus, so those portals stay mounted (their
 * typed state survives) yet never cover a focused split partner. `null` outside
 * a pane (app-global portals fall back to `document.body`).
 */
export const PanePortalContainerContext = createContext<HTMLElement | null>(
  null,
);

export function usePanePortalContainer(): HTMLElement | null {
  return use(PanePortalContainerContext);
}

/**
 * A stable getter that reports whether the surrounding pane is focused RIGHT
 * NOW, read from a live DOM attribute rather than a captured render value. This
 * is the one thing `usePaneFocused()` cannot provide inside a Radix
 * `onCloseAutoFocus` handler: the handler fires when a modal's content unmounts,
 * and the only closure available to it was created while the pane was still
 * focused. `SurfacePresentationBoundary` provides this (reading its own
 * `data-pane-focused` attribute, which React has already flipped to `false` by
 * the time the defocus-driven unmount fires — verified in a real browser).
 * Defaults to always-focused outside a boundary.
 */
export const PaneFocusProbeContext = createContext<() => boolean>(() => true);

export function usePaneFocusProbe(): () => boolean {
  return use(PaneFocusProbeContext);
}

/**
 * Composes a Radix `onCloseAutoFocus` handler that KILLS the focus-restore at
 * its source when the content is unmounting because its pane lost focus: Radix
 * would otherwise `trigger.focus()` back into the (now-background) pane, which
 * `TopLevelTabHost`'s focus-capture reads as a real user focus (`.focus()` is
 * `isTrusted:true` in Chrome) and canonically REACTIVATES the pane — bouncing
 * activation off the focused partner. A genuine user close leaves the pane
 * focused, so the caller's handler runs and Radix restores focus normally.
 */
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

/**
 * Raised for the exact synchronous duration of the forced blur that
 * `SurfacePresentationBoundary` performs when a pane loses focus (it blurs an
 * already-focused portal descendant to relinquish keyboard ownership WITHOUT
 * unmounting, so typed draft state survives). A blur-as-commit consumer — one
 * whose `onBlur`/`focusout` handler commits, closes, or moves focus, such as
 * `ArtifactLinkPopover` — reads `isPresentationLossBlur()` inside that handler to
 * tell "my pane is being backgrounded" apart from a genuine user field blur, and
 * skips its side effect so the in-progress draft is retained for refocus.
 * `element.blur()` dispatches `focusout` synchronously, so the flag is up for
 * exactly the window in which the consumer's handler runs. Save/restore (rather
 * than a bare toggle) keeps it correct if a handler triggers a nested blur.
 */
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

/**
 * `true` when the surrounding epic pane is the visible one. Defaults to `true`
 * outside a provider so surfaces rendered without the host (tests, isolated
 * stories) behave as if visible.
 */
export function usePaneVisible(): boolean {
  return use(PaneVisibilityContext);
}

/** `true` only for the visible surface that owns global pane effects. */
export function usePaneFocused(): boolean {
  const focused = use(PaneSurfaceActivityContext).focused;
  const visible = usePaneVisible();
  return focused && visible;
}

/**
 * Runs an effect only while the surrounding pane is focused. This is the
 * canonical gate for pane-local global ownership: shortcuts, find, DOM focus,
 * modal registration, and active-only toasts. Geometry work belongs to
 * `useVisiblePaneEffect` instead, because both members of a split are visible.
 */
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
