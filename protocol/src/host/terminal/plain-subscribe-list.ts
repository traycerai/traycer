/** Replacement-state collection stream for durable plain terminals. */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
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

export const terminalPlainSubscribeListV21 = defineStreamRpcContract({
  method: "terminal.plain.subscribeList",
  schemaVersion: { major: 2, minor: 1 } as const,
  openRequestSchema: terminalPlainSubscribeListOpenRequestSchema,
  serverFrameSchema: terminalPlainSubscribeListServerFrameSchema,
  clientFrameSchema: terminalPlainSubscribeListClientFrameSchema,
});
