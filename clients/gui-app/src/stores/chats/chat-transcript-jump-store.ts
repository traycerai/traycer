/** Cross-tile transcript jumps: "open this chat AND scroll it to this anchor". */
import { create } from "zustand";

export type ChatTranscriptJumpTarget =
  /** The current end of the transcript. */
  | { readonly kind: "end" }
  /** A tool / sub-agent card inside the transcript. */
  | { readonly kind: "block"; readonly blockId: string }
  /** A delivered message row. */
  | { readonly kind: "message"; readonly messageId: string }
  /** A durable event projected as an inline transcript row. */
  | { readonly kind: "event"; readonly eventId: string }
  /**
   * The SENDER-side counterpart of an A2A exchange: the "Sent message" tool card in this chat's own
   * transcript.
   */
  | {
      readonly kind: "sent-message";
      readonly receiverAgentId: string;
      readonly messageText: string;
      readonly timestamp: number;
    }
  /** The very start of the transcript - where this agent's life began. */
  | { readonly kind: "first-message" };

export interface ChatTranscriptJumpRequest {
  readonly target: ChatTranscriptJumpTarget;
  readonly requestId: number;
}

interface ChatTranscriptJumpStore {
  readonly requestsByChatId: Readonly<
    Record<string, ChatTranscriptJumpRequest | undefined>
  >;
  readonly requestJump: (
    hostId: string,
    chatId: string,
    target: ChatTranscriptJumpTarget,
  ) => void;
  readonly consumeJump: (
    hostId: string,
    chatId: string,
    requestId: number,
  ) => void;
}

export function chatTranscriptJumpKey(hostId: string, chatId: string): string {
  return JSON.stringify([hostId, chatId]);
}

export { chatTranscriptEventRowId } from "@traycer/protocol/persistence/chat-transcript/row-projection";

let nextRequestId = 0;

export const useChatTranscriptJumpStore = create<ChatTranscriptJumpStore>(
  (set) => ({
    requestsByChatId: {},
    requestJump: (hostId, chatId, target) => {
      nextRequestId += 1;
      const request: ChatTranscriptJumpRequest = {
        target,
        requestId: nextRequestId,
      };
      const key = chatTranscriptJumpKey(hostId, chatId);
      set((state) => ({
        requestsByChatId: { ...state.requestsByChatId, [key]: request },
      }));
    },
    consumeJump: (hostId, chatId, requestId) =>
      set((state) => {
        const key = chatTranscriptJumpKey(hostId, chatId);
        const current = state.requestsByChatId[key];
        // Only the exact request that was handled is cleared: a newer jump
        // issued while the tile was mounting must survive.
        if (current === undefined || current.requestId !== requestId) {
          return state;
        }
        return {
          requestsByChatId: Object.fromEntries(
            Object.entries(state.requestsByChatId).filter(([id]) => id !== key),
          ),
        };
      }),
  }),
);
