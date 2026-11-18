import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * What a surface that re-provides a picked host's transports may show: its
 * live content, a spinner, or a dead end.
 */
export type ScopedHostReadiness = "ready" | "connecting" | "unavailable";

/**
 * The gate every stream-backed surface with its own host picker applies before
 * rendering live content - the onboarding tour's two host-dependent acts and
 * the session-import dialog share it, because each re-derivation of these
 * three rules has eventually got one of them wrong.
 *
 * Gated on there being a PICK, not on the status alone: with no pick the
 * surface reads the host it has always read, and an `unreachable` blip on it
 * is not a reason to replace a working wizard with a notice about a machine
 * the user never chose. The same rule the usage popover applies for the same
 * reason.
 *
 * `streamOnPickedHost` is a second question from `scope.status`, and the
 * surface is wrong without it: `useScopedStreamBinding` fills its binding in
 * an EFFECT, so for at least the commit after a pick - and for as long as that
 * transport is null or closed - the subtree is still on the ambient stream
 * while the scope has already resolved to the new host. A scan, a wizard and
 * the run it starts all ride that transport, so rendering through the gap
 * would list host A's sessions, and import them, under host B's name. That
 * lag is `connecting`, never `unavailable`: nothing is wrong with the host,
 * the surface has simply not finished moving onto it.
 */
export function scopedHostReadiness(input: {
  readonly scope: HostScope;
  /** The user named a host, rather than following the one the surface opened on. */
  readonly hasExplicitPick: boolean;
  /** The stream transport beneath the surface is dialing the host the picker names. */
  readonly streamOnPickedHost: boolean;
}): ScopedHostReadiness {
  if (!input.hasExplicitPick) return "ready";
  if (input.scope.status === "connecting") return "connecting";
  if (!isHostScopeUsable(input.scope.status)) return "unavailable";
  return input.streamOnPickedHost ? "ready" : "connecting";
}
