import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { autoJudgeTierSchema } from "@traycer/protocol/host/auto-mode/contracts";

/**
 * `bot.*` - bots (Tracy Bots): owner-only, host-bound chat containers that
 * live in a team or personal environment. The wire mirror of the cloud's
 * `bots` row - `@traycer/protocol` is an OSS package and must not depend on
 * the internal `@traycerai/common`, so the record is declared here the way
 * `usage-analytics/schemas.ts` mirrors its aggregator.
 *
 * Every schema is a `lazySchema` thunk (the lazy-import gate). Every method
 * is OPTIONAL: registered with `degrade: { kind: "unsupported" }`, off the
 * released floor, so a host that predates bots advertises nothing and a
 * client hides the surface rather than failing the connection.
 */

/**
 * `bot_` + a 26-character Crockford ULID, the one shape the cloud mints
 * (`mintBotId`). Exact rather than "1-36 characters" so a host never carries a
 * client-supplied string that is not a bot id into a cloud call or a log line.
 * The first character is `[0-7]`: a ULID's 48-bit timestamp leaves the top
 * bits of its first base32 digit zero. Mirrored by the server's `isBotIdShape`.
 */
export const botIdSchema = lazySchema(() =>
  z.string().regex(/^bot_[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
);
const hostIdSchema = lazySchema(() => z.string().min(1).max(255));
const botTitleSchema = lazySchema(() => z.string().min(1).max(500));
const botHarnessSchema = lazySchema(() => z.string().min(1).max(64));
const botModelSchema = lazySchema(() => z.string().min(1).max(255));
const botEffortSchema = lazySchema(() => z.string().min(1).max(64).nullable());
const botProfileSchema = lazySchema(() =>
  z.string().min(1).max(255).nullable(),
);

/**
 * A bot's standing directive: what its trunk and thread sessions are told as
 * "your directive". At most 8,000 UTF-16 units of plain text - lines and
 * tabs, no other control character, no line or paragraph separator and no
 * bidirectional override, since the text reaches a model prompt the person
 * reading the form does not see. Mirrored by the cloud's request schema.
 */
export const BOT_DIRECTIVE_MAX_LENGTH = 8_000;
const botDirectiveSchema = lazySchema(() =>
  z
    .string()
    .max(BOT_DIRECTIVE_MAX_LENGTH)
    .refine((directive) => directive.trim().length > 0, {
      message: "a directive needs text",
    })
    .refine(
      (directive) =>
        !/[\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]|(?![\n\t])\p{Cc}/u.test(
          directive,
        ),
      {
        message:
          "a directive is plain text: lines and tabs, no other control characters",
      },
    ),
);

/**
 * `bot.create`'s request key: a lowercase UUID, and only that spelling - not
 * `z.uuid()`, which admits uppercase. No database compares the key (the cloud
 * hashes it into the bot's id), so collation never folds two spellings
 * together; one canonical spelling keeps that hash one-to-one with the key
 * the caller minted. Mirrored by the cloud's request schema.
 */
const botRequestKeySchema = lazySchema(() =>
  z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);

/**
 * How a bot answers a member's top-level post. `thread`: in a thread under
 * the post, run by a session of its own. `direct`: the bot itself answers at
 * the channel's top level, under the post; a member may still open a thread
 * under the post. `direct` is for a bot of a personal environment
 * only, and its default there; a team environment's bot is always `thread`.
 */
export const botReplyModeSchema = lazySchema(() =>
  z.enum(["direct", "thread"]),
);
export type BotReplyMode = z.infer<typeof botReplyModeSchema>;

/** The bot row as the cloud returns it. */
export const botRecordSchema = lazySchema(() =>
  z.object({
    botId: botIdSchema,
    /** The environment (team or personal) the bot lives in. */
    environmentId: z.string().min(1),
    /**
     * The member who created the bot. Attribution only, never authority;
     * null once that account was erased, since a team bot outlives its
     * creator.
     */
    createdByUserId: z.string().min(1).nullable(),
    title: botTitleSchema,
    harness: botHarnessSchema,
    model: botModelSchema,
    effort: botEffortSchema,
    profile: botProfileSchema,
    /** The trunk chat: a chat row under `task_id = botId`. */
    trunkChatId: z.string().min(1),
    /**
     * Which host runs the trunk now; `bot.claimAuthority` rebinds it. Null
     * when no host runs it until a member claims it onto one.
     */
    boundHostId: hostIdSchema.nullable(),
    /** Authority generation: 0 at create, +1 per claim. */
    hostEpoch: z.number().int().nonnegative(),
    createdAt: z.number().int(),
    archivedAt: z.number().int().nullable(),
    /** The bot's standing directive; `null` for none. */
    directive: z.string().nullable(),
    /**
     * How the bot answers a top-level post, as it applies to this bot.
     * Absent from a host that predates the field, which answers every post
     * in a thread.
     */
    replyMode: botReplyModeSchema.default("thread"),
    /**
     * The app conversation `bot.create` made with the bot: the bot's
     * channel. Derived from the bot id, so no conversation filed under the
     * bot later, whatever its timestamp, can stand in for it. `null` (or
     * absent) from a host that predates the field; a client then falls back
     * to the bot's earliest conversation.
     */
    appConversationChatId: z.string().min(1).nullable().default(null),
  }),
);
export type BotRecord = z.infer<typeof botRecordSchema>;

// ---- bot.create -------------------------------------------------------- //

/**
 * The host mints the trunk's chat id and binds itself as the bot's host, the
 * same way it mints every chat id it owns; the cloud takes the owner from the
 * bearer and derives the app conversation's chat id from the bot's id. The response also names the app conversation's chat id so the
 * caller can open it without a list round trip.
 *
 * `requestKey` makes the create safe to repeat: the cloud creates at most one
 * bot per caller and key, and answers a repeat with that bot as it is now, so
 * a retry after an unknown outcome - by the transport's credential recovery,
 * or by the person pressing the button again - never makes a second bot. The
 * caller mints it once per create it means (a lowercase UUID) and keeps it
 * across its own retries; a repeat whose fields differ, or whose bot was
 * deleted since, is refused with `E_BOT_REQUEST_KEY_REUSED`.
 */
export const botCreateRequestSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1).max(36),
    title: botTitleSchema,
    harness: botHarnessSchema,
    model: botModelSchema,
    effort: botEffortSchema,
    profile: botProfileSchema,
    requestKey: botRequestKeySchema,
    /** The bot's standing directive, `null` for none. */
    directive: botDirectiveSchema.nullable(),
  }),
);
export type BotCreateRequest = z.infer<typeof botCreateRequestSchema>;

export const botCreateResponseSchema = lazySchema(() =>
  z.object({
    bot: botRecordSchema,
    appConversationChatId: z.string().min(1),
  }),
);
export type BotCreateResponse = z.infer<typeof botCreateResponseSchema>;

// ---- bot.list ---------------------------------------------------------- //

/**
 * Every live bot across every environment the caller belongs to, each row
 * carrying its `environmentId` so a client groups them. No environment
 * argument: a user belongs to several environments (one per team plus a
 * personal one) and there is no "current" one.
 */
export const botListRequestSchema = lazySchema(() => z.object({}));
export type BotListRequest = z.infer<typeof botListRequestSchema>;

/** `bot.list@1.0`'s response, frozen: the rows alone. */
export const botListResponseSchemaV10 = lazySchema(() =>
  z.object({
    bots: z.array(botRecordSchema),
  }),
);

/**
 * `bot.list@1.1` adds each environment's main bot (decision 30): environment
 * id to bot id, for every listed environment with a live bot. `null` when the
 * answering host predates it (a `1.0` response upgraded), which says nothing
 * about which bot is main.
 */
export const botListResponseSchema = lazySchema(() =>
  z.object({
    bots: z.array(botRecordSchema),
    mainBotIds: z.record(z.string().min(1), botIdSchema).nullable(),
  }),
);
export type BotListResponse = z.infer<typeof botListResponseSchema>;

// ---- bot.read ---------------------------------------------------------- //

export const botReadRequestSchema = lazySchema(() =>
  z.object({ botId: botIdSchema }),
);
export type BotReadRequest = z.infer<typeof botReadRequestSchema>;

export const botReadResponseSchema = lazySchema(() =>
  z.object({ bot: botRecordSchema }),
);
export type BotReadResponse = z.infer<typeof botReadResponseSchema>;

// ---- bot.updateTitle / bot.updateRunSettings / bot.updateDirective ------ //
// ---- bot.updateReplyMode ----------------------------------------------- //

/**
 * Narrow updates, one method per field group - the `epic.updateChatProfile`
 * posture: a client never rebuilds and replays the whole row to move one
 * field.
 */
export const botUpdateTitleRequestSchema = lazySchema(() =>
  z.object({ botId: botIdSchema, title: botTitleSchema }),
);
export type BotUpdateTitleRequest = z.infer<typeof botUpdateTitleRequestSchema>;

export const botUpdateRunSettingsRequestSchema = lazySchema(() =>
  z.object({
    botId: botIdSchema,
    harness: botHarnessSchema,
    model: botModelSchema,
    effort: botEffortSchema,
    profile: botProfileSchema,
  }),
);
export type BotUpdateRunSettingsRequest = z.infer<
  typeof botUpdateRunSettingsRequestSchema
>;

/** The directive, or `null` to clear it. */
export const botUpdateDirectiveRequestSchema = lazySchema(() =>
  z.object({
    botId: botIdSchema,
    directive: botDirectiveSchema.nullable(),
  }),
);
export type BotUpdateDirectiveRequest = z.infer<
  typeof botUpdateDirectiveRequestSchema
>;

/**
 * The reply mode. `direct` on a bot of a team environment is refused with
 * `E_BOT_REPLY_MODE_NOT_ALLOWED`. The change applies from the next post;
 * threads already open stay threads.
 */
export const botUpdateReplyModeRequestSchema = lazySchema(() =>
  z.object({
    botId: botIdSchema,
    replyMode: botReplyModeSchema,
  }),
);
export type BotUpdateReplyModeRequest = z.infer<
  typeof botUpdateReplyModeRequestSchema
>;

export const botUpdateResponseSchema = lazySchema(() =>
  z.object({ bot: botRecordSchema }),
);
export type BotUpdateResponse = z.infer<typeof botUpdateResponseSchema>;

// ---- bot.notificationLevel.read / bot.notificationLevel.set ------------ //

/**
 * What the caller's bell raises for one of a bot's conversations (Tracy Bots
 * T63): `all` of the bot's activity there, `mentions` (the answers to their
 * own posts and threads they took part in, which is what a conversation
 * with no level set reads as), or `off`. A thread follows its channel's
 * level. Stored per person in the cloud, so it is the same on every device.
 */
export const botNotificationLevelSchema = lazySchema(() =>
  z.enum(["all", "mentions", "off"]),
);
export type BotNotificationLevel = z.infer<typeof botNotificationLevelSchema>;

export const botNotificationLevelReadRequestSchema = lazySchema(() =>
  z.object({ botId: botIdSchema }),
);
export type BotNotificationLevelReadRequest = z.infer<
  typeof botNotificationLevelReadRequestSchema
>;

/** The caller's levels by conversation id; a conversation absent reads `mentions`. */
export const botNotificationLevelReadResponseSchema = lazySchema(() =>
  z.object({
    levels: z.record(z.string().min(1), botNotificationLevelSchema),
  }),
);
export type BotNotificationLevelReadResponse = z.infer<
  typeof botNotificationLevelReadResponseSchema
>;

export const botNotificationLevelSetRequestSchema = lazySchema(() =>
  z.object({
    botId: botIdSchema,
    conversationId: z.string().min(1),
    level: botNotificationLevelSchema,
  }),
);
export type BotNotificationLevelSetRequest = z.infer<
  typeof botNotificationLevelSetRequestSchema
>;

export const botNotificationLevelSetResponseSchema = lazySchema(() =>
  z.object({ level: botNotificationLevelSchema }),
);
export type BotNotificationLevelSetResponse = z.infer<
  typeof botNotificationLevelSetResponseSchema
>;

// ---- bot.delete -------------------------------------------------------- //

export const botDeleteRequestSchema = lazySchema(() =>
  z.object({ botId: botIdSchema }),
);
export type BotDeleteRequest = z.infer<typeof botDeleteRequestSchema>;

export const botDeleteResponseSchema = lazySchema(() =>
  z.object({
    /** False when the bot was already archived - idempotent, not an error. */
    deleted: z.boolean(),
  }),
);
export type BotDeleteResponse = z.infer<typeof botDeleteResponseSchema>;

// ---- bot.claimAuthority ------------------------------------------------ //

/**
 * Rebind the bot to THIS host (the host serving the call): the bot row and
 * every chat under it move together and both epochs advance, so the previous
 * host's next publication is refused. The request names the bot only; the
 * host supplies its own id.
 */
export const botClaimAuthorityRequestSchema = lazySchema(() =>
  z.object({ botId: botIdSchema }),
);
export type BotClaimAuthorityRequest = z.infer<
  typeof botClaimAuthorityRequestSchema
>;

export const botClaimAuthorityResponseSchema = lazySchema(() =>
  z.object({ bot: botRecordSchema }),
);
export type BotClaimAuthorityResponse = z.infer<
  typeof botClaimAuthorityResponseSchema
>;

// ---- bot.open ---------------------------------------------------------- //

/**
 * Open a bot on THIS host (the host serving the tab), claiming it here when
 * its bound host cannot be reached. The person never picks the host:
 * the app opens the bot through whichever host serves the tab and follows
 * the answer. A caller the bot is not visible to - not a member of its
 * environment, or the bot deleted - gets the same not-found error
 * `bot.read` answers; every other answer is an `outcome`.
 */
export const botOpenRequestSchema = lazySchema(() =>
  z.object({ botId: botIdSchema }),
);
export type BotOpenRequest = z.infer<typeof botOpenRequestSchema>;

/**
 * Why this host claimed the bot: its bound host is not reachable now, or no
 * host was bound at all.
 */
export const botOpenClaimReasonSchema = lazySchema(() =>
  z.enum(["bound-host-unreachable", "no-bound-host"]),
);
export type BotOpenClaimReason = z.infer<typeof botOpenClaimReasonSchema>;

/**
 * Why the bot cannot be served right now, with no claim made:
 *
 * - `host-not-in-environment`: this host is not a host of the bot's
 *   environment, so it may not run the bot;
 * - `bound-to-sandbox`: the bot runs on its environment's sandbox, which is
 *   never claimed away from, and the sandbox is not reachable from here;
 * - `bound-host-not-observable`: the bot runs on another member's machine,
 *   whose reachability this account cannot see;
 * - `reachability-unknown`: whether the bound host is reachable, or what kind
 *   of host it is, could not be read now;
 * - `trunk-busy`: this host still runs a turn of the bot's trunk from an
 *   earlier binding, and the bot is not claimed under it until it settles.
 */
export const botOpenPausedReasonSchema = lazySchema(() =>
  z.enum([
    "host-not-in-environment",
    "bound-to-sandbox",
    "bound-host-not-observable",
    "reachability-unknown",
    "trunk-busy",
  ]),
);
export type BotOpenPausedReason = z.infer<typeof botOpenPausedReasonSchema>;

export const botOpenOutcomeSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    /**
     * This host runs the bot: it was bound here already (`claimed: null`),
     * or this call claimed it here for `claimed`.
     */
    z.object({
      kind: z.literal("serve-here"),
      claimed: botOpenClaimReasonSchema.nullable(),
    }),
    /**
     * Another host runs the bot and serves it: it is reachable
     * (`reachable`), or another host claimed it while this call was
     * deciding (`claimed-concurrently`) and this host made no second claim.
     */
    z.object({
      kind: z.literal("serve-on-bound-host"),
      hostId: hostIdSchema,
      why: z.enum(["reachable", "claimed-concurrently"]),
    }),
    /** No host can serve the bot from here now; nothing was claimed. */
    z.object({
      kind: z.literal("paused"),
      reason: botOpenPausedReasonSchema,
    }),
  ]),
);
export type BotOpenOutcome = z.infer<typeof botOpenOutcomeSchema>;

export const botOpenResponseSchema = lazySchema(() =>
  z.object({
    /** The bot row after the decision (after the claim, when one was made). */
    bot: botRecordSchema,
    outcome: botOpenOutcomeSchema,
  }),
);
export type BotOpenResponse = z.infer<typeof botOpenResponseSchema>;

// ---- bot.subscribe ----------------------------------------------------- //

/**
 * How often the bot hears about one of its tasks: a periodic check-in every
 * `seconds`, one check-in once the task's agents have all gone idle
 * (`on-completion`), or none.
 */
export const botTaskCadenceSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("every"),
      seconds: z.number().int().positive(),
    }),
    z.object({ kind: z.literal("on-completion") }),
    z.object({ kind: z.literal("none") }),
  ]),
);
export type BotTaskCadence = z.infer<typeof botTaskCadenceSchema>;

// ---- the last delivered check-in --------------------------------------- //

/*
 * What the trunk was shown about one task in the last check-in it consumed:
 * the composer's per-task section as structured rows, every row carrying the
 * ids the bot drills with (agent ids, shell ids, ticket artifact ids and
 * paths, forward ids). The host bounds it with the same caps it renders the
 * prompt under: a list holds at most the rows the prompt listed, the rest
 * are counted in its `omitted`, and text that is not the host's own (a title,
 * a shell description, a path) is cut to the prompt's per-field length with a
 * trailing ` [...]`.
 */

/** An agent created in the task during the window. */
const botCheckinAgentRowSchema = lazySchema(() =>
  z.object({
    agentId: z.string().min(1),
    /** The agent's title; empty when it has none. */
    title: z.string(),
    /** `null` when the host could not read the run settings (a terminal agent has none). */
    harnessId: z.string().nullable(),
    model: z.string().nullable(),
    reasoningEffort: z.string().nullable(),
    startedAt: z.number().int(),
    /** The agent that created it, from the communication graph; `null` when unknown. */
    creatorAgentId: z.string().nullable(),
    isTerminal: z.boolean(),
  }),
);

/**
 * A host-authored event of the task during the window: a shell that exited
 * or was interrupted by a host restart, or a delivery to one of the task's
 * agents (a shell's output, a port forward's interruption notice).
 * `agentTitle` is the title of `agentId`, `null` when the host has none.
 */
const botCheckinBackgroundRowSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("shell-exited"),
      at: z.number().int(),
      shellId: z.string().min(1),
      description: z.string(),
      agentId: z.string().min(1),
      agentTitle: z.string().nullable(),
      /** `null` when the shell ended by signal or its code is unknown. */
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("shell-interrupted"),
      at: z.number().int(),
      shellId: z.string().min(1),
      description: z.string(),
      agentId: z.string().min(1),
      agentTitle: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("shell-output-delivered"),
      at: z.number().int(),
      shellId: z.string().min(1),
      /** `null` when the shell's record is gone. */
      description: z.string().nullable(),
      agentId: z.string().min(1),
      agentTitle: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("forward-notice-delivered"),
      at: z.number().int(),
      forwardId: z.string().min(1),
      agentId: z.string().min(1),
      agentTitle: z.string().nullable(),
    }),
  ]),
);

/** A `kind: ticket` artifact of the task whose status moved to in progress or complete. */
const botCheckinTicketRowSchema = lazySchema(() =>
  z.object({
    artifactId: z.string().min(1),
    title: z.string(),
    /** `epics/<taskId>/artifacts/<folder chain>/index.md`. */
    path: z.string(),
    /** `opened`: status moved to 1 (in progress); `closed`: to 2 (complete). */
    move: z.enum(["opened", "closed"]),
  }),
);

/**
 * A cost figure over the host's usage facts. `knownCostUsd` covers only the
 * priced turns: `completeness` and `unpricedTurnCount` say how much of
 * `turnCount` it covers, so a partial figure is never read as a whole one.
 */
const botCheckinCostTotalsSchema = lazySchema(() =>
  z.object({
    knownCostUsd: z.number().nonnegative(),
    turnCount: z.number().int().nonnegative(),
    completeness: z.object({
      measured: z.number().int().nonnegative(),
      partial: z.number().int().nonnegative(),
      absent: z.number().int().nonnegative(),
    }),
    unpricedTurnCount: z.number().int().nonnegative(),
  }),
);

const botCheckinCostShareSchema = lazySchema(() =>
  z.object({
    knownCostUsd: z.number().nonnegative(),
    turnCount: z.number().int().nonnegative(),
  }),
);

/** The window's cost, with its split by agent and by model (each capped, the rest counted). */
const botCheckinWindowCostSchema = lazySchema(() =>
  botCheckinCostTotalsSchema.extend({
    perAgent: z.array(
      botCheckinCostShareSchema.extend({
        agentId: z.string().min(1),
        agentTitle: z.string().nullable(),
      }),
    ),
    perAgentOmitted: z.number().int().nonnegative(),
    perModel: z.array(
      botCheckinCostShareSchema.extend({
        harnessId: z.string(),
        model: z.string(),
      }),
    ),
    perModelOmitted: z.number().int().nonnegative(),
  }),
);

/** What a check-in's still-running part lists, whatever its state. */
const botCheckinStillRunningListsSchema = lazySchema(() =>
  z.object({
    agents: z.array(
      z.object({
        agentId: z.string().min(1),
        agentTitle: z.string().nullable(),
        /** `turn`: mid-turn; `background`: background work running. */
        tier: z.enum(["turn", "background"]),
      }),
    ),
    agentsOmitted: z.number().int().nonnegative(),
    shells: z.array(
      z.object({
        shellId: z.string().min(1),
        description: z.string(),
        agentId: z.string().min(1),
        agentTitle: z.string().nullable(),
      }),
    ),
    shellsOmitted: z.number().int().nonnegative(),
  }),
);

/**
 * The five parts of a task's check-in, always all present, in the order the
 * prompt renders them. A part the host could not read says so
 * (`available: false`) rather than reading as empty.
 */
export const botCheckinSectionsSchema = lazySchema(() =>
  z.object({
    agentsStarted: z.object({
      /** `false` when the task's agent registry could not be read. */
      available: z.boolean(),
      rows: z.array(botCheckinAgentRowSchema),
      /** Rows past the cap; they are in the next check-in's window. */
      omitted: z.number().int().nonnegative(),
      /** Too many communication-graph events to read every creator. */
      creatorsBeyondCap: z.boolean(),
    }),
    backgroundEvents: z.object({
      /** Oldest first. */
      rows: z.array(botCheckinBackgroundRowSchema),
      /** Rows past the cap; they are in the next check-in's window. */
      omitted: z.number().int().nonnegative(),
    }),
    tickets: z.object({
      rows: z.array(botCheckinTicketRowSchema),
      /** Moves past the cap; the next check-in reports them. */
      omitted: z.number().int().nonnegative(),
      /**
       * `true` on a task's first check-in, which lists tickets UPDATED in the
       * window with an in-progress or complete status; later ones list
       * status changes since the previous check-in.
       */
      firstCheckin: z.boolean(),
    }),
    cost: z.object({
      /** `false` when the host had no usage facts to read; both figures are then null. */
      available: z.boolean(),
      window: botCheckinWindowCostSchema.nullable(),
      /** The task's whole-life total. */
      total: botCheckinCostTotalsSchema.nullable(),
    }),
    /**
     * `state` says whether the task counted as running, and `reason` why, in
     * the only pairings the host writes:
     * - `idle`, reason `null`: nothing running;
     * - `running`: an agent is working or a shell is running (`working`, the
     *   agents and shells listed here), an agent still owes release work (a
     *   shell it stopped has not finished; `owed-release-work`), the task has
     *   no agent yet so it has not begun (`no-agent-yet`, nothing listed), or
     *   the task resumed between the reads, so nothing is listed
     *   (`resumed-while-composing`);
     * - `unknown`, reason `check-failed`: the idle check could not be
     *   completed, so the task counted as running.
     */
    stillRunning: z.discriminatedUnion("state", [
      botCheckinStillRunningListsSchema.extend({
        state: z.literal("idle"),
        reason: z.null(),
      }),
      botCheckinStillRunningListsSchema.extend({
        state: z.literal("running"),
        reason: z.enum([
          "working",
          "owed-release-work",
          "no-agent-yet",
          "resumed-while-composing",
        ]),
      }),
      botCheckinStillRunningListsSchema.extend({
        state: z.literal("unknown"),
        reason: z.literal("check-failed"),
      }),
    ]),
  }),
);
export type BotCheckinSections = z.infer<typeof botCheckinSectionsSchema>;

/**
 * The last check-in the trunk consumed for a task, as the bound host kept it:
 * replaced by the next one, dropped when the task's entry leaves the list or
 * the task is deleted. The window is `(since, through]`; `through` is earlier
 * than the instant the check-in was composed when the rendering budget left
 * rows for the next one.
 */
export const botTaskLastCheckinSchema = lazySchema(() =>
  z.object({
    /**
     * When the bound host received the report: the moment the check-in
     * became the bot's, before its trunk reads it.
     */
    deliveredAt: z.number().int(),
    since: z.number().int(),
    through: z.number().int(),
    sections: botCheckinSectionsSchema,
  }),
);
export type BotTaskLastCheckin = z.infer<typeof botTaskLastCheckinSchema>;

/** The turn of the bot's chat that read a check-in: a session chat and its turn. */
export const botCheckinTurnSchema = lazySchema(() =>
  z.object({
    chatId: z.string().min(1),
    turnId: z.string().min(1),
  }),
);
export type BotCheckinTurn = z.infer<typeof botCheckinTurnSchema>;

/** A member as the bot's records name one: their user id. */
const botMemberIdSchema = lazySchema(() => z.string().min(1).max(36));

/**
 * An automation a member paused (T92): its check-ins wait, unread by the
 * bot, until they resume it; `since` is when they paused it.
 */
export const botTaskPauseSchema = lazySchema(() =>
  z.object({ byUserId: botMemberIdSchema, since: z.number().int() }),
);
export type BotTaskPause = z.infer<typeof botTaskPauseSchema>;

/** An automation a member stopped (T92): its entry ended `by-bot` at `at`. */
export const botTaskStopSchema = lazySchema(() =>
  z.object({ byUserId: botMemberIdSchema, at: z.number().int() }),
);
export type BotTaskStop = z.infer<typeof botTaskStopSchema>;

/**
 * A member's Run now not answered yet (T92): `running` when the bound host
 * composes the pass itself, `requested` when the task runs only on other
 * hosts, whose next report answers it.
 */
export const botTaskRunRequestSchema = lazySchema(() =>
  z.object({
    byUserId: botMemberIdSchema,
    requestedAt: z.number().int(),
    state: z.enum(["running", "requested"]),
  }),
);
export type BotTaskRunRequest = z.infer<typeof botTaskRunRequestSchema>;

/**
 * One entry of a task's check-in history (`bot.subscribe@1.4`, T86), newest
 * first, as the bot's bound host kept it:
 *
 *  - `received` - a host's report: when the bound host received it, the
 *    host that composed it (`hostId` `null` for a report from before T83,
 *    which names none), what it said in counts (`agentsStarted` `null` when
 *    the host could not read its agents), and the turn of the bot's chat
 *    that read it, `null` until one has;
 *  - `missed` - no host reported for at least one whole period past a due
 *    time: `dueAt` the first due time missed, `missedThrough` the latest,
 *    `reason` why (`no-host-reported`: no report arrived from any host), and
 *    `caughtUpAt` when the next report was received, `null` until one is.
 */
export const botTaskCheckinRecordSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("received"),
      receivedAt: z.number().int(),
      hostId: hostIdSchema.nullable(),
      hostName: z.string().min(1),
      outcome: z.enum(["idle", "still-running", "deleted", "deleted-owner"]),
      agentsStarted: z.number().int().nonnegative().nullable(),
      ticketsOpened: z.number().int().nonnegative(),
      ticketsClosed: z.number().int().nonnegative(),
      backgroundEvents: z.number().int().nonnegative(),
      turn: botCheckinTurnSchema.nullable(),
      /**
       * The member whose Run now this report answered (T92): the first
       * report filed after they asked. `null` for a pass on the task's own
       * cadence, and from a host that predates it.
       */
      requestedByUserId: botMemberIdSchema.nullable().default(null),
    }),
    z.object({
      kind: z.literal("missed"),
      dueAt: z.number().int(),
      missedThrough: z.number().int(),
      reason: z.enum(["no-host-reported"]),
      caughtUpAt: z.number().int().nullable(),
    }),
  ]),
);
export type BotTaskCheckinRecord = z.infer<typeof botTaskCheckinRecordSchema>;

/**
 * What an agent of one of the bot's tasks waits on a person for, as the
 * task's host reported it (Tracy Bots T88): a question it asked, with each
 * question's options; a tool approval no mode or judge decided, with the
 * judge's tier when one escalated it and whether only a person may decide
 * it; or a browser session it parked for a person, with the page and why.
 */
export const botInputNeededSurfaceSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("question"),
      blockId: z.string().min(1),
      /**
       * `questionId` is the question's id in its interview, which an answer
       * names; `null` where the agent gave none. `allowsFreeText`: the
       * question takes an answer in the person's own words.
       */
      questions: z.array(
        z.object({
          questionId: z.string().nullable(),
          text: z.string(),
          options: z.array(z.string()),
          allowsFreeText: z.boolean(),
        }),
      ),
      askedAt: z.number().int().nonnegative(),
    }),
    z.object({
      kind: z.literal("approval"),
      approvalId: z.string().min(1),
      tool: z.string(),
      summary: z.string(),
      tier: autoJudgeTierSchema.nullable(),
      requiresPerson: z.boolean(),
      askedAt: z.number().int().nonnegative(),
    }),
    z.object({
      kind: z.literal("browser"),
      sessionId: z.string().min(1),
      tabId: z.string().min(1),
      url: z.string().nullable(),
      title: z.string().nullable(),
      reason: z.string(),
      parkedAt: z.number().int().nonnegative(),
      /** The park's own id: a session parked again is another surface. */
      parkId: z.string().min(1),
    }),
  ]),
);
export type BotInputNeededSurface = z.infer<typeof botInputNeededSurfaceSchema>;

/**
 * One surface of a task still open, as the bot's bound host last heard of
 * it (`bot.subscribe@1.5`, T89): the host that runs the agent, by id and by
 * the name it showed, the agent's chat, the surface's id on that host (the
 * block id, the approval id, or the park's), when the bot's host filed it,
 * and whether the task's host settles a member's answer or decision sent
 * from another host (`acceptsActions`; `false` from a task's host that
 * predates it, whose surfaces are answered in the task).
 */
export const botInputNeededSchema = lazySchema(() =>
  z.object({
    hostId: z.string().min(1),
    hostName: z.string().min(1),
    agentChatId: z.string().min(1),
    surfaceId: z.string().min(1),
    surface: botInputNeededSurfaceSchema,
    reportedAt: z.number().int().nonnegative(),
    acceptsActions: z.boolean(),
  }),
);
export type BotInputNeeded = z.infer<typeof botInputNeededSchema>;

/**
 * Why a member's answer or decision from a bot's card was not recorded:
 * the surface was already settled (by someone else, or by this member from
 * another window); the member does not hold the task; the task's host
 * settles nothing sent from another host (it predates it); the surface is
 * no longer on the task's host; or the task's host could not be reached.
 */
export const botSurfaceActionRefusalCodeSchema = lazySchema(() =>
  z.enum([
    "ALREADY_SETTLED",
    "ACCESS_DENIED",
    "NOT_SUPPORTED",
    "NOT_FOUND",
    "NOT_REACHABLE",
  ]),
);
export type BotSurfaceActionRefusalCode = z.infer<
  typeof botSurfaceActionRefusalCodeSchema
>;

/**
 * One of the subscriber's own actions from a bot's card sent to a task on
 * another host (`bot.surface.act`, `bot.subscribe@1.5`): `sending` until the
 * task's host records it - the post's surface then shows the resolution and
 * the entry goes - or `refused` with why.
 */
export const botSurfaceActionStateSchema = lazySchema(() =>
  z.object({
    actionId: z.string().min(1).max(64),
    messageId: z.string().min(1).max(255),
    state: z.enum(["sending", "refused"]),
    code: botSurfaceActionRefusalCodeSchema.nullable(),
  }),
);
export type BotSurfaceActionState = z.infer<typeof botSurfaceActionStateSchema>;

/**
 * One task the bot created, as the stream lists it (the bot row's task list,
 * written by the task tools and the check-in composer). An ended entry stays
 * listed with its reason; setting a cadence again re-arms it.
 *
 * Reshaped in place on `bot.subscribe@1.0`: the method has not shipped in a
 * host release, and nothing filled the earlier shape.
 */
export const botTaskEntrySchema = lazySchema(() =>
  z
    .object({
      taskId: z.string().min(1),
      cadence: botTaskCadenceSchema,
      /** When the last check-in for this task was consumed; null if never. */
      lastCheckinAt: z.number().int().nullable(),
      /**
       * What that check-in said, kept by the bot's bound host and mirrored
       * into the bot's environment room, which any other host serves it
       * from (T65); `null` before the first check-in, for a deleted task,
       * and while the serving host cannot read the room.
       */
      lastCheckin: botTaskLastCheckinSchema.nullable(),
      /** When the next periodic check-in is due; null for any other cadence. */
      nextAt: z.number().int().nullable(),
      state: z.enum(["tracking", "ended"]),
      /**
       * Null while tracking. `by-bot`: the bot set `none`; `deleted`: the task
       * was deleted; `archived`: its owner archived it; `completed`: an
       * `on-completion` check-in fired.
       */
      endedReason: z
        .enum(["by-bot", "deleted", "archived", "completed"])
        .nullable(),
      /**
       * The member who set the task up, read off the open request of the
       * bot thread that created it (T46b); the cloud keeps it only for a
       * member of the bot's environment. A mention target and a provenance
       * mark, never an authorization input: nothing reads it to decide who
       * may act on the bot or the task. `null` for a task the trunk created,
       * and when the thread had no open request. Defaulted so a host that
       * predates the field serves an entry without it.
       */
      createdByUserId: z.string().min(1).max(36).nullable().default(null),
      /**
       * Whether the bot spun the task (its creator is the bot); `false` for a
       * task the bot adopted, one a member made. This and the three fields
       * below are `bot.subscribe@1.3` (T82), where the task came from as the
       * bot's task list recorded it, and `null` from a host that predates
       * them.
       */
      spun: z.boolean().nullable().default(null),
      /** What the task is for, as the bot named it; `null` for no name. */
      label: z.string().min(1).max(64).nullable().default(null),
      /**
       * The request in the bot's channel the bot was acting on when it set
       * the task up: a member's post. `null` when it acted on none.
       */
      originRequestId: z.string().min(1).max(64).nullable().default(null),
      /**
       * The thread whose session set the task up, by its thread id
       * (`BotThreadSummary.threadId`); `null` for a task the trunk set up.
       */
      createdByChatId: z.string().min(1).max(36).nullable().default(null),
      /**
       * The task's check-in history (`bot.subscribe@1.4`, T86), newest
       * first, kept by the bot's bound host and mirrored into its
       * environment room like `lastCheckin`. `null` from a host that
       * predates it, where `lastCheckin` is all there is, and wherever
       * `lastCheckin` is `null` for want of the room.
       */
      checkins: z.array(botTaskCheckinRecordSchema).nullable().default(null),
      /**
       * What the task's agents wait on a person for now (`bot.subscribe@1.5`,
       * T89), kept by the bot's bound host and mirrored into its environment
       * room like `lastCheckin`; empty when nothing waits. `null` from a
       * host that predates it, and while the serving host cannot read the
       * room.
       */
      inputNeeded: z.array(botInputNeededSchema).nullable().default(null),
      /**
       * What members did to the automation from the Activity page (T92),
       * kept by the bot's bound host and mirrored into its environment room
       * like `checkins`: who paused it and since when, who stopped it, and a
       * Run now not answered yet. `null` for none, and from a host that
       * predates them.
       */
      pause: botTaskPauseSchema.nullable().default(null),
      stop: botTaskStopSchema.nullable().default(null),
      runRequest: botTaskRunRequestSchema.nullable().default(null),
    })
    .superRefine((entry, ctx) => {
      if ((entry.state === "ended") !== (entry.endedReason !== null)) {
        ctx.addIssue({
          code: "custom",
          path: ["endedReason"],
          message: "endedReason is set exactly when state is ended",
        });
      }
      if (entry.nextAt !== null && entry.cadence.kind !== "every") {
        ctx.addIssue({
          code: "custom",
          path: ["nextAt"],
          message: "nextAt is null unless the cadence is every",
        });
      }
    }),
);
export type BotTaskEntry = z.infer<typeof botTaskEntrySchema>;

/**
 * The task entry of `bot.subscribe@1.4`, frozen by hand: with the check-in
 * history and the members' pause, stop and Run now (T92), and without the
 * `@1.5` open surfaces, so a 1.4 peer's re-parse strips them.
 */
const botTaskEntrySchemaV14 = lazySchema(() =>
  z
    .object({
      taskId: z.string().min(1),
      cadence: botTaskCadenceSchema,
      lastCheckinAt: z.number().int().nullable(),
      lastCheckin: botTaskLastCheckinSchema.nullable(),
      nextAt: z.number().int().nullable(),
      state: z.enum(["tracking", "ended"]),
      endedReason: z
        .enum(["by-bot", "deleted", "archived", "completed"])
        .nullable(),
      createdByUserId: z.string().min(1).max(36).nullable().default(null),
      spun: z.boolean().nullable().default(null),
      label: z.string().min(1).max(64).nullable().default(null),
      originRequestId: z.string().min(1).max(64).nullable().default(null),
      createdByChatId: z.string().min(1).max(36).nullable().default(null),
      checkins: z.array(botTaskCheckinRecordSchema).nullable().default(null),
      pause: botTaskPauseSchema.nullable().default(null),
      stop: botTaskStopSchema.nullable().default(null),
      runRequest: botTaskRunRequestSchema.nullable().default(null),
    })
    .superRefine((entry, ctx) => {
      if ((entry.state === "ended") !== (entry.endedReason !== null)) {
        ctx.addIssue({
          code: "custom",
          path: ["endedReason"],
          message: "endedReason is set exactly when state is ended",
        });
      }
      if (entry.nextAt !== null && entry.cadence.kind !== "every") {
        ctx.addIssue({
          code: "custom",
          path: ["nextAt"],
          message: "nextAt is null unless the cadence is every",
        });
      }
    }),
);

/**
 * The task entry of `bot.subscribe@1.3`, frozen by hand: with the provenance
 * and without the `@1.4` check-in history, so a 1.3 peer's re-parse strips it.
 */
const botTaskEntrySchemaV13 = lazySchema(() =>
  z
    .object({
      taskId: z.string().min(1),
      cadence: botTaskCadenceSchema,
      lastCheckinAt: z.number().int().nullable(),
      lastCheckin: botTaskLastCheckinSchema.nullable(),
      nextAt: z.number().int().nullable(),
      state: z.enum(["tracking", "ended"]),
      endedReason: z
        .enum(["by-bot", "deleted", "archived", "completed"])
        .nullable(),
      createdByUserId: z.string().min(1).max(36).nullable().default(null),
      spun: z.boolean().nullable().default(null),
      label: z.string().min(1).max(64).nullable().default(null),
      originRequestId: z.string().min(1).max(64).nullable().default(null),
      createdByChatId: z.string().min(1).max(36).nullable().default(null),
    })
    .superRefine((entry, ctx) => {
      if ((entry.state === "ended") !== (entry.endedReason !== null)) {
        ctx.addIssue({
          code: "custom",
          path: ["endedReason"],
          message: "endedReason is set exactly when state is ended",
        });
      }
      if (entry.nextAt !== null && entry.cadence.kind !== "every") {
        ctx.addIssue({
          code: "custom",
          path: ["nextAt"],
          message: "nextAt is null unless the cadence is every",
        });
      }
    }),
);

/**
 * The task entry up to `bot.subscribe@1.2`, frozen by hand: without the
 * `@1.3` provenance, so an older peer's re-parse strips it. Every earlier
 * minor's snapshot binds it.
 */
const botTaskEntrySchemaV12 = lazySchema(() =>
  z
    .object({
      taskId: z.string().min(1),
      cadence: botTaskCadenceSchema,
      lastCheckinAt: z.number().int().nullable(),
      lastCheckin: botTaskLastCheckinSchema.nullable(),
      nextAt: z.number().int().nullable(),
      state: z.enum(["tracking", "ended"]),
      endedReason: z
        .enum(["by-bot", "deleted", "archived", "completed"])
        .nullable(),
      createdByUserId: z.string().min(1).max(36).nullable().default(null),
    })
    .superRefine((entry, ctx) => {
      if ((entry.state === "ended") !== (entry.endedReason !== null)) {
        ctx.addIssue({
          code: "custom",
          path: ["endedReason"],
          message: "endedReason is set exactly when state is ended",
        });
      }
      if (entry.nextAt !== null && entry.cadence.kind !== "every") {
        ctx.addIssue({
          code: "custom",
          path: ["nextAt"],
          message: "nextAt is null unless the cadence is every",
        });
      }
    }),
);

export const botSubscribeOpenRequestSchema = lazySchema(() =>
  z.object({ botId: botIdSchema }),
);
export type BotSubscribeOpenRequest = z.infer<
  typeof botSubscribeOpenRequestSchema
>;

/**
 * What the person can do about a failed turn: sign in to the provider, or
 * nothing here.
 */
export const botActivityActionSchema = lazySchema(() =>
  z.enum(["sign-in", "none"]),
);
export type BotActivityAction = z.infer<typeof botActivityActionSchema>;

/**
 * Why a session is `failed` or `parked`. For `failed`, `summary` is the
 * turn's error as the transcript draws it (the error row's text, or the
 * settled card's after a provider fallback), `code` the error row's code,
 * which a client maps to its own words for a sandbox's refusal as the row
 * does, and `harnessId` the harness that ran the turn; for `parked`,
 * `summary` is why the queue is paused, `code` `null`, `harnessId` the
 * session's harness and `action` `none`.
 */
export const botActivityReasonSchema = lazySchema(() =>
  z.object({
    summary: z.string().min(1),
    code: z.string().nullable().default(null),
    harnessId: z.string().min(1).max(64),
    action: botActivityActionSchema,
  }),
);
export type BotActivityReason = z.infer<typeof botActivityReasonSchema>;

/**
 * What one of the bot's running chats (the trunk, or a thread's session) is
 * doing, as the bound host sees it (and writes it to the bot's environment
 * room, which every other host serves it from, T65):
 *
 *  - `idle` - the session is open and no turn runs;
 *  - `replying` - a turn runs; `startedAt` is when it started and `step` the
 *    latest tool call or command it made, labelled as the transcript labels
 *    it (`host/agent/gui/activity-step-label.ts`);
 *  - `parked` - the session's queue is paused on a conversation message it
 *    could not deliver;
 *  - `failed` - the last turn ended in an error while the request it answered
 *    is still open, until a later turn starts or the request resolves.
 *
 * `requestId` names the open post the turn is answering, the latest one
 * delivered to it; `null` for a turn that answers none (a check-in, a
 * notice), and once its post is resolved while the turn runs on.
 *
 * `reason` (`bot.subscribe@1.1`) says why the session is `failed` or
 * `parked`, `null` in every other state and from a host that predates it.
 */
export const botSessionActivitySchema = lazySchema(() =>
  z.object({
    state: z.enum(["idle", "replying", "parked", "failed"]),
    startedAt: z.number().int().nullable(),
    step: z.string().nullable(),
    requestId: z.string().min(1).nullable(),
    reason: botActivityReasonSchema.nullable().default(null),
  }),
);
export type BotSessionActivity = z.infer<typeof botSessionActivitySchema>;

/**
 * Every running chat of the bot on its bound host. A chat whose session is
 * not open on the host (never started, gone cold, or its thread closed) is
 * absent: absent reads as idle.
 */
export const botActivitySchema = lazySchema(() =>
  z.object({
    trunk: botSessionActivitySchema.nullable(),
    /** Keyed by thread id, never the session's chat id. */
    threads: z.record(z.string().min(1), botSessionActivitySchema),
  }),
);
export type BotActivity = z.infer<typeof botActivitySchema>;

/** Which entry of {@link botActivitySchema} an `activity` frame replaces. */
export const botActivityTargetSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("trunk") }),
    z.object({ kind: z.literal("thread"), threadId: z.string().min(1) }),
  ]),
);
export type BotActivityTarget = z.infer<typeof botActivityTargetSchema>;

/**
 * One of the bot's chats subscribed to its person's notification feed
 * (`bot.subscribe@1.2`, Tracy Bots T84): the trunk or a thread's session,
 * keyed as {@link botActivityTargetSchema} keys activity. `everySeconds` is
 * the digest interval, `null` for a digest on each burst of rows. `since`
 * (`bot.subscribe@1.4`, T86) is when the chat started watching, `null` from
 * a host that predates it.
 */
export const botNotificationSubscriptionSchema = lazySchema(() =>
  z.object({
    target: botActivityTargetSchema,
    attentionOnly: z.boolean(),
    everySeconds: z.number().int().positive().nullable(),
    since: z.number().int().nullable().default(null),
    /**
     * The digests the chat was handed (T92), newest first, bounded as a
     * task's check-in history is; `null` from a host that predates them.
     */
    digests: z.array(botNotificationDigestSchema).nullable().default(null),
  }),
);
export type BotNotificationSubscription = z.infer<
  typeof botNotificationSubscriptionSchema
>;

/**
 * One digest a subscribed chat was handed (T92): when its turn took it, how
 * many notifications it listed and how many of those needed the person, and
 * the queue item it travelled as.
 */
export const botNotificationDigestSchema = lazySchema(() =>
  z.object({
    deliveredAt: z.number().int(),
    itemCount: z.number().int().nonnegative(),
    attentionCount: z.number().int().nonnegative(),
    queueItemId: z.string().min(1),
  }),
);
export type BotNotificationDigest = z.infer<typeof botNotificationDigestSchema>;

/**
 * A chat's notification watch a member stopped from the Activity page (T92),
 * kept beside the live ones until the chat watches again: what it watched,
 * who stopped it and when, and the digests it had been handed.
 */
export const botStoppedNotificationWatchSchema = lazySchema(() =>
  z.object({
    target: botActivityTargetSchema,
    attentionOnly: z.boolean(),
    everySeconds: z.number().int().positive().nullable(),
    since: z.number().int(),
    stoppedAt: z.number().int(),
    stoppedByUserId: botMemberIdSchema,
    digests: z.array(botNotificationDigestSchema),
  }),
);
export type BotStoppedNotificationWatch = z.infer<
  typeof botStoppedNotificationWatchSchema
>;

/** The subscription of `bot.subscribe@1.2` and `@1.3`, frozen without `since`. */
const botNotificationSubscriptionSchemaV13 = lazySchema(() =>
  z.object({
    target: botActivityTargetSchema,
    attentionOnly: z.boolean(),
    everySeconds: z.number().int().positive().nullable(),
  }),
);

/**
 * The bot as one subscriber sees it. `snapshot` opens the stream and is
 * re-sent whole whenever the bot row, its task list, a task's check-ins,
 * its open-request count, its conversations' rows or its chats' notification
 * subscriptions change (on the bound host, or in the bot's environment room
 * on any other);
 * `activity` carries one changed entry of the bot's activity in between;
 * `deleted` ends it (the bot
 * was archived, or the caller lost it). The conversation rows stay
 * authoritative for open requests; `openRequestCount` is a hint, as the GUI
 * spec says.
 */
export const botSubscribeServerFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      bot: botRecordSchema,
      tasks: z.array(botTaskEntrySchema),
      /**
       * Requests across the bot's conversations not yet resolved, as the
       * bound host knows them; another host serves the count the bound host
       * wrote to the bot's environment room (T65). `null` until the bound
       * host has read the conversations once (a later snapshot carries the
       * count), and while the serving host cannot read the room.
       */
      openRequestCount: z.number().int().nonnegative().nullable(),
      /**
       * Changes whenever a row is written to the bot's channel or a thread
       * record on the bound host (a post, a reply, an announcement, a
       * verdict): a changed value says to read the threads' listing again.
       * Another host serves the value the bound host writes to the bot's
       * environment room once the row is published (T65). `null` while the
       * serving host cannot read the room.
       */
      conversationsRevision: z.number().int().nonnegative().nullable(),
      /** `boundHostId` and `hostEpoch` restated for cheap comparison. */
      boundHost: z.object({
        /** Null when no host runs the bot. */
        hostId: hostIdSchema.nullable(),
        epoch: z.number().int().nonnegative(),
        /** Whether the serving host is the bound one. */
        isThisHost: z.boolean(),
      }),
      /**
       * What the bot's running chats are doing, whole; later changes arrive
       * as `activity` frames. Another host serves what the bound host wrote
       * to the bot's environment room (T65), where a `trunk` of `null` means
       * no value has been written. `null` while the serving host cannot read
       * the room.
       */
      activity: botActivitySchema.nullable(),
      /**
       * The bot's chats subscribed to the person's notification feed
       * (`bot.subscribe@1.2`), as the bound host holds them; the bot owns
       * them, so nothing here changes them. `null` from any other host, and
       * from a host that predates the key.
       */
      notificationSubscriptions: z
        .array(botNotificationSubscriptionSchema)
        .nullable()
        .default(null),
      /**
       * This subscriber's own answers and decisions sent from the bot's
       * channel to a task on another host, still in flight or refused
       * (`bot.subscribe@1.5`, T89), as the serving host holds them. `null`
       * from a host that predates it.
       */
      surfaceActions: z
        .array(botSurfaceActionStateSchema)
        .nullable()
        .default(null),
      /**
       * The watches members stopped (T92), apart from the live ones so a
       * reader that predates the key never shows one as live. Kept on the
       * bound host only, like `notificationSubscriptions`.
       */
      stoppedNotificationWatches: z
        .array(botStoppedNotificationWatchSchema)
        .nullable()
        .default(null),
      hasBinaryPayload: z.literal(false),
    }),
    /**
     * One entry of the snapshot's `activity` changed: `entry` replaces it, and
     * `null` removes it (the session is no longer open on the host). Sent
     * only after a snapshot that carried an `activity`.
     */
    z.object({
      kind: z.literal("activity"),
      target: botActivityTargetSchema,
      entry: botSessionActivitySchema.nullable(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("deleted"),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);
export type BotSubscribeServerFrame = z.infer<
  typeof botSubscribeServerFrameSchema
>;

// ---- bot.subscribe@1.4, frozen ------------------------------------------ //
//
// A hand-written copy of the 1.4 snapshot frame (with T92's stopped watches),
// its task entries without the `@1.5` open surfaces and the snapshot without
// `surfaceActions`, so a 1.4 peer's re-parse strips them. The frames that did
// not change at 1.5 are the live ones.

export const botSubscribeServerFrameSchemaV14 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      bot: botRecordSchema,
      tasks: z.array(botTaskEntrySchemaV14),
      openRequestCount: z.number().int().nonnegative().nullable(),
      conversationsRevision: z.number().int().nonnegative().nullable(),
      boundHost: z.object({
        hostId: hostIdSchema.nullable(),
        epoch: z.number().int().nonnegative(),
        isThisHost: z.boolean(),
      }),
      activity: botActivitySchema.nullable(),
      notificationSubscriptions: z
        .array(botNotificationSubscriptionSchema)
        .nullable()
        .default(null),
      stoppedNotificationWatches: z
        .array(botStoppedNotificationWatchSchema)
        .nullable()
        .default(null),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("activity"),
      target: botActivityTargetSchema,
      entry: botSessionActivitySchema.nullable(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("deleted"),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);

// ---- bot.subscribe@1.3, frozen ------------------------------------------ //
//
// A hand-written copy of the 1.3 snapshot frame, its task entries without the
// `@1.4` check-in history and its subscriptions without `since`, so a 1.3
// peer's re-parse strips them. The frames that did not change at 1.4 are the
// live ones.

export const botSubscribeServerFrameSchemaV13 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      bot: botRecordSchema,
      tasks: z.array(botTaskEntrySchemaV13),
      openRequestCount: z.number().int().nonnegative().nullable(),
      conversationsRevision: z.number().int().nonnegative().nullable(),
      boundHost: z.object({
        hostId: hostIdSchema.nullable(),
        epoch: z.number().int().nonnegative(),
        isThisHost: z.boolean(),
      }),
      activity: botActivitySchema.nullable(),
      notificationSubscriptions: z
        .array(botNotificationSubscriptionSchemaV13)
        .nullable()
        .default(null),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("activity"),
      target: botActivityTargetSchema,
      entry: botSessionActivitySchema.nullable(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("deleted"),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);

// ---- bot.subscribe@1.2, frozen ------------------------------------------ //
//
// A hand-written copy of the 1.2 snapshot frame, its task entries without the
// `@1.3` provenance, so an older peer's re-parse strips it. The frames that
// did not change at 1.3 are the live ones.

export const botSubscribeServerFrameSchemaV12 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      bot: botRecordSchema,
      tasks: z.array(botTaskEntrySchemaV12),
      openRequestCount: z.number().int().nonnegative().nullable(),
      conversationsRevision: z.number().int().nonnegative().nullable(),
      boundHost: z.object({
        hostId: hostIdSchema.nullable(),
        epoch: z.number().int().nonnegative(),
        isThisHost: z.boolean(),
      }),
      activity: botActivitySchema.nullable(),
      notificationSubscriptions: z
        .array(botNotificationSubscriptionSchemaV13)
        .nullable()
        .default(null),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("activity"),
      target: botActivityTargetSchema,
      entry: botSessionActivitySchema.nullable(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("deleted"),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);

// ---- bot.subscribe@1.1, frozen ------------------------------------------ //
//
// A hand-written copy of the 1.1 snapshot frame, without
// `notificationSubscriptions`, so an older peer's re-parse strips it. The
// frames that did not change at 1.2 are the live ones.

export const botSubscribeServerFrameSchemaV11 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      bot: botRecordSchema,
      tasks: z.array(botTaskEntrySchemaV12),
      openRequestCount: z.number().int().nonnegative().nullable(),
      conversationsRevision: z.number().int().nonnegative().nullable(),
      boundHost: z.object({
        hostId: hostIdSchema.nullable(),
        epoch: z.number().int().nonnegative(),
        isThisHost: z.boolean(),
      }),
      activity: botActivitySchema.nullable(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("activity"),
      target: botActivityTargetSchema,
      entry: botSessionActivitySchema.nullable(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("deleted"),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);

// ---- bot.subscribe@1.0, frozen ------------------------------------------ //
//
// Hand-written copies of the 1.0 activity and frame schemas, without
// `reason`: a derived copy would track the live schemas, which is what a
// freeze must not do. `bot.subscribe@1.0` binds these.

const botSessionActivitySchemaV10 = lazySchema(() =>
  z.object({
    state: z.enum(["idle", "replying", "parked", "failed"]),
    startedAt: z.number().int().nullable(),
    step: z.string().nullable(),
    requestId: z.string().min(1).nullable(),
  }),
);

const botActivitySchemaV10 = lazySchema(() =>
  z.object({
    trunk: botSessionActivitySchemaV10.nullable(),
    threads: z.record(z.string().min(1), botSessionActivitySchemaV10),
  }),
);

export const botSubscribeServerFrameSchemaV10 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      bot: botRecordSchema,
      tasks: z.array(botTaskEntrySchemaV12),
      openRequestCount: z.number().int().nonnegative().nullable(),
      conversationsRevision: z.number().int().nonnegative().nullable(),
      boundHost: z.object({
        hostId: hostIdSchema.nullable(),
        epoch: z.number().int().nonnegative(),
        isThisHost: z.boolean(),
      }),
      activity: botActivitySchemaV10.nullable(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("activity"),
      target: botActivityTargetSchema,
      entry: botSessionActivitySchemaV10.nullable(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("deleted"),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);

export const botSubscribeClientFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);
export type BotSubscribeClientFrame = z.infer<
  typeof botSubscribeClientFrameSchema
>;

// ---- bot.listChanged --------------------------------------------------- //

export const botListChangedOpenRequestSchema = lazySchema(() => z.object({}));
export type BotListChangedOpenRequest = z.infer<
  typeof botListChangedOpenRequestSchema
>;

/**
 * `changed`: the bot list of an environment the subscriber belongs to moved
 * on another host or for another member. It carries NOTHING: the client
 * refetches `bot.list`, so a late or repeated frame can only cost a
 * refetch, never replay an older list. A change made through this host for
 * the same subscriber is not reported (the client that made it already
 * refetched).
 */
export const botListChangedServerFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("changed"),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);
export type BotListChangedServerFrame = z.infer<
  typeof botListChangedServerFrameSchema
>;

export const botListChangedClientFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);
export type BotListChangedClientFrame = z.infer<
  typeof botListChangedClientFrameSchema
>;

// ---- bot.memory.subscribe (T87) ----------------------------------------- //

/**
 * One bot's memory as the person reads it (Tracy Bots T87): opened with the
 * bot and the environment whose room keeps the pool. The serving host reads
 * the room it holds for that environment; the environment's every member
 * may read it.
 */
export const botMemorySubscribeOpenRequestSchema = lazySchema(() =>
  z.object({
    botId: botIdSchema,
    environmentId: z.string().min(1).max(36),
  }),
);
export type BotMemorySubscribeOpenRequest = z.infer<
  typeof botMemorySubscribeOpenRequestSchema
>;

/**
 * Who wrote an entry: the bot and its chat (its trunk, or a thread's
 * session), and the member's post the chat was answering, by its request
 * id. `botId` and `chatId` are `null` for an entry copied in from the bots'
 * earlier notes; `requestId` is `null` for one written before entries
 * recorded it, or by a turn that answered no post.
 */
export const botMemoryWriterSchema = lazySchema(() =>
  z.object({
    botId: z.string().min(1).nullable(),
    chatId: z.string().min(1).nullable(),
    requestId: z.string().min(1).nullable(),
  }),
);
export type BotMemoryWriter = z.infer<typeof botMemoryWriterSchema>;

/**
 * One entry of the pool. `at` is when it was written and `confirmedAt` when
 * a bot last said it still holds, each `null` where the room gives no time
 * a reader can use. `tags` names the bots it is for: bot ids, and `all` for
 * every bot of the environment.
 */
export const botMemoryEntrySchema = lazySchema(() =>
  z.object({
    id: z.string().min(1),
    text: z.string(),
    tags: z.array(z.string().min(1)),
    writtenBy: botMemoryWriterSchema,
    at: z.number().nullable(),
    confirmedAt: z.number().nullable(),
  }),
);
export type BotMemoryEntry = z.infer<typeof botMemoryEntrySchema>;

/**
 * What one tag holds against its ceiling: its entries, the characters they
 * take, and the characters it may take before the bot is told to tidy it.
 */
export const botMemoryTagUsageSchema = lazySchema(() =>
  z.object({
    entries: z.number().int().nonnegative(),
    chars: z.number().int().nonnegative(),
    ceiling: z.number().int().positive(),
  }),
);
export type BotMemoryTagUsage = z.infer<typeof botMemoryTagUsageSchema>;

/**
 * The entries the bot reads before every reply - those tagged its id and
 * those tagged `all` - and the usage of each of the two tags.
 */
export const botMemorySchema = lazySchema(() =>
  z.object({
    entries: z.array(botMemoryEntrySchema),
    own: botMemoryTagUsageSchema,
    shared: botMemoryTagUsageSchema,
  }),
);
export type BotMemory = z.infer<typeof botMemorySchema>;

/**
 * `snapshot` carries the bot's memory whole, on open and again after every
 * change to the pool, from any host or bot. `memory` is `null` while the
 * serving host cannot read the environment's room.
 */
export const botMemorySubscribeServerFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      memory: botMemorySchema.nullable(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);
export type BotMemorySubscribeServerFrame = z.infer<
  typeof botMemorySubscribeServerFrameSchema
>;

export const botMemorySubscribeClientFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);
export type BotMemorySubscribeClientFrame = z.infer<
  typeof botMemorySubscribeClientFrameSchema
>;
