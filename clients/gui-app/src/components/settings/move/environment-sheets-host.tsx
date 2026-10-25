import { useEffect, type ReactNode } from "react";
import { MoveSheet } from "@/components/settings/move-sheet";
import { RetrospectiveSession } from "@/components/settings/move/retrospective-session";
import { isReviewV11 } from "@/components/settings/move/review-v11";
import { statusPlanesSupported } from "@/components/settings/move/status-planes-supported";
import { planesHaveSharedUnrecorded } from "@/components/settings/move/status-planes";
import { useThisComputer } from "@/components/settings/move/this-computer";
import {
  useEnvironmentReviewRead,
  useEnvironmentStatusRead,
} from "@/hooks/environment/use-environment-reads";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";

/**
 * The environment sheets, mounted once for the whole app rather than inside
 * Settings: the retrospective sheet has to open by itself on the first launch
 * after the update, whatever the window shows, and both it and the move sheet
 * are opened from outside Settings too (the Start toast, the retrospective
 * sheet's `Move to Personal`).
 */
export function EnvironmentSheetsHost(): ReactNode {
  return (
    <>
      <RetrospectiveShowOnce />
      <RetrospectiveSheetFromStore />
      <MoveSheet />
    </>
  );
}

/**
 * Shown once on a computer whose settings an earlier version uploaded
 * (design, first run and the move › The retrospective sheet): this computer
 * has a plane `shared_unrecorded` and its `environment.review@1.1` record
 * says the sheet was never shown. The sheet records `shown` when it renders,
 * so the next launch finds `shownAt` and opens nothing. Decided once per
 * computer per window; a host below `environment.status@1.1` has no planes
 * and is never asked.
 */
function RetrospectiveShowOnce(): ReactNode {
  const computer = useThisComputer();
  const checked = useRetrospectiveSheetStore((state) =>
    computer.hostId === null ? true : state.checkedHostIds.has(computer.hostId),
  );
  const recordShowOnce = useRetrospectiveSheetStore(
    (state) => state.recordShowOnce,
  );
  const version = useHostNegotiatedMethodVersion(
    computer.client,
    "environment.status",
  );
  const enabled = !checked && statusPlanesSupported(version);
  const status = useEnvironmentStatusRead(
    computer.client,
    computer.hostId,
    enabled,
  );
  const review = useEnvironmentReviewRead(
    computer.client,
    computer.hostId,
    enabled,
  );
  const statusData = enabled ? status.data : null;
  const reviewData = enabled ? review.data : null;
  const decided = statusData !== null && reviewData !== null;
  const due =
    statusData !== null &&
    reviewData !== null &&
    planesHaveSharedUnrecorded(statusData.planes) &&
    isReviewV11(reviewData) &&
    reviewData.shownAt === null;
  const { hostId, hostName } = computer;
  useEffect(() => {
    if (!decided || hostId === null) return;
    recordShowOnce(hostId, due ? { hostId, hostName } : null);
  }, [decided, due, hostId, hostName, recordShowOnce]);
  return null;
}

function RetrospectiveSheetFromStore(): ReactNode {
  const target = useRetrospectiveSheetStore((state) => state.target);
  const open = useRetrospectiveSheetStore((state) => state.open);
  const closeSheet = useRetrospectiveSheetStore((state) => state.closeSheet);
  const hostId = target === null ? null : target.hostId;
  const named = useHostClientForHostId(hostId);
  // `null` resolves the window's following client, which is not the target.
  const client = hostId === null ? null : named;
  if (target === null || client === null) return null;
  return (
    <RetrospectiveSession
      key={target.hostId}
      client={client}
      reviewHostId={target.hostId}
      stopClient={client}
      stopHostId={target.hostId}
      hostName={target.hostName}
      open={open}
      held={null}
      onOpenChange={(next) => {
        if (!next) closeSheet();
      }}
    />
  );
}
