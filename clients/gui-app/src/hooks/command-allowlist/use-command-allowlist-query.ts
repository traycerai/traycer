import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { QueryActivityOptions } from "@/hooks/harnesses/use-gui-harness-catalog";

/**
 * App-wide `commandAllowlist.list`: the per-device "always allow" command rules
 * saved from approval prompts, scoped to the active host (the settings panel
 * re-provides the host client to target the selected host). Static config — no
 * background polling; refetched on mutation invalidation.
 */
export function useCommandAllowlist(
  activity: QueryActivityOptions,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "commandAllowlist.list">,
  HostRpcError
> {
  const client = useHostClient();
  return useHostQuery<HostRpcRegistry, "commandAllowlist.list">({
    client,
    method: "commandAllowlist.list",
    params: {},
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
    },
  });
}
