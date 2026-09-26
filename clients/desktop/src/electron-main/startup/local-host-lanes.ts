import { log } from "../app/logger";
import type { LocalHostCapability } from "../../ipc-contracts/host-lifecycle-types";

/**
 * The deferred startup work that exists only for a LOCAL host: each one
 * discovers, watches, repairs, updates or starts the host on this machine.
 * A desktop booted in the lifecycle policy's `none` mode runs none of them
 * (host lifecycle modes, "No local host mode"), and the list is the one place
 * that says which lanes that is - a new local-host lane added outside it
 * would run in `none` mode.
 */
export const LOCAL_HOST_LANE_NAMES = [
  // `applyHostUpdateMenuState` from the controller's status broadcast.
  "host-update-menu-state",
  // `bootstrapHostWithInstallState`: pid.json discovery and its watcher.
  "host-watcher",
  // `startHostHealthMonitor` → `respawnIfDown` → `recoverIfDown`.
  "health-monitor",
  // macOS: the durable service-registration owner record.
  "substrate-owner-backfill",
  // macOS: `applyPendingLoginItemRevisionIfIdle` on its poll.
  "pending-login-item-revision-monitor",
  // macOS: retire a competing LaunchAgent registration.
  "competing-registration-repair",
  // The launch registry probe (and its background `stageLatest`).
  "registry-probe",
  // `runLaunchTimeCliReconciliation`.
  "cli-reconcile",
  // The hourly registry backstop.
  "registry-periodic-refresh",
] as const;

export type LocalHostLaneName = (typeof LOCAL_HOST_LANE_NAMES)[number];

/**
 * One starter per lane, keyed by name: a `Record` over the whole list, so a
 * lane added to {@link LOCAL_HOST_LANE_NAMES} without a starter - or a starter
 * with no entry there - fails to compile.
 */
export type LocalHostLaneStarters = Readonly<
  Record<LocalHostLaneName, () => void>
>;

/**
 * Start every lane, in {@link LOCAL_HOST_LANE_NAMES} order, when this
 * instance runs the local-host lanes, and none of them in `none` mode.
 * Returns the names it started, so the gate is assertable on its own.
 */
export function startLocalHostLanes(
  capability: LocalHostCapability,
  starters: LocalHostLaneStarters,
): readonly LocalHostLaneName[] {
  if (capability === "none") {
    log.info("[startup] local host lanes skipped", {
      reason: "no-local-host",
    });
    return [];
  }
  const started: LocalHostLaneName[] = [];
  for (const name of LOCAL_HOST_LANE_NAMES) {
    starters[name]();
    started.push(name);
  }
  return started;
}
