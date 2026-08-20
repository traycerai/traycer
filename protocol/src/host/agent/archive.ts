/**
 * `agent.archive@1.0` - archive a GUI chat or TUI agent on the host that
 * owns it. Brand-new method on the optional-capability channel: an old host
 * simply lacks it (`degrade: unsupported`).
 *
 * The busy / self-archive rules live in the host resolver. This contract
 * only names the ids and the resulting archive marker.
 */
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { z } from "zod";

export const agentArchiveRequestSchema = z.object({
  epicId: z.string().min(1),
  agentId: z.string().min(1),
  /** Calling agent. Required so self-archive can waive the turn-busy arm. */
  senderAgentId: z.string().min(1),
});
export type AgentArchiveRequest = z.infer<typeof agentArchiveRequestSchema>;

export const agentArchiveResponseSchema = z.object({
  agentId: z.string().min(1),
  archived: z.literal(true),
  /** False when the marker was already set. */
  updated: z.boolean(),
});
export type AgentArchiveResponse = z.infer<typeof agentArchiveResponseSchema>;

export const agentArchiveV10 = defineRpcContract({
  method: "agent.archive",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentArchiveRequestSchema,
  responseSchema: agentArchiveResponseSchema,
});
