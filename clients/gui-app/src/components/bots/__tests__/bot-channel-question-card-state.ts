/**
 * What the question-card files' mocked boundaries read: the sessions the
 * channel is served, the host client the tab holds, the threads the host
 * lists and what the bot is doing. It imports no app module at run time, so a
 * mock factory can reach it while the app's modules are still loading. The
 * harness resets it for every case.
 */
import { create } from "zustand";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotActivity } from "@/hooks/bots/use-bot-activity";
import type { HostRpcRegistry } from "@/lib/host";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

export const mocks = {
  handles: new Map<string, ChatSessionStoreHandle>(),
  client: null as HostRequester<HostRpcRegistry> | null,
  threads: [] as BotThreadSummary[],
};

/** What the bot is doing, as the scripted `useBotActivity` reads it. */
export const activityStore = create<{ activity: BotActivity | null }>()(() => ({
  activity: null,
}));
