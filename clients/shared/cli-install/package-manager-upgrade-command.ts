import {
  cliInstallSourceSchema,
  type CliInstallSource,
} from "@traycer/protocol/config/installation-records";

/**
 * The published npm name of the Traycer CLI. Client copy only - the wire and
 * the persisted install records never carry it - which is why it lives here
 * and not in `@traycer/protocol` (the client⇄host contract, which the CLI
 * inlines and which a copy change must never rebuild). Coupled to the npm
 * publish in `scripts/native-packaging/publish-cli-package-managers.cjs`.
 */
export const CLI_NPM_PACKAGE_NAME = "@traycerai/cli";

/**
 * One command vocabulary for every surface that tells a person how to
 * upgrade a package-manager-owned CLI: the CLI's own refusal hints
 * (`manifest/cli-manifest.ts` → `cli upgrade`, `host/compat-recovery.ts`),
 * Desktop's launch reconciliation sidecar (`electron-main/cli/cli-reconcile`),
 * the GUI's CLI-floor remedy and its add-host instructions. One table, so a
 * manager's command cannot drift between them.
 *
 * Each entry is coupled to the artifact the same repo renders for that
 * manager in `scripts/native-packaging/publish-cli-package-managers.cjs`:
 * `brew upgrade traycer` to the tap's `Formula/traycer.rb`, `Traycer.CLI` to
 * the winget manifest id, `traycer-cli` to the Scoop bucket and the deb/rpm
 * package name. Rename one there and this row is the other end.
 *
 * What the feeds CARRY is only partly knowable from this repo, and the copy
 * built on this table says no more than that: `publish-cli-package-managers.yml`
 * runs on `release: released` (never a prerelease) and publishes npm - a
 * prerelease reaches npm only by `workflow_dispatch`, under its own dist-tag -
 * and opens the Homebrew formula PR; the winget/Scoop/deb/rpm renders exist in
 * the script but no workflow here publishes them. So an npm floor remedy pins
 * the exact required version (`latest` is stable-only), and every other
 * manager's command - Homebrew's included - is a rolling stable upgrade that
 * a prerelease floor cannot rely on; the GUI offers installation help there.
 */
export const PACKAGE_MANAGER_UPGRADE_COMMAND = {
  homebrew: "brew upgrade traycer",
  npm: `npm install -g ${CLI_NPM_PACKAGE_NAME}@latest`,
  winget: "winget upgrade Traycer.CLI",
  scoop: "scoop update traycer-cli",
  apt: "sudo apt update && sudo apt install --only-upgrade traycer-cli",
  rpm: "sudo dnf upgrade traycer-cli",
} as const satisfies Record<
  Exclude<CliInstallSource, "desktop" | "manual">,
  string
>;

/**
 * The package-manager-owned install sources, DERIVED from the table so there
 * is one definition of the set: adding a manager to `cliInstallSourceSchema`
 * fails the `satisfies` above until it has a command, and every consumer of
 * the set (the CLI's upgrade-ownership contract, Desktop's reconcile branch,
 * the GUI remedy's routing) reads the same keys. Before this, the CLI and
 * Desktop each kept a hand-written copy that a new manager missed silently.
 */
export type PackageManagerCliSource =
  keyof typeof PACKAGE_MANAGER_UPGRADE_COMMAND;

export function isPackageManagerCliSource(
  source: CliInstallSource,
): source is PackageManagerCliSource {
  return Object.hasOwn(PACKAGE_MANAGER_UPGRADE_COMMAND, source);
}

export const PACKAGE_MANAGER_CLI_SOURCES: ReadonlySet<CliInstallSource> =
  new Set<CliInstallSource>(
    cliInstallSourceSchema.options.filter(isPackageManagerCliSource),
  );
