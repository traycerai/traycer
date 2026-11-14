import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { botIdSchema } from "@traycer/protocol/host/bot/schemas";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";

/**
 * `providers.previewProfileMove` and `providers.commitProfileMove`.
 * Both are optional at 1.0, off the released floor. This file is the
 * schemas and the contracts. It registers no resolver.
 */

/** Same bounds as the bot row's `boundHostId`. That const is not exported. */
const profileMoveHostIdSchema = lazySchema(() => z.string().min(1).max(255));

const profileMoveModeSchema = lazySchema(() => z.enum(["waiting", "switch"]));

const profileMoveExtentSchema = lazySchema(() =>
  z.enum(["fleet", "this-computer"]),
);

/** Lowercase UUID, the spelling of a bot create's request key. */
const profileMoveOperationIdSchema = lazySchema(() =>
  z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);

const profileMoveSourceSchema = lazySchema(() =>
  z.object({
    providerId: providerIdSchema,
    profileId: z.string().min(1),
  }),
);

const profileMoveStandingSchema = lazySchema(() =>
  z.enum(["waiting", "idle", "running"]),
);

const profileMoveAgentTargetSchema = lazySchema(() =>
  z.object({
    kind: z.literal("agent"),
    epicId: z.string().min(1),
    agentId: z.string().min(1),
    hostId: profileMoveHostIdSchema,
    title: z.string().nullable(),
    standing: profileMoveStandingSchema,
  }),
);

const profileMoveBotTargetSchema = lazySchema(() =>
  z.object({
    kind: z.literal("bot"),
    botId: botIdSchema,
    hostId: profileMoveHostIdSchema.nullable(),
    title: z.string().min(1).max(500),
    standing: profileMoveStandingSchema,
  }),
);

const profileMoveTargetSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    profileMoveAgentTargetSchema,
    profileMoveBotTargetSchema,
  ]),
);

const profileMoveTargetRefSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("agent"),
      epicId: z.string().min(1),
      agentId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("bot"),
      botId: botIdSchema,
    }),
  ]),
);

const profileMoveTerminalSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    agentId: z.string().min(1),
    hostId: profileMoveHostIdSchema,
    title: z.string().nullable(),
  }),
);

const profileMovePendingReasonSchema = lazySchema(() =>
  z.enum(["unreachable", "unsupported"]),
);

const profileMovePendingComputerSchema = lazySchema(() =>
  z.object({
    hostId: profileMoveHostIdSchema,
    reason: profileMovePendingReasonSchema,
  }),
);

const profileMoveSkipReasonSchema = lazySchema(() =>
  z.enum([
    "not-waiting",
    "binding-changed",
    "not-allowed",
    "destination-unusable",
    "personal-boundary",
    "unsupported",
    "gone",
  ]),
);

export const providersPreviewProfileMoveRequestSchema = lazySchema(() =>
  z.object({
    extent: profileMoveExtentSchema,
    mode: profileMoveModeSchema,
    source: profileMoveSourceSchema,
  }),
);
export type ProvidersPreviewProfileMoveRequest = z.infer<
  typeof providersPreviewProfileMoveRequestSchema
>;

export const providersPreviewProfileMoveResponseSchema = lazySchema(() =>
  z
    .object({
      extent: profileMoveExtentSchema,
      mode: profileMoveModeSchema,
      targets: z.array(profileMoveTargetSchema).max(2000),
      terminals: z.array(profileMoveTerminalSchema).max(2000),
      pendingComputers: z.array(profileMovePendingComputerSchema).max(500),
    })
    .superRefine((value, ctx) => {
      if (
        value.extent === "this-computer" &&
        value.pendingComputers.length > 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pendingComputers"],
          message: "a single computer does not report other computers",
        });
      }
      if (value.mode === "waiting") {
        value.targets.forEach((target, index) => {
          if (target.standing !== "waiting") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["targets", index, "standing"],
              message: "waiting mode lists waiting targets only",
            });
          }
        });
      }
    }),
);
export type ProvidersPreviewProfileMoveResponse = z.infer<
  typeof providersPreviewProfileMoveResponseSchema
>;

const profileMoveResultSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("moved"),
      target: profileMoveTargetRefSchema,
      row: profileMoveTargetSchema.nullable(),
    }),
    z.object({
      outcome: z.literal("skipped"),
      target: profileMoveTargetRefSchema,
      row: profileMoveTargetSchema.nullable(),
      reason: profileMoveSkipReasonSchema,
    }),
    z.object({
      outcome: z.literal("deferred"),
      target: profileMoveTargetRefSchema,
      row: profileMoveTargetSchema.nullable(),
    }),
    z.object({
      outcome: z.literal("pending"),
      target: profileMoveTargetRefSchema,
      row: profileMoveTargetSchema.nullable(),
    }),
  ]),
);

export const providersCommitProfileMoveRequestSchema = lazySchema(() =>
  z
    .object({
      operationId: profileMoveOperationIdSchema,
      extent: profileMoveExtentSchema,
      mode: profileMoveModeSchema,
      source: profileMoveSourceSchema,
      destinationProfileId: z.string().min(1),
      targets: z.array(profileMoveTargetRefSchema).max(2000),
    })
    .superRefine((value, ctx) => {
      if (value.destinationProfileId === value.source.profileId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["destinationProfileId"],
          message: "the destination is a different row",
        });
      }
      const seen = new Set<string>();
      value.targets.forEach((target, index) => {
        const key =
          target.kind === "agent"
            ? `agent:${target.epicId}:${target.agentId}`
            : `bot:${target.botId}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["targets", index],
            message: "a target is listed once",
          });
        }
        seen.add(key);
      });
    }),
);
export type ProvidersCommitProfileMoveRequest = z.infer<
  typeof providersCommitProfileMoveRequestSchema
>;

export const providersCommitProfileMoveResponseSchema = lazySchema(() =>
  z
    .object({
      operationId: profileMoveOperationIdSchema,
      extent: profileMoveExtentSchema,
      mode: profileMoveModeSchema,
      results: z.array(profileMoveResultSchema).max(2000),
    })
    .superRefine((value, ctx) => {
      if (value.mode !== "waiting") return;
      value.results.forEach((result, index) => {
        if (result.outcome === "deferred") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["results", index, "outcome"],
            message: "waiting mode does not defer",
          });
        }
      });
    }),
);
export type ProvidersCommitProfileMoveResponse = z.infer<
  typeof providersCommitProfileMoveResponseSchema
>;

export const providersPreviewProfileMoveV10 = defineRpcContract({
  method: "providers.previewProfileMove",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersPreviewProfileMoveRequestSchema,
  responseSchema: providersPreviewProfileMoveResponseSchema,
});

export const providersCommitProfileMoveV10 = defineRpcContract({
  method: "providers.commitProfileMove",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersCommitProfileMoveRequestSchema,
  responseSchema: providersCommitProfileMoveResponseSchema,
});
