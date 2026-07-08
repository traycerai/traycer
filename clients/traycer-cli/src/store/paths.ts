import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Environment } from "../runner/environment";

// ~/.traycer/ is the single Traycer root. Per the Native Packaging
// tech plan, prod and dev *components* are siblings inside it rather
// than under sibling root dirs like ~/.traycer-dev - that way a user
// sees the full install surface in one tree.
//
//   ~/.traycer/cli/                            - shared CLI surface + prod
//   ~/.traycer/cli/config.json                 - shared CLI config
//   ~/.traycer/cli/credentials                 - shared auth
//   ~/.traycer/cli/manifest.json               - prod install manifest
//   ~/.traycer/cli/.lock                       - prod mutation lock
//   ~/.traycer/cli/post-finalize.json          - prod pending-upgrade helper marker
//   ~/.traycer/cli/dev/manifest.json           - dev install manifest
//   ~/.traycer/cli/dev/.lock                   - dev mutation lock
//   ~/.traycer/cli/dev/post-finalize.json      - dev pending-upgrade helper marker
//   ~/.traycer/host/                         - prod host runtime root
//   ~/.traycer/host/host.log               - prod host stdout + bootstrap markers
//   ~/.traycer/host/pid.json                 - prod host pid metadata
//   ~/.traycer/host/install/                 - prod host install dir (atomic-swap target)
//   ~/.traycer/host/install/install.json     - prod host install record
//   ~/.traycer/host/staging/                 - prod host staging root (verify-before-replace)
//   ~/.traycer/host/dev/                     - dev host runtime root (parallel layout)
//   ~/.traycer/host/dev/install/install.json - dev host install record
//   ~/.traycer/host/dev/staging/             - dev host staging root
const TRAYCER_HOME = join(homedir(), ".traycer");
const CLI_HOME = join(TRAYCER_HOME, "cli");
const HOST_HOME = join(TRAYCER_HOME, "host");
const HOST_INSTALL_SUBDIR = "install";
// The host install temp/extract area (verify-before-replace), kept distinct
// from the host root. Named "install-staging" for clarity.
const HOST_STAGING_SUBDIR = "install-staging";
const HOST_INSTALL_RECORD_FILENAME = "install.json";
const CLI_LOG_FILENAME = "cli.log";
const HOST_LOG_FILENAME = "host.log";
const HOST_PID_FILENAME = "pid.json";

function environmentSubdir(base: string, environment: Environment): string {
  // production → base; dev → base/dev (the slot dir name is the environment
  // value itself).
  return environment === "production" ? base : join(base, environment);
}

export const traycerHomeDir = (): string => TRAYCER_HOME;
// Shared (non-environment) config surface. `cliConfigPath`
// (~/.traycer/cli/config.json) holds machine-local shell/env config that is
// genuinely environment-agnostic, so it stays at the shared root and is owned
// by `@traycer/protocol/config` (the CLI and the host resolve the exact same
// file); re-exported here for the CLI's existing callers.
export { cliConfigPath } from "@traycer/protocol/config/paths";
export const cliSharedHomeDir = (): string => CLI_HOME;

// Credentials are environment-scoped (production → shared root, dev/staging →
// the slot subdir, matching `cliHomeDir`). The path now lives in
// `@traycer/protocol/config` so the host resolves the exact same file when it
// reads `user.id` to pin its owner (the owner-binding gate); re-exported here
// for the CLI's existing callers.
export { cliCredentialsPath } from "@traycer/protocol/config/paths";

// Environment-aware CLI paths.
export function cliHomeDir(environment: Environment | undefined): string {
  // Existing non-environment callers (config-store, credentials) treat the
  // CLI home as a shared root. Environment-aware callers (manifest, lock,
  // post-finalize marker) pass an explicit environment and we resolve to
  // the per-environment subdir.
  if (environment === undefined) return CLI_HOME;
  return environmentSubdir(CLI_HOME, environment);
}
export function cliManifestPath(environment: Environment): string {
  return join(cliHomeDir(environment), "manifest.json");
}
export function cliLockPath(environment: Environment): string {
  return join(cliHomeDir(environment), ".lock");
}
export function cliLogPath(environment: Environment): string {
  return join(cliHomeDir(environment), CLI_LOG_FILENAME);
}
// Marker the detached pending-CLI-upgrade finalize helper writes after
// it attempts the live-binary swap. The next CLI invocation (Doctor,
// host restart, etc.) reconciles this marker against the CLI install
// manifest and clears `pendingUpgrade` on swap success - see
// upgrade/finalize-helper.ts.
export function cliPostFinalizeMarkerPath(environment: Environment): string {
  return join(cliHomeDir(environment), "post-finalize.json");
}

// Environment-aware host paths. All environments are rooted under
// ~/.traycer/host/; non-production environments nest one level deeper.
// Non-environment callers (bootstrap-log, pid-metadata, host-status) pass
// `undefined` and resolve to the production root - host bootstrap is
// production-only, so environment is not threaded through that flow.
export function hostHomeDir(environment: Environment | undefined): string {
  if (environment === undefined) return HOST_HOME;
  return environmentSubdir(HOST_HOME, environment);
}

// On-disk contracts written by the host and read here by string path -
// no host-package import. Shape verified at the host writer site
// (the host is the external Traycer Host).
// Bootstrap markers and host stdout share `host.log` - the supervisor
// redirects the host's stdio fd to the same file the markers are
// appended to, so the renderer's failure-card tail is one cohesive log.
export function hostPidMetadataPath(
  environment: Environment | undefined,
): string {
  return join(hostHomeDir(environment), HOST_PID_FILENAME);
}
export function hostLogPath(environment: Environment | undefined): string {
  return join(hostHomeDir(environment), HOST_LOG_FILENAME);
}
export function bootstrapLogPath(environment: Environment | undefined): string {
  return hostLogPath(environment);
}

// Host install/staging surface - the installer stages a new host
// archive under `hostStagingRoot(environment)/stage-*`, verifies it, and
// then atomically renames into `hostInstallDir(environment)`. The single
// install record is written at `hostInstallRecordPath(environment)` after
// the swap. Both environments stay isolated under the single ~/.traycer/
// root per the Tech Plan; there is no cross-environment sharing.
export function hostInstallDir(environment: Environment): string {
  return join(hostHomeDir(environment), HOST_INSTALL_SUBDIR);
}
export function hostStagingRoot(environment: Environment): string {
  return join(hostHomeDir(environment), HOST_STAGING_SUBDIR);
}
export function hostInstallRecordPath(environment: Environment): string {
  return join(hostInstallDir(environment), HOST_INSTALL_RECORD_FILENAME);
}

export async function ensureTraycerHomeDir(): Promise<void> {
  await mkdir(TRAYCER_HOME, { recursive: true });
}

// Environment-aware host home mkdir. Non-environment callers pass undefined to
// get the prod root; environment-aware callers (installer/uninstaller) pass
// the runtime environment.
export async function ensureHostHomeDir(
  environment: Environment | undefined,
): Promise<void> {
  await mkdir(hostHomeDir(environment), { recursive: true });
}

export async function ensureHostInstallDir(
  environment: Environment,
): Promise<void> {
  await mkdir(hostInstallDir(environment), { recursive: true });
}

export async function ensureHostStagingRoot(
  environment: Environment,
): Promise<void> {
  await mkdir(hostStagingRoot(environment), { recursive: true });
}

// Environment-aware CLI home mkdir. Non-environment callers pass undefined to
// get the shared root; environment-aware callers pass the runtime environment.
export async function ensureCliHomeDir(
  environment: Environment | undefined,
): Promise<void> {
  // 0o700 keeps the credentials file readable only by the current user
  // even if the file's own mode is later relaxed. Environment subdir
  // inherits these permissions.
  await mkdir(cliHomeDir(environment), { recursive: true, mode: 0o700 });
}
