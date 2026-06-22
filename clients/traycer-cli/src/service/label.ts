import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import type { Environment } from "../runner/environment";

// A `ServiceLabel` namespaces an OS-service registration (LaunchAgent /
// systemd unit / Scheduled Task) so the production host and a
// non-production desktop session can co-exist on the same machine. The
// label id is collapsed to prod vs non-prod because the OS service namespace
// only needs those two slots, but `environment` preserves the exact runtime
// environment so status/stop/restart read the matching pid metadata.
//
// The service manifest never references the host binary directly - it
// invokes the stable per-user CLI binary with `host start` (the slot is
// baked into the CLI build via `config.environment`). That makes upgrades
// simple: replacing the install directory in-place is enough; the manifest
// never has to be rewritten.
export interface ServiceLabel {
  // Reverse-DNS service identifier (LaunchAgent label, systemd unit
  // basename, Scheduled Task identifier seed).
  readonly id: string;
  // Human-readable display name surfaced by the OS service UI.
  readonly displayName: string;
  // Exact runtime environment this label operates on.
  readonly environment: Environment;
}

const PRODUCTION_LABEL: ServiceLabel = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production",
};

const NON_PRODUCTION_LABEL = {
  id: "ai.traycer.host.dev",
  displayName: "Traycer Host (Dev)",
};

export function serviceLabelFor(environment: Environment): ServiceLabel {
  if (environment === "production") return PRODUCTION_LABEL;
  return { ...NON_PRODUCTION_LABEL, environment };
}

// Platform-specific manifest path (plist / unit / task XML).
// Windows Scheduled Tasks aren't filesystem-backed - we return the
// empty string as a sentinel; the Windows controller uses the task
// name for its identifier.
export function serviceManifestPath(label: ServiceLabel): string {
  const home = homedir();
  const platform = osPlatform();
  if (platform === "darwin") {
    return join(home, "Library", "LaunchAgents", `${label.id}.plist`);
  }
  if (platform === "win32") {
    return "";
  }
  return join(home, ".config", "systemd", "user", `${label.id}.service`);
}

// Windows Scheduled Task identifier. production = `\Traycer\Host`,
// non-production = `\Traycer\Host-Dev`.
export function windowsTaskName(label: ServiceLabel): string {
  const suffix = label.environment === "production" ? "Host" : "Host-Dev";
  return `\\Traycer\\${suffix}`;
}
