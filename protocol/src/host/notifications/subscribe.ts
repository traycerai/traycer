/**
 * `notifications.subscribe@1.0` / `@1.1` - versioned streaming-RPC contract for
 * the per-user notifications Y.Doc subscription.
 *
 * `userId` is inferred from the host authentication context, so the open
 * request carries no parameters.
 *
 * Server frames:
 *
 * - `snapshot`  - initial state for the user's notifications doc. Text
 *                 envelope carries just the notifications-doc schema version
 *                 as a semver string; the Y.Doc snapshot rides the paired
 *                 binary payload.
 * - `update`    - an incremental Y.Doc update. Binary-only payload.
 * - `pong`      - heartbeat response to a client `ping`. Text-only.
 * - `awareness` - (`@1.1`) awareness update for the per-user notification
 *                 room, carrying agent-activity presence. Binary-only payload
 *                 (a y-protocols awareness encoding). Server-only: the GUI
 *                 reads activity and never publishes it, so there is no
 *                 matching client frame.
 *
 * Client frames:
 *
 * - `applyUpdate` - an incremental Y.Doc update pushed by the client.
 *                   Binary payload.
 * - `ping`        - heartbeat. Text-only.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

/**
 * Awareness state field under which each host publishes its agent-activity
 * presence for the per-user notification room (`notifications:<userId>`),
 * grouped by epic:
 *
 * ```ts
 * { [epicId: string]: { working: string[]; turn: string[] } }
 * ```
 *
 * `working` is every agent id at the `hasActivity` level; `turn` is the subset
 * whose work is an actual agent **turn** (running or activating), as opposed to
 * background-only work (`run_in_background` / a subagent / Monitor / a
 * scheduled wakeup) that keeps a session non-idle while the agent itself is not
 * executing. The cloud merges one awareness entry per host, so the cross-host
 * union is free: a client sees working agents regardless of which host runs
 * them, and a host that dies or disconnects ages out of awareness, clearing its
 * own spinners with no cleanup protocol.
 *
 * Awareness rides an opaque binary payload (the `awareness` frame is
 * `hasBinaryPayload: true`), so this value is NOT schema-validated and is NOT
 * covered by the stream contract's `major`/`minor` negotiation - a reader
 * cannot learn from the handshake whether its peer publishes it. Four rules
 * follow, and all of them are load-bearing:
 *
 * 1. The shape above is FROZEN. Never reshape it; extend only by adding new
 *    awareness fields beside it. Readers shape-check what they find and drop
 *    what they do not recognise, so repurposing this field makes agents
 *    silently vanish from the working set on older clients.
 * 2. Absence is per-HOST, and must be read that way. Cloud-merged awareness
 *    carries one entry per host, so a single client can see an old host (field
 *    absent) and a new host (field present) simultaneously - indefinitely, not
 *    just during a rollout. An epicId absent from every entry's map is idle.
 * 3. Shape-check PER ENTRY and per epic bucket (`Array.isArray` on `working`
 *    and `turn`), and skip the offending entry or bucket rather than the whole
 *    read. One malformed publisher must not blank out every other host.
 * 4. Ids in `working` but not in `turn` are genuinely background-only. A host
 *    whose entry carries no usable tier information (`turn` absent or
 *    malformed) has an UNKNOWN tier: degrade its working ids to turns, the
 *    conservative pre-existing behaviour. A publisher therefore only needs to
 *    list ids it can positively classify; agents with no turn/background
 *    distinction (terminal agents, CLI/TUI runs) simply stay in the turn set.
 *
 * Published by the host's per-user notification-room activity pin, filtered to
 * the room's userId (rooms are per-user; publishing another user's agents would
 * leak spinners across users on a shared host). Read by the gui-app's
 * cross-epic activity surfaces. Shared here so writer and reader cannot drift.
 */
export const AGENT_ACTIVITY_AWARENESS_FIELD = "agentActivityByEpic";

/**
 * Awareness state field under which each host stamps its own `hostId` on the
 * {@link AGENT_ACTIVITY_AWARENESS_FIELD} entry it publishes. Diagnostics, plus
 * it lets a client tell its own host's entry apart from remote ones.
 *
 * Same frozen-shape and per-host-absence rules as
 * {@link AGENT_ACTIVITY_AWARENESS_FIELD}: a plain string, outside
 * `major`/`minor` negotiation, and OPTIONAL by design - an entry missing this
 * field is still a valid activity entry and its epic buckets must still be
 * read. Never treat it as a key or a filter.
 */
export const AGENT_ACTIVITY_HOST_ID_AWARENESS_FIELD = "agentActivityHostId";

/**
 * Awareness state field under which each host publishes its own RUNTIME status
 * — the drain-relevant facts about what it is doing right now:
 *
 * ```ts
 * {
 *   busy: boolean;
 *   busySessionCount: number;
 *   updateProgress: { state: "updating" | "failed"; error: string | null } | null;
 * }
 * ```
 *
 * These three used to ride the cloud `GET /api/v3/hosts` DTO, on a lease the
 * host refreshed every 20 seconds. That lease is gone, and its replacement is
 * refreshed on the order of MINUTES — far too coarse for a session count that
 * gates a destructive "Apply now — ends N sessions" button. So they moved to
 * the two channels that are actually live: `host.status@1.1` for a client
 * holding a session to the host, and this field for a client that holds the
 * room but no session (the cross-host case — the My-Hosts-style surfaces).
 *
 * ADDITIVE, and additive is the whole point: awareness entries are per-host and
 * unnegotiated, so a host that does not publish this is not an error state, it
 * is the normal steady state for part of a fleet. Every rule on
 * {@link AGENT_ACTIVITY_AWARENESS_FIELD} applies here verbatim — frozen shape,
 * per-HOST absence, shape-check per entry, skip the offending entry rather than
 * the whole read.
 *
 * One rule is specific to this field, and it is the load-bearing one:
 * **absence is not zero.** A missing entry means "this host is not telling us",
 * and the only correct rendering is no drain information at all. Defaulting it
 * to `busySessionCount: 0` would state, in the UI, that ending the update now
 * costs nothing — about a host that never said so.
 */
export const HOST_RUNTIME_STATUS_AWARENESS_FIELD = "hostRuntimeStatus";

/**
 * Shape-check for one {@link HOST_RUNTIME_STATUS_AWARENESS_FIELD} value.
 *
 * Shared so the publishing host and the reading client cannot drift on a field
 * the stream contract's `major`/`minor` negotiation does not cover. Mirrors
 * `host.status@1.1`'s `updateProgress` arm exactly — the same fact reaching a
 * client by a second route must not arrive in a second shape.
 *
 * Deliberately NOT `.strict()`, unlike the `GET /api/v3/hosts` DTO. There,
 * strictness makes a server-side addition fail loudly, because both ends of a
 * negotiated HTTP contract ship together. Here they do not: awareness entries
 * from old and new hosts coexist in one room indefinitely, so an unrecognised
 * key must be dropped and the rest of the entry still read — a strict parse
 * would blank out a newer host's busy count on every older client.
 */
export const hostRuntimeStatusAwarenessSchema = z.object({
  busy: z.boolean(),
  busySessionCount: z.number().int().nonnegative(),
  updateProgress: z
    .object({
      state: z.enum(["updating", "failed"]),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type HostRuntimeStatusAwareness = z.infer<
  typeof hostRuntimeStatusAwarenessSchema
>;

const hostRuntimeStatusAwarenessEntrySchema = z.object({
  [HOST_RUNTIME_STATUS_AWARENESS_FIELD]: hostRuntimeStatusAwarenessSchema,
});

/**
 * Reads one awareness entry's runtime status, or `null` when the entry does not
 * carry a usable one.
 *
 * A helper rather than an inline `safeParse` at each call site because the NULL
 * RETURN is the contract: "field absent" and "field malformed" are the same
 * answer to a reader — no live source — and both must stay distinguishable from
 * a host that positively reported zero busy sessions. A caller that treats the
 * null as a falsy count reintroduces exactly the claim this field refuses to
 * make.
 */
export function readHostRuntimeStatusAwareness(
  entry: unknown,
): HostRuntimeStatusAwareness | null {
  const parsed = hostRuntimeStatusAwarenessEntrySchema.safeParse(entry);
  return parsed.success
    ? parsed.data[HOST_RUNTIME_STATUS_AWARENESS_FIELD]
    : null;
}

export const notificationsSubscribeOpenRequestSchema = z.object({});
export type NotificationsSubscribeOpenRequest = z.infer<
  typeof notificationsSubscribeOpenRequestSchema
>;

const notificationsSnapshotMetaSchema = z.object({
  schemaVersion: z.string(),
});

// ─── Frozen notifications.subscribe@1.0 shape (as shipped) ────────────────
//
// IMMUTABLE. A client that negotiated @1.0 agreed to exactly these three frame
// kinds, so this union must never learn a new one - sending a peer a frame it
// did not negotiate is the host breaking the contract, not a "graceful"
// degrade the peer happens to drop.
export const notificationsSubscribeServerFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      meta: notificationsSnapshotMetaSchema,
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("update"),
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type NotificationsSubscribeServerFrameV10 = z.infer<
  typeof notificationsSubscribeServerFrameSchemaV10
>;

// ─── notifications.subscribe@1.1 - additive: room awareness ───────────────
//
// Adds the `awareness` frame: a y-protocols awareness update for the per-user
// notification room, carrying each host's agent-activity presence (see
// `AGENT_ACTIVITY_AWARENESS_FIELD`). Binary-only, like the room's `update`
// frame - the payload is opaque to this contract and is NOT covered by
// `major`/`minor` negotiation, which is why the awareness FIELD shapes are
// frozen at their constants above.
//
// Server-only: the GUI reads activity and never publishes it, so the client
// frame union is unchanged and shared by both minors.
//
// Eligibility MUST be gated on the NEGOTIATED minor by the emitting resolver:
// a @1.0 client must never be sent this frame. Nothing in this contract
// enforces that at runtime (streams have no bridges), so the gate is a
// resolver obligation.
export const notificationsSubscribeServerFrameSchemaV11 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      meta: notificationsSnapshotMetaSchema,
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("update"),
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("awareness"),
      hasBinaryPayload: z.literal(true),
    }),
  ],
);
export type NotificationsSubscribeServerFrameV11 = z.infer<
  typeof notificationsSubscribeServerFrameSchemaV11
>;

/** The latest installed shape. Host code builds frames against this. */
export const notificationsSubscribeServerFrameSchema =
  notificationsSubscribeServerFrameSchemaV11;
export type NotificationsSubscribeServerFrame =
  NotificationsSubscribeServerFrameV11;

export const notificationsSubscribeClientFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("applyUpdate"),
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type NotificationsSubscribeClientFrame = z.infer<
  typeof notificationsSubscribeClientFrameSchema
>;

export const notificationsSubscribeV10 = defineStreamRpcContract({
  method: "notifications.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: notificationsSubscribeOpenRequestSchema,
  serverFrameSchema: notificationsSubscribeServerFrameSchemaV10,
  clientFrameSchema: notificationsSubscribeClientFrameSchema,
});

export const notificationsSubscribeV11 = defineStreamRpcContract({
  method: "notifications.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: notificationsSubscribeOpenRequestSchema,
  serverFrameSchema: notificationsSubscribeServerFrameSchemaV11,
  clientFrameSchema: notificationsSubscribeClientFrameSchema,
});
