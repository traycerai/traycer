import { createContext, type ReactNode } from "react";
import type {
  BotNotificationSubscription,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

export interface BotSessionStatusData {
  readonly tasks: readonly BotTaskEntry[];
  readonly subscriptions: readonly BotNotificationSubscription[] | null;
  readonly boundHostId: string | null;
}

export const BotSessionStatusDataContext =
  createContext<BotSessionStatusData | null>(null);
export const BotSessionStatusSlotContext = createContext<
  ((handle: ChatSessionStoreHandle) => ReactNode) | null
>(null);
