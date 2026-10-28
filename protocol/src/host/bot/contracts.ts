import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  botClaimAuthorityRequestSchema,
  botClaimAuthorityResponseSchema,
  botCreateRequestSchema,
  botCreateResponseSchema,
  botDeleteRequestSchema,
  botDeleteResponseSchema,
  botListChangedClientFrameSchema,
  botListChangedOpenRequestSchema,
  botListChangedServerFrameSchema,
  botListRequestSchema,
  botListResponseSchema,
  botListResponseSchemaV10,
  botOpenRequestSchema,
  botOpenResponseSchema,
  botReadRequestSchema,
  botReadResponseSchema,
  botSubscribeClientFrameSchema,
  botSubscribeOpenRequestSchema,
  botSubscribeServerFrameSchema,
  botSubscribeServerFrameSchemaV10,
  botUpdateResponseSchema,
  botUpdateRunSettingsRequestSchema,
  botUpdateDirectiveRequestSchema,
  botUpdateReplyModeRequestSchema,
  botNotificationLevelReadRequestSchema,
  botNotificationLevelReadResponseSchema,
  botNotificationLevelSetRequestSchema,
  botNotificationLevelSetResponseSchema,
  botUpdateTitleRequestSchema,
} from "./schemas";
import {
  botConversationListRequestSchema,
  botConversationListResponseSchema,
  botConversationSendRequestSchema,
  botConversationSendRequestSchemaV10,
  botConversationSendResponseSchema,
  botThreadListRequestSchema,
  botThreadListResponseSchema,
} from "./conversation-schemas";
import {
  botOnboardingChooseRequestSchema,
  botOnboardingChooseResponseSchema,
  botOnboardingCompleteRequestSchema,
  botOnboardingCompleteResponseSchema,
  botOnboardingReadRequestSchema,
  botOnboardingReadResponseSchema,
} from "./onboarding-schemas";

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
  responseSchema: botListResponseSchemaV10,
});

/** `bot.list@1.1` (T44b): the rows and each environment's main bot. */
export const botListV11 = defineRpcContract({
  method: "bot.list",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: botListRequestSchema,
  responseSchema: botListResponseSchema,
});
export const botListUpgradeV10ToV11 = defineUpgradePath<
  typeof botListV10,
  typeof botListV11
>({
  from: botListV10.schemaVersion,
  to: botListV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({ ...response, mainBotIds: null }),
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

export const botUpdateDirectiveV10 = defineRpcContract({
  method: "bot.updateDirective",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botUpdateDirectiveRequestSchema,
  responseSchema: botUpdateResponseSchema,
});

export const botUpdateReplyModeV10 = defineRpcContract({
  method: "bot.updateReplyMode",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botUpdateReplyModeRequestSchema,
  responseSchema: botUpdateResponseSchema,
});

/**
 * `bot.notificationLevel.read@1.0` / `.set@1.0`: the caller's notification
 * level per conversation of a bot, kept in the cloud and proxied by any
 * host, like the rest of the namespace's cloud reads.
 */
export const botNotificationLevelReadV10 = defineRpcContract({
  method: "bot.notificationLevel.read",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botNotificationLevelReadRequestSchema,
  responseSchema: botNotificationLevelReadResponseSchema,
});

export const botNotificationLevelSetV10 = defineRpcContract({
  method: "bot.notificationLevel.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botNotificationLevelSetRequestSchema,
  responseSchema: botNotificationLevelSetResponseSchema,
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
 * `bot.open@1.0`: open a bot on the serving host, claiming it there
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
  requestSchema: botConversationSendRequestSchemaV10,
  responseSchema: botConversationSendResponseSchema,
});

/**
 * `bot.conversation.send@1.1` (T69): a send may retry a failed post
 * (`redeliver`) or replace it (`supersedes`). A 1.0 request is a new post.
 */
export const botConversationSendV11 = defineRpcContract({
  method: "bot.conversation.send",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: botConversationSendRequestSchema,
  responseSchema: botConversationSendResponseSchema,
});
export const botConversationSendUpgradeV10ToV11 = defineUpgradePath<
  typeof botConversationSendV10,
  typeof botConversationSendV11
>({
  from: botConversationSendV10.schemaVersion,
  to: botConversationSendV11.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    redeliver: null,
    supersedes: null,
  }),
  upgradeResponse: (response) => response,
});

/**
 * `bot.thread.list@1.0` (T41): the threads of a bot's channel, each with its
 * anchor post, reply count, last reply, open requests and cost. Answered by
 * the bot's bound host from its own store (the thread records live there),
 * and by any other host from the summaries the bound host keeps in the
 * bot's environment room (T65). Same optional posture as the namespace.
 */
export const botThreadListV10 = defineRpcContract({
  method: "bot.thread.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botThreadListRequestSchema,
  responseSchema: botThreadListResponseSchema,
});

/**
 * `bot.onboarding.*@1.0` (T48): a team environment's onboarding. The read
 * and the choice answer from any host (the set is authn's, the choice the
 * cloud's); the completion creates the chosen bots on the serving host, so
 * the client sends it to a host the bots may run on. Same optional posture
 * as the namespace.
 */
export const botOnboardingReadV10 = defineRpcContract({
  method: "bot.onboarding.read",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botOnboardingReadRequestSchema,
  responseSchema: botOnboardingReadResponseSchema,
});

export const botOnboardingChooseV10 = defineRpcContract({
  method: "bot.onboarding.choose",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botOnboardingChooseRequestSchema,
  responseSchema: botOnboardingChooseResponseSchema,
});

export const botOnboardingCompleteV10 = defineRpcContract({
  method: "bot.onboarding.complete",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botOnboardingCompleteRequestSchema,
  responseSchema: botOnboardingCompleteResponseSchema,
});

/**
 * `bot.subscribe@1.0` - the bot row, its task list with cadence and last
 * check-in, the open-request count and the bound host, as one snapshot
 * re-sent on change, and what the bot's running chats are doing, one entry
 * per change. Replaces polling for Home and the bot tab.
 */
export const botSubscribeV10 = defineStreamRpcContract({
  method: "bot.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: botSubscribeOpenRequestSchema,
  serverFrameSchema: botSubscribeServerFrameSchemaV10,
  clientFrameSchema: botSubscribeClientFrameSchema,
});

/**
 * `bot.subscribe@1.1` (T69): an activity entry says why its session is
 * `failed` or `parked` (`reason`). A 1.0 subscriber's frames carry none.
 */
export const botSubscribeV11 = defineStreamRpcContract({
  method: "bot.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: botSubscribeOpenRequestSchema,
  serverFrameSchema: botSubscribeServerFrameSchema,
  clientFrameSchema: botSubscribeClientFrameSchema,
});

/**
 * `bot.listChanged@1.0` - a payload-free `changed` frame each time the bot
 * list of one of the subscriber's environments moves elsewhere (a teammate's
 * create, rename, run-settings change, claim or delete), so Home and the bot
 * tab refetch `bot.list` without waiting for focus. The host learns of it
 * from the environment room's bots doorbell; focus stays the backup.
 */
export const botListChangedV10 = defineStreamRpcContract({
  method: "bot.listChanged",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: botListChangedOpenRequestSchema,
  serverFrameSchema: botListChangedServerFrameSchema,
  clientFrameSchema: botListChangedClientFrameSchema,
});
