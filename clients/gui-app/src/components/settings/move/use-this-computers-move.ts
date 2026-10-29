import { planesHaveLocal } from "@/components/settings/move/cohort-rows";
import { planesFromStatus } from "@/components/settings/move/status-planes";
import type { ThisComputer } from "@/components/settings/move/this-computer";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { moveIsPastTheAccept } from "@/lib/environment/move-in-progress";

/**
 * Where this computer's own settings stand against Personal, from its own
 * `environment.status`:
 *
 * - `pending`: the status is still being read.
 * - `unknown`: this computer cannot answer - no local host, a host without
 *   the method or its planes, or a first read that failed. Nothing is claimed
 *   from it; a surface that invites the move leaves the invitation out.
 * - `not_moved`: a plane is still this computer's own, or stopped, and no
 *   move is running: there is something to invite.
 * - `moved`: the settings are in Personal, or a move into it is under way.
 *
 * The planes answer this, NOT `status.consent`. The consent on the wire is
 * the migration marker's, and `Stop sharing from this computer` keeps that
 * marker while first start waits to be asked again
 * (`lib/environment/move-in-progress.ts` has the host references): keyed on
 * the consent, a computer that stopped sharing would read `moved` and the
 * Getting started card would say Complete over a computer sharing nothing.
 *
 * A move that stopped partway is past the accept, so it reads `moved` and
 * this invitation stays quiet: the Overview is already asking that person to
 * Retry, and two surfaces asking differently for the same thing is noise.
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
  if (moveIsPastTheAccept(status.data)) return "moved";
  return planesHaveLocal(planes) ? "not_moved" : "moved";
}
