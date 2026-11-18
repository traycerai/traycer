import { create } from "zustand";

/**
 * What the Activity strip asks the canvas to draw on a pane: an outline while
 * the pointer is over an agent row whose chat is on screen, and a one-shot flash
 * when a click moves focus to that chat.
 *
 * Both name the tile by its instance id, which is unique across canvases, so
 * the pane showing that tile is the pane drawn. Transient and never persisted.
 */
interface PaneEmphasisState {
  readonly outlinedInstanceId: string | null;
  readonly flash: {
    readonly instanceId: string;
    readonly nonce: number;
  } | null;
}

export const usePaneEmphasisStore = create<PaneEmphasisState>(() => ({
  outlinedInstanceId: null,
  flash: null,
}));

let nextFlashNonce = 0;

export function outlinePaneOf(instanceId: string): void {
  usePaneEmphasisStore.setState({ outlinedInstanceId: instanceId });
}

/** Clears the outline only while it is still `instanceId`'s. */
export function clearPaneOutline(instanceId: string): void {
  if (usePaneEmphasisStore.getState().outlinedInstanceId !== instanceId) return;
  usePaneEmphasisStore.setState({ outlinedInstanceId: null });
}

/** A repeat flash of the same pane restarts it: the nonce always advances. */
export function flashPaneOf(instanceId: string): void {
  nextFlashNonce += 1;
  usePaneEmphasisStore.setState({
    flash: { instanceId, nonce: nextFlashNonce },
  });
}

/** Clears the flash only while it is still the one `nonce` names. */
export function clearPaneFlash(nonce: number): void {
  if (usePaneEmphasisStore.getState().flash?.nonce !== nonce) return;
  usePaneEmphasisStore.setState({ flash: null });
}
