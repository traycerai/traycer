import { useEffect, type RefObject } from "react";
import { usePaneFocusProbe } from "@/components/epic-tabs/pane-visibility-context";
import { resolveMatchingChord } from "@/lib/keybindings/chord";
import { isEditableEventTarget } from "@/lib/keybindings/editable-target";
import { browserScopedCommandForChord } from "../reserved-chords-registration";

interface BrowserAddressTarget {
  readonly tile: HTMLDivElement;
  readonly isPaneFocused: () => boolean;
  readonly focusAddress: () => void;
}

const targets = new Set<BrowserAddressTarget>();

/** Renderer chrome needs an address shortcut even without a guest or armed stream. */
export function useBrowserAddressShortcut(input: {
  readonly enabled: boolean;
  readonly tileRef: RefObject<HTMLDivElement | null>;
  readonly focusAddress: () => void;
}): void {
  const { enabled, tileRef, focusAddress } = input;
  const isPaneFocused = usePaneFocusProbe();
  useEffect(() => {
    const tile = tileRef.current;
    if (!enabled || tile === null) return;
    const target = { tile, isPaneFocused, focusAddress };
    targets.add(target);
    return () => {
      targets.delete(target);
    };
  }, [enabled, tileRef, focusAddress, isPaneFocused]);
}

/** Called by the app's capture listener before the editor binding takes the key. */
export function focusBrowserAddressForShortcut(event: KeyboardEvent): boolean {
  const chord = resolveMatchingChord(event);
  if (
    chord === null ||
    browserScopedCommandForChord(chord) !== "focusAddressBar"
  ) {
    return false;
  }
  // Leader-aware dialogs allow app dispatch, but still own their focus.
  if (
    event
      .composedPath()
      .some(
        (target) =>
          target instanceof Element &&
          target.matches('[role="dialog"][data-state="open"]'),
      )
  ) {
    return false;
  }
  const candidates = [...targets].filter(
    ({ tile, isPaneFocused }) => tile.isConnected && isPaneFocused(),
  );
  const eventTarget = event.target;
  const containing = candidates.find(
    ({ tile }) => eventTarget instanceof Node && tile.contains(eventTarget),
  );
  if (containing !== undefined) {
    containing.focusAddress();
    return true;
  }
  // Opening/selecting a tab can leave focus on its tab-strip button or the
  // pane wrapper, and clicking blank space can leave it on the body. Resolve
  // those through the pane's active tile, without stealing an editor's chord.
  if (event.composedPath().some(isEditableEventTarget)) {
    return false;
  }
  if (candidates.length !== 1) return false;
  candidates[0]?.focusAddress();
  return true;
}
