/**
 * `null` entry is no focused composer (palette uses the app-wide catalog). `entry.hostClient === null` is focused but unresolved: list nothing, never another host.
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
