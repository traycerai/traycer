/**
 * `host.remote.capabilities.subscribe@1.0` - versioned streaming-RPC contract
 * for REMOTE HOST CAPABILITY DISCOVERY. A client opens a subscription against
 * the host it is connected to and asks what capabilities a REMOTE host - a
 * different Traycer host the user is signed into, a peer in a multi-host epic,
 * a session target resolved through the attach-grant seam - declares for
 * itself, BEFORE (or while) taking cross-host actions such as opening a remote
 * session or attempting a cross-host method call.
 *
 * Shape follows the snapshot-first stream pattern established by
 * `epic.communicationGraph.subscribe`: the client opens with `{ hostId }`
 * naming the remote host it is asking about, and the serving host emits
 * EXACTLY ONE `snapshot` frame carrying that host's FULL capability set, then
 * `update` frames whenever a capability changes while the subscription is
 * open. Changes are RARE - a host build's capability set is stable for the
 * lifetime of that build - which is what makes this a cheap long-lived
 * subscription rather than a poll.
 *
 * WHY A STREAM RATHER THAN A UNARY READ: the consumer's question ("what can
 * this remote host do?") has a lifetime, not a moment - the client keeps the
 * capability view open for as long as it is reasoning about the remote host,
 * and an `update` frame is the only way it learns that a session target
 * changed (host upgraded, feature toggled, persistence mode switched) without
 * polling or re-reading on every cross-host action. A unary read would turn
 * every such action into either a stale assumption or a fresh round trip.
 *
 * WHAT THE FRAMES MEAN:
 *
 *   - `snapshot` is AUTHORITATIVE and REPLACE-WHOLE. Exactly one arrives
 *     first, and the client REPLACES any capability it holds for that host
 *     with the frame's payload - never merges, never reconciles field-wise.
 *     It is also how a reconnect re-syncs: because the capability set is
 *     small and change is rare, resume is a fresh snapshot, not a delta.
 *   - `update` carries the FULL capability object, NOT a delta or a field
 *     patch. The client applies it by REPLACING its stored copy for the
 *     subscription's `hostId` wholesale. A partial-update design would
 *     reintroduce ordering bugs (two fields changing in two frames applied
 *     out of order) for zero bandwidth gain on a payload this small, so the
 *     wire never asks a consumer to patch.
 *   - The capability's `hostId` MUST equal the open request's `hostId`. A
 *     frame that carries a different id is a serving-host bug; a consumer
 *     should treat it as a protocol error (log, drop the frame) rather than
 *     start a second implicit subscription.
 *   - Text frames only. Every frame - server and client - carries
 *     `hasBinaryPayload: false`; there is no binary side channel in this
 *     contract.
 *
 * WHAT A CAPABILITY IS - a POINT-IN-TIME DECLARATION, not a promise:
 * `supportedStreamMethods` / `supportedUnaryMethods` list the remote host's
 * advertised method surface (its `/stream` and `/rpc` manifests, in the
 * manifest's own `method@major.minor` spelling), `persistenceType` names its
 * durable store, `harnesses` the harnesses it can run agents on, and
 * `features` its feature flags (e.g. `durable-inbox`, `policy-eval`). The
 * client uses this to PRE-FLIGHT cross-host actions - "does the target
 * support the method I am about to call / the harness I want / the
 * persistence I need" - and to degrade gracefully when it does not. It does
 * not replace the per-method stream compat check: `supportedStreamMethods`
 * answers "does the remote host ADVERTISE this method at all", and the
 * actual subscribe still negotiates the minor pair.
 *
 * COMPAT POSTURE - additive, post-v1.0.0 OPTIONAL stream method. A host that
 * predates this method simply does not advertise it in its `/stream`
 * manifest, and stream compatibility is checked PER METHOD at subscribe time
 * (`checkStreamMethodCompatibility`), so the client's subscription resolves
 * to `onMethodSupport(method, "unsupported")` and the cross-host surface
 * degrades to "capabilities unknown" - the client falls back to attempting
 * the cross-host action without a pre-flight, exactly as it did before this
 * method existed. This is the `resources.subscribe` / 
 * `epic.communicationGraph.subscribe` precedent, and it is why the method
 * must never be added to the unary released floor (`released-floor.ts`),
 * which is fail-closed on the name set.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

/**
 * What a remote host declares about itself. Deliberately FLAT and
 * point-in-time: each field is the remote host's own self-report, relayed
 * without interpretation by the host serving this subscription. The lists are
 * open `string` arrays (NOT closed enums) for the same reason the
 * communication-graph log fields are open strings - a value invented by a
 * NEWER remote host after this contract froze must still parse and render,
 * and the consumer's contract for an unknown entry is "show the raw string /
 * treat as not-supported", never "the frame is unreadable".
 */
export const remoteCapabilitySchema = z.object({
  /** The remote host this capability describes; must equal the open
   * request's `hostId`. */
  hostId: z.string().min(1),
  /** Host version string, e.g. `1.4.2`. Display/provenance metadata only. */
  version: z.string(),
  /**
   * The remote host's advertised `/stream` method surface, in the manifest's
   * `method@major.minor` spelling, e.g. `"epic.communicationGraph.subscribe@1.0@1"`.
   * A client pre-flights a cross-host subscription against this list; the
   * actual subscribe still negotiates the minor pair.
   */
  supportedStreamMethods: z.array(z.string()),
  /** The remote host's advertised `/rpc` method surface, in
   * `method@major.minor` spelling. */
  supportedUnaryMethods: z.array(z.string()),
  /** What the remote host persists to: `sqlite` (local durable store),
   * `memory` (RAM-only), or `cloud` (cloud-tier backing). */
  persistenceType: z.enum(["sqlite", "memory", "cloud"]),
  /** Harness ids the remote host can run agents on, e.g. `claude`, `codex`. */
  harnesses: z.array(z.string()),
  /** Feature flags the remote host advertises, e.g. `durable-inbox`,
   * `policy-eval`. */
  features: z.array(z.string()),
});
export type RemoteCapability = z.infer<typeof remoteCapabilitySchema>;

/**
 * Stream open request: WHICH remote host to query. One subscription covers
 * exactly one remote host - there is no "give me everything" variant, because
 * a capability view is something a client holds per target it is reasoning
 * about, and multiplexing several hosts onto one stream would force every
 * consumer to filter frames that belong to someone else.
 */
export const remoteCapabilitiesSubscribeOpenRequestSchema = z.object({
  /** The remote host to report capabilities for. Required - the serving
   * host refuses a subscription that does not name its target. */
  hostId: z.string().min(1),
});
export type RemoteCapabilitiesSubscribeOpenRequest = z.infer<
  typeof remoteCapabilitiesSubscribeOpenRequestSchema
>;

export const remoteCapabilitiesSubscribeServerFrameSchema =
  z.discriminatedUnion("kind", [
    /**
     * Exactly one per subscription, emitted first: the remote host's FULL
     * capability set at open time. Authoritative and REPLACE-WHOLE - the
     * client replaces any capability it holds for this host with this
     * payload, and treats the frame as the baseline every later `update`
     * builds on. Also the reconnect re-sync: on a new open the host re-sends
     * a fresh snapshot, never a delta.
     */
    z.object({
      kind: z.literal("snapshot"),
      capability: remoteCapabilitySchema,
      ...textFrameFields,
    }),
    /**
     * A capability changed while the subscription was open (host upgraded,
     * feature toggled, persistence switched) - RARE. Carries the FULL
     * capability object, never a field patch: the client REPLACES its
     * stored copy for the subscription's `hostId` wholesale. The capability's
     * `hostId` must equal the open request's `hostId`; a mismatch is a
     * serving-host bug and the consumer should treat the frame as a protocol
     * error, not start a second subscription.
     */
    z.object({
      kind: z.literal("update"),
      capability: remoteCapabilitySchema,
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type RemoteCapabilitiesSubscribeServerFrame = z.infer<
  typeof remoteCapabilitiesSubscribeServerFrameSchema
>;

export const remoteCapabilitiesSubscribeClientFrameSchema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ]);
export type RemoteCapabilitiesSubscribeClientFrame = z.infer<
  typeof remoteCapabilitiesSubscribeClientFrameSchema
>;

/**
 * `host.remote.capabilities.subscribe@1.0` - see the module doc. Snapshot-
 * first, text-frames-only, one remote host per subscription.
 */
export const hostRemoteCapabilitiesSubscribeV10 = defineStreamRpcContract({
  method: "host.remote.capabilities.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: remoteCapabilitiesSubscribeOpenRequestSchema,
  serverFrameSchema: remoteCapabilitiesSubscribeServerFrameSchema,
  clientFrameSchema: remoteCapabilitiesSubscribeClientFrameSchema,
});
