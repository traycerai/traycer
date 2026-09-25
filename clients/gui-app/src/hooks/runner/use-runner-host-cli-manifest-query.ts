import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  CliInstallManifestSnapshot,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";

/** The upgrade Desktop recorded for this machine's package-manager CLI. */
export type PackageManagerUpgrade = NonNullable<
  CliInstallManifestSnapshot["packageManagerUpgrade"]
>;

function hostCliManifestQueryOptions(management: IHostManagement | null) {
  return queryOptions<CliInstallManifestSnapshot | null>({
    queryKey:
      management === null
        ? runnerQueryKeys.hostCliManifestUnavailable()
        : runnerQueryKeys.hostCliManifest(management),
    queryFn:
      management === null ? skipCliManifest : () => management.cliManifest(),
    enabled: management !== null,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * THIS machine's CLI manifest, over the local management bridge.
 *
 * One query for two readers on the Overview, and that is the point of it being
 * a hook rather than a read inside either: the Installation tab's Command-line
 * tools hint and the warning dot on that tab's trigger both ask it, so they
 * share one cache entry and cannot disagree - the dot shows exactly while the
 * hint does, and both clear on the read that finds the tools current.
 */
export function useRunnerHostCliManifestQuery(): UseQueryResult<CliInstallManifestSnapshot | null> {
  const management = useRunnerHost().hostManagement;
  return useQuery(hostCliManifestQueryOptions(management));
}

/**
 * The pending upgrade the manifest records, or `null` while there is no
 * bridge, no manifest yet, or nothing to upgrade - which is every machine
 * whose CLI Desktop already keeps current.
 */
export function pendingPackageManagerUpgrade(
  manifest: CliInstallManifestSnapshot | null | undefined,
): PackageManagerUpgrade | null {
  return manifest?.packageManagerUpgrade ?? null;
}

function skipCliManifest(): Promise<CliInstallManifestSnapshot | null> {
  return Promise.reject(new Error("host management bridge unavailable"));
}
