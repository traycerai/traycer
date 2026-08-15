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
 */
export function useGlobalResourcesUnsupported(): boolean {
  const resourcesSupport = useStreamMethodSupport("resources.subscribe");
  const resourcesVersion = useStreamMethodSchemaVersion("resources.subscribe");
  return (
    resourcesSupport === "unsupported" ||
    (resourcesVersion !== null && !resourcesGlobalSupported(resourcesVersion))
  );
}
