import { planesNotMoved } from "@/components/settings/move/cohort-rows";
import { planesFromStatus } from "@/components/settings/move/status-planes";
import type { ThisComputer } from "@/components/settings/move/this-computer";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";

/**
 * Where this computer's own settings stand against Personal, from its own
 * `environment.status`:
 *
 * - `pending`: the status is still being read.
 * - `unknown`: this computer cannot answer - no local host, a host without
 *   the method or its planes, or a first read that failed. Nothing is claimed
 *   from it; a surface that invites the move leaves the invitation out.
 * - `not_moved`: nothing has moved and the move still waits for the person.
 * - `moved`: the person accepted the move, or the settings are in Personal
 *   already.
 *
 * A re-read that fails keeps the last answer, which is what the status read
 * does: otherwise one failed read would take an unpressed invitation away.
 */
export type ThisComputersMove = "pending" | "unknown" | "not_moved" | "moved";

export function useThisComputersMove(
  computer: ThisComputer,
  enabled: boolean,
): ThisComputersMove {
  const status = useEnvironmentStatusRead(
    computer.client,
    computer.hostId,
    enabled,
  );
  if (!enabled || computer.hostId === null) return "unknown";
  if (status.supported === false) return "unknown";
  if (status.data === null) return status.isError ? "unknown" : "pending";
  const planes = planesFromStatus(status.data);
  if (planes === null) return "unknown";
  if (status.data.consent !== null) return "moved";
  return planesNotMoved(planes, status.data.pendingUploads.length > 0)
    ? "not_moved"
    : "moved";
}
