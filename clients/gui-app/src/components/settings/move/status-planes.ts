/**
 * `environment.status@1.1` fields P5 reads: `planes`, `returnedFromTeam`,
 * and `stoppedAt` when the host sends it. A 1.0 answer has no `planes`; the
 * caller draws no cohort or dated line (E4 greys that row).
 */
import type {
  EnvironmentStatusResponse,
  EnvironmentStatusResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentPlanes } from "@/components/settings/move/cohort-rows";

export function isStatusV11(
  status: EnvironmentStatusResponse,
): status is EnvironmentStatusResponseV11 {
  return "planes" in status;
}

/**
 * The three planes, or `null` when this answer predates 1.1 (the caller
 * must not invent them; E4 greys that row).
 */
export function planesFromStatus(
  status: EnvironmentStatusResponse,
): EnvironmentPlanes | null {
  if (!isStatusV11(status)) return null;
  return status.planes;
}

/** `status.returnedFromTeam.at`, or `null` when the field is missing. */
export function returnedFromTeamAt(
  status: EnvironmentStatusResponse,
): number | null {
  if (!isStatusV11(status)) return null;
  return status.returnedFromTeam === null ? null : status.returnedFromTeam.at;
}

/**
 * When this computer last stopped sharing (`environment.status@1.1`
 * `stoppedAt`), or `null` while it shares, never did, or predates 1.1.
 */
export function stoppedSharingAt(
  status: EnvironmentStatusResponse,
): number | null {
  if (!isStatusV11(status)) return null;
  return status.stoppedAt;
}

export function planesHaveSharedUnrecorded(planes: EnvironmentPlanes): boolean {
  return (
    planes.records === "shared_unrecorded" ||
    planes.broker === "shared_unrecorded" ||
    planes.room === "shared_unrecorded"
  );
}

/** A computer that has moved or was already shared can stop sharing. */
export function planesOfferStopSharing(planes: EnvironmentPlanes): boolean {
  const values = [planes.records, planes.broker, planes.room];
  return values.some(
    (state) => state === "moved" || state === "shared_unrecorded",
  );
}
