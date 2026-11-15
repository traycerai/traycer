import { useMemo } from "react";
import type { BotComposerPending } from "@/components/bots/bot-message-composer";
import {
  BOT_CONVERSATION_NONCE_VERSION,
  botSendTakes,
} from "@/hooks/bots/use-bot-send-version";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import type { BotPendingSendStart } from "@/lib/bots/bot-pending-send";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * A box's send drawn at Send (T249), where the host serving the tab
 * (`hostId`) takes a send's nonce and someone is signed in; `null` sends as
 * before, drawn once the host's row arrives.
 */
export function useBotComposerPending(input: {
  readonly hostId: string;
  readonly onStart: (start: BotPendingSendStart) => void;
  readonly onRefused: (start: BotPendingSendStart) => void;
}): BotComposerPending | null {
  const { hostId, onStart, onRefused } = input;
  const takesNonce = botSendTakes(
    useHostMethodSchemaVersion(hostId, "bot.conversation.send"),
    BOT_CONVERSATION_NONCE_VERSION,
  );
  const senderUserId = useAuthStore((s) => s.profile?.userId ?? null);
  return useMemo(
    () =>
      !takesNonce || senderUserId === null
        ? null
        : { hostId, senderUserId, onStart, onRefused },
    [hostId, onRefused, onStart, senderUserId, takesNonce],
  );
}
