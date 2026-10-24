import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The OpenCode product line a managed install or a chat runs: 1 is the
 * `opencode-ai` line, 2 the `@opencode/cli` line. The two speak different
 * server APIs and keep separate session stores, so a chat stays on the line it
 * started on.
 */
export const opencodeLineSchema = lazySchema(() =>
  z.union([z.literal(1), z.literal(2)]),
);
export type OpencodeLine = z.infer<typeof opencodeLineSchema>;
