import {
  useStreamMethodSchemaVersion,
  useStreamMethodSupport,
} from "@/lib/host/stream-runtime-context";

function resourcesGlobalSupported(
  version: { readonly major: number; readonly minor: number } | null,
): boolean {
  return version === null || (version.major === 1 && version.minor >= 1);
}

/**
 * Whether the stream this subtree is bound to can serve a GLOBAL resources
 * subscription at all — `false` while the handshake is still unresolved, since
 * "we have not negotiated yet" is not a verdict.
 *
 * Read through the ambient `StreamRuntimeContext`, so under a host-scoped
 * provider (the resource monitor's picker) this answers for the PICKED host,
 * not the active one.
 *
 * It lives in one place because two surfaces have to agree on it and must not
 * drift: `GlobalResourcesStreamMount`, which declines to acquire, and the
 * monitor's panel, which has to say so. Without the second, a host too old for
 * a global stream sits on "Waiting for <host>…" forever — there is no acquire,
 * so no attribution, so no event that could ever end the wait.
 *
 * KNOWN GAP — this answers for LOCAL hosts only. `RemoteStreamClient` reports
 * `"unknown"` support and a `null` schema version for every method BY DESIGN:
 * the mux session resolves an incompatible method as a fatal error on the
 * subscribe attempt, not as a queryable pre-check, so there is no learned
 * capability cache to read. Both terms below therefore stay false for a remote
 * host and this returns `false` — the mount acquires and an old remote host
 * waits rather than being told why.
 *
 * That is the pre-picker behaviour preserved, not a regression: the ambient
 * host this used to gate is normally the local one. But the picker's whole
 * purpose is watching another machine, so the population that most needs the
 * notice is exactly the one that cannot get it. Closing it means deriving the
 * verdict from what the remote session really produces — the terminal failure
 * of the subscribe — rather than from a pre-check that cannot answer. Tracked
 * separately rather than widened into this change.
 */
export function useGlobalResourcesUnsupported(): boolean {
  const resourcesSupport = useStreamMethodSupport("resources.subscribe");
  const resourcesVersion = useStreamMethodSchemaVersion("resources.subscribe");
  return (
    resourcesSupport === "unsupported" ||
    (resourcesVersion !== null && !resourcesGlobalSupported(resourcesVersion))
  );
}
