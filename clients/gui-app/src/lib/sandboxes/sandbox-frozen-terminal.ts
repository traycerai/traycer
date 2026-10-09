import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";

/** The two host-list reads a frozen sandbox's surfaces are drawn from. */
export interface SandboxFrozenHostList {
  /** Re-reads the host directory, which the tile's frozen frame reads. */
  readonly refreshDirectory: () => Promise<unknown>;
  /** Invalidates the registry query, which the host picker's rows read. */
  readonly invalidateRegisteredHosts: () => Promise<unknown>;
}

/**
 * What a host's remote session ending terminally does for the host list.
 * Only `SANDBOX_FROZEN` acts: an attach-grant mint authn refused because the
 * sandbox ran out of credits. The frozen tile frame and the picker's frozen
 * row read the host list, not the session, so both are re-read to show it
 * frozen instead of leaving it looking awake. Any other fatal does nothing.
 *
 * Fire and forget: each read is started on its own, and neither a throw nor
 * a rejection from one stops the other or escapes into the session's close.
 */
export function refreshHostListOnSandboxFrozen(
  fatal: FatalErrorDetails,
  hostList: SandboxFrozenHostList,
): void {
  if (fatal.code !== "SANDBOX_FROZEN") return;
  startIgnoringFailure(hostList.refreshDirectory);
  startIgnoringFailure(hostList.invalidateRegisteredHosts);
}

function startIgnoringFailure(read: () => Promise<unknown>): void {
  try {
    read().catch(() => undefined);
  } catch {
    // A synchronous throw is a failed read like any other.
  }
}
