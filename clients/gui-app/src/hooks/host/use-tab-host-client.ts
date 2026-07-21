import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";

/**
 * Builds a routed `HostRequester` bound to the CURRENT tab's host
 * (`useTabHostId`) rather than the app-wide active host.
 *
 * Per CLAUDE.md a chat/terminal tab is bound to a host for life, and that
 * host can differ from the renderer-default one (a tab bound to a remote /
 * non-default host). RPCs that must hit the host a tab's terminals actually
 * live on - e.g. setup-terminal liveness (`terminal.list`) and Cancel
 * (`terminal.kill`) - resolve their client here so they never silently switch
 * host scope by render context.
 *
 * The entry is resolved from the referentially stable directory list so the
 * underlying `useHostClientFor` memoizes per host. Returns `null` until the
 * directory resolves the entry (or when signed out); callers treat `null` as
 * "not ready" - `useHostQuery` disables itself and the kill mutation no-ops.
 *
 * Must be called inside `<TabHostProvider>` (every tile renderer is wrapped).
 */
export function useTabHostClient(): HostClient<HostRpcRegistry> | null {
  const tabHostId = useTabHostId();
  const directory = useHostDirectoryList();
  const entry = useMemo(
    () => (directory.data ?? []).find((e) => e.hostId === tabHostId) ?? null,
    [directory.data, tabHostId],
  );
  return useHostClientFor(entry);
}
