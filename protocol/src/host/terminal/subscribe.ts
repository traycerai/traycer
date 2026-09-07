/**
 * `terminal.subscribe@1.3` - versioned streaming-RPC contract for a single host-owned terminal (PTY) session.
 * The open request MUST carry the client's current `cols`/`rows` so the `min()` recompute on attach completes before the initial `snapshot` is sent.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  canonicalTerminalSessionInfoSchema,
  canonicalTerminalSessionInfoWithCurrentCwdSchema,
  terminalSessionInfoSchema,
} from "@traycer/protocol/host/terminal/unary-schemas";

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

export const terminalSubscribeViewerSchema = z.enum(["presentation", "cache"]);
export type TerminalSubscribeViewer = z.infer<
  typeof terminalSubscribeViewerSchema
>;

/**
 * `terminal.subscribe@1.6` open request. `viewer` defaults to `presentation`
 * so a 1.6 parse of a 1.5-shaped open is byte-identical to today's attach.
 */
export const terminalSubscribeOpenRequestSchemaV16 =
  terminalSubscribeOpenRequestSchema.extend({
    viewer: terminalSubscribeViewerSchema.default("presentation"),
  });
export type TerminalSubscribeOpenRequestV16 = z.infer<
  typeof terminalSubscribeOpenRequestSchemaV16
>;

export const terminalActionSchema = z.enum(["write", "resize"]);
export type TerminalAction = z.infer<typeof terminalActionSchema>;

export const terminalActionAckStatusSchema = z.enum(["accepted", "rejected"]);
export type TerminalActionAckStatus = z.infer<
  typeof terminalActionAckStatusSchema
>;

const binaryFrameFields = {
  hasBinaryPayload: z.literal(true),
} as const;

// Generous upper bound on one coalesced `ack` batch.
// Rejects a wildly wrong/malformed report at the schema boundary rather than silently zeroing the ack-credit tally for an implausible amount.
const MAX_ACK_BYTES = 8 * 1024 * 1024;

// ─── Frozen `terminal.subscribe@1.1` server-frame shape (as shipped before binary framing) - shared by the `1.0` and `1.1` contracts below, neither of which ever sees `binaryData`/`binarySnapshot`..
const terminalSubscribeServerFrameSchemaV11 = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    ...textFrameFields,
    ...sessionReferenceFields,
    session: terminalSessionInfoSchema,
    // Rolling scrollback bytes the renderer feeds straight into xterm via `term.write(scrollback)`.
    scrollback: z.string(),
    // `chat.subscribe@1.1` - Ack-credit capability sentinel (`@1.1`) - see the file-level doc comment.
    // Optional (not just absent on `1.0`) for the same rolling-update robustness reason as `chat.subscribe@1.1`'s `backgroundItems`: the renderer must treat a missing value as "not supported", never as "assume supported".
    ackCreditSupported: z.boolean().optional(),
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
    // NB: the exit *reason* lives on the session info (snapshot), not here.
    // Keeping the reason off the frozen stream frame avoids retroactively widening an already-shipped minor.
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

const terminalSubscribeServerFrameSchemaV12 = z.discriminatedUnion("kind", [
  ...terminalSubscribeServerFrameSchemaV11.def.options,
  z.object({
    kind: z.literal("binarySnapshot"),
    ...binaryFrameFields,
    ...sessionReferenceFields,
    session: terminalSessionInfoSchema,
    // No `scrollback` field - the bytes arrive as the paired binary WS frame.
  }),
  z.object({
    kind: z.literal("binaryData"),
    ...binaryFrameFields,
    ...sessionReferenceFields,
    // No `chunk` field - the bytes arrive as the paired binary WS frame.
  }),
]);

// `terminal.subscribe@1.3` (current major-1 latest) - extends V12 with
// `sessionUpdated`.
export const terminalSubscribeServerFrameSchema = z.discriminatedUnion("kind", [
  ...terminalSubscribeServerFrameSchemaV12.def.options,
  z.object({
    kind: z.literal("sessionUpdated"),
    ...textFrameFields,
    ...sessionReferenceFields,
    session: terminalSessionInfoSchema,
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
  z.object({
    kind: z.literal("ack"),
    ...textFrameFields,
    ...sessionReferenceFields,
    // Bytes the client's terminal engine has actually parsed since its last `ack` (coalesced client-side, not one frame per chunk).
    bytes: z.number().int().nonnegative().max(MAX_ACK_BYTES),
  }),
]);
export type TerminalSubscribeClientFrame = z.infer<
  typeof terminalSubscribeClientFrameSchema
>;

// `terminal.subscribe@1.4` deliberately replaces the nested `session` shape from `epicId` to `scope`, even though the general minor-version rule is additive.
// Do not use this as a general minor-bump precedent.
export const terminalSubscribeServerFrameSchemaV14 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      ...sessionReferenceFields,
      session: canonicalTerminalSessionInfoSchema,
      scrollback: z.string(),
      ackCreditSupported: z.boolean().optional(),
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
    z.object({
      kind: z.literal("binarySnapshot"),
      ...binaryFrameFields,
      ...sessionReferenceFields,
      session: canonicalTerminalSessionInfoSchema,
    }),
    z.object({
      kind: z.literal("binaryData"),
      ...binaryFrameFields,
      ...sessionReferenceFields,
    }),
    z.object({
      kind: z.literal("sessionUpdated"),
      ...textFrameFields,
      ...sessionReferenceFields,
      session: canonicalTerminalSessionInfoSchema,
    }),
  ],
);
export type TerminalSubscribeServerFrameV14 = z.infer<
  typeof terminalSubscribeServerFrameSchemaV14
>;

// `terminal.subscribe@1.5` is the current scope-bearing shape.
// V1.4 remains frozen above; the host explicitly projects session info for each negotiated minor.
export const terminalSubscribeServerFrameSchemaV15 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      ...sessionReferenceFields,
      session: canonicalTerminalSessionInfoWithCurrentCwdSchema,
      scrollback: z.string(),
      ackCreditSupported: z.boolean().optional(),
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
    z.object({
      kind: z.literal("binarySnapshot"),
      ...binaryFrameFields,
      ...sessionReferenceFields,
      session: canonicalTerminalSessionInfoWithCurrentCwdSchema,
    }),
    z.object({
      kind: z.literal("binaryData"),
      ...binaryFrameFields,
      ...sessionReferenceFields,
    }),
    z.object({
      kind: z.literal("sessionUpdated"),
      ...textFrameFields,
      ...sessionReferenceFields,
      session: canonicalTerminalSessionInfoWithCurrentCwdSchema,
    }),
  ],
);
export type TerminalSubscribeServerFrameV15 = z.infer<
  typeof terminalSubscribeServerFrameSchemaV15
>;

export const terminalSubscribeV16 = defineStreamRpcContract({
  method: "terminal.subscribe",
  schemaVersion: { major: 1, minor: 6 } as const,
  openRequestSchema: terminalSubscribeOpenRequestSchemaV16,
  serverFrameSchema: terminalSubscribeServerFrameSchemaV15,
  clientFrameSchema: terminalSubscribeClientFrameSchema,
});

export const terminalSubscribeV15 = defineStreamRpcContract({
  method: "terminal.subscribe",
  schemaVersion: { major: 1, minor: 5 } as const,
  openRequestSchema: terminalSubscribeOpenRequestSchema,
  serverFrameSchema: terminalSubscribeServerFrameSchemaV15,
  clientFrameSchema: terminalSubscribeClientFrameSchema,
});

export const terminalSubscribeV14 = defineStreamRpcContract({
  method: "terminal.subscribe",
  schemaVersion: { major: 1, minor: 4 } as const,
  openRequestSchema: terminalSubscribeOpenRequestSchema,
  serverFrameSchema: terminalSubscribeServerFrameSchemaV14,
  clientFrameSchema: terminalSubscribeClientFrameSchema,
});

export const terminalSubscribeV13 = defineStreamRpcContract({
  method: "terminal.subscribe",
  schemaVersion: { major: 1, minor: 3 } as const,
  openRequestSchema: terminalSubscribeOpenRequestSchema,
  serverFrameSchema: terminalSubscribeServerFrameSchema,
  clientFrameSchema: terminalSubscribeClientFrameSchema,
});

export const terminalSubscribeV12 = defineStreamRpcContract({
  method: "terminal.subscribe",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: terminalSubscribeOpenRequestSchema,
  serverFrameSchema: terminalSubscribeServerFrameSchemaV12,
  clientFrameSchema: terminalSubscribeClientFrameSchema,
});

export const terminalSubscribeV11 = defineStreamRpcContract({
  method: "terminal.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: terminalSubscribeOpenRequestSchema,
  serverFrameSchema: terminalSubscribeServerFrameSchemaV11,
  clientFrameSchema: terminalSubscribeClientFrameSchema,
});

// ─── Frozen `terminal.subscribe@1.0` shape (as shipped before ack-credit) ──

const terminalSubscribeClientFrameSchemaV10 = z.discriminatedUnion("kind", [
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

export const terminalSubscribeV10 = defineStreamRpcContract({
  method: "terminal.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: terminalSubscribeOpenRequestSchema,
  serverFrameSchema: terminalSubscribeServerFrameSchemaV11,
  clientFrameSchema: terminalSubscribeClientFrameSchemaV10,
});
