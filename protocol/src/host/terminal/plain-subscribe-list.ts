/** Snapshot-first collection stream for durable plain terminals. */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  plainTerminalProjectionSchema,
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

export const terminalPlainSubscribeListServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      terminals: z.array(plainTerminalProjectionSchema),
    }),
    z.strictObject({
      // Marks the ordered boundary after the snapshot and every mutation
      // buffered while that snapshot was being constructed.
      kind: z.literal("initialized"),
      ...textFrameFields,
    }),
    z.strictObject({
      kind: z.literal("upsert"),
      ...textFrameFields,
      terminal: plainTerminalProjectionSchema,
    }),
    z.strictObject({
      kind: z.literal("deleted"),
      ...textFrameFields,
      terminalId: z.string().min(1),
      // A stale upsert with a lower revision cannot resurrect this id.
      revision: z.number().int().nonnegative(),
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
  openRequestSchema: terminalPlainSubscribeListOpenRequestSchema,
  serverFrameSchema: terminalPlainSubscribeListServerFrameSchema,
  clientFrameSchema: terminalPlainSubscribeListClientFrameSchema,
});
