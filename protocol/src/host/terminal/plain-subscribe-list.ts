/** Replacement-state collection stream for durable plain terminals. */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  plainTerminalProjectionSchemaV10,
  plainTerminalScopeSchemaV10,
} from "@traycer/protocol/host/terminal/plain-v1-schemas";
import {
  plainTerminalListStateSchema,
  plainTerminalScopeSchema,
} from "@traycer/protocol/host/terminal/plain-schemas";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

export const terminalPlainSubscribeListOpenRequestSchema = z.strictObject({
  scope: plainTerminalScopeSchema,
});
export type TerminalPlainSubscribeListOpenRequest = z.infer<
  typeof terminalPlainSubscribeListOpenRequestSchema
>;

export const terminalPlainSubscribeListOpenRequestSchemaV10 = z.strictObject({
  scope: plainTerminalScopeSchemaV10,
});

/** Frozen snapshot-first server frames shipped in desktop/host v1.2.0-rc.1. */
export const terminalPlainSubscribeListServerFrameSchemaV10 =
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      terminals: z.array(plainTerminalProjectionSchemaV10),
    }),
    z.strictObject({
      kind: z.literal("initialized"),
      ...textFrameFields,
    }),
    z.strictObject({
      kind: z.literal("upsert"),
      ...textFrameFields,
      terminal: plainTerminalProjectionSchemaV10,
    }),
    z.strictObject({
      kind: z.literal("deleted"),
      ...textFrameFields,
      terminalId: z.string().min(1),
      revision: z.number().int().nonnegative(),
    }),
    z.strictObject({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type TerminalPlainSubscribeListServerFrameV10 = z.infer<
  typeof terminalPlainSubscribeListServerFrameSchemaV10
>;

export const terminalPlainSubscribeListClientFrameSchemaV10 =
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ]);

/**
 * Server frames are replacement `state` plus the transport keepalive.
 * Each accepted `state` frame replaces the collection described by its
 * coverage. There is no upsert/delete tombstone interpretation: host
 * withdrawal is absence from the next complete replacement state.
 */
export const terminalPlainSubscribeListServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("state"),
      ...textFrameFields,
      state: plainTerminalListStateSchema,
    }),
    z.strictObject({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ],
);
export type TerminalPlainSubscribeListServerFrame = z.infer<
  typeof terminalPlainSubscribeListServerFrameSchema
>;

export const terminalPlainSubscribeListClientFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ],
);
export type TerminalPlainSubscribeListClientFrame = z.infer<
  typeof terminalPlainSubscribeListClientFrameSchema
>;

export const terminalPlainSubscribeListV10 = defineStreamRpcContract({
  method: "terminal.plain.subscribeList",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: terminalPlainSubscribeListOpenRequestSchemaV10,
  serverFrameSchema: terminalPlainSubscribeListServerFrameSchemaV10,
  clientFrameSchema: terminalPlainSubscribeListClientFrameSchemaV10,
});

export const terminalPlainSubscribeListV21 = defineStreamRpcContract({
  method: "terminal.plain.subscribeList",
  schemaVersion: { major: 2, minor: 1 } as const,
  openRequestSchema: terminalPlainSubscribeListOpenRequestSchema,
  serverFrameSchema: terminalPlainSubscribeListServerFrameSchema,
  clientFrameSchema: terminalPlainSubscribeListClientFrameSchema,
});
