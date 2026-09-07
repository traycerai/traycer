import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/** What a surface that re-provides a picked host's transports may show: its live content, a spinner, or a dead
 * end. */
export type ScopedHostReadiness = "ready" | "connecting" | "unavailable";

/** Gated on there being a pick, not on the status alone. */
export function scopedHostReadiness(input: {
  readonly scope: HostScope;
  /** The user named a host, rather than following the one the surface opened on. */
  readonly hasExplicitPick: boolean;
  readonly streamOnPickedHost: boolean;
}): ScopedHostReadiness {
  if (!input.hasExplicitPick) return "ready";
  if (input.scope.status === "connecting") return "connecting";
  if (!isHostScopeUsable(input.scope.status)) return "unavailable";
  return input.streamOnPickedHost ? "ready" : "connecting";
}
