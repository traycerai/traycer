import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  runtimeApprovalDecisionSchema,
  runtimeInterviewAnswerSchema,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import { botSurfaceReferenceSchema } from "@traycer/protocol/persistence/epic/messages";
import { botIdSchema, botSurfaceActionRefusalCodeSchema } from "./schemas";

/**
 * `bot.surface.*` schemas (Tracy Bots T89): a member answers a task agent's
 * question, or decides its tool approval, from the card under a bot's post.
 * Kept apart from `schemas.ts` for the reason `conversation-schemas.ts` is.
 */

/**
 * What the member does: answer the question (the answers the task's chat
 * would take from its own card, one per question), skip it (with any
 * answers drafted so far), or allow or deny the approval.
 */
export const botSurfaceActionSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("answer"),
      answers: z.array(runtimeInterviewAnswerSchema).min(1),
    }),
    z.object({
      kind: z.literal("skip"),
      draftAnswers: z.array(runtimeInterviewAnswerSchema),
    }),
    z.object({
      kind: z.literal("decide"),
      decision: runtimeApprovalDecisionSchema,
    }),
  ]),
);
export type BotSurfaceAction = z.infer<typeof botSurfaceActionSchema>;

/**
 * `bot.surface.act@1.0`: the action, on the bot's post (`messageId`) whose
 * surface it settles. `actionId` is minted by the client once per action: a
 * resend of the same id is the same action. The serving host settles it when
 * it runs the task's chat, and otherwise sends it to the host that does,
 * which settles it as this member's after checking their access to the task.
 * An answer or Skip names a `question` surface, a decision an `approval`.
 */
export const botSurfaceActRequestSchema = lazySchema(() =>
  z
    .object({
      botId: botIdSchema,
      messageId: z.string().min(1).max(255),
      actionId: z.string().min(1).max(64),
      surface: botSurfaceReferenceSchema,
      action: botSurfaceActionSchema,
    })
    .superRefine((request, ctx) => {
      const wants = request.action.kind === "decide" ? "approval" : "question";
      if (request.surface.kind !== wants) {
        ctx.addIssue({
          code: "custom",
          path: ["surface", "kind"],
          message: `a ${request.action.kind} action names a ${wants} surface`,
        });
      }
    }),
);
export type BotSurfaceActRequest = z.infer<typeof botSurfaceActRequestSchema>;

/**
 * `settled`: the serving host ran the task's chat and the action is
 * recorded. `forwarded`: it is on its way to the task's host; the
 * subscriber's `surfaceActions` (`bot.subscribe@1.5`) carries it until the
 * post's surface shows its resolution, or the task's host refuses it.
 * `refused`: nothing was recorded, `code` says why.
 */
export const botSurfaceActResponseSchema = lazySchema(() =>
  z
    .object({
      outcome: z.enum(["settled", "forwarded", "refused"]),
      code: botSurfaceActionRefusalCodeSchema.nullable(),
    })
    .superRefine((response, ctx) => {
      if ((response.outcome === "refused") !== (response.code !== null)) {
        ctx.addIssue({
          code: "custom",
          path: ["code"],
          message: "code is set exactly when the action is refused",
        });
      }
    }),
);
export type BotSurfaceActResponse = z.infer<typeof botSurfaceActResponseSchema>;
