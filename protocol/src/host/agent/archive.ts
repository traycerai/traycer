/**
 * `agent.archive@1.0` - archive a GUI chat or TUI agent on the host that
 * owns it. Brand-new method on the optional-capability channel: an old host
 * simply lacks it (`degrade: unsupported`).
 *
 * `@1.1` adds `outcome`, as `epic.setChatArchived@1.1` does (#1628).
 *
 * The busy / self-archive rules live in the host resolver. This contract
 * only names the ids and the resulting archive marker.
 */
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  agentRecordWriteOutcomeSchema,
  agentRecordWriteOwnerHostIdSchema,
} from "@traycer/protocol/host/epic/unary-schemas";

export const agentArchiveRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    agentId: z.string().min(1),
    /** Calling agent. Required so self-archive can waive the turn-busy arm. */
    senderAgentId: z.string().min(1),
  }),
);
export type AgentArchiveRequest = z.infer<typeof agentArchiveRequestSchema>;

/**
 * Frozen response for released agent.archive@1.0 peers.
 *
 * Hand-pinned field-for-field rather than derived from the live schema via
 * `.omit()` - a field added to the live shape must not silently leak back into
 * this contract, which is the failure a freeze exists to prevent.
 */
export const agentArchiveResponseSchemaV10 = lazySchema(() =>
  z.object({
    agentId: z.string().min(1),
    archived: z.literal(true),
    /** False when the marker was already set. */
    updated: z.boolean(),
  }),
);

export const agentArchiveResponseSchema = lazySchema(() =>
  z.object({
    agentId: z.string().min(1),
    archived: z.literal(true),
    /**
     * False when the marker was already set. On `requested`, true: the
     * archive was accepted as a request.
     */
    updated: z.boolean(),
    // @1.1: see `agentRecordWriteOutcomeSchema`. The receiving host answers
    // `requested` when it holds the record but another host runs it, and
    // wrote the archive to the cloud row for that owner to finish.
    outcome: agentRecordWriteOutcomeSchema,
    ownerHostId: agentRecordWriteOwnerHostIdSchema,
  }),
);
export type AgentArchiveResponse = z.infer<typeof agentArchiveResponseSchema>;

export const agentArchiveV10 = defineRpcContract({
  method: "agent.archive",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentArchiveRequestSchema,
  responseSchema: agentArchiveResponseSchemaV10,
});

export const agentArchiveV11 = defineRpcContract({
  method: "agent.archive",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: agentArchiveRequestSchema,
  responseSchema: agentArchiveResponseSchema,
});

// A 1.0 peer only ever enacts the archive on its own record.
export const agentArchiveUpgradeV10ToV11 = defineUpgradePath<
  typeof agentArchiveV10,
  typeof agentArchiveV11
>({
  from: agentArchiveV10.schemaVersion,
  to: agentArchiveV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({ ...response, outcome: "applied" }),
});
