import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

// A local desktop's preparation channel, not a browser inventory or a native
// lifecycle route. The ordinary browser.sessions handshake still admits tabs.
const textFrame = { hasBinaryPayload: z.literal(false) };
const requestId = lazySchema(() => z.string().min(1).max(128));

export const browserDesktopControlOpenSchema = lazySchema(() =>
  z.object({}).strict(),
);
export const browserDesktopControlServerFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("prepare"),
        ...textFrame,
        requestId,
        epicId: z.string().min(1).max(128),
      })
      .strict(),
    z.object({ kind: z.literal("release"), ...textFrame, requestId }).strict(),
    z.object({ kind: z.literal("pong"), ...textFrame }).strict(),
  ]),
);
export const browserDesktopControlClientFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    // A hold was acquired, not proof of readiness. Only the native route's
    // attestation on browser.sessions can make the original call proceed.
    z
      .object({
        kind: z.literal("prepared"),
        ...textFrame,
        requestId,
        windowId: z.string().min(1).max(128),
      })
      .strict(),
    z.object({ kind: z.literal("refused"), ...textFrame, requestId }).strict(),
    z.object({ kind: z.literal("ping"), ...textFrame }).strict(),
  ]),
);
export type BrowserDesktopControlServerFrame = z.infer<
  typeof browserDesktopControlServerFrameSchema
>;
export type BrowserDesktopControlClientFrame = z.infer<
  typeof browserDesktopControlClientFrameSchema
>;

export const browserDesktopControlV10 = defineStreamRpcContract({
  method: "host.browserPreparation.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: browserDesktopControlOpenSchema,
  serverFrameSchema: browserDesktopControlServerFrameSchema,
  clientFrameSchema: browserDesktopControlClientFrameSchema,
});
