import { defineRpcContract } from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  botClaimAuthorityRequestSchema,
  botClaimAuthorityResponseSchema,
  botCreateRequestSchema,
  botCreateResponseSchema,
  botDeleteRequestSchema,
  botDeleteResponseSchema,
  botListRequestSchema,
  botListResponseSchema,
  botOpenRequestSchema,
  botOpenResponseSchema,
  botReadRequestSchema,
  botReadResponseSchema,
  botSubscribeClientFrameSchema,
  botSubscribeOpenRequestSchema,
  botSubscribeServerFrameSchema,
  botUpdateResponseSchema,
  botUpdateRunSettingsRequestSchema,
  botUpdateTitleRequestSchema,
} from "./schemas";
import {
  botConversationListRequestSchema,
  botConversationListResponseSchema,
  botConversationSendRequestSchema,
  botConversationSendResponseSchema,
} from "./conversation-schemas";

/**
 * The `bot.*` namespace (Tracy Bots, T5). Brand-new v1.0 methods, none on
 * `RELEASED_FLOOR_METHOD_NAMES`, every unary one registered with
 * `degrade: { kind: "unsupported" }` in `registry.ts`, the way `drafts.*`
 * and `host.usage.summary` are. A host that predates them answers
 * `E_HOST_UNSUPPORTED` and the client hides the bots surface; the stream is
 * simply absent from an old host's `/stream` manifest.
 *
 * All of these are cloud-backed: the host resolvers call the cloud's
 * `/api/bots/*` routes under the caller's bearer, so the host adds nothing to
 * the authorization - owner-only on the row, member-wide on the list.
 */

export const botCreateV10 = defineRpcContract({
  method: "bot.create",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botCreateRequestSchema,
  responseSchema: botCreateResponseSchema,
});

export const botListV10 = defineRpcContract({
  method: "bot.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botListRequestSchema,
  responseSchema: botListResponseSchema,
});

export const botReadV10 = defineRpcContract({
  method: "bot.read",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botReadRequestSchema,
  responseSchema: botReadResponseSchema,
});

export const botUpdateTitleV10 = defineRpcContract({
  method: "bot.updateTitle",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botUpdateTitleRequestSchema,
  responseSchema: botUpdateResponseSchema,
});

export const botUpdateRunSettingsV10 = defineRpcContract({
  method: "bot.updateRunSettings",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botUpdateRunSettingsRequestSchema,
  responseSchema: botUpdateResponseSchema,
});

export const botDeleteV10 = defineRpcContract({
  method: "bot.delete",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botDeleteRequestSchema,
  responseSchema: botDeleteResponseSchema,
});

export const botClaimAuthorityV10 = defineRpcContract({
  method: "bot.claimAuthority",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botClaimAuthorityRequestSchema,
  responseSchema: botClaimAuthorityResponseSchema,
});

/**
 * `bot.open@1.0` (T18): open a bot on the serving host, claiming it there
 * when its bound host is unreachable. Same optional posture as the rest of
 * the namespace.
 */
export const botOpenV10 = defineRpcContract({
  method: "bot.open",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botOpenRequestSchema,
  responseSchema: botOpenResponseSchema,
});

/**
 * `bot.conversation.*@1.0` (T7): the human side of a bot. Same posture as the
 * rest of the namespace - optional, `degrade: { kind: "unsupported" }`. The
 * list is cloud-backed like `bot.list`; the send is the one method here the
 * host itself answers, writing the conversation record on the bound host or
 * handing the message to it through the cross-host mailbox.
 */
export const botConversationListV10 = defineRpcContract({
  method: "bot.conversation.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botConversationListRequestSchema,
  responseSchema: botConversationListResponseSchema,
});

export const botConversationSendV10 = defineRpcContract({
  method: "bot.conversation.send",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botConversationSendRequestSchema,
  responseSchema: botConversationSendResponseSchema,
});

/**
 * `bot.subscribe@1.0` - the bot row, its task list with cadence and last
 * check-in, the open-request count and the bound host, as one snapshot
 * re-sent on change. Replaces polling for Home and the bot tab.
 */
export const botSubscribeV10 = defineStreamRpcContract({
  method: "bot.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: botSubscribeOpenRequestSchema,
  serverFrameSchema: botSubscribeServerFrameSchema,
  clientFrameSchema: botSubscribeClientFrameSchema,
});
