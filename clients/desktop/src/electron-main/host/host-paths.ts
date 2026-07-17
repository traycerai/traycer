import { homedir } from "node:os";
import { join } from "node:path";
import type { Environment } from "../../config";
import { devDesktopSlotForEnvironment } from "./dev-desktop-slot";
// Re-export so the desktop's host consumers can import the deploy-slot type
// from a single place alongside the layout helpers.
export type { Environment } from "../../config";

/**
 * A `ServiceLabel` namespaces a service registration (LaunchAgent / unit /
 * Scheduled Task) so production and dev installations don't overwrite each
 * other. Kept here so the small set of consumers (`main-process`,
 * `host-lifecycle`) don't need to depend on the deleted `service/` subtree.
 */
export interface ServiceLabel {
  /** Reverse-DNS service identifier (e.g. `ai.traycer.host`). */
  readonly id: string;
  /** Human-readable display name for service-manager UIs. */
  readonly displayName: string;
  /** Subdirectory of `~/Library/Application Support` (macOS) / etc. */
  readonly appSupportDirName: string;
}

export const PRODUCTION_LABEL: ServiceLabel = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  appSupportDirName: "Traycer",
};

export const DEV_LABEL: ServiceLabel = {
  id: "ai.traycer.host.dev",
  displayName: "Traycer Host (Dev)",
  appSupportDirName: "Traycer-Dev",
};

// The label for an environment/slot. Mirrors the CLI's `serviceLabelFor`:
// production keeps the bare `ai.traycer.host`; every other slot nests under its
// own name (`ai.traycer.host.<environment>`) so a staging/dev install owns an
// isolated LaunchAgent + app-support dir and never collides with prod. A
// hardcoded dev-only fallback silently mapped internal `staging` builds onto the
// dev slot (`ai.traycer.host.dev`), mismatching the `ai.traycer.host.staging`
// plist the installer ships - derive from `environment` so new slots can't drift.
export function labelForEnvironment(environment: Environment): ServiceLabel {
  if (environment === "production") return PRODUCTION_LABEL;
  const devSlot = devDesktopSlotForEnvironment(environment, process.env);
  if (devSlot !== null) {
    return {
      id: `ai.traycer.host.dev.${devSlot}`,
      displayName: `Traycer Host (Dev ${devSlot})`,
      appSupportDirName: `Traycer-Dev-${devSlot}`,
    };
  }
  if (environment === "dev") return DEV_LABEL;
  const titled = capitalizeEnvironment(environment);
  return {
    id: `ai.traycer.host.${environment}`,
    displayName: `Traycer Host (${titled})`,
    appSupportDirName: `Traycer-${titled}`,
  };
}

function capitalizeEnvironment(environment: Environment): string {
  if (environment.length === 0) return environment;
  return environment.charAt(0).toUpperCase() + environment.slice(1);
}

/**
 * Filesystem layout the desktop shell uses to locate the host's published
 * metadata and diagnostics.
 *
 * ### Cross-workspace contract
 *
 * `pidMetadataFile` is the on-disk coordination point with the host.
 * For the prod environment the canonical path is `~/.traycer/host/pid.json`;
 * for the dev environment it is `~/.traycer/host/dev/pid.json`, or
 * `~/.traycer/host/dev-runs/<slot>/pid.json` when `DEV_DESKTOP_SLOT` is set.
 * The path is a JSON document matching `HostPidMetadata`, written by the host
 * (the external Traycer Host). The host writes it on bind and unlinks it on
 * graceful shutdown; this runner reads it to discover a live local host and
 * its localhost `websocketUrl`.
 *
 * The dev/prod split mirrors the CLI's
 * `clients/traycer-cli/src/store/paths.ts` and the layout used by the host
 * (the external Traycer Host). CLI service status, Doctor,
 * Desktop dev flow, and the host runtime all agree on the same
 * environment-scoped layout so a `make dev-desktop` session never reads a
 * production host's pid metadata (or vice-versa).
 *
 * DO NOT change the filename without updating the matching helper
 * `getDefaultHostPidMetadataPath()` on the host side - drift here
 * silently breaks local host discovery for every packaged build.
 *
 * `pendingLoginItemRevisionFile` is a second cross-repo coordination point,
 * this time with the *internal* `traycer-internal` repository's
 * `scripts/desktop-install-cloud.js` (a separate repo from this one - see
 * that repo's CLAUDE.md for the submodule boundary). That installer writes
 * this marker when it deliberately preserves a busy/indeterminate running
 * host across a bundle swap instead of `launchctl bootout`-ing it: the
 * on-disk LaunchAgent plist changed (e.g. a new descriptor limit) but the
 * loaded launchd job/SMAppService registration did not. `ensureHost`'s
 * already-ready fast path checks for this file and, once it observes the
 * host idle, runs the existing `registerHostLoginItem()` bootout->
 * unregister->register cycle to apply the refreshed plist, then deletes the
 * marker. DO NOT change this filename without updating the matching write
 * site in `desktop-install-cloud.js`.
 */

export interface HostFsLayout {
  readonly rootDir: string;
  readonly pidMetadataFile: string;
  readonly logFile: string;
  readonly installDir: string;
  readonly installRecordFile: string;
  readonly pendingLoginItemRevisionFile: string;
  readonly environment: Environment;
}

// The deploy-slot subdir rule, single-sourced for the desktop: production has
// no suffix; every other environment nests under its own name. Mirrors the CLI
// package's `environmentSubdir` in store/paths.ts (separate bundle, so it can't
// be imported here).
export function environmentSubdir(
  base: string,
  environment: Environment,
): string {
  return environment === "production" ? base : join(base, environment);
}

function hostSlotRoot(base: string, environment: Environment): string {
  const devSlot = devDesktopSlotForEnvironment(environment, process.env);
  if (devSlot !== null) return join(base, "dev-runs", devSlot);
  return environmentSubdir(base, environment);
}

export function getHostFsLayout(environment: Environment): HostFsLayout {
  const base = join(homedir(), ".traycer", "host");
  const rootDir = hostSlotRoot(base, environment);
  const installDir = join(rootDir, "install");
  return {
    rootDir,
    pidMetadataFile: join(rootDir, "pid.json"),
    logFile: join(rootDir, "host.log"),
    installDir,
    installRecordFile: join(installDir, "install.json"),
    pendingLoginItemRevisionFile: join(
      rootDir,
      "pending-login-item-revision.json",
    ),
    environment,
  };
}
