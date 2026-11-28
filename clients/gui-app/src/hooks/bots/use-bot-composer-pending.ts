import { useMemo } from "react";
import type { BotComposerPending } from "@/components/bots/bot-message-composer";
import {
  BOT_CONVERSATION_NONCE_VERSION,
  botSendTakes,
} from "@/hooks/bots/use-bot-send-version";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import type {
  BotPendingSendStart,
  BotSendBinding,
} from "@/lib/bots/bot-pending-send";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * A box's send drawn at Send (T249), where the host serving the tab is the
 * bot's bound host (`binding`), takes a send's nonce, and someone is signed
 * in; the send is made for that binding. `null` sends as before, drawn once
 * the host's row arrives: a send through any other host is relayed to the
 * bound one, which mints its id, so it carries no nonce.
 */
export function useBotComposerPending(input: {
  readonly binding: BotSendBinding;
  readonly onStart: (start: BotPendingSendStart) => void;
  readonly onRefused: (start: BotPendingSendStart) => void;
}): BotComposerPending | null {
  const { binding, onStart, onRefused } = input;
  const { hostId, boundHostId, boundHostEpoch, onMoved } = binding;
  const takesNonce = botSendTakes(
    useHostMethodSchemaVersion(hostId, "bot.conversation.send"),
    BOT_CONVERSATION_NONCE_VERSION,
  );
  const senderUserId = useAuthStore((s) => s.profile?.userId ?? null);
  return useMemo(
    () =>
      !takesNonce || senderUserId === null || boundHostId !== hostId
        ? null
        : {
            authority: { hostId, hostEpoch: boundHostEpoch },
            senderUserId,
            onStart,
            onRefused,
            onAuthorityMoved: onMoved,
          },
    [
      boundHostEpoch,
      boundHostId,
      hostId,
      onMoved,
      onRefused,
      onStart,
      senderUserId,
      takesNonce,
    ],
  );
}
