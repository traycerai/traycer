import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import type { Environment } from "../runner/environment";
import { devDesktopSlotForEnvironment } from "../store/dev-desktop-slot";

// A `ServiceLabel` namespaces an OS-service registration (LaunchAgent /
// systemd unit / Scheduled Task) so hosts for different environments can
// co-exist on the same machine. The label id is derived per environment
// (`ai.traycer.host.<environment>`, with production keeping the bare
// `ai.traycer.host`), so each channel owns an isolated slot and `environment`
// still names the exact runtime so status/stop/restart read the matching pid
// metadata.
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
  // The dev-desktop run slot baked into `id`/`displayName`, or `null` when
  // this label isn't slot-specific. First-class so consumers (e.g.
  // `windowsTaskName`) never have to re-derive it by re-parsing `id`.
  readonly devSlot: string | null;
}

const PRODUCTION_LABEL: ServiceLabel = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production",
  devSlot: null,
};

// Each non-production environment gets its OWN service slot
// (`ai.traycer.host.<environment>`), mirroring the per-environment install
// tree (`~/.traycer/<component>/<environment>/`). Collapsing them onto a
// single shared label would make distinct channels - e.g. the `dev` channel
// from `make dev-desktop` and an internal `staging` dogfood build - fight over
// the same LaunchAgent id and plist path, and would make status/stop/uninstall
// for one channel silently act on the other.
function capitalizeEnvironment(environment: Environment): string {
  if (environment.length === 0) return environment;
  return environment.charAt(0).toUpperCase() + environment.slice(1);
}

export function serviceLabelFor(environment: Environment): ServiceLabel {
  if (environment === "production") return PRODUCTION_LABEL;
  const devSlot = devDesktopSlotForEnvironment(environment, process.env);
  if (devSlot !== null) {
    return {
      id: `ai.traycer.host.dev.${devSlot}`,
      displayName: `Traycer Host (Dev ${devSlot})`,
      environment,
      devSlot,
    };
  }
  return {
    id: `ai.traycer.host.${environment}`,
    displayName: `Traycer Host (${capitalizeEnvironment(environment)})`,
    environment,
    devSlot: null,
  };
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
// non-production = `\Traycer\Host-<Environment>` (e.g. `Host-Dev`,
// `Host-Staging`).
export function windowsTaskName(label: ServiceLabel): string {
  if (label.environment === "production") return "\\Traycer\\Host";
  if (label.devSlot !== null) {
    return `\\Traycer\\Host-Dev-${capitalizeEnvironment(label.devSlot)}`;
  }
  return `\\Traycer\\Host-${capitalizeEnvironment(label.environment)}`;
}
