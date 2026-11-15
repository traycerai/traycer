import { useEffect, useRef, useSyncExternalStore } from "react";
import type { BotReadPosition } from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useBotReadCursorAdvanceMutation } from "@/hooks/bots/use-bot-read-cursor";
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

/** Serializes advances of the observed prefix; explicit banner retry remains available after refusal. */
export function useAdvanceWhilePresented(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly botId: string;
  readonly conversationId: string;
  readonly target: BotReadPosition | null;
}): void {
  const { client, botId, conversationId, target } = args;
  const { mutateAsync: advance, isPending } =
    useBotReadCursorAdvanceMutation(client);
  const attempted = useRef(new Map<string, number>());
  const targetMessageId = target?.messageId ?? null;
  const targetSeq = target?.seq ?? null;
  useEffect(() => {
    if (isPending || targetMessageId === null || targetSeq === null) return;
    const done = attempted.current.get(conversationId);
    if (done !== undefined && done >= targetSeq) return;
    attempted.current.set(conversationId, targetSeq);
    void advance({
      botId,
      conversationId,
      messageId: targetMessageId,
      seq: targetSeq,
    }).catch(() => {
      // Keep the unread banner retryable; never spin on a refused write.
    });
  }, [advance, botId, conversationId, isPending, targetMessageId, targetSeq]);
}
