import type { SchemaVersion } from "@traycer/protocol/framework/index";
import { getNegotiatedStreamMethodVersion } from "@traycer-clients/shared/host-transport/negotiated-stream-version-registry";

/**
 * What a subscribe on `method` would negotiate with `hostId`, or `null` when
 * nothing is known - no stream handshake with that host has completed, or one
 * has and the pairing cannot bridge the method at all.
 *
 * The stream counterpart of `readNegotiatedMethodVersion`, and deliberately
 * NARROWER than it: the unary reader separates "not known" from "the host does
 * not have it" (`null` vs `false`), because its consumers hide an affordance on
 * a proven absence. A stream-version consumer has no such branch - both answers
 * mean "do not send the newer shape" - so the third state would be a
 * distinction nobody could act on.
 *
 * THREE READERS, ONE FACT, and which to use is decided by what you hold. In
 * descending order of authority:
 *
 * 1. `IStreamSession.getNegotiatedSchemaVersion()` - what THIS session put on
 *    the wire. The default for a gate gating a SEND on that session; see
 *    `ChatStreamClient.sameTurnSteeringProtocolSupported`, whose own note
 *    explains the failure the weaker readers allow (a sibling tab's
 *    negotiation answering for this tab's host, because every open chat tab is
 *    its own `chat.subscribe` session).
 * 2. `IStreamClient.getMethodSchemaVersion(method)` - what this client's live
 *    session negotiated, or what its handshake predicts for a method it has no
 *    session for.
 * 3. This one - what the host last negotiated with ANY of this renderer's
 *    stream clients, for a host named at dispatch time and a method the caller
 *    may hold no session for at all.
 *
 * So reach for this when the question is genuinely about the HOST - "if I
 * subscribe there, what will I get" - and for a send, reach for (1) unless the
 * send meets BOTH conditions below.
 *
 * ## When a SEND gate may read (3) instead of (1)
 *
 * This used to say "(1) and nothing else". That was too strong, and the gate
 * that showed it is `sendAttachmentsByHashSupported`
 * (`lib/composer/attachments-by-hash.ts`): it decides the SHAPE of a document -
 * hash-only image nodes versus inlined base64 - at a composer's submit, one
 * layer ABOVE the store that later hands the document to a session. It holds a
 * `hostId` and no session, so (1) is not merely inconvenient there, it is not
 * reachable without carrying a session's answer up through four layers that
 * have no other reason to know about stream versions.
 *
 * Two conditions make (3) sound for such a gate, and BOTH must hold:
 *
 * A. **The divergence is bounded by a session's lifetime, not open-ended.** A
 *    negotiated stream minor is a function of the client build and the host
 *    build alone (`predictedSubscribeSchemaVersion` over the two manifests), so
 *    two sessions on ONE host can disagree only if they were negotiated against
 *    different host incarnations - and no session survives its incarnation. On
 *    the local plane the host process exits, which closes the one socket every
 *    session of that host shares (they are shared per host by
 *    `lib/host/host-stream-client-cache.ts`), and the reconnect re-runs
 *    `WsStreamClient.applyHostManifest`, which re-publishes this registry. On
 *    the relay plane the client's leg outlives the host's across the DETACH
 *    only: `host_detached` deliberately keeps the socket and pauses the
 *    scheduler, and the matching `host_attached` then tears it down and
 *    redials - `RemoteSession.onHostAttached` → `handleConnectionLost
 *    ("host-reattached")` → `dropConnection` → `teardownConnection`, which does
 *    `scheduler.stop()`, `relaySocket.close(1000, …)` and `noise.wipe()`. There
 *    is no resume case, because the host discards all Noise state on any uplink
 *    close, and the redial's `handleOpenAck` re-publishes here and re-opens the
 *    subscriptions in the same synchronous block. What is left is the interval
 *    between the loss edge and the next handshake, during which this registry
 *    still answers for the previous incarnation (`resetMethodSupport` clears
 *    the CLIENT's own predictions, but only `applyHostManifest` republishes
 *    here) and no session on that host is ready to send anyway.
 * B. **The worst case inside that interval is a REJECTION the user already
 *    sees, not a wrong write.** A gate that guesses high sends a shape an older
 *    host answers with its existing refusal, which surfaces and restores the
 *    prompt; nothing is persisted under the wrong contract. A gate whose
 *    guessing high would COMMIT something - inject a message under an ordering
 *    policy the host predates, as (1)'s own example does - fails B and must use
 *    (1) however awkward the plumbing.
 *
 * Lives in `lib/` rather than beside a hook, for the same reason the unary
 * reader does: it is a dispatch-time read, and a dispatch is not a hook. A
 * version captured in a render is stale the moment the host re-handshakes;
 * gates must re-derive it as they send.
 */
export function readNegotiatedStreamMethodVersion(
  hostId: string,
  method: string,
): SchemaVersion | null {
  return getNegotiatedStreamMethodVersion(hostId, method);
}
