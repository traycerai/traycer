import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";

/** Renderer-side seam for "the fleet changed; the authority must re-read it" (redesign P1.2 fixup F6). */
export type FleetRefreshCapableShell = Pick<IRunnerHost, "refreshHostFleet">;

/** Announce that this account's host fleet changed. */
export function requestFleetRefresh(shell: FleetRefreshCapableShell): void {
  void shell.refreshHostFleet().catch(() => undefined);
}
