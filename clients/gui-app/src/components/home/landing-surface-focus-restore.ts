import {
  activeLandingTerminalInstanceId,
  landingPanelLayoutFor,
  useLandingPanelStore,
} from "@/stores/home/landing-panel-store";
import { focusTerminalInstance } from "@/lib/terminals/terminal-focus-registry";
import { focusRegisteredActiveComposer } from "@/lib/composer/composer-focus-registry";

/**
 * Puts the caret back where this surface last had it, in the order the surface
 * itself ranks its endpoints: a maximized terminal owns the pane outright, then
 * the element that actually held focus, then the active composer.
 *
 * Its own module rather than an inline effect body, so the surface's effect
 * stays a list of GUARDS - who may restore, and when - with the ranking read on
 * its own, and so the ranking can be driven directly: the surface reaches it
 * only through a focus-in transition on a fully mounted home page, which is a
 * long way to come for a decision that is a pure read of the panel store. A
 * `.tsx` cannot export it either - one non-component export there breaks fast
 * refresh for the whole file.
 */
export function restoreLandingSurfaceFocus(
  draftId: string | null,
  surface: HTMLDivElement | null,
  previous: HTMLElement | null,
): void {
  const terminalState = useLandingPanelStore.getState();
  const layout = landingPanelLayoutFor(
    terminalState,
    draftId ?? "unbound-landing-page",
  );
  if (layout.panelOpen && layout.maximized) {
    // The maximized panel's active row is not necessarily a terminal - the
    // strip is mixed - and only a terminal claims a terminal focus request, so
    // a browser row or the chooser falls through to the restore below.
    const instanceId = activeLandingTerminalInstanceId(terminalState);
    if (instanceId !== null) {
      focusTerminalInstance(instanceId);
      return;
    }
  }

  if (
    surface !== null &&
    previous !== null &&
    previous.isConnected &&
    surface.contains(previous)
  ) {
    previous.focus({ preventScroll: true });
    if (
      document.activeElement === previous ||
      (document.activeElement !== null &&
        previous.contains(document.activeElement))
    ) {
      return;
    }
  }
  // The local Tiptap editor may not have registered yet
  // (`immediatelyRender: false`). Never fall back to a retained inactive split
  // partner here; if no active endpoint exists, the local editor's own
  // autofocus effect will run as soon as it registers.
  focusRegisteredActiveComposer();
}
