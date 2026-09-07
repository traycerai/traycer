import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

/** The invariant every consumer owes: a visible host name must always match the client used by every read,
 * stream and mutation beneath it. When that cannot be proven, render loading or unavailable. */
export type HostScopeStatus =
  | "following"
  | "connecting"
  | "unreachable"
  | "vanished"
  | "ready";

/** The gate decides what is rendered; this decides what is mounted, and the difference is the whole point. */
export function isHostScopeUsable(status: HostScopeStatus): boolean {
  return status === "following" || status === "ready";
}

export interface HostListOutcome {
  readonly hasData: boolean;
  readonly isError: boolean;
}

export interface HostListReadiness {
  readonly resolved: boolean;
  readonly failed: boolean;
}

/** Treating only data as settled left `resolved` false forever on a failed request, so a pinned host that was
 * genuinely gone sat in `connecting` until the app restarted. */
export function hostListReadiness(
  directory: HostListOutcome,
  registry: HostListOutcome,
): HostListReadiness {
  return {
    resolved:
      (directory.hasData || directory.isError) &&
      (registry.hasData || registry.isError),
    failed: directory.isError || registry.isError,
  };
}

/** The status derivation. */
export function deriveHostScopeStatus(input: {
  readonly isFollowing: boolean;
  readonly host: HostScopeOption | null;
  readonly vanishedHostId: string | null;
  readonly overrideClient: HostClient<HostRpcRegistry> | null;
  readonly hasRequestAuthority: boolean;
  readonly listsResolved: boolean;
}): HostScopeStatus {
  if (input.vanishedHostId !== null) return "vanished";
  // No host and no answer yet from the lists is the one genuine pending state this surface has: a cold Settings
  // before either source has replied.
  if (input.host === null) {
    return input.listsResolved ? "unreachable" : "connecting";
  }
  // No route exists and none is being built - this is terminal, not pending, and must not render as a spinner
  // that never resolves.
  if (!input.host.connectable) return "unreachable";
  if (input.isFollowing) return "following";
  if (input.overrideClient !== null) return "ready";
  // The transient client is built synchronously (`createRequester` is a Proxy), so the only way to get here is a
  // missing request context or unbound user: signed out.
  return input.hasRequestAuthority ? "connecting" : "unreachable";
}
