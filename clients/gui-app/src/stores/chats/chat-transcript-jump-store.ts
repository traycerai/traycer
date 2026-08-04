/**
 * Cross-tile transcript jumps: "open this chat AND scroll it to this anchor".
 *
 * `ChatScrollToBlockContext` already covers scrolling from INSIDE a mounted
 * chat tile, but a jump from another tile (the communication-graph timeline)
 * has no such context - the target tile may not even be mounted yet when the
 * jump is issued. So the request is parked here by chat id and the chat tile
 * picks it up on its next render, whether that is the current one or the first
 * one after `openTileInEpic` mounts it.
 *
 * Session-only and deliberately not persisted: a jump is a navigation intent,
 * not reading position (that is `tile-scroll-anchor-store`). Requests are
 * CONSUMED - the tile clears the entry once it has acted - so a remount does
 * not replay an old jump, and a repeat jump to the same anchor still fires
 * because `requestId` advances.
 */
import { create } from "zustand";

export type ChatTranscriptJumpTarget =
  /** A tool / sub-agent card inside the transcript. */
  | { readonly kind: "block"; readonly blockId: string }
  /** A delivered message row. */
  | { readonly kind: "message"; readonly messageId: string }
  /**
   * The SENDER-side counterpart of an A2A exchange: the "Sent message" tool
   * card in this chat's own transcript. No captured anchor exists for it (the
   * sender's block id is its harness's tool id and never reaches the host),
   * but the block's `agentMessageSend` enrichment carries the receiver and
   * the verbatim message, and so does the comm-event row - so the tile
   * RESOLVES the anchor at jump time instead of trusting a captured ref.
   * `timestamp` breaks ties when the same text was sent to the same receiver
   * more than once.
   */
  | {
      readonly kind: "sent-message";
      readonly receiverAgentId: string;
      readonly messageText: string;
      readonly timestamp: number;
    }
  /**
   * The very start of the transcript - where this agent's life began. Used
   * by the communication graph's Created rows: a creation has no message of
   * its own to anchor on, but "the beginning" is a deterministic landing
   * (for an A2A-created child, the first message IS its task). Resolves to
   * the first message once the transcript has one.
   */
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
    chatId: string,
    target: ChatTranscriptJumpTarget,
  ) => void;
  readonly consumeJump: (chatId: string, requestId: number) => void;
}

let nextRequestId = 0;

export const useChatTranscriptJumpStore = create<ChatTranscriptJumpStore>(
  (set) => ({
    requestsByChatId: {},
    requestJump: (chatId, target) => {
      nextRequestId += 1;
      const request: ChatTranscriptJumpRequest = {
        target,
        requestId: nextRequestId,
      };
      set((state) => ({
        requestsByChatId: { ...state.requestsByChatId, [chatId]: request },
      }));
    },
    consumeJump: (chatId, requestId) =>
      set((state) => {
        const current = state.requestsByChatId[chatId];
        // Only the exact request that was handled is cleared: a newer jump
        // issued while the tile was mounting must survive.
        if (current === undefined || current.requestId !== requestId) {
          return state;
        }
        return {
          requestsByChatId: Object.fromEntries(
            Object.entries(state.requestsByChatId).filter(
              ([id]) => id !== chatId,
            ),
          ),
        };
      }),
  }),
);
