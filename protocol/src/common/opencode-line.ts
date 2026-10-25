import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The OpenCode product line a managed install or a chat runs: 1 is the
 * `opencode-ai` line, 2 the `@opencode/cli` line. The two speak different
 * server APIs and keep separate session stores, so a chat that changes line
 * starts a fresh session on the new one.
 */
export const opencodeLineSchema = lazySchema(() =>
  z.union([z.literal(1), z.literal(2)]),
);
export type OpencodeLine = z.infer<typeof opencodeLineSchema>;

/**
 * Why a chat stays on its recorded line although the saved selection names
 * another:
 *  - `background_work`: work the chat started could still resume the session
 *    on its current line;
 *  - `model_unavailable`: the other line cannot run this message: it lacks the
 *    turn's model, the target model cannot take its images, or the line lacks
 *    its slash command or skill;
 *  - `binary_unavailable`: the selected binary, or its catalog, cannot be read
 *    yet.
 */
export const opencodeLineHeldReasonSchema = lazySchema(() =>
  z.enum(["background_work", "model_unavailable", "binary_unavailable"]),
);
export type OpencodeLineHeldReason = z.infer<
  typeof opencodeLineHeldReasonSchema
>;

/**
 * A chat held on `line` (its recorded line) for `reason`. It moves at the first
 * turn start where no reason holds it.
 */
export const opencodeLineHeldSchema = lazySchema(() =>
  z.object({
    line: opencodeLineSchema,
    reason: opencodeLineHeldReasonSchema,
  }),
);
export type OpencodeLineHeld = z.infer<typeof opencodeLineHeldSchema>;
