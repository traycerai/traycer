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
  botMemorySubscribeClientFrameSchema,
  botMemorySubscribeOpenRequestSchema,
  botMemorySubscribeServerFrameSchema,
  botOpenRequestSchema,
  botOpenResponseSchema,
  botReadRequestSchema,
  botReadResponseSchema,
  botSubscribeClientFrameSchema,
  botSubscribeOpenRequestSchema,
  botSubscribeServerFrameSchema,
  botSubscribeServerFrameSchemaV10,
  botSubscribeServerFrameSchemaV11,
  botSubscribeServerFrameSchemaV12,
  botSubscribeServerFrameSchemaV13,
  botSubscribeServerFrameSchemaV14,
  botSubscribeServerFrameSchemaV15,
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
  botConversationSendRequestSchemaV11,
  botConversationSendResponseSchema,
  botThreadListRequestSchema,
  botTurnLocateRequestSchema,
  botTurnLocateResponseSchema,
  botThreadListResponseSchema,
  botThreadListResponseSchemaV10,
} from "./conversation-schemas";
import {
  botOnboardingChooseRequestSchema,
  botOnboardingChooseResponseSchema,
  botOnboardingCompleteRequestSchema,
  botOnboardingCompleteResponseSchema,
  botOnboardingReadRequestSchema,
  botOnboardingReadResponseSchema,
  botOnboardingReadResponseSchemaV10,
  botOnboardingReadResponseSchemaV11,
} from "./onboarding-schemas";
import {
  botSurfaceActRequestSchema,
  botSurfaceActResponseSchema,
} from "./surface-schemas";
import {
  botNotificationsStopRequestSchema,
  botNotificationsStopResponseSchema,
  botTaskActionRequestSchema,
  botTaskRunNowResponseSchema,
  botTaskSetPausedRequestSchema,
  botTaskSetPausedResponseSchema,
  botTaskStopResponseSchema,
} from "./task-action-schemas";

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
  requestSchema: botConversationSendRequestSchemaV11,
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
 * `bot.conversation.send@1.2` (T91): a send may answer or skip a question a
 * bot asked without waiting (`answer`). A 1.1 request answers none.
 */
export const botConversationSendV12 = defineRpcContract({
  method: "bot.conversation.send",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: botConversationSendRequestSchema,
  responseSchema: botConversationSendResponseSchema,
});
export const botConversationSendUpgradeV11ToV12 = defineUpgradePath<
  typeof botConversationSendV11,
  typeof botConversationSendV12
>({
  from: botConversationSendV11.schemaVersion,
  to: botConversationSendV12.schemaVersion,
  upgradeRequest: (request) => ({ ...request, answer: null }),
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
  responseSchema: botThreadListResponseSchemaV10,
});

/**
 * `bot.thread.list@1.1` (T85): the response names the rows the bound host
 * roots a thread on beyond a post, a question, a proposal and a direct post,
 * and the binding that said them (`threadAnchors`). A 1.0 host names none.
 */
export const botThreadListV11 = defineRpcContract({
  method: "bot.thread.list",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: botThreadListRequestSchema,
  responseSchema: botThreadListResponseSchema,
});
export const botThreadListUpgradeV10ToV11 = defineUpgradePath<
  typeof botThreadListV10,
  typeof botThreadListV11
>({
  from: botThreadListV10.schemaVersion,
  to: botThreadListV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({ ...response, threadAnchors: null }),
});

/**
 * `bot.turn.locate@1.0` (T86): the session turns behind a bot's replies, its
 * not-answered posts and its check-ins, for the receipt under a reply and
 * the turn it opens. Answered by the bound host from its own record and by
 * any other from the bot's environment room. Same optional posture as the
 * namespace: a host without it shows no receipt.
 */
export const botTurnLocateV10 = defineRpcContract({
  method: "bot.turn.locate",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botTurnLocateRequestSchema,
  responseSchema: botTurnLocateResponseSchema,
});

/**
 * `bot.task.*@1.0` and `bot.notifications.stop@1.0` (T92): what a member does
 * to the bot's automations and notification watches from the Activity page,
 * answered by the bound host alone. Same optional posture as the namespace:
 * a host without them shows none of the actions.
 */
export const botTaskRunNowV10 = defineRpcContract({
  method: "bot.task.runNow",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botTaskActionRequestSchema,
  responseSchema: botTaskRunNowResponseSchema,
});

export const botTaskSetPausedV10 = defineRpcContract({
  method: "bot.task.setPaused",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botTaskSetPausedRequestSchema,
  responseSchema: botTaskSetPausedResponseSchema,
});

export const botTaskStopV10 = defineRpcContract({
  method: "bot.task.stop",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botTaskActionRequestSchema,
  responseSchema: botTaskStopResponseSchema,
});

export const botNotificationsStopV10 = defineRpcContract({
  method: "bot.notifications.stop",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botNotificationsStopRequestSchema,
  responseSchema: botNotificationsStopResponseSchema,
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
  responseSchema: botOnboardingReadResponseSchemaV10,
});

/**
 * `bot.onboarding.read@1.1` (T67): the team's main bot while it is still to
 * be set up. A `1.0` host offers no setup.
 */
export const botOnboardingReadV11 = defineRpcContract({
  method: "bot.onboarding.read",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: botOnboardingReadRequestSchema,
  responseSchema: botOnboardingReadResponseSchemaV11,
});
export const botOnboardingReadUpgradeV10ToV11 = defineUpgradePath<
  typeof botOnboardingReadV10,
  typeof botOnboardingReadV11
>({
  from: botOnboardingReadV10.schemaVersion,
  to: botOnboardingReadV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({ ...response, setup: null }),
});

/**
 * `bot.onboarding.read@1.2` (T67b): the setup stays once the team's main bot
 * exists, `live`, with how the team's host came. A `1.1` setup is a main bot
 * still to be set up; a `1.1` caller is served `null` once it is live
 * (`WITHIN_MAJOR_RESPONSE_PROJECTIONS` on the host).
 */
export const botOnboardingReadV12 = defineRpcContract({
  method: "bot.onboarding.read",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: botOnboardingReadRequestSchema,
  responseSchema: botOnboardingReadResponseSchema,
});
export const botOnboardingReadUpgradeV11ToV12 = defineUpgradePath<
  typeof botOnboardingReadV11,
  typeof botOnboardingReadV12
>({
  from: botOnboardingReadV11.schemaVersion,
  to: botOnboardingReadV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    setup:
      response.setup === null
        ? null
        : { ...response.setup, state: "needs_host", arrival: null },
  }),
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
  serverFrameSchema: botSubscribeServerFrameSchemaV11,
  clientFrameSchema: botSubscribeClientFrameSchema,
});

/**
 * `bot.subscribe@1.2` (T84): the snapshot names the bot's chats subscribed to
 * the person's notification feed (`notificationSubscriptions`). A 1.1
 * subscriber's snapshot carries none.
 */
export const botSubscribeV12 = defineStreamRpcContract({
  method: "bot.subscribe",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: botSubscribeOpenRequestSchema,
  serverFrameSchema: botSubscribeServerFrameSchemaV12,
  clientFrameSchema: botSubscribeClientFrameSchema,
});

/**
 * `bot.subscribe@1.3` (T82): each task entry says where the task came from:
 * whether the bot spun it, its label, the request it was set up for and the
 * thread that set it up. A 1.2 subscriber's entries carry none.
 */
export const botSubscribeV13 = defineStreamRpcContract({
  method: "bot.subscribe",
  schemaVersion: { major: 1, minor: 3 } as const,
  openRequestSchema: botSubscribeOpenRequestSchema,
  serverFrameSchema: botSubscribeServerFrameSchemaV13,
  clientFrameSchema: botSubscribeClientFrameSchema,
});

/**
 * `bot.subscribe@1.4` (T86): each task entry carries its check-in history
 * (`checkins`), and each notification subscription when it started
 * (`since`). A 1.3 subscriber's snapshot carries neither, and reads the last
 * check-in alone. Grown in place by T92 (the namespace is unreleased): each
 * entry's pause, stop and pending Run now, each received check-in's
 * requester, each subscription's digests and the stopped watches, all
 * defaulted `null`.
 */
export const botSubscribeV14 = defineStreamRpcContract({
  method: "bot.subscribe",
  schemaVersion: { major: 1, minor: 4 } as const,
  openRequestSchema: botSubscribeOpenRequestSchema,
  serverFrameSchema: botSubscribeServerFrameSchemaV14,
  clientFrameSchema: botSubscribeClientFrameSchema,
});

/**
 * `bot.subscribe@1.5` (T89): each task entry carries what its agents wait on
 * a person for (`inputNeeded`), and the snapshot this subscriber's own
 * answers and decisions still on their way to a task's host
 * (`surfaceActions`). A 1.4 subscriber's snapshot carries neither.
 */
export const botSubscribeV15 = defineStreamRpcContract({
  method: "bot.subscribe",
  schemaVersion: { major: 1, minor: 5 } as const,
  openRequestSchema: botSubscribeOpenRequestSchema,
  serverFrameSchema: botSubscribeServerFrameSchemaV15,
  clientFrameSchema: botSubscribeClientFrameSchema,
});

/**
 * `bot.subscribe@1.6` (T71): a failed turn's reason may offer
 * `update-provider`, which updates the provider's command-line tool on the
 * bot's host. A 1.5 subscriber's frames carry `none` in its place.
 */
export const botSubscribeV16 = defineStreamRpcContract({
  method: "bot.subscribe",
  schemaVersion: { major: 1, minor: 6 } as const,
  openRequestSchema: botSubscribeOpenRequestSchema,
  serverFrameSchema: botSubscribeServerFrameSchema,
  clientFrameSchema: botSubscribeClientFrameSchema,
});

/**
 * `bot.surface.act@1.0` (T89): a member answers a task agent's question, or
 * decides its tool approval, from the card under a bot's post. Optional: a
 * host that predates it advertises nothing and the card offers Open.
 */
export const botSurfaceActV10 = defineRpcContract({
  method: "bot.surface.act",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: botSurfaceActRequestSchema,
  responseSchema: botSurfaceActResponseSchema,
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

/**
 * `bot.memory.subscribe@1.0` (T87) - what a bot knows: the entries of the
 * environment's memory pool tagged the bot or `all`, whole, on open and
 * after every change to the pool. Read-only: nothing on the stream changes
 * an entry; the bot writes them through its memory tool.
 */
export const botMemorySubscribeV10 = defineStreamRpcContract({
  method: "bot.memory.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: botMemorySubscribeOpenRequestSchema,
  serverFrameSchema: botMemorySubscribeServerFrameSchema,
  clientFrameSchema: botMemorySubscribeClientFrameSchema,
});
