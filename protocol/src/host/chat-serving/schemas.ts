import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

const textFrameFields = {
  hasBinaryPayload: lazySchema(() => z.literal(false)),
} as const;

/**
 * Who serves a team sandbox's chat right now, as the server publishes it.
 *
 * - `live` - the chat's owner host is awake, holds the chat's authority and
 *   has hydrated it and taken its local writer lease: it serves the chat, live
 *   turn included.
 * - `catching-up` - a host is awake for the chat or has just left it, but the
 *   chat is not yet served live and the pool's copy may be behind:
 *   {@link CHAT_CATCHING_UP_REASONS} says which. The pool serves what it has,
 *   and the app says the chat is catching up instead of showing a plain
 *   at-rest page.
 * - `at-rest` - no host serves the chat; the pool's index is built from the
 *   chat's current head and the pool serves it.
 */
export const CHAT_SERVING_STATES = ["live", "catching-up", "at-rest"] as const;
export type ChatServingState = (typeof CHAT_SERVING_STATES)[number];

/**
 * - `transfer` - the chat's authority was moved to a new host that is still
 *   hydrating it from the published parts or taking its lease.
 * - `final-publication` - the owner host is leaving (suspending, stopping or
 *   removed) and its final publication is not yet confirmed.
 * - `indexing` - no host serves the chat and the pool's index has not yet
 *   been built from the chat's current head.
 */
export const CHAT_CATCHING_UP_REASONS = [
  "transfer",
  "final-publication",
  "indexing",
] as const;
export type ChatCatchingUpReason = (typeof CHAT_CATCHING_UP_REASONS)[number];

export const chatServingSchema = lazySchema(() =>
  z.object({
    /**
     * The chat's current owner host (the server's authority record). A tab
     * bound to any other host reads the chat as at rest.
     */
    ownerHostId: z.string().min(1),
    state: z.enum(CHAT_SERVING_STATES),
    /** Set exactly when `state` is `catching-up`. */
    catchingUp: z.enum(CHAT_CATCHING_UP_REASONS).nullable(),
  }),
);
export type ChatServing = z.infer<typeof chatServingSchema>;

export const chatServingSubscribeOpenRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    chatId: z.string().min(1),
  }),
);
export type ChatServingSubscribeOpenRequest = z.infer<
  typeof chatServingSubscribeOpenRequestSchema
>;

/**
 * SNAPSHOT-ONLY: every frame is the chat's whole serving state, so a dropped
 * or repeated frame costs nothing. The first frame follows the open; later
 * ones only when the state changed.
 */
export const chatServingSubscribeServerFrameSchema = lazySchema(() =>
  z.object({
    kind: z.literal("serving"),
    ...textFrameFields,
    serving: chatServingSchema,
  }),
);
export type ChatServingSubscribeServerFrame = z.infer<
  typeof chatServingSubscribeServerFrameSchema
>;

/** `refresh` asks the server to re-read the state now. */
export const chatServingSubscribeClientFrameSchema = lazySchema(() =>
  z.object({
    kind: z.literal("refresh"),
    ...textFrameFields,
  }),
);
export type ChatServingSubscribeClientFrame = z.infer<
  typeof chatServingSubscribeClientFrameSchema
>;

/**
 * `chat.continueHere`: continue a team sandbox's chat whose sandbox was
 * removed on THIS sandbox host, keeping the chat id. The host asks the server
 * to move the chat's authority to it, then hydrates the chat from its
 * published parts and takes its writer lease; the witness turns `live` for
 * this host once all three are done.
 *
 * `operationId` names the move: a retry with the same id (a lost answer, a
 * restarted host) resumes it and never moves the chat twice.
 */
export const chatContinueHereRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    chatId: z.string().min(1),
    operationId: z.string().uuid(),
  }),
);
export type ChatContinueHereRequest = z.infer<
  typeof chatContinueHereRequestSchema
>;

/**
 * Why a continue was refused.
 *
 * - `source-live` - the chat's sandbox still exists (awake or asleep): resume
 *   it instead.
 * - `other-environment` - this host is not a sandbox of the environment that
 *   owns the chat (or not a sandbox at all): clone instead.
 * - `already-moved` - another continue already moved the chat to
 *   `ownerHostId`.
 * - `never-published` - the removed sandbox never published the chat, so
 *   there is nothing to continue from.
 */
export const CHAT_CONTINUE_REFUSALS = [
  "source-live",
  "other-environment",
  "already-moved",
  "never-published",
] as const;
export type ChatContinueRefusal = (typeof CHAT_CONTINUE_REFUSALS)[number];

export const chatContinueHereResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      /**
       * `accepted` - the server moved the chat here and this host is catching
       * up (hydrating, taking the lease); `ready` - it serves the chat live.
       */
      kind: z.enum(["accepted", "ready"]),
      operationId: z.string().uuid(),
      /** The host the chat now belongs to: this host. */
      ownerHostId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("refused"),
      reason: z.enum(CHAT_CONTINUE_REFUSALS),
      /** The chat's current owner host, when the server named one. */
      ownerHostId: z.string().min(1).nullable(),
    }),
  ]),
);
export type ChatContinueHereResponse = z.infer<
  typeof chatContinueHereResponseSchema
>;
