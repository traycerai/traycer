import type { ReactNode } from "react";
import { CopyTextButton } from "@/components/copy-text-button";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { formatPackageManagerSource } from "@/components/settings/panels/host-settings-panel-model";
import { SettingsGroup } from "@/components/settings/settings-group";
import {
  pendingPackageManagerUpgrade,
  useRunnerHostCliManifestQuery,
  type PackageManagerUpgrade,
} from "@/hooks/runner/use-runner-host-cli-manifest-query";

interface PackageManagerUpgradeHintProps {
  readonly hint: PackageManagerUpgrade;
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
      className="flex flex-col gap-2 bg-warning/10 px-5 py-3 text-ui-sm text-warning-foreground"
    >
      <div>
        Your {formatPackageManagerSource(hint.source)} install of{" "}
        <span className="font-mono">traycer</span> is older than the bundled CLI
        (installed <span className="font-mono">v{hint.installedVersion}</span>,
        bundled <span className="font-mono">v{hint.bundledVersion}</span>). Run
        the upgrade command below to update it.
      </div>
      <div className="flex w-full max-w-full items-center gap-2 rounded-md border border-warning/30 bg-background/40 py-1 pr-1 pl-3">
        <pre
          data-testid="settings-host-package-manager-upgrade-command"
          className="min-w-0 flex-1 overflow-auto py-1 font-mono text-code-xs text-foreground"
        >
          {hint.upgradeCommand}
        </pre>
        <CopyTextButton
          value={hint.upgradeCommand}
          label={null}
          ariaLabel="Copy upgrade command"
          disabled={false}
        />
      </div>
    </output>
  );
}

/**
 * Installation ▸ Command-line tools: the hint wired to its only possible
 * source, this machine's CLI manifest over the local management bridge.
 * Renders nothing - no group, no label - while there is no bridge, no
 * manifest, or no hint, which is every machine whose CLI Desktop already keeps
 * current, so the caller mounts it unconditionally on the local path.
 *
 * It reads the same query as {@link LocalPackageManagerUpgradeDot}, which is
 * what makes the tab's dot and this group appear and clear together.
 */
export function LocalPackageManagerUpgradeHint(): ReactNode {
  const manifest = useRunnerHostCliManifestQuery();
  const hint = pendingPackageManagerUpgrade(manifest.data);
  if (hint === null) return null;
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.commandLineTools}
      showTitle
      tone="default"
      dataTestId="host-overview-command-line-tools"
      fill={false}
    >
      <PackageManagerUpgradeHint hint={hint} />
    </SettingsGroup>
  );
}

/**
 * The Installation tab's warning dot - on its trigger, and on its item in the
 * phone's section dropdown - while {@link LocalPackageManagerUpgradeHint} has
 * an upgrade to show. Same query, same `null`, so the two cannot drift: the
 * dot says "look in Installation" exactly while there is something there to
 * see. The words ride along for a screen reader, which cannot see a dot.
 */
export function LocalPackageManagerUpgradeDot(): ReactNode {
  const manifest = useRunnerHostCliManifestQuery();
  const hint = pendingPackageManagerUpgrade(manifest.data);
  if (hint === null) return null;
  return (
    <span
      className="inline-flex items-center"
      data-testid="host-overview-installation-dot"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span className="sr-only">{" (command-line tools need an upgrade)"}</span>
    </span>
  );
}
