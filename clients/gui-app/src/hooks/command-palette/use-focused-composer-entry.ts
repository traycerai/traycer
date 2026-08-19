/**
 * Reactive read of the focused composer's registry entry (see
 * `FocusedComposerEntry`), for consumers that need its target-host client.
 * Subscribes via `useSyncExternalStore`, the same way `useFocusedComposerKind`
 * does, so the palette's composer subpages re-render when focus moves to a
 * composer on another host. The entry object is stable per registration, so
 * it is its own snapshot.
 *
 * Callers must distinguish "no focused composer" (`null` entry) from
 * "focused, host still resolving" (`entry.hostClient === null`): the palette
 * lists the app-wide default host's catalog for the former (nothing to
 * dispatch into anyway) and nothing for the latter, never another host's.
 */
import { useSyncExternalStore } from "react";
import {
  getFocusedComposerControls,
  subscribeFocusedComposerControls,
  type FocusedComposerEntry,
} from "@/lib/commands/composer-controls-registry";

export function useFocusedComposerEntry(): FocusedComposerEntry | null {
  return useSyncExternalStore(
    subscribeFocusedComposerControls,
    getFocusedComposerControls,
    getFocusedComposerControls,
  );
}
