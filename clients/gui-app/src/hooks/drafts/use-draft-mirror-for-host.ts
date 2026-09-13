import { useEffect } from "react";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostStreamClientBindingFor } from "@/hooks/host/use-host-stream-client-for";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import {
  acquireDraftMirrorSession,
  releaseDraftMirrorSession,
} from "@/lib/drafts/draft-mirror-coordinator";

/**
 * Acquires a refcounted `drafts.list` + `drafts.subscribe` session for
 * `hostId`. No-ops when the host is unreachable or predates the methods
 * (`E_HOST_UNSUPPORTED` / missing manifest) — stores stay device-local.
 */
export function useDraftMirrorForHost(hostId: string | null): void {
  const client = useHostClientForHostId(hostId);
  const entry = useHostDirectoryEntryForHostId(hostId);
  const auth = useStreamAuthRevalidator();
  const streamBinding = useHostStreamClientBindingFor(entry, auth);
  const unarySupport = useHostMethodSupport(hostId, "drafts.upsert");
  const readiness = useReactiveHostReadiness(client);

  useEffect(() => {
    if (hostId === null) return;
    if (client === null || streamBinding === null) return;
    if (unarySupport !== true || !readiness.isReady) return;
    acquireDraftMirrorSession({
      hostId,
      client,
      streamClient: streamBinding.client,
      timing: undefined,
    });
    return () => {
      releaseDraftMirrorSession(hostId);
    };
  }, [client, hostId, readiness.isReady, streamBinding, unarySupport]);
}
