import { useEffect, useEffectEvent, useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ChatFindIndexRead } from "@/components/chat/chat-find-index";
import {
  skeletonOrdinalOf,
  TRANSCRIPT_JUMP_TTL_MS,
} from "@/components/epic-canvas/renderers/chat-tile-jump-logic";
import { useChatLocateRowAnswer } from "@/hooks/chats/use-chat-locate-row";
import type { HostRpcRegistry } from "@/lib/host";
import type { TranscriptWindow } from "@/stores/chats/transcript-window";

export interface ChatFindIndexReadArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly transcriptWindow: TranscriptWindow | null;
  /** The index hit find is confirming, or `null` when no read is outstanding. */
  readonly read: ChatFindIndexRead | null;
  /** `ChatSessionState.requestFindReadOrdinal` of the chat's session store. */
  readonly requestFindReadOrdinal: (ordinal: number | null) => void;
  /** The row cannot be placed, so the hit cannot be confirmed. */
  readonly onReadFailed: (messageId: string) => void;
}

/**
 * Hydrates the row an index hit names, WITHOUT moving the viewport, so the
 * client scan can confirm or drop the hit.
 *
 * The row is placed the way a cold jump target is: the skeleton first - a user
 * or steer row's id, or a held assistant record's row id - and the host's
 * `chat.locateRow` only when the skeleton cannot say, which is an assistant
 * record whose turn-keyed rows are cold. The ordinal goes to the store as
 * required hydration, which is the only thing that will fetch the row: nothing
 * scrolls to it.
 *
 * A read the host settles without a row, one it rejects, and one still
 * outstanding after the jump TTL - unplaced, or placed but never hydrated - all
 * fail the same way: `onReadFailed`, and the ordinal is released. Find then
 * treats the hit as unconfirmed rather than waiting on it.
 */
export function useChatFindIndexRead(args: ChatFindIndexReadArgs): void {
  const {
    chatId,
    client,
    epicId,
    onReadFailed,
    read,
    requestFindReadOrdinal,
    transcriptWindow,
  } = args;
  // Keyed on the strings, not the object: a controller that rebuilds an equal
  // read per render must not restart the wait or re-request the row.
  const messageId = read?.messageId ?? null;
  const target = read?.target ?? null;

  const skeletonOrdinal = useMemo(
    () =>
      transcriptWindow === null || target === null
        ? null
        : skeletonOrdinalOf(transcriptWindow, target),
    [target, transcriptWindow],
  );
  const located = useChatLocateRowAnswer({
    client,
    epicId,
    chatId,
    target:
      messageId === null || skeletonOrdinal !== null
        ? null
        : { kind: "message", messageId },
    epoch: transcriptWindow?.epoch ?? 0,
  });
  const ordinal =
    skeletonOrdinal ?? (located.status === "found" ? located.ordinal : null);
  const locateMissing =
    skeletonOrdinal === null && located.status === "missing";

  // The hold follows the ORDINAL, not the target string. Released only when the
  // read ends or moves to another message, and on unmount - a separate effect
  // from the one below, so a new ordinal for the same read replaces the old one
  // without a release in between, and a re-target that lands on the SAME row
  // (a located record whose row id the skeleton now names) keeps it.
  useEffect(() => {
    if (messageId === null) return;
    return () => requestFindReadOrdinal(null);
  }, [messageId, requestFindReadOrdinal]);

  useEffect(() => {
    if (messageId === null || ordinal === null) return;
    requestFindReadOrdinal(ordinal);
  }, [messageId, ordinal, requestFindReadOrdinal]);

  const failRead = useEffectEvent((failedMessageId: string): void => {
    onReadFailed(failedMessageId);
    requestFindReadOrdinal(null);
  });

  useEffect(() => {
    if (messageId === null || !locateMissing) return;
    failRead(messageId);
  }, [locateMissing, messageId]);

  // Bounds the WHOLE read, not just the wait for an ordinal: a placed row whose
  // hydration never lands (a dropped range, an invalidated window) would
  // otherwise hold the read forever. Restarted only by a new read - the find
  // side moves on the moment the row lands - and stood down once the host has
  // already said no, so a read fails once.
  useEffect(() => {
    if (messageId === null || locateMissing) return;
    const timer = window.setTimeout(() => {
      failRead(messageId);
    }, TRANSCRIPT_JUMP_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [locateMissing, messageId, target]);
}
