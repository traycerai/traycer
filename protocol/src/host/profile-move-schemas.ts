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

const profileMoveAgentTargetRefSchema = lazySchema(() =>
  z.object({
    kind: z.literal("agent"),
    epicId: z.string().min(1),
    agentId: z.string().min(1),
  }),
);

const profileMoveTargetRefSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    profileMoveAgentTargetRefSchema,
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
      const seenTargets = new Set<string>();
      value.targets.forEach((target, index) => {
        const key = profileMoveTargetRefKey(target);
        if (seenTargets.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["targets", index],
            message: "a target is listed once",
          });
        }
        seenTargets.add(key);
      });
      const seenTerminals = new Set<string>();
      value.terminals.forEach((terminal, index) => {
        const key = JSON.stringify([terminal.epicId, terminal.agentId]);
        if (seenTerminals.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["terminals", index],
            message: "a terminal is listed once",
          });
        }
        seenTerminals.add(key);
      });
      const seenComputers = new Set<string>();
      value.pendingComputers.forEach((computer, index) => {
        if (seenComputers.has(computer.hostId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["pendingComputers", index],
            message: "a computer is listed once",
          });
        }
        seenComputers.add(computer.hostId);
      });
    }),
);
export type ProvidersPreviewProfileMoveResponse = z.infer<
  typeof providersPreviewProfileMoveResponseSchema
>;

/**
 * A bot is never deferred; it moves by one cloud write at commit and its
 * outcome is `moved` even while one of its threads is in a turn; that
 * thread keeps the settings it started with; the count of targets that
 * move when their turns end never includes a bot.
 */
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
      target: profileMoveAgentTargetRefSchema,
      row: profileMoveAgentTargetSchema.nullable(),
    }),
    z.object({
      outcome: z.literal("pending"),
      target: profileMoveTargetRefSchema,
      row: profileMoveTargetSchema.nullable(),
    }),
  ]),
);

/** A colon inside an id must not make two different refs one key. */
function profileMoveTargetRefKey(
  target:
    | { kind: "agent"; epicId: string; agentId: string }
    | { kind: "bot"; botId: string },
): string {
  if (target.kind === "agent") {
    return JSON.stringify([target.kind, target.epicId, target.agentId]);
  }
  return JSON.stringify([target.kind, target.botId]);
}

function profileMoveRowIsTarget(
  target:
    | { kind: "agent"; epicId: string; agentId: string }
    | { kind: "bot"; botId: string },
  row:
    | { kind: "agent"; epicId: string; agentId: string }
    | { kind: "bot"; botId: string },
): boolean {
  if (target.kind === "agent") {
    return (
      row.kind === "agent" &&
      row.epicId === target.epicId &&
      row.agentId === target.agentId
    );
  }
  return row.kind === "bot" && row.botId === target.botId;
}

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
        const key = profileMoveTargetRefKey(target);
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
      const seen = new Set<string>();
      value.results.forEach((result, index) => {
        if (value.mode === "waiting" && result.outcome === "deferred") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["results", index, "outcome"],
            message: "waiting mode does not defer",
          });
        }
        if (
          result.row !== null &&
          !profileMoveRowIsTarget(result.target, result.row)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["results", index, "row"],
            message: "the row is the target",
          });
        }
        const key = profileMoveTargetRefKey(result.target);
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["results", index],
            message: "a target is listed once",
          });
        }
        seen.add(key);
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
