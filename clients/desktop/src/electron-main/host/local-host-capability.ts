import type { HostLifecycleMode } from "@traycer/protocol/config/host-lifecycle-policy";
import type { LocalHostCapability } from "../../ipc-contracts/host-lifecycle-types";

/**
 * The local-host capability this desktop instance booted with.
 *
 * Read from the lifecycle policy ONCE, before any host lane or IPC handler
 * exists, and pinned for the life of the process: a `none` machine runs no
 * local host, and turning the lanes on or off again is restart-to-apply (the
 * mode's own contract, "Restart Traycer to apply"). A module-level value for
 * the same reason `setActiveEnvironment` is one - it is a boot fact that the
 * fleet source, the ensure port and the host IPC handlers all consult, and
 * threading it through `RunnerIpcBridge`'s options would widen a surface
 * every IPC suite constructs.
 *
 * Defaults to `managed`, which is exactly the behaviour before this record
 * existed, so a code path (or a test) that never pins it keeps the lanes on.
 */
let applied: LocalHostCapability = "managed";

export function localHostCapabilityForMode(
  mode: HostLifecycleMode,
): LocalHostCapability {
  return mode === "none" ? "none" : "managed";
}

/** Pinned by desktop startup once, before the IPC bridge is installed. */
export function setAppliedLocalHostCapability(
  capability: LocalHostCapability,
): void {
  applied = capability;
}

export function appliedLocalHostCapability(): LocalHostCapability {
  return applied;
}
