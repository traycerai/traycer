import { supportsGlobalResourcesScope } from "@traycer-clients/shared/host-transport/resources-stream-client";
import {
  useStreamMethodSchemaVersion,
  useStreamMethodSupport,
} from "@/lib/host/stream-runtime-context";
import { useGlobalResourcesScopeSupport } from "@/stores/resources/resources-registry";

/**
 * The verdict available BEFORE any global stream is opened, read from the
 * ambient `StreamRuntimeContext` — so under a host-scoped provider (the
 * resource monitor's picker) this answers for the PICKED host, not the active
 * one.
 *
 * This is what `GlobalResourcesStreamMount` gates on, and it is deliberately
 * NOT the whole answer (see `useGlobalResourcesUnsupported`). It reports only
 * what a client-wide capability cache can know without dialling, which is why
 * it can decline to acquire at all: convicting a host here costs nothing,
 * because no stream had to be opened to learn it.
 *
 * It can answer for either transport once support has settled: remote sessions
 * publish method support and schema version at `openAck`. While a reader is
 * still undecided, both terms below stay false and the mount may acquire;
 * the stream's own outcome then settles the fallback.
 */
export function useGlobalResourcesPreCheckUnsupported(): boolean {
  const resourcesSupport = useStreamMethodSupport("resources.subscribe");
  const resourcesVersion = useStreamMethodSchemaVersion("resources.subscribe");
  return (
    resourcesSupport === "unsupported" ||
    (resourcesVersion !== null &&
      !supportsGlobalResourcesScope(resourcesVersion))
  );
}

/**
 * Whether the host this subtree is bound to can serve a GLOBAL resources
 * subscription at all — `false` while the evidence is still unresolved, since
 * "we have not negotiated yet" is not a verdict.
 *
 * Two independent sources, because they answer at different times:
 *
 *  1. the client-wide pre-check above, which can answer before this stream
 *     opens on either transport, and
 *  2. the live stream's own negotiation, republished by the registry, which
 *     remains authoritative for the opened session.
 *
 * (2) catches an `@1.0` host of either kind that got past the
 * mount, because such a host does not fail a global subscribe. The `@1.1`
 * request keeps `epicId` on the wire so the probe downgrades cleanly, so the
 * old host accepts it and answers with one empty projection for an epic named
 * `__global__` that does not exist — indistinguishable, from the outside, from
 * a healthy stream on an idle machine. Its negotiated VERSION is what gives it
 * away.
 *
 * Read by the monitor's panel, which has to SAY so. Without it a host too old
 * for a global stream sits on "Waiting for <host>…" forever: nothing will ever
 * attribute a projection to that machine, so no event could ever end the wait.
 *
 * `claimedHostId` is the machine the CALLER is naming on screen. (2) is only
 * repeated for the host its stream was actually opened against — see
 * `getGlobalScopeSupport`. (1) needs no such check: it is read through this
 * subtree's own stream context, which under a scoped provider is already the
 * picked host's.
 *
 * Both hooks run unconditionally — `||` would short-circuit the second one out
 * of the render on exactly the frames where the first is true.
 */
export function useGlobalResourcesUnsupported(
  claimedHostId: string | null,
): boolean {
  const preCheckUnsupported = useGlobalResourcesPreCheckUnsupported();
  const streamScopeSupport = useGlobalResourcesScopeSupport(claimedHostId);
  return preCheckUnsupported || streamScopeSupport === "unsupported";
}
