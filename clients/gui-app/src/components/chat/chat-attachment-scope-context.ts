import { createContext, use } from "react";

import type { RequiredHostMethodVersion } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ReadChatAttachmentRequest,
  ReadChatAttachmentResponse,
} from "@traycer/protocol/host/epic/chat-attachment";

/**
 * Exactly the slice of the host client a chat attachment read needs: the two
 * signal-bound dispatches. Narrower than `HostClient` on purpose - the provider
 * hands its real client straight in (the generic methods instantiate to these),
 * and a test can supply just these instead of faking a whole client class
 * through an `as unknown` cast.
 *
 * BOTH are required, and the second is not optional convenience. A read that
 * SELECTS the local-only plane must carry a version floor to the wire, because
 * `plane` is an optional field an older peer strips - so a client that could
 * only offer the plain dispatch would silently restore the cloud fallback the
 * selector exists to refuse. Declaring one and calling the other is how that
 * became a type error rather than a runtime surprise; found by the test agent
 * for this change, because vitest does not type-check.
 */
export interface ChatAttachmentReadClient {
  requestWithSignal(
    method: "epic.readChatAttachment",
    params: ReadChatAttachmentRequest,
    signal: AbortSignal | undefined,
  ): Promise<ReadChatAttachmentResponse>;
  requestWithSignalRequiringHostMethodVersion(
    method: "epic.readChatAttachment",
    params: ReadChatAttachmentRequest,
    signal: AbortSignal | undefined,
    requiredHostMethodVersion: RequiredHostMethodVersion,
  ): Promise<ReadChatAttachmentResponse>;
}

/**
 * Everything a chat image byte read is scoped by, resolved ONCE per chat tile.
 *
 * Chat image bytes live on the chat plane now, and `epic.readChatAttachment`
 * takes the owning chat id so the serving host can apply that chat's visibility
 * rule to a local-store hit (see `@traycer/protocol`
 * `host/epic/chat-attachment.ts`). Every render site that shows a chat image is
 * structurally inside exactly one chat, so the id is context rather than a prop
 * threaded through five layers of transcript rendering with no other reason to
 * know it.
 *
 * ## Why the CLIENT is in here too
 *
 * Because resolving it is a `useHostDirectoryList()` query subscription, and a
 * transcript can hold a hundred image thumbnails. Resolving per thumbnail would
 * put a query observer behind every image and force every surface that renders
 * a chat message into a `QueryClientProvider`. The tile already knows its host -
 * it is `<TabHostProvider>`-bound for life - so it resolves the client once and
 * hands it down. `null` is the ordinary "not ready / signed out" value that
 * `useTabHostClient` already returns.
 *
 * Deliberately its own context rather than fields borrowed off
 * `ChatPlanActionsContext` (which happens to carry the same epic/chat pair): a
 * byte read has nothing to do with plan actions, and hanging it there would make
 * the plan-action provider load-bearing for image rendering.
 *
 * `null` outside a chat tile - the landing composer and the new-conversation
 * modal both compose images before any chat exists, and both keep the epic-doc
 * byte source they already used.
 */
export interface ChatAttachmentScopeValue {
  readonly epicId: string;
  readonly chatId: string;
  /** The tile's bound host - the one asked for chat-plane bytes. */
  readonly hostId: string;
  /**
   * That host's BUILD, from its directory entry; `null` while the directory
   * has not resolved one.
   *
   * Carried alongside the id because a host upgrade keeps its id: Traycer can
   * install and activate a newer build under the same `hostId` with no
   * renderer reload, and `use-chat-image-fetcher.ts` remembers the
   * "this host predates `epic.readChatAttachment`" verdict per BUILD so that
   * upgrade re-probes instead of staying degraded for the session.
   */
  readonly hostVersion: string | null;
  /** Routed to `hostId`; `null` until the directory resolves it. */
  readonly client: ChatAttachmentReadClient | null;
}

export const ChatAttachmentScopeContext =
  createContext<ChatAttachmentScopeValue | null>(null);

export function useChatAttachmentScope(): ChatAttachmentScopeValue | null {
  return use(ChatAttachmentScopeContext);
}
