import { formatPackageManagerSource } from "@/components/settings/panels/host-settings-panel-model";
import type { CliInstallManifestSnapshot } from "@traycer-clients/shared/platform/runner-host";

interface PackageManagerUpgradeHintProps {
  readonly hint: NonNullable<
    CliInstallManifestSnapshot["packageManagerUpgrade"]
  >;
}

export function PackageManagerUpgradeHint(
  props: PackageManagerUpgradeHintProps,
) {
  const { hint } = props;
  return (
    <output
      data-testid="settings-host-package-manager-upgrade-hint"
      className="flex flex-col gap-2 border-b border-amber-500/30 bg-amber-500/10 px-5 py-3 text-ui-sm text-amber-950 dark:text-amber-100"
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
