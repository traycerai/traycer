/**
 * `terminal.subscribe@1.0` - versioned streaming-RPC contract for a single
 * host-owned terminal (PTY) session.
 *
 * Multiple clients may attach to the same `sessionId` simultaneously. Every
 * subscriber sees the same `data` fanout from the PTY. The host enforces
 * `effectiveCols = min(cols across attached clients)` (and rows similarly) so
 * no viewer's grid overflows; whenever the effective size changes, the host
 * broadcasts a `resized` server frame and every client locks its xterm to
 * those dimensions.
 *
 * The open request MUST carry the client's current `cols`/`rows` so the
 * `min()` recompute on attach completes before the initial `snapshot` is
 * sent. `actionAck` frames are addressed only to the sender - other clients
 * see only the resulting `data` echo.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { terminalSessionInfoSchema } from "@traycer/protocol/host/terminal/unary-schemas";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

const sessionReferenceFields = {
  sessionId: z.string(),
} as const;

const ownerActionFrameFields = {
  ...textFrameFields,
  ...sessionReferenceFields,
  clientActionId: z.string(),
} as const;

export const terminalSubscribeOpenRequestSchema = z.object({
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TerminalSubscribeOpenRequest = z.infer<
  typeof terminalSubscribeOpenRequestSchema
>;

export const terminalActionSchema = z.enum(["write", "resize"]);
export type TerminalAction = z.infer<typeof terminalActionSchema>;

export const terminalActionAckStatusSchema = z.enum(["accepted", "rejected"]);
export type TerminalActionAckStatus = z.infer<
  typeof terminalActionAckStatusSchema
>;

export const terminalSubscribeServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    ...textFrameFields,
    ...sessionReferenceFields,
    session: terminalSessionInfoSchema,
    // Rolling scrollback bytes the renderer feeds straight into xterm via
    // `term.write(scrollback)`. The `session.cols`/`rows` already reflect the
    // post-`min()` effective size after this client attached.
    scrollback: z.string(),
  }),
  z.object({
    kind: z.literal("data"),
    ...textFrameFields,
    ...sessionReferenceFields,
    chunk: z.string(),
  }),
  z.object({
    kind: z.literal("resized"),
    ...textFrameFields,
    ...sessionReferenceFields,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("exit"),
    ...textFrameFields,
    ...sessionReferenceFields,
    exitCode: z.number().int(),
  }),
  z.object({
    kind: z.literal("actionAck"),
    ...textFrameFields,
    ...sessionReferenceFields,
    clientActionId: z.string(),
    action: terminalActionSchema,
    status: terminalActionAckStatusSchema,
    reason: z.string().nullable(),
    code: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("pong"),
    ...textFrameFields,
  }),
]);
export type TerminalSubscribeServerFrame = z.infer<
  typeof terminalSubscribeServerFrameSchema
>;

export const terminalSubscribeClientFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("write"),
    ...ownerActionFrameFields,
    data: z.string(),
  }),
  z.object({
    kind: z.literal("resize"),
    ...ownerActionFrameFields,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("ping"),
    ...textFrameFields,
  }),
]);
export type TerminalSubscribeClientFrame = z.infer<
  typeof terminalSubscribeClientFrameSchema
>;

export const terminalSubscribeV10 = defineStreamRpcContract({
  method: "terminal.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: terminalSubscribeOpenRequestSchema,
  serverFrameSchema: terminalSubscribeServerFrameSchema,
  clientFrameSchema: terminalSubscribeClientFrameSchema,
});
