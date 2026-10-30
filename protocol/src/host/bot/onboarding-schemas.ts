import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { botIdSchema } from "./schemas";

/**
 * `bot.onboarding.*` schemas (Tracy Bots T48): a team environment's
 * onboarding. Step 1 is the team's GitHub set, step 2 the areas the team
 * starts with as bots, step 3 the channels those bots open. Every schema is
 * a `lazySchema` thunk, as in `schemas.ts`.
 */

/** An area's key, as the host's catalog names it. */
export const botOnboardingAreaKeySchema = lazySchema(() =>
  z.string().min(1).max(64),
);

/**
 * One area the onboarding offers as a bot, as the host's catalog holds it:
 * its title, what it does and when it runs, verbatim from the interaction
 * model. `when` is `null` for an area the model gives no timing for.
 */
export const botOnboardingAreaSchema = lazySchema(() =>
  z.object({
    area: botOnboardingAreaKeySchema,
    title: z.string().min(1),
    description: z.string().min(1),
    when: z.string().min(1).nullable(),
    tickedByDefault: z.boolean(),
  }),
);
export type BotOnboardingArea = z.infer<typeof botOnboardingAreaSchema>;

/**
 * The team's GitHub set as step 1 shows it. `callerCanConnect` is whether
 * the reader may connect GitHub (a team admin); `permission` is the
 * installing admin's access to each repository, `null` when that identity
 * cannot read it now.
 */
export const botOnboardingGithubSchema = lazySchema(() =>
  z.object({
    state: z.enum(["ok", "needs_installing_admin"]),
    installingAdmin: z
      .object({ displayName: z.string(), you: z.boolean() })
      .nullable(),
    repositories: z.array(
      z.object({
        repositoryId: z.string().min(1),
        fullName: z.string().nullable(),
        permission: z.enum(["read", "write"]).nullable(),
      }),
    ),
    callerCanConnect: z.boolean(),
  }),
);
export type BotOnboardingGithub = z.infer<typeof botOnboardingGithubSchema>;

/**
 * The areas the team chose, and when every one of them was set up (`null`
 * before). `pending` names each chosen area whose bot exists but is not set
 * up yet, with the host it runs on (`null` while it is bound to none):
 * that host finishes its routine, announcement and first turn, so a
 * completion there is what finishes the onboarding.
 */
export const botOnboardingChoiceSchema = lazySchema(() =>
  z.object({
    areas: z.array(botOnboardingAreaKeySchema),
    chosenAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().nullable(),
    pending: z.array(
      z.object({
        area: botOnboardingAreaKeySchema,
        botId: botIdSchema,
        hostId: z.string().min(1).nullable(),
      }),
    ),
  }),
);
export type BotOnboardingChoice = z.infer<typeof botOnboardingChoiceSchema>;

export const botOnboardingReadRequestSchema = lazySchema(() =>
  z.object({ environmentId: z.string().min(1) }),
);
export type BotOnboardingReadRequest = z.infer<
  typeof botOnboardingReadRequestSchema
>;

/**
 * `bot.onboarding.read@1.0`'s response, frozen: a team environment's
 * onboarding, for a member of it. `unlocked` is whether the GitHub set holds
 * a repository and works: the bots can then be created. `choice` is `null`
 * before any member chose.
 */
export const botOnboardingReadResponseSchemaV10 = lazySchema(() =>
  z.object({
    github: botOnboardingGithubSchema,
    unlocked: z.boolean(),
    choice: botOnboardingChoiceSchema.nullable(),
    catalog: z.array(botOnboardingAreaSchema),
  }),
);

/**
 * `bot.onboarding.read@1.1`'s setup, frozen (Tracy Bots T67): the team has no
 * live bot, so the main bot does not exist yet and no host the team can use
 * runs it. `botId` is the id it will be created under, the one its
 * environment derives, so a channel opened on it now is the bot's channel
 * once it exists; `title` is the name it will be created with.
 */
export const botOnboardingSetupSchemaV11 = lazySchema(() =>
  z.object({
    botId: botIdSchema,
    title: z.string().min(1),
  }),
);

/**
 * `bot.onboarding.read@1.1`'s response, frozen: `setup` is the team's main
 * bot while it is still to be set up, `null` once the team has a live bot
 * (or had its bots before onboarding existed). `null` too when the answering
 * host predates it (a `1.0` response upgraded), which offers no setup.
 */
export const botOnboardingReadResponseSchemaV11 = lazySchema(() =>
  z.object({
    github: botOnboardingGithubSchema,
    unlocked: z.boolean(),
    choice: botOnboardingChoiceSchema.nullable(),
    catalog: z.array(botOnboardingAreaSchema),
    setup: botOnboardingSetupSchemaV11.nullable(),
  }),
);

/**
 * How the team's host came, once its main bot exists (T67b): `cloud` when
 * the team's bots run on its sandboxes, the only way a team gets a host
 * today.
 */
export const botOnboardingArrivalSchema = lazySchema(() =>
  z.object({ kind: z.enum(["cloud"]) }),
);
export type BotOnboardingArrival = z.infer<typeof botOnboardingArrivalSchema>;

/**
 * The team's main bot through its setup (T67, T67b). `needs_host` while the
 * team has no live bot: no host the team can use runs it yet, and `botId` is
 * the id it will be created under (the one its environment derives), so a
 * channel opened on it now is the bot's channel once it exists. `live` once
 * the team's first host created it: the setup stays in the channel as its
 * history, and `arrival` says how the host came (`null` while
 * `needs_host`). `title` is the name it is created with.
 */
export const botOnboardingSetupSchema = lazySchema(() =>
  z.object({
    botId: botIdSchema,
    title: z.string().min(1),
    state: z.enum(["needs_host", "live"]),
    arrival: botOnboardingArrivalSchema.nullable(),
  }),
);
export type BotOnboardingSetup = z.infer<typeof botOnboardingSetupSchema>;

/**
 * `bot.onboarding.read@1.2`'s response: `setup` stays once the main bot
 * exists, in its `live` state. `null` for a team whose bots pre-date
 * onboarding, and when the answering host predates `setup`.
 */
export const botOnboardingReadResponseSchema = lazySchema(() =>
  z.object({
    github: botOnboardingGithubSchema,
    unlocked: z.boolean(),
    choice: botOnboardingChoiceSchema.nullable(),
    catalog: z.array(botOnboardingAreaSchema),
    setup: botOnboardingSetupSchema.nullable(),
  }),
);
export type BotOnboardingReadResponse = z.infer<
  typeof botOnboardingReadResponseSchema
>;

/** Keeps the team's choice, replacing an earlier one, until its bots exist. */
export const botOnboardingChooseRequestSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
    areas: z.array(botOnboardingAreaKeySchema).max(32),
  }),
);
export type BotOnboardingChooseRequest = z.infer<
  typeof botOnboardingChooseRequestSchema
>;

export const botOnboardingChooseResponseSchema = lazySchema(() =>
  z.object({ choice: botOnboardingChoiceSchema }),
);
export type BotOnboardingChooseResponse = z.infer<
  typeof botOnboardingChooseResponseSchema
>;

/**
 * Creates the chosen bots on the serving host, each with its area's
 * directive, routine, announcement and first turn, and marks the onboarding
 * complete once every chosen area is set up. A bot an earlier try made on
 * another host is left to that host and answered in `choice.pending`; the
 * onboarding then stays incomplete. Refused until the set is unlocked. Safe
 * to repeat: a repeat answers with the bots the first made. The run
 * settings are the new bots'.
 */
export const botOnboardingCompleteRequestSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
    harness: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().min(1).nullable(),
    profile: z.string().min(1).nullable(),
  }),
);
export type BotOnboardingCompleteRequest = z.infer<
  typeof botOnboardingCompleteRequestSchema
>;

export const botOnboardingCompleteResponseSchema = lazySchema(() =>
  z.object({
    choice: botOnboardingChoiceSchema,
    bots: z.array(
      z.object({ area: botOnboardingAreaKeySchema, botId: botIdSchema }),
    ),
  }),
);
export type BotOnboardingCompleteResponse = z.infer<
  typeof botOnboardingCompleteResponseSchema
>;
