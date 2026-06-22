/**
 * Reactive read of `FocusedComposerKind`. Subscribes to the
 * focused-composer-controls registry via `useSyncExternalStore` so
 * consumers re-render when the focused composer changes. Used by
 * the palette to build a live `CommandContext.focusedComposerKind`
 * without piping state through React context.
 */
import { useSyncExternalStore } from "react";
import {
  getFocusedComposerControls,
  subscribeFocusedComposerControls,
} from "@/lib/commands/composer-controls-registry";
import type { FocusedComposerKind } from "@/lib/commands/types";

function getSnapshot(): FocusedComposerKind | null {
  return getFocusedComposerControls()?.kind ?? null;
}

export function useFocusedComposerKind(): FocusedComposerKind | null {
  return useSyncExternalStore(
    subscribeFocusedComposerControls,
    getSnapshot,
    getSnapshot,
  );
}
