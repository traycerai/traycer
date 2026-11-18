import { z } from "zod";
import { appLogger } from "@/lib/logger";
import { persistKey, STORE_KEYS } from "@/lib/persist";

const liveChatCompletionAcknowledgementSchema = z.object({
  id: z.string().min(1),
  type: z.literal("live-chat-completion-acknowledgement"),
  version: z.literal(1),
  originId: z.string().min(1),
  userId: z.string().min(1),
  originHostId: z.string().min(1),
  epicId: z.string().min(1),
  chatId: z.string().min(1),
  turnId: z.string().min(1),
  observedAt: z.number(),
});

export type LiveChatCompletionAcknowledgement = z.infer<
  typeof liveChatCompletionAcknowledgementSchema
>;

export type LiveChatCompletionAcknowledgementInput = Omit<
  LiveChatCompletionAcknowledgement,
  "id" | "type" | "version" | "originId"
>;

export interface LiveChatCompletionAcknowledgementTarget {
  readonly userId: string;
  readonly originHostId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly recoverableTurnId: string | null;
}

type LiveChatCompletionAcknowledgementListener = (
  acknowledgement: LiveChatCompletionAcknowledgement,
) => void;

export interface LiveChatCompletionAcknowledgementTransport {
  readonly publish: (input: LiveChatCompletionAcknowledgementInput) => void;
  readonly subscribe: (
    listener: LiveChatCompletionAcknowledgementListener,
  ) => () => void;
  readonly dispose: () => void;
}

const CHANNEL_NAME = persistKey(
  STORE_KEYS.liveChatCompletionAcknowledgementsChannel,
);

export function liveChatCompletionAcknowledgementMatches(
  acknowledgement: LiveChatCompletionAcknowledgement,
  target: LiveChatCompletionAcknowledgementTarget,
): boolean {
  return (
    acknowledgement.userId === target.userId &&
    acknowledgement.originHostId === target.originHostId &&
    acknowledgement.epicId === target.epicId &&
    acknowledgement.chatId === target.chatId &&
    acknowledgement.turnId === target.recoverableTurnId
  );
}

export function createLiveChatCompletionAcknowledgementTransport(
  transportOriginId: string,
): LiveChatCompletionAcknowledgementTransport {
  const listeners = new Set<LiveChatCompletionAcknowledgementListener>();
  let channel: BroadcastChannel | null = null;
  let sequence = 0;

  const handleMessage = (event: MessageEvent<unknown>): void => {
    const parsed = liveChatCompletionAcknowledgementSchema.safeParse(
      event.data,
    );
    if (!parsed.success) {
      appLogger.warn(
        "[live-chat-completion-acknowledgements] ignored malformed message",
        {},
      );
      return;
    }
    const acknowledgement = parsed.data;
    if (acknowledgement.originId === transportOriginId) return;
    for (const listener of listeners) {
      listener(acknowledgement);
    }
  };

  const ensureChannel = (): BroadcastChannel | null => {
    if (channel !== null) return channel;
    if (typeof BroadcastChannel === "undefined") return null;
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener("message", handleMessage);
    return channel;
  };

  const closeChannel = (): void => {
    if (channel === null) return;
    channel.removeEventListener("message", handleMessage);
    channel.close();
    channel = null;
  };

  return {
    publish: (input) => {
      sequence += 1;
      ensureChannel()?.postMessage({
        ...input,
        id: `${transportOriginId}:${String(sequence)}`,
        type: "live-chat-completion-acknowledgement",
        version: 1,
        originId: transportOriginId,
      } satisfies LiveChatCompletionAcknowledgement);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      ensureChannel();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) closeChannel();
      };
    },
    dispose: () => {
      listeners.clear();
      closeChannel();
    },
  };
}

function createOriginId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const liveChatCompletionAcknowledgements =
  createLiveChatCompletionAcknowledgementTransport(createOriginId());
