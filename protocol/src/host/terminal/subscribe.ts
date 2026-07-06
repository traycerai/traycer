/**
 * `terminal.subscribe@1.3` - versioned streaming-RPC contract for a single
 * host-owned terminal (PTY) session. `terminal.subscribe@1.0`/`@1.1`/`@1.2`
 * (frozen, near the bottom of this file) are the exact shapes shipped before
 * ack-credit, binary framing, and live session metadata respectively; each
 * minor only adds on top of the last, additively, so a newer app still bridges
 * to an older host. Streams have no cross-major downgrade bridge (see
 * `stream-compat.ts`'s `canBridgeStream()`) - a major mismatch is a hard
 * incompatibility, not a fallback - so once a method ships, its major must
 * never move again, only additive minors.
 *
 * Multiple clients may attach to the same `sessionId` simultaneously. Every
 * subscriber sees the same `data`/`binaryData` fanout from the PTY. The host
 * enforces `effectiveCols = min(cols across attached clients)` (and rows
 * similarly) so no viewer's grid overflows; whenever the effective size
 * changes, the host broadcasts a `resized` server frame and every client
 * locks its xterm to those dimensions.
 *
 * The open request MUST carry the client's current `cols`/`rows` so the
 * `min()` recompute on attach completes before the initial `snapshot` is
 * sent. `actionAck` frames are addressed only to the sender - other clients
 * see only the resulting `data`/`binaryData` echo.
 *
 * `ack` (`@1.1`): the client reports bytes actually parsed by its terminal
 * engine (not just received off the socket), coalesced client-side. The host
 * folds outstanding unacked bytes into its own backpressure signal alongside
 * `bufferedAmount`, so a slow renderer parse loop (not just a slow socket)
 * also mutes instead of growing xterm.js's internal write buffer unbounded.
 * Gated on the negotiated minor: a `1.0` client never sends it, and the host
 * must not treat the absence of acks from a `1.0` connection as "behind".
 *
 * `snapshot.ackCreditSupported` (`@1.1`) is the client-side half of that
 * gate: a capability sentinel, same pattern as `chat.subscribe@1.1`'s
 * `backgroundItems`. The renderer only knows its own negotiated minor
 * indirectly (through whichever contract the transport bridged to), so it
 * waits for the host to confirm ack-credit support on the snapshot before
 * ever sending an `ack` frame. Without this, a client bridged down to a
 * `1.0` host would still emit `ack` frames the old host's frame schema can't
 * parse - harmless (the connection doesn't fatal-close), but a steady stream
 * of malformed-frame warnings server-side.
 *
 * `binaryData`/`binarySnapshot` (`@1.2`): the wire twins of `data`/`snapshot`
 * that carry their payload as a paired binary WS frame (the transport's
 * existing `hasBinaryPayload` mechanism - see `epic.subscribe`'s `update`
 * frame for the established pattern) instead of a JSON string field. This
 * kills the 3-6x JSON-escaping tax on ANSI-heavy output, and xterm.js accepts
 * `Uint8Array` directly so the renderer skips re-decoding it back to a JS
 * string. These are ADDITIVE new variants, not a change to `data`/`snapshot`
 * - the framework rejects a minor bump that drops a field or variant (see
 * `versioned-stream-rpc.ts`'s `assertSchemaCompatibility`), so a `1.2` host
 * still sends plain `data`/`snapshot` to any subscriber that only negotiated
 * `1.0`/`1.1`, and only sends the binary twins to a `1.2`+ subscriber.
 * `binarySnapshot` has no `ackCreditSupported` field: receiving it at all
 * already proves the connection negotiated `1.2`, which implies `1.1`'s
 * ack-credit support, so the sentinel would always read `true`.
 *
 * `sessionUpdated` (`@1.3`): a lightweight metadata push for fields that can
 * change while the PTY keeps running, currently the host-observed foreground
 * process name and user title. Byte streams remain on `data`/`binaryData`.
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

const binaryFrameFields = {
  hasBinaryPayload: z.literal(true),
} as const;

// Generous upper bound on one coalesced `ack` batch. A conforming client's
// largest single accounted unit is a `MAX_SNAPSHOT_BYTES`-capped (2 MB)
// snapshot or a `CATCHUP_CAP_BYTES`-capped (1 MB) catch-up/live chunk, plus
// its own coalescing window - nowhere close to this. Rejects a wildly
// wrong/malformed report at the schema boundary rather than silently
// zeroing the ack-credit tally for an implausible amount.
const MAX_ACK_BYTES = 8 * 1024 * 1024;

// ─── Frozen `terminal.subscribe@1.1` server-frame shape (as shipped before
// binary framing) - shared by the `1.0` and `1.1` contracts below, neither of
// which ever sees `binaryData`/`binarySnapshot`. ──────────────────────────
const terminalSubscribeServerFrameSchemaV11 = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    ...textFrameFields,
    ...sessionReferenceFields,
    session: terminalSessionInfoSchema,
    // Rolling scrollback bytes the renderer feeds straight into xterm via
    // `term.write(scrollback)`. The `session.cols`/`rows` already reflect the
    // post-`min()` effective size after this client attached.
    scrollback: z.string(),
    // Ack-credit capability sentinel (`@1.1`) - see the file-level doc
    // comment. Optional (not just absent on `1.0`) for the same
    // rolling-update robustness reason as `chat.subscribe@1.1`'s
    // `backgroundItems`: the renderer must treat a missing value as "not
    // supported", never as "assume supported".
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
    // A reap only fires with zero attached viewers, so a `reaped` exit is
    // never delivered as a live exit frame - it is observed on reattach via
    // `snapshot.session.exitReason`. Keeping the reason off the frozen
    // stream frame avoids retroactively widening an already-shipped minor.
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
    // Bytes the client's terminal engine has actually parsed since its last
    // `ack` (coalesced client-side, not one frame per chunk). No
    // `clientActionId` - unlike `write`/`resize` this is a fire-and-forget
    // credit signal, not a tracked user action.
    bytes: z.number().int().nonnegative().max(MAX_ACK_BYTES),
  }),
]);
export type TerminalSubscribeClientFrame = z.infer<
  typeof terminalSubscribeClientFrameSchema
>;

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
