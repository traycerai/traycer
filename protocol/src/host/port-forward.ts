/**
 * Port forwards: a loopback port on one of the user's machines made reachable
 * as a loopback port on another, over `host.tunnel.open`.
 *
 * Two tables, on two hosts. The OWNED FORWARD lives on the agent's own host
 * and is the whole record. The HELD LEASE lives on the other machine and is
 * either a bound loopback listener (`listen`) or permission for one owner to
 * reach one named port (`target`). Without the second form an owner could
 * reach any loopback port on the other machine just by asking.
 *
 * Host-to-host verbs (`host.portForward.*`) are for the host-agent principal
 * and carry `epicId` at the top level, because both the editor-role gate and
 * the communication-graph capture read it there. App-facing verbs
 * (`portForward.*`) are for the user principal.
 *
 * The OWNER mints `leaseId`, before the acquire leaves. That is what lets it
 * record the release it may come to owe while the call is still in flight: an
 * id that only existed in the answer could not be released when the answer
 * was lost. `ownerIncarnation` names the owning host PROCESS, so the lease
 * host can tell a straggler from a dead process apart from the live one, and
 * retire everything an older incarnation held when a newer one appears.
 *
 * Every method here is brand-new and unknown to every host shipped before it,
 * so each degrades as `unsupported`.
 */
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { z } from "zod";

/** Ports below this need privileges the host does not have, and are refused at both ends. */
export const PORT_FORWARD_MIN_PORT = 1024;
export const PORT_FORWARD_MAX_PORT = 65_535;

/** How many recent events an owned forward keeps; older ones fall off the front. */
export const PORT_FORWARD_RECENT_EVENT_LIMIT = 20;

export const portForwardPortSchema = z
  .number()
  .int()
  .min(PORT_FORWARD_MIN_PORT)
  .max(PORT_FORWARD_MAX_PORT);

export const portForwardStateSchema = z.enum([
  "binding",
  "active",
  "interrupted",
  "stopped",
]);
export type PortForwardState = z.infer<typeof portForwardStateSchema>;

export const portForwardEventKindSchema = z.enum([
  "port-taken",
  "target-refused",
  "lease-reaped",
  "link-dropped",
  "cut-by-user",
]);
export type PortForwardEventKind = z.infer<typeof portForwardEventKindSchema>;

export const portForwardEventSchema = z.object({
  atMs: z.number(),
  kind: portForwardEventKindSchema,
  detail: z.string().nullable(),
});
export type PortForwardEvent = z.infer<typeof portForwardEventSchema>;

export const portForwardCountersSchema = z.object({
  openConnections: z.number().int().nonnegative(),
  totalConnections: z.number().int().nonnegative(),
  bytesIn: z.number().nonnegative(),
  bytesOut: z.number().nonnegative(),
});
export type PortForwardCounters = z.infer<typeof portForwardCountersSchema>;

/** The owned forward, as the owning host reports it. */
export const ownedPortForwardSchema = z.object({
  forwardId: z.string().min(1),
  epicId: z.string().min(1),
  ownerAgentId: z.string().min(1),
  description: z.string(),
  target: z.object({ hostId: z.string().min(1), port: portForwardPortSchema }),
  listen: z.object({
    hostId: z.string().min(1),
    requestedPort: portForwardPortSchema,
    boundPort: portForwardPortSchema.nullable(),
  }),
  state: portForwardStateSchema,
  /** Why it is `interrupted` or `stopped`; null otherwise. */
  stateReason: z.string().nullable(),
  createdAtMs: z.number(),
  counters: portForwardCountersSchema,
  recentEvents: z.array(portForwardEventSchema),
});
export type OwnedPortForward = z.infer<typeof ownedPortForwardSchema>;

/**
 * Which half of the forward the lease host holds: the loopback LISTENER, or
 * permission to reach one named TARGET port.
 */
export const portForwardLeaseRoleSchema = z.enum(["listen", "target"]);
export type PortForwardLeaseRole = z.infer<typeof portForwardLeaseRoleSchema>;

/** A held lease, as the machine holding it reports it. */
export const heldPortForwardLeaseSchema = z.object({
  leaseId: z.string().min(1),
  forwardId: z.string().min(1),
  epicId: z.string().min(1),
  ownerHostId: z.string().min(1),
  role: portForwardLeaseRoleSchema,
  /** The bound listener's port for `listen`; the reachable port for `target`. */
  port: portForwardPortSchema,
  description: z.string(),
  createdAtMs: z.number(),
  openConnections: z.number().int().nonnegative(),
});
export type HeldPortForwardLease = z.infer<typeof heldPortForwardLeaseSchema>;

// ─── host-to-host ───────────────────────────────────────────────────────────

export const hostPortForwardAcquireLeaseRequestSchema = z.object({
  epicId: z.string().min(1),
  leaseId: z.string().min(1),
  forwardId: z.string().min(1),
  ownerIncarnation: z.string().min(1),
  role: portForwardLeaseRoleSchema,
  /** The port to listen on (same port first) for `listen`; the port to reach for `target`. */
  port: portForwardPortSchema,
  description: z.string(),
});
export type HostPortForwardAcquireLeaseRequest = z.infer<
  typeof hostPortForwardAcquireLeaseRequestSchema
>;

export const portForwardLeaseRefusalReasonSchema = z.enum([
  /** The port is one of the lease host's own control ports. */
  "control-port",
  /** Neither the requested port nor any other could be bound. */
  "no-free-port",
  /** The lease host is shutting down. */
  "closing",
  /** This lease id was already released; a release overtook its acquire. */
  "released",
  /** The owner incarnation has been superseded by a newer one from that host. */
  "superseded",
]);
export type PortForwardLeaseRefusalReason = z.infer<
  typeof portForwardLeaseRefusalReasonSchema
>;

export const hostPortForwardAcquireLeaseResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      outcome: z.literal("held"),
      /** The port actually bound or admitted. */
      port: portForwardPortSchema,
      /** False when the requested listen port was taken and another was bound. */
      keptRequestedPort: z.boolean(),
    }),
    z.object({
      outcome: z.literal("refused"),
      reason: portForwardLeaseRefusalReasonSchema,
    }),
  ],
);
export type HostPortForwardAcquireLeaseResponse = z.infer<
  typeof hostPortForwardAcquireLeaseResponseSchema
>;

export const hostPortForwardAcquireLeaseV10 = defineRpcContract({
  method: "host.portForward.acquireLease",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostPortForwardAcquireLeaseRequestSchema,
  responseSchema: hostPortForwardAcquireLeaseResponseSchema,
});

export const hostPortForwardReleaseLeaseRequestSchema = z.object({
  epicId: z.string().min(1),
  leaseId: z.string().min(1),
  ownerIncarnation: z.string().min(1),
});
export type HostPortForwardReleaseLeaseRequest = z.infer<
  typeof hostPortForwardReleaseLeaseRequestSchema
>;

/**
 * Always success, an unknown lease included: the owner retries a release
 * against a machine that may have restarted, and "already gone" is the answer
 * it wants.
 */
export const hostPortForwardReleaseLeaseResponseSchema = z.object({
  released: z.literal(true),
});

export const hostPortForwardReleaseLeaseV10 = defineRpcContract({
  method: "host.portForward.releaseLease",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostPortForwardReleaseLeaseRequestSchema,
  responseSchema: hostPortForwardReleaseLeaseResponseSchema,
});

/**
 * Why a lease ended on the machine holding it, when the owner could not
 * otherwise learn. Per-connection trouble (a refused target, a dropped link)
 * is NOT here: it rides the reset of the tunnel it happened on. A lease that
 * ended has no tunnel and never will, so it dials back instead.
 */
export const portForwardLeaseEndCauseSchema = z.enum([
  "cut-by-user",
  "listener-failed",
]);
export type PortForwardLeaseEndCause = z.infer<
  typeof portForwardLeaseEndCauseSchema
>;

export const hostPortForwardLeaseEndedRequestSchema = z.object({
  epicId: z.string().min(1),
  leaseId: z.string().min(1),
  cause: portForwardLeaseEndCauseSchema,
});
export type HostPortForwardLeaseEndedRequest = z.infer<
  typeof hostPortForwardLeaseEndedRequestSchema
>;

/** Always success: a forward the owner no longer has is one it need not be told about. */
export const hostPortForwardLeaseEndedResponseSchema = z.object({
  acknowledged: z.literal(true),
});

export const hostPortForwardLeaseEndedV10 = defineRpcContract({
  method: "host.portForward.leaseEnded",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostPortForwardLeaseEndedRequestSchema,
  responseSchema: hostPortForwardLeaseEndedResponseSchema,
});

// ─── app-facing ─────────────────────────────────────────────────────────────

export const portForwardListForHostRequestSchema = z.object({});

/** The host's two tables, shown as they are. */
export const portForwardListForHostResponseSchema = z.object({
  owned: z.array(ownedPortForwardSchema),
  held: z.array(heldPortForwardLeaseSchema),
});
export type PortForwardListForHostResponse = z.infer<
  typeof portForwardListForHostResponseSchema
>;

export const portForwardListForHostV10 = defineRpcContract({
  method: "portForward.listForHost",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: portForwardListForHostRequestSchema,
  responseSchema: portForwardListForHostResponseSchema,
});

export const portForwardStopRequestSchema = z.object({
  forwardId: z.string().min(1),
});

/** Idempotent; `stopped` is false when there was no such forward. */
export const portForwardStopResponseSchema = z.object({
  stopped: z.boolean(),
});

export const portForwardStopV10 = defineRpcContract({
  method: "portForward.stop",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: portForwardStopRequestSchema,
  responseSchema: portForwardStopResponseSchema,
});

export const portForwardCutLeaseRequestSchema = z.object({
  leaseId: z.string().min(1),
});

/** Idempotent; `cut` is false when there was no such lease. */
export const portForwardCutLeaseResponseSchema = z.object({
  cut: z.boolean(),
});

export const portForwardCutLeaseV10 = defineRpcContract({
  method: "portForward.cutLease",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: portForwardCutLeaseRequestSchema,
  responseSchema: portForwardCutLeaseResponseSchema,
});

/**
 * FATAL `code` a lease host puts on a tunnel it could not connect to the
 * target port. A per-connection event, so it rides the tunnel's own reset.
 */
export const TUNNEL_TARGET_REFUSED_CODE = "TUNNEL_TARGET_REFUSED";

/**
 * FATAL `code` on a tunnel refused because the dialing principal may not edit
 * the lease's task RIGHT NOW. Deliberately not `TUNNEL_NOT_AUTHORIZED`: that
 * one says "no such lease here", which the other side acts on by forgetting
 * the lease. A role refusal says nothing about the lease - it is still held,
 * and still owed a release - so it must never read as that.
 */
export const TUNNEL_NO_EDIT_ACCESS_CODE = "TUNNEL_NO_EDIT_ACCESS";

/**
 * FATAL `code` on a tunnel that reached an owner whose forward is still being
 * CREATED: the lease host bound its listener and accepted a connection before
 * its acquire answer got back. Refused, because a forward that is not `active`
 * carries no connection - but, like a role refusal, it says nothing about the
 * lease, so it must not read as `TUNNEL_NOT_AUTHORIZED` and cost the listener.
 */
export const TUNNEL_LEASE_NOT_READY_CODE = "TUNNEL_LEASE_NOT_READY";
