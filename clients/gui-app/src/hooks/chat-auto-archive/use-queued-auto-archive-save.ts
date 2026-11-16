import { useRef } from "react";
import type { ChatAutoArchiveSetRequest } from "@traycer/protocol/host/chat-auto-archive/contracts";

/**
 * Builds a write on the newest unsettled one and sends it. `build` gets the
 * policy to write over and returns the write, or `null` when there is
 * nothing to send. `onRejected` runs after the save's own error toast, for
 * the one write whose control holds local state: the custom threshold field.
 */
export type AutoArchiveSave = (
  build: (base: ChatAutoArchiveSetRequest) => ChatAutoArchiveSetRequest | null,
  onRejected: (() => void) | null,
) => void;

/**
 * One row's queued saves. Writes are BUILT on the newest write this row sent
 * that has not settled, at event time, not on the rendered `current`: the
 * mutation reaches React a timer tick after `mutate`, and a touch tap
 * delivers the threshold field's leave-blur and the switch's click in one
 * task, so a click built on the rendered `current` would carry the old
 * threshold and, queued last, put it back.
 */
export function useQueuedAutoArchiveSave(
  current: ChatAutoArchiveSetRequest,
  mutate: (
    next: ChatAutoArchiveSetRequest,
    callbacks: {
      readonly onError: (() => void) | undefined;
      readonly onSettled: () => void;
    },
  ) => void,
  track: () => void,
): AutoArchiveSave {
  // Read only in handlers, never during render.
  const unsettled = useRef<ChatAutoArchiveSetRequest | null>(null);
  return (build, onRejected) => {
    const next = build(unsettled.current ?? current);
    if (next === null) return;
    unsettled.current = next;
    track();
    mutate(next, {
      onError: onRejected ?? undefined,
      // Per-call callbacks run only for the observer's newest `mutate`, the
      // only one `unsettled` can still name.
      onSettled: () => {
        if (unsettled.current === next) unsettled.current = null;
      },
    });
  };
}
