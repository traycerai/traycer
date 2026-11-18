import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";

/**
 * Which configuration a page's editors edit: a team's or Personal's id read
 * from the cloud, else the host whose own settings they are. An editor keyed
 * on it never carries a draft, or a write's outcome, to another configuration
 * whose names and revisions happen to match.
 */
export function useConfigurationKey(): string {
  const source = useConfigurationSource();
  const hostId = useAddressableHostId();
  return source.kind === "pool"
    ? `environment:${source.environmentId}`
    : `host:${hostId ?? ""}`;
}
