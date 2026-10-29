import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  botActivityTargetSchema,
  botIdSchema,
  botTaskPauseSchema,
  botTaskRunRequestSchema,
  botTaskStopSchema,
} from "./schemas";

/**
 * What a member does to a bot's automations and notification watches from
 * the Activity page (Tracy Bots T92): Run now, Pause and Resume, Stop, and
 * Stop watching. Answered by the bot's bound host alone, which holds the
 * check-ins and the watches. The caller's cloud read of the bot is the
 * access check, as for every bot verb. A refusal (another host, a task the
 * list does not hold, an entry that is not a tracking periodic one) is a
 * 409 whose message names it. Every schema is a `lazySchema` thunk, as in
 * `schemas.ts`.
 */

/** A task of the bot's list, as the stream lists it. */
const botTaskIdSchema = lazySchema(() => z.string().min(1).max(64));

/** `bot.task.runNow` / `.stop`: the automation `taskId` of the bot. */
export const botTaskActionRequestSchema = lazySchema(() =>
  z.object({ botId: botIdSchema, taskId: botTaskIdSchema }),
);
export type BotTaskActionRequest = z.infer<typeof botTaskActionRequestSchema>;

/** The Run now as recorded: answered by the next report filed for the task. */
export const botTaskRunNowResponseSchema = lazySchema(() =>
  z.object({ runRequest: botTaskRunRequestSchema }),
);
export type BotTaskRunNowResponse = z.infer<typeof botTaskRunNowResponseSchema>;

/** `bot.task.setPaused`: pause the automation, or resume it. */
export const botTaskSetPausedRequestSchema = lazySchema(() =>
  z.object({
    botId: botIdSchema,
    taskId: botTaskIdSchema,
    paused: z.boolean(),
  }),
);
export type BotTaskSetPausedRequest = z.infer<
  typeof botTaskSetPausedRequestSchema
>;

/**
 * The pause as it stands after the call: the one already held when the
 * automation was paused before, `null` once resumed.
 */
export const botTaskSetPausedResponseSchema = lazySchema(() =>
  z.object({ pause: botTaskPauseSchema.nullable() }),
);
export type BotTaskSetPausedResponse = z.infer<
  typeof botTaskSetPausedResponseSchema
>;

/** The automation's end as recorded. */
export const botTaskStopResponseSchema = lazySchema(() =>
  z.object({ stop: botTaskStopSchema }),
);
export type BotTaskStopResponse = z.infer<typeof botTaskStopResponseSchema>;

/** `bot.notifications.stop`: the chat of the bot whose watch ends. */
export const botNotificationsStopRequestSchema = lazySchema(() =>
  z.object({ botId: botIdSchema, target: botActivityTargetSchema }),
);
export type BotNotificationsStopRequest = z.infer<
  typeof botNotificationsStopRequestSchema
>;

/** Whether the chat was watching: `false` changes nothing. */
export const botNotificationsStopResponseSchema = lazySchema(() =>
  z.object({ stopped: z.boolean() }),
);
export type BotNotificationsStopResponse = z.infer<
  typeof botNotificationsStopResponseSchema
>;
