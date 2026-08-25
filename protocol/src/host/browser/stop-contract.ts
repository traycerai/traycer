import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";

/**
 * Ticket 12 - the one-click Stop on the passive borrowed-tile indicator.
 *
 * A unary RPC rather than a `browser.sessions` client frame on purpose: the
 * stream's subscriber only carries `{chatId, accessScope}`, which is not
 * always enough to reconstruct the `BrowserSessionOwnerRef`
 * (`{userId, epicId, chatId, agentRunId}`) `stopAgentActivity`'s composition
 * is keyed by, whereas every other owner-scoped host RPC (`agent.stop`
 * included) already resolves `userId` from the authenticated request context
 * and takes `epicId`/`agentRunId` as explicit params. Reusing that pattern
 * avoids inventing new owner-resolution logic on the stream.
 *
 * Stop is inherently owner-scoped, not tile-scoped: `stopAgentActivity`
 * terminates the owner's one cell-runner JavaScript execution. Host calls
 * already admitted by that cell are allowed to settle and are reflected as
 * `outcome_unknown`; new calls are refused once Stop begins.
 */
export const browserStopAgentActivityRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
  agentRunId: z.string().nullable(),
});
export type BrowserStopAgentActivityRequest = z.infer<
  typeof browserStopAgentActivityRequestSchema
>;

/**
 * Stop reports the one lifecycle it controls: the owner's active REPL cell.
 * `idle` means there was no cell, `stopped` means no browser host call had
 * crossed the seam, and `outcome_unknown` means a host call was already in
 * flight and may have changed the page before the cell was interrupted.
 */
export const browserStopAgentActivityResponseSchema = z.object({
  status: z.enum(["idle", "stopped", "outcome_unknown"]),
});
export type BrowserStopAgentActivityResponse = z.infer<
  typeof browserStopAgentActivityResponseSchema
>;

export const browserStopAgentActivityV10 = defineRpcContract({
  method: "browser.stopAgentActivity",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: browserStopAgentActivityRequestSchema,
  responseSchema: browserStopAgentActivityResponseSchema,
});
