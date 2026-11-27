/**
 * Per-host record of what a SUBSCRIBE on each stream method would negotiate -
 * the stream-version half of what `negotiated-manifest-registry.ts` does for
 * unary RPC, and the third of the three per-host stream/unary registries in
 * this directory.
 *
 * ## Why this exists beside two registries that nearly answer it
 *
 * - `negotiated-manifest-registry.ts` records the UNARY manifest an `openAck`
 *   advertises. It cannot answer a stream question: stream support is not a
 *   name lookup (`checkStreamMethodCompatibility` runs against the client's own
 *   served majors), and the unary manifest does not carry stream methods at
 *   all.
 * - `stream-method-support-registry.ts` records the computed SUPPORT verdict
 *   per host, which is the right shape - but only the verdict, and only from
 *   the local transport, because its consumer is a cold-start seed that must
 *   stay silent for the mux.
 *
 * What a version gate needs is the third thing: the `{ major, minor }` a
 * subscribe would settle on, for a named host, from either plane. Both stream
 * clients can already answer it for THEMSELVES
 * (`IStreamClient.getMethodSchemaVersion`), and that is the right call when you
 * hold the client. It is not reachable when the question is "what would this
 * host do", asked by a dispatch that holds a host id: a composer deciding
 * whether to send hash-only image nodes or inline base64 is answering that
 * question, not a question about a session it owns.
 *
 * ## What is recorded, and by whom
 *
 * BOTH transports publish, at the same handshake where they publish their
 * other capability evidence:
 *
 * - `WsStreamClient.applyHostManifest` (local), for every method in the
 *   manifest it selected - the same loop that records support.
 * - `RemoteSession.handleOpenAck` (mux), through the client-side recorder the
 *   client adapter installs, beside the unary `onNegotiatedMethods` hook.
 *
 * A recording REPLACES that host's map rather than merging into it. The map is
 * one handshake's answer about one host process, and a merge would let a method
 * a re-handshaked host no longer bridges keep a version from the incarnation
 * that did.
 *
 * ## Fail-closed, refreshed by traffic, and deliberately un-notified
 *
 * A host with no completed stream handshake reads `null`, which every consumer
 * must treat as "not known to meet the floor" - the gates built on this all
 * have a correct older-peer behaviour to fall back to, and taking it for one
 * extra dispatch is the cheap direction.
 *
 * Entries are refreshed by traffic and never evicted, exactly like their two
 * siblings: a host upgraded in place re-handshakes on its next subscribe and
 * overwrites its map.
 *
 * There are no listeners here, and that is a scope decision rather than an
 * omission. This is a DISPATCH-time read - "as I send, what does this host
 * negotiate" - and its consumers re-read it at the moment they send. A render
 * that wants to reflect a version change subscribes to the client it holds
 * (`subscribeMethodSupport`), which is where that fan-out already exists and is
 * already torn down correctly.
 */

import type { SchemaVersion } from "@traycer/protocol/framework/index";

const versionsByHostId = new Map<string, ReadonlyMap<string, SchemaVersion>>();

/**
 * Records, for `hostId`, the version a subscribe on each named method would
 * settle on. Methods absent from `versions` are methods this host cannot be
 * subscribed to at all (no shared major, or no bridgeable minor), and they are
 * absent rather than `null` so the two readings - "this host cannot serve it"
 * and "nothing is known about this host" - stay one value apart at the read.
 */
export function recordNegotiatedStreamMethodVersions(
  hostId: string,
  versions: ReadonlyMap<string, SchemaVersion>,
): void {
  versionsByHostId.set(hostId, new Map(versions));
}

/**
 * The version `hostId`'s last stream handshake settled for `method`, or `null`
 * when that host has not handshaken, or has and cannot serve the method.
 */
export function getNegotiatedStreamMethodVersion(
  hostId: string,
  method: string,
): SchemaVersion | null {
  return versionsByHostId.get(hostId)?.get(method) ?? null;
}

/** Test seam: drops every recorded map. */
export function resetNegotiatedStreamVersions(): void {
  versionsByHostId.clear();
}
