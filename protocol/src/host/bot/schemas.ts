import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

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

export const botUpdateResponseSchema = lazySchema(() =>
  z.object({ bot: botRecordSchema }),
);
export type BotUpdateResponse = z.infer<typeof botUpdateResponseSchema>;

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
    /** When the trunk's queue settled the check-in as delivered. */
    deliveredAt: z.number().int(),
    since: z.number().int(),
    through: z.number().int(),
    sections: botCheckinSectionsSchema,
  }),
);
export type BotTaskLastCheckin = z.infer<typeof botTaskLastCheckinSchema>;

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
       * What that check-in said, kept by the bot's bound host: `null` from
       * any other host (the cloud row does not carry it), before the first
       * check-in, and for a deleted task.
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

export const botSubscribeOpenRequestSchema = lazySchema(() =>
  z.object({ botId: botIdSchema }),
);
export type BotSubscribeOpenRequest = z.infer<
  typeof botSubscribeOpenRequestSchema
>;

/**
 * The bot as one subscriber sees it. `snapshot` opens the stream and is
 * re-sent whole whenever the bot row, its task list, a task's last check-in,
 * its open-request count or its conversations' rows change on this host;
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
       * bound host knows them. `null` when the serving host is not the bound
       * one, and on the bound host until it has read the conversations once
       * (a later snapshot carries the count).
       */
      openRequestCount: z.number().int().nonnegative().nullable(),
      /**
       * Changes whenever a row is written to the bot's channel or a thread
       * record on the bound host (a post, a reply, an announcement, a
       * verdict): a changed value says to read the threads' listing again.
       * `null` when the serving host is not the bound one.
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
