import { useRef } from "react";
import type { ChatAutoArchiveSetRequest } from "@traycer/protocol/host/chat-auto-archive/contracts";

/** `onRejected` runs after the save's own error toast. */
export type AutoArchiveSave = (
  build: (base: ChatAutoArchiveSetRequest) => ChatAutoArchiveSetRequest | null,
  onRejected: (() => void) | null,
) => void;

/**
 * Built on the newest unsettled write at event time: the mutation reaches React a
 * tick after `mutate`, and a tap delivers the field's blur and the switch's click
 * in one task, so the rendered value would be stale.
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
