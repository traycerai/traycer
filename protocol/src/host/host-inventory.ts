import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { hostListItemSchema } from "@traycer/protocol/host/host-status";

const textFrameFields = {
  hasBinaryPayload: lazySchema(() => z.literal(false)),
} as const;

/**
 * The signed-in account's host registry, pushed by the client's own host.
 *
 * ## Why a host serves rows it does not own
 *
 * `GET /api/v3/hosts` is one endpoint that three parties read: the app, for
 * its host list; the host's origin-host-gone signal, for the verdict that
 * another machine is not coming back; and the host's agent-facing directory
 * reads. Each used to fetch it separately - the app once a minute per window,
 * the host twice over - so an account with two windows open and a routed
 * browser realm made four reads a minute of one Redis lease.
 *
 * The host is the natural single reader: it is one process per machine however
 * many windows the app has, it already holds a device-bound credential for the
 * endpoint, and it already needs the answer for itself. This stream is that
 * reader's output.
 *
 * ## The rows are the cloud's own, not a projection
 *
 * A frame carries {@link hostListItemSchema} rows - exactly what
 * `GET /api/v3/hosts` returns and what the client already projects through
 * `hostListItemToDirectoryEntry`. Deliberately NOT the client's projected
 * `HostDirectoryEntry`: three of that shape's fields are the CLIENT's to
 * decide, not the host's - whether the account's plan allows remote hosts,
 * where the relay attach endpoint is, and how the client's own clock reads a
 * `lastSeenAt` - and a host answering those would be inventing them. The host
 * ships the evidence; the viewer keeps the derivation it already owns.
 *
 * ## Optional, and a fallback that is the status quo
 *
 * Additive, post-v1.0.0 OPTIONAL stream method. A host that predates it never
 * advertises it, the client's subscription degrades to `unsupported`, and the
 * app's own `GET /api/v3/hosts` poll remains exactly what it is today - so an
 * older host costs latency and a redundant read, never a missing fleet. Never
 * add it to the unary released floor; that list is fail-closed on the name set.
 *
 * ## One frame kind, carrying the whole inventory
 *
 * `snapshot` is the only server frame: there is no delta grammar and no resume
 * cursor, because the inventory is small, whole, and re-read on a cadence
 * rather than mutated. A reconnect re-reads it, which is the same thing a
 * first connect does. The host sends one on subscribe and again whenever the
 * rows change, and suppresses the re-send when a read returns what the client
 * already has - otherwise a push plane would tick once a minute per client
 * with a poll's shape and none of a poll's honesty about it.
 *
 * A `pong` rides the same union, because the transport's heartbeat IS a stream
 * frame - see that member.
 *
 * `fetchedAtMs` is the host's own clock at the read that produced these rows,
 * for a viewer that wants to say how old the answer is. `stale` says the most
 * recent read did NOT produce these rows - it failed, or its body did not
 * parse - and the last good rows are being served instead. A failed read never
 * turns into an empty fleet: it says nothing about any host, and reporting it
 * as "no hosts" would show every machine as departed, so a host with no good
 * rows to serve sends no snapshot at all. The rows of a stale snapshot are
 * therefore the last GOOD rows, and those may legitimately be empty - an
 * account with no other host whose next read fails is exactly that frame -
 * which is why the schema does not demand a non-empty `hosts` on `stale`.
 */
export const hostInventorySubscribeOpenRequestSchemaV10 = lazySchema(() =>
  z.object({}),
);
export type HostInventorySubscribeOpenRequestV10 = z.infer<
  typeof hostInventorySubscribeOpenRequestSchemaV10
>;

export const hostInventorySubscribeServerFrameSchemaV10 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      hosts: z.array(hostListItemSchema),
      /** The host's clock at the read these rows came from. */
      fetchedAtMs: z.number().int().nonnegative(),
      /** These are the last good rows; the most recent read did not refresh them. */
      stale: z.boolean(),
    }),
    /**
     * The heartbeat's answer, and NOT optional decoration: the transport's
     * liveness check is a stream frame, not a socket ping. `WsStreamSession`
     * writes a `ping` CLIENT frame every `pingIntervalMs` and advances
     * `lastPongAt` only on this frame; `pongTimeoutMs` is the drop cutoff
     * measured from that timestamp. A stream contract without this kind is a
     * stream every subscriber tears down and re-dials at the cutoff, forever,
     * while the host sits there healthy - which is why every stream contract
     * in this registry carries it.
     */
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]),
);
export type HostInventorySubscribeServerFrameV10 = z.infer<
  typeof hostInventorySubscribeServerFrameSchemaV10
>;

export const hostInventorySubscribeClientFrameSchemaV10 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ]),
);
export type HostInventorySubscribeClientFrameV10 = z.infer<
  typeof hostInventorySubscribeClientFrameSchemaV10
>;

export const hostInventorySubscribeV10 = defineStreamRpcContract({
  method: "host.hostInventory.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: hostInventorySubscribeOpenRequestSchemaV10,
  serverFrameSchema: hostInventorySubscribeServerFrameSchemaV10,
  clientFrameSchema: hostInventorySubscribeClientFrameSchemaV10,
});
