import { useEffect, type ReactNode } from "react";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostBinding } from "@/lib/host";
import { appLogger } from "@/lib/logger";
import { useDraftMirrorForHost } from "./use-draft-mirror-for-host";
import { useDraftMirrorFlush } from "./use-draft-mirror-flush";
import { useCloudDraftsIngest } from "./use-cloud-drafts-ingest";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";

let warnedMissingHostRuntime = false;

/**
 * Mounted inside `<TabHostProvider>` so the session binds `useTabHostId()`.
 * Tests that wrap the provider without a host runtime skip the inner hooks
 * (`useHostBinding` is null-safe; `useHostStreamClientBindingFor` is not).
 */
export function TabDraftMirrorMount(): ReactNode {
  const binding = useHostBinding();
  useEffect(() => {
    if (binding !== null) return;
    if (!import.meta.env.DEV || warnedMissingHostRuntime) return;
    warnedMissingHostRuntime = true;
    appLogger.warn(
      "[draft-mirror] TabDraftMirrorMount skipped: HostRuntimeProvider is not mounted; tab drafts stay device-local",
      {},
    );
  }, [binding]);
  if (binding === null) return null;
  return <TabDraftMirrorSession />;
}

function TabDraftMirrorSession(): ReactNode {
  const hostId = useTabHostId();
  useDraftMirrorForHost(hostId);
  useCloudDraftsIngest(useTabHostClient(), hostId);
  useDraftMirrorFlush();
  return null;
}
