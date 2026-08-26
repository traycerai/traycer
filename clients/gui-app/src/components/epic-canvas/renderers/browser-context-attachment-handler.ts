import { useEffect } from "react";

import {
  mintBrowserObserveGrant,
  registerBrowserContextAttachmentHandler,
  type BrowserContextAttachmentPayload,
  type BrowserContextAttachmentResult,
} from "@/lib/browser-view/browser-context-attachments";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

const GRANT_TTL_MS = 10 * 60 * 1000;

export function useBrowserContextAttachmentHandler(input: {
  readonly chatId: string;
  readonly viewTabId: string;
}): void {
  useEffect(() => {
    const registration = registerBrowserContextAttachmentHandler((request) => {
      const { payload } = request;
      if (request.targetChatId !== input.chatId) {
        return unhandledAttachment(payload);
      }
      if (payload.source.tile.viewTabId !== input.viewTabId) {
        return unhandledAttachment(payload);
      }
      const nextPayload = mintBrowserObserveGrant(payload, {
        chatId: input.chatId,
        expiresAt: Date.now() + GRANT_TTL_MS,
      });
      useComposerDraftStore
        .getState()
        .addBrowserContextAttachment(input.chatId, nextPayload);
      return { status: "attached", payload: nextPayload };
    });
    return () => {
      registration.dispose();
    };
  }, [input.chatId, input.viewTabId]);
}

function unhandledAttachment(
  payload: BrowserContextAttachmentPayload,
): BrowserContextAttachmentResult {
  return {
    status: "unhandled",
    payload,
    reason: "ticket-12-handler-not-registered",
  };
}
