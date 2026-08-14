import type { ReactNode } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { formatPackageManagerSource } from "@/components/settings/panels/host-settings-panel-model";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import { useRunnerHost } from "@/providers/use-runner-host";
import type { CliInstallManifestSnapshot } from "@traycer-clients/shared/platform/runner-host";

interface PackageManagerUpgradeHintProps {
  readonly hint: NonNullable<
    CliInstallManifestSnapshot["packageManagerUpgrade"]
  >;
}

/**
 * The remediation for a package-manager-owned CLI that is older than the
 * bundled one. Desktop deliberately never overwrites a Homebrew/npm/winget
 * binary; it records the source-specific upgrade command instead, and this is
 * the surface that renders it. A Desktop-local fact by construction — the
 * producer writes it into this machine's reconcile state, never the host-side
 * manifest — so it renders only where the local bridge answers.
 */
export function PackageManagerUpgradeHint(
  props: PackageManagerUpgradeHintProps,
) {
  const { hint } = props;
  return (
    <output
      data-testid="settings-host-package-manager-upgrade-hint"
      className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-5 py-3 text-ui-sm text-amber-950 dark:text-amber-100"
    >
      <div>
        Your {formatPackageManagerSource(hint.source)} install of{" "}
        <span className="font-mono">traycer</span> is older than the bundled CLI
        (installed <span className="font-mono">v{hint.installedVersion}</span>,
        bundled <span className="font-mono">v{hint.bundledVersion}</span>). Run
        the upgrade command below to update it.
      </div>
      <pre
        data-testid="settings-host-package-manager-upgrade-command"
        className="w-full max-w-full overflow-auto rounded-md border border-amber-500/30 bg-background/40 px-3 py-2 font-mono text-code-xs"
      >
        {hint.upgradeCommand}
      </pre>
    </output>
  );
}

/**
 * The hint wired to its only possible source: this machine's CLI manifest over
 * the local management bridge. Renders nothing while there is no bridge, no
 * manifest, or no hint — which is every machine whose CLI Desktop already
 * keeps current — so the caller mounts it unconditionally on the local path.
 */
export function LocalPackageManagerUpgradeHint(): ReactNode {
  const management = useRunnerHost().hostManagement;
  const manifest = useQuery(
    queryOptions<CliInstallManifestSnapshot | null>({
      queryKey:
        management === null
          ? runnerQueryKeys.hostCliManifestUnavailable()
          : runnerQueryKeys.hostCliManifest(management),
      queryFn:
        management === null ? skipCliManifest : () => management.cliManifest(),
      enabled: management !== null,
      staleTime: 5 * 60 * 1000,
    }),
  );
  const hint = manifest.data?.packageManagerUpgrade ?? null;
  if (hint === null) return null;
  return <PackageManagerUpgradeHint hint={hint} />;
}

function skipCliManifest(): Promise<CliInstallManifestSnapshot | null> {
  return Promise.reject(new Error("host management bridge unavailable"));
}
