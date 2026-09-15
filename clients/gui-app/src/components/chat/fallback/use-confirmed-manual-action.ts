import { useCallback } from "react";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";

/**
 * What a confirmed manual rung reports, minus the ids the surface already
 * knows.
 *
 * Deliberately not the store's whole record: `hostId`/`epicId`/`chatId` are
 * facts about the surface, and asking a call site to restate them is asking it
 * to get one of them wrong.
 */
export interface ConfirmedManualActionReport {
  readonly rung: "retry" | "switch" | "wait_once";
  readonly userMessageId: string;
  readonly turnId: string;
  readonly target: ChatRunSettings | null;
}

export type ConfirmedManualActionPublisher = (
  report: ConfirmedManualActionReport,
) => void;

/**
 * Publishes a confirmed manual fallback action onto this chat's session store,
 * for the transcript announcer to speak.
 *
 * Reaches the session store directly, exactly as `useChatLastFailedAttempt` and
 * `useFallbackChoiceLease` do and for the same reason: the error card is
 * mounted inside a transcript that knows its `(epicId, chatId, hostId)` triple
 * but sits well below the tile that owns the action bundle.
 *
 * The returned function is what a MUTATION-level `onSuccess` closes over, which
 * is the point of handing it out rather than reaching the registry from inside
 * the mutation hook. The callback outlives this component: the popover closes
 * on `applied`, so the surface is usually gone before the host's answer lands,
 * and the store it writes to is not (a released chat session stays warm for
 * ten minutes).
 */
export function usePublishConfirmedManualFallbackAction(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
}): ConfirmedManualActionPublisher {
  const { epicId, chatId, hostId } = input;
  const handle = useExistingChatSessionHandle(epicId, chatId, hostId);
  return useCallback(
    (report: ConfirmedManualActionReport) => {
      if (handle === null) return;
      handle.store.getState().publishConfirmedManualFallbackAction({
        hostId,
        epicId,
        chatId,
        rung: report.rung,
        userMessageId: report.userMessageId,
        turnId: report.turnId,
        target: report.target,
      });
    },
    [chatId, epicId, handle, hostId],
  );
}
