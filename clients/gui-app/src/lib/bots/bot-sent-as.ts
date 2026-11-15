import { useMemo } from "react";
import { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";
import { useBotLifetime } from "@/lib/bots/bot-lifetime";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Who a bot send goes out as, fixed at the press (Tracy Bots T249): the bot
 * lifetime the pressed control was drawn in and the account signed in then.
 * The send leaves only while both still hold
 * (`useBotConversationSendMutation`), and what its answer opens or settles
 * is written only in that lifetime.
 */
export interface BotSentAs {
  readonly lifetime: number;
  /** `null` while nobody is signed in: such a send never leaves. */
  readonly account: string | null;
}

/** What a control drawn in this render sends as. */
export function useBotSentAs(): BotSentAs {
  const lifetime = useBotLifetime();
  const account = useAuthStore((s) => s.profile?.userId ?? null);
  return useMemo(() => ({ lifetime, account }), [account, lifetime]);
}

/**
 * A send refused before it left: the bot lifetime it was pressed in has
 * ended, or the client no longer sends as the account that pressed it.
 * Nothing of it was written.
 */
export class BotSendAccountMovedError extends HostRpcError {
  constructor() {
    super({
      code: "RPC_ERROR",
      message: "The account this send was made under is no longer signed in.",
      requestId: "client-refused",
      method: "bot.conversation.send",
      fatalDetails: null,
    });
    this.name = "BotSendAccountMovedError";
  }
}
