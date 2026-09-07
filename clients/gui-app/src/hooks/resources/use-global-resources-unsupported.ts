import { supportsGlobalResourcesScope } from "@traycer-clients/shared/host-transport/resources-stream-client";
import {
  useStreamMethodSchemaVersion,
  useStreamMethodSupport,
} from "@/lib/host/stream-runtime-context";
import { useGlobalResourcesScopeSupport } from "@/stores/resources/resources-registry";

/** Pre-dial verdict from ambient StreamRuntimeContext (picked host under a scoped provider). Local hosts only; remote always returns false so the mount can acquire. */
export function useGlobalResourcesPreCheckUnsupported(): boolean {
  const resourcesSupport = useStreamMethodSupport("resources.subscribe");
  const resourcesVersion = useStreamMethodSchemaVersion("resources.subscribe");
  return (
    resourcesSupport === "unsupported" ||
    (resourcesVersion !== null &&
      !supportsGlobalResourcesScope(resourcesVersion))
  );
}

/** false while evidence is unresolved. */
export function useGlobalResourcesUnsupported(
  claimedHostId: string | null,
): boolean {
  const preCheckUnsupported = useGlobalResourcesPreCheckUnsupported();
  const streamScopeSupport = useGlobalResourcesScopeSupport(claimedHostId);
  return preCheckUnsupported || streamScopeSupport === "unsupported";
}
