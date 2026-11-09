import { useEffect, useRef, useSyncExternalStore } from "react";
import type { BotReadCursorReadResponse } from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useBotReadCursorAdvanceMutation } from "@/hooks/bots/use-bot-read-cursor";
import { advanceTarget } from "@/lib/bots/bot-read-cursor";
import type { HostRpcRegistry } from "@/lib/host";
import {
  isDocumentFocused,
  subscribeHostNotificationPresence,
} from "@/lib/notifications/notification-presence";

/**
 * Whether the person can see a surface that is `shown`: it is in the pane on
 * screen, in a window they are in.
 */
export function usePresented(shown: boolean): boolean {
  const paneVisible = usePaneVisible();
  const windowForeground = useSyncExternalStore(
    subscribeHostNotificationPresence,
    isDocumentFocused,
  );
  return shown && paneVisible && windowForeground;
}

/**
 * Moves the person's read cursor on a conversation they can see to its
 * newest row (decision 139), as that row arrives: one advance per newest
 * row, never while it is not presented. The read cursor's own read follows
 * the rows (the bot's subscription reads it again as they land), so a row
 * landing while the conversation is in view advances the cursor past it.
 */
export function useAdvanceWhilePresented(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly botId: string;
  readonly conversationId: string | null;
  readonly readCursors: BotReadCursorReadResponse | undefined;
  readonly presented: boolean;
}): void {
  const { client, botId, conversationId, readCursors, presented } = args;
  const { mutateAsync: advance } = useBotReadCursorAdvanceMutation(client);
  const target =
    !presented || conversationId === null || readCursors === undefined
      ? null
      : advanceTarget(readCursors, conversationId);
  // The newest row advanced to, or being advanced to, per conversation: a
  // read that has not caught up with the advance yet asks for the same row
  // again. A failed advance is forgotten, so the row is asked for again.
  const advanced = useRef(new Map<string, number>());
  const targetMessageId = target?.messageId ?? null;
  const targetSeq = target?.seq ?? null;
  useEffect(() => {
    if (
      conversationId === null ||
      targetMessageId === null ||
      targetSeq === null
    ) {
      return;
    }
    const done = advanced.current.get(conversationId);
    if (done !== undefined && done >= targetSeq) return;
    advanced.current.set(conversationId, targetSeq);
    advance({
      botId,
      conversationId,
      messageId: targetMessageId,
      seq: targetSeq,
    }).catch(() => {
      if (advanced.current.get(conversationId) === targetSeq) {
        advanced.current.delete(conversationId);
      }
    });
  }, [advance, botId, conversationId, targetMessageId, targetSeq]);
}
