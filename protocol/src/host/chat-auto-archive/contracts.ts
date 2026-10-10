/**
 * The account-wide chat auto-archive setting, proxied through the host.
 *
 * Two methods:
 *
 * - `chatAutoArchive.get` - the account's policy and the host's bounds.
 * - `chatAutoArchive.set` - last-write-wins save of the whole policy.
 *
 * The record lives on traycer-server so one value follows the user to every
 * host they run; these methods exist so the GUI edits it through whichever
 * host the settings panel is bound to, rather than reaching the cloud directly
 * and showing a remote host a policy it is not actually running under (the
 * same reason `autoPolicy.get` / `autoPolicy.set` are host RPCs).
 *
 * Both are OPTIONAL capabilities. Neither is in `RELEASED_FLOOR_METHOD_NAMES`
 * and neither may ever enter it: the floor is fail-closed on the name UNION,
 * so a name present on only one peer would make the whole connection
 * incompatible. Each declares `degrade: { kind: "unsupported" }` in the
 * registry and the renderer feature-detects: a host that predates the setting
 * advertises neither, and Settings renders without the row.
 *
 * Archiving authority is the HOST's. The host's sweep decides which chats are
 * idle and archives them; the client never schedules, simulates or performs
 * auto-archiving itself, whatever these methods answer.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The account's saved policy.
 *
 * `idleSeconds` is a positive integer and nothing more on the wire: the range
 * is enforced by the host (see `bounds`), not pinned here, because a
 * schema-level ceiling would freeze an implementation constant into the wire
 * contract (the worktree auto-cleanup schemas make the same call).
 *
 * `updatedAt` is the server's clock in milliseconds, stamped on every save.
 */
export const chatAutoArchivePolicySchema = lazySchema(() =>
  z.object({
    enabled: z.boolean(),
    /**
     * Off: only chats an agent created. On: chats the user created as well.
     * Terminal agents carry no creator marker and count as user-created.
     */
    includeUserCreated: z.boolean(),
    idleSeconds: z.number().int().positive(),
    updatedAt: z.number(),
  }),
);
export type ChatAutoArchivePolicy = z.infer<typeof chatAutoArchivePolicySchema>;

/**
 * The host-enforced threshold range, sent so the GUI's control cannot offer a
 * value the host will reject. Host implementation constants, not user policy;
 * they travel as data so they can move without a protocol change.
 */
export const chatAutoArchiveBoundsSchema = lazySchema(() =>
  z.object({
    minSeconds: z.number().int().positive(),
    maxSeconds: z.number().int().positive(),
  }),
);
export type ChatAutoArchiveBounds = z.infer<typeof chatAutoArchiveBoundsSchema>;

/**
 * What both methods answer with. One shape for read and write so a successful
 * save never needs a second round trip to re-render.
 *
 * `policy` is `null` when the account has never saved one, which is distinct
 * from a saved policy with `enabled: false`. It is a nullable MEMBER of an
 * object root, never a nullable root, so the response can grow additively.
 */
export const chatAutoArchiveResponseSchema = lazySchema(() =>
  z.object({
    policy: chatAutoArchivePolicySchema.nullable(),
    bounds: chatAutoArchiveBoundsSchema,
  }),
);
export type ChatAutoArchiveResponse = z.infer<
  typeof chatAutoArchiveResponseSchema
>;

export const chatAutoArchiveGetRequestSchema = lazySchema(() => z.object({}));
export type ChatAutoArchiveGetRequest = z.infer<
  typeof chatAutoArchiveGetRequestSchema
>;

export const chatAutoArchiveGetResponseSchema = chatAutoArchiveResponseSchema;
export type ChatAutoArchiveGetResponse = ChatAutoArchiveResponse;

export const chatAutoArchiveGetV10 = defineRpcContract({
  method: "chatAutoArchive.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatAutoArchiveGetRequestSchema,
  responseSchema: chatAutoArchiveGetResponseSchema,
});

/**
 * The whole policy, last-write-wins. `idleSeconds` travels even when `enabled`
 * is false so disabling keeps the user's threshold for the next enable.
 */
export const chatAutoArchiveSetRequestSchema = lazySchema(() =>
  z.object({
    enabled: z.boolean(),
    includeUserCreated: z.boolean(),
    idleSeconds: z.number().int().positive(),
  }),
);
export type ChatAutoArchiveSetRequest = z.infer<
  typeof chatAutoArchiveSetRequestSchema
>;

export const chatAutoArchiveSetResponseSchema = chatAutoArchiveResponseSchema;
export type ChatAutoArchiveSetResponse = ChatAutoArchiveResponse;

export const chatAutoArchiveSetV10 = defineRpcContract({
  method: "chatAutoArchive.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatAutoArchiveSetRequestSchema,
  responseSchema: chatAutoArchiveSetResponseSchema,
});
