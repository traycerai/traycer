import { createContext, use } from "react";

import type {
  ReadChatAttachmentRequest,
  ReadChatAttachmentResponse,
} from "@traycer/protocol/host/epic/chat-attachment";

/** Exactly the slice of the host client a chat attachment read needs: this ONE signal-bound method. Narrower than `HostClient` on purpose - the provider hands its real client straight in (a generic `requestWithSignal` instantiates to this), and a test can supply the one method instead of faking a whole client class through an `as unknown` cast. */
export interface ChatAttachmentReadClient {
  requestWithSignal(
    method: "epic.readChatAttachment",
    params: ReadChatAttachmentRequest,
    signal: AbortSignal | undefined,
  ): Promise<ReadChatAttachmentResponse>;
}

/** Every render site that shows a chat image is structurally inside exactly one chat, so the id is context rather than a prop threaded through five layers of transcript rendering with no other reason to know it. Deliberately its own context rather than fields borrowed off `ChatPlanActionsContext` (which happens to carry the same epic/chat pair): a byte read has nothing to do with plan actions, and hanging it there would make the plan-action provider load-bearing for image rendering. */
export interface ChatAttachmentScopeValue {
  readonly epicId: string;
  readonly chatId: string;
  /** The tile's bound host - the one asked for chat-plane bytes. */
  readonly hostId: string;
  /** That host's BUILD, from its directory entry; `null` while the directory has not resolved one. Carried alongside the id because a host upgrade keeps its id: Traycer can install and activate a newer build under the same `hostId` with no renderer reload, and `use-chat-image-fetcher.ts` remembers the "this host predates `epic.readChatAttachment`" verdict per BUILD so that upgrade re-probes instead of staying degraded for the session. */
  readonly hostVersion: string | null;
  /** Routed to `hostId`; `null` until the directory resolves it. */
  readonly client: ChatAttachmentReadClient | null;
}

export const ChatAttachmentScopeContext =
  createContext<ChatAttachmentScopeValue | null>(null);

export function useChatAttachmentScope(): ChatAttachmentScopeValue | null {
  return use(ChatAttachmentScopeContext);
}
