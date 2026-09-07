import { homedir } from "node:os";
import { join } from "node:path";
import type { Environment } from "../../config";
import { devDesktopSlotForEnvironment } from "./dev-desktop-slot";
// Re-export so the desktop's host consumers can import the deploy-slot type
// from a single place alongside the layout helpers.
export type { Environment } from "../../config";

/**
 * A `ServiceLabel` namespaces a service registration (LaunchAgent / unit / Scheduled Task) so production and dev installations don't overwrite each other.
 * Kept here so the small set of consumers (`main-process`, `host-lifecycle`) don't need to depend on the deleted `service/` subtree.
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

// The `.agent` suffix is collision-free by construction: raw CLI installs never append it, so no legacy record can ever match this label.
// DO NOT change this derivation without updating the three sites that must stay in lockstep and cannot import this module.
export function smAppServiceAgentLabelId(cliLabelId: string): string {
  return `${cliLabelId}.agent`;
}

// The raw user-domain LaunchAgent manifest path the CLI writes for a label (mirrors the CLI's `serviceManifestPath` on darwin; separate bundle, so it can't be imported here).
export function userLaunchAgentPlistPath(labelId: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${labelId}.plist`);
}

/** Do not rename `pid.json` or the pending-login-item marker without updating `getDefaultHostPidMetadataPath()` and `desktop-install-cloud.js`. */

export interface HostFsLayout {
  readonly rootDir: string;
  readonly pidMetadataFile: string;
  readonly identityEnrollmentFile: string;
  readonly logFile: string;
  readonly installDir: string;
  readonly installRecordFile: string;
  readonly stagedDir: string;
  readonly stagedRecordFile: string;
  readonly pendingLoginItemRevisionFile: string;
  /**
   * Deliberately NOT `hostManagesHostLoginItem()`: that predicate is a capability of THIS Desktop build (darwin, not dev, in-bundle plist present) and stays true on a machine where.
   * Filename must stay in lockstep with the CLI's `hostSubstratePath` (`traycer-cli/src/store/paths.ts`); separate bundle, so it cannot be imported here.
   */
  readonly substrateFile: string;
  readonly transitionJournalFile: string;
  readonly browserTraceFile: string;
  readonly browserTraceRotatedFile: string;
  readonly browserTelemetryFile: string;
  readonly browserTelemetryRotatedFile: string;
  readonly environment: Environment;
}

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
  const stagedDir = join(rootDir, "staged");
  return {
    rootDir,
    pidMetadataFile: join(rootDir, "pid.json"),
    identityEnrollmentFile: join(rootDir, "identity", "enrollment.json"),
    logFile: join(rootDir, "host.log"),
    installDir,
    installRecordFile: join(installDir, "install.json"),
    stagedDir,
    stagedRecordFile: join(stagedDir, "staged.json"),
    pendingLoginItemRevisionFile: join(
      rootDir,
      "pending-login-item-revision.json",
    ),
    substrateFile: join(rootDir, "substrate.json"),
    transitionJournalFile: join(rootDir, "transition.json"),
    browserTraceFile: join(rootDir, "browser-trace.jsonl"),
    browserTraceRotatedFile: join(rootDir, "browser-trace.jsonl.1"),
    browserTelemetryFile: join(rootDir, "browser-telemetry.jsonl"),
    browserTelemetryRotatedFile: join(rootDir, "browser-telemetry.jsonl.1"),
    environment,
  };
}

export function cliSlotRootForEnvironment(environment: Environment): string {
  const cliRoot = join(homedir(), ".traycer", "cli");
  return hostSlotRoot(cliRoot, environment);
}

/** The desktop-held lock sections (Host Update Layer Redesign Tech Plan, "cli-lock" rule 3) acquire the SAME file via `desktop-cli-lock.ts`, so this must resolve byte-for-byte. */
export function cliLockPath(environment: Environment): string {
  return join(cliSlotRootForEnvironment(environment), ".lock");
}
