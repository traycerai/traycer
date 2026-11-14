import { useQueryClient } from "@tanstack/react-query";
import { invalidateEnvironmentReads } from "@/hooks/environment/use-environment-cloud";
import { useCallback, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ReviewChoiceOutcome } from "@traycer-clients/shared/environment/environment-review";
import type { ConfigurationWriteIssue } from "@/components/settings/environment/configuration-write-issue";
import { TeamReadFailed } from "@/components/settings/environment/team-read-failed";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  stillLocalFromPlanes,
  type EnvironmentPlanes,
} from "@/components/settings/move/cohort-rows";
import { heldRowsFromReview } from "@/components/settings/move/held-from-review";
import {
  appliedOnHostNames,
  roomSharedLine,
  sharedInUseFromItems,
} from "@/components/settings/move/review-inventory";
import type { HeldApplyChoice } from "@/components/settings/move/retrospective-copy";
import {
  RetrospectiveSheet,
  type HeldRow,
  type StillLocalRow,
} from "@/components/settings/move/retrospective-sheet";
import { StopSharingSession } from "@/components/settings/move/stop-sharing-session";
import {
  planesFromStatus,
  planesOfferStopSharing,
} from "@/components/settings/move/status-planes";
import { useEnvironmentHostLists } from "@/hooks/bots/use-environment-host-lists-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentReviewHeldApplyMutation } from "@/hooks/environment/use-environment-review-held-apply-mutation";
import { useEnvironmentReviewRecordMutation } from "@/hooks/environment/use-environment-review-record-mutation";
import {
  useEnvironmentReviewRead,
  useEnvironmentStatusRead,
  type EnvironmentRead,
} from "@/hooks/environment/use-environment-reads";
import type { HostRpcRegistry } from "@/lib/host";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

/**
 * One opening of the sheet, and the held rows whose Approve authn refused in
 * it because the live value moved (`conflict`). Such a row offers no Approve
 * again until it shows the value it would replace, which no row draws yet
 * (board C22), so for now it keeps Discard only. A `gone` answer is not kept
 * here.
 */
interface SheetOpening {
  readonly open: boolean;
  readonly id: number;
  readonly conflicted: ReadonlySet<string>;
}

const NO_CONFLICTS: ReadonlySet<string> = new Set();

export function RetrospectiveSession(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly reviewHostId: string | null;
  readonly stopClient: HostClient<HostRpcRegistry> | null;
  readonly stopHostId: string | null;
  readonly hostName: string;
  readonly open: boolean;
  readonly held: readonly HeldRow[] | null;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const review = useEnvironmentReviewRead(
    props.client,
    props.reviewHostId,
    props.open && props.reviewHostId !== null,
  );
  const status = useEnvironmentStatusRead(
    props.stopClient,
    props.stopHostId,
    props.open && props.stopHostId !== null,
  );
  const appliedOn = useAppliedOnHosts(props.open);
  const record = useEnvironmentReviewRecordMutation(props.client);
  const entries = review.data?.entries ?? [];
  const heldApply = useEnvironmentReviewHeldApplyMutation(entries);
  const recordMutate = record.mutate;
  const queryClient = useQueryClient();
  const retryReview = (): void => {
    void invalidateEnvironmentReads(queryClient, ["environment.review"]);
  };
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);
  const [stopOpen, setStopOpen] = useState(false);
  const [opening, setOpening] = useState<SheetOpening>({
    open: props.open,
    id: 0,
    conflicted: NO_CONFLICTS,
  });

  const onShown = useCallback((): void => {
    recordMutate({ event: "shown" });
  }, [recordMutate]);

  const held = props.held ?? heldRowsFromReview(entries);
  const planes = status.data === null ? null : planesFromStatus(status.data);
  const { stillLocal, offerStop } = planeFacts(planes);
  // A team's computer is the team's: its local planes are not the person's
  // settings, so the sheet offers no move (`localRowCohort` has the same rule).
  const teamOwned = status.data?.principal?.kind === "team";
  const statusItems = status.data?.items ?? [];
  const sharedInUse = sharedInUseFromItems(statusItems);
  const roomShared = roomSharedLine(planes, statusItems);
  const evidence =
    review.data === null ? { version: null, at: null } : review.data.evidence;
  const heldPendingId = heldApply.isPending ? heldApply.variables.heldId : null;

  // A closed sheet starts its next opening with no row refused.
  if (opening.open !== props.open) {
    setOpening({
      open: props.open,
      id: opening.id + 1,
      conflicted: NO_CONFLICTS,
    });
  }
  const onHeldApply = (heldId: string, choice: HeldApplyChoice): void => {
    const openingId = opening.id;
    heldApply.mutate(
      { heldId, choice },
      {
        onSuccess: (answer) => {
          if (answer.outcome !== "conflict") return;
          setOpening((current) =>
            current.id === openingId
              ? {
                  ...current,
                  conflicted: new Set(current.conflicted).add(heldId),
                }
              : current,
          );
        },
      },
    );
  };

  return (
    <>
      <RetrospectiveSheet
        open={props.open}
        inventoryReady={inventoryReady(review, status, props.stopHostId)}
        hostName={props.hostName}
        evidence={evidence}
        sharedInUse={sharedInUse}
        roomShared={roomShared}
        appliedOn={appliedOn}
        held={held}
        stillLocal={stillLocal}
        heldPendingId={heldPendingId}
        heldApproveRefused={opening.conflicted}
        heldIssue={heldApplyIssue(heldApply.data)}
        inventoryRead={inventoryReadLine(review, props.hostName, retryReview)}
        onOpenChange={props.onOpenChange}
        onShown={onShown}
        onAcknowledged={() => {
          recordMutate({ event: "acknowledged" });
        }}
        onHeldApply={onHeldApply}
        // Each leads elsewhere, so the sheet closes first: what it says about
        // this computer is out of date once the move or the stop is done.
        onMoveToPersonal={
          teamOwned
            ? null
            : () => {
                if (props.stopHostId === null) return;
                props.onOpenChange(false);
                openMoveSheet({
                  hostId: props.stopHostId,
                  hostName: props.hostName,
                });
              }
        }
        onStopSharing={
          offerStop
            ? () => {
                props.onOpenChange(false);
                setStopOpen(true);
              }
            : null
        }
      />
      <StopSharingSession
        client={props.stopClient}
        hostId={props.stopHostId}
        hostName={props.hostName}
        open={stopOpen}
        onOpenChange={setStopOpen}
      />
    </>
  );
}

/**
 * Where the review read is, while it is read or once it fails: an inventory
 * with no rows would otherwise read as nothing on this computer.
 */
function inventoryReadLine(
  review: EnvironmentRead<unknown>,
  hostName: string,
  onRetry: () => void,
): ReactNode {
  if (review.isError)
    return (
      <TeamReadFailed
        message={`Couldn't read ${hostName}'s settings.`}
        onRetry={onRetry}
      />
    );
  if (review.supported === true && review.data === null)
    return <MutedAgentSpinner />;
  return null;
}

/**
 * A held-row choice's answer under the rows. `gone` and `conflict` draw
 * nothing here: the reread draws the row as it is now, or drops it.
 */
function heldApplyIssue(
  answer: ReviewChoiceOutcome | undefined,
): ConfigurationWriteIssue {
  return answer?.outcome === "forbidden" ? { kind: "forbidden" } : null;
}

/**
 * What the planes say on the sheet: the settings still on this computer, and
 * whether it can still stop using Personal (a computer that stopped has
 * nothing left to stop). Nothing of either before the planes are read.
 */
function planeFacts(planes: EnvironmentPlanes | null): {
  readonly stillLocal: readonly StillLocalRow[];
  readonly offerStop: boolean;
} {
  if (planes === null) return { stillLocal: [], offerStop: false };
  return {
    stillLocal: stillLocalFromPlanes(planes),
    offerStop: planesOfferStopSharing(planes),
  };
}

/**
 * Whether the inventory the sheet shows has loaded: the review has answered,
 * and the status read has answered or will not be asked (no host to read it
 * from, or a host that does not serve it).
 */
function inventoryReady(
  review: EnvironmentRead<unknown>,
  status: EnvironmentRead<unknown>,
  stopHostId: string | null,
): boolean {
  if (review.data === null) return false;
  return (
    stopHostId === null ||
    status.supported === false ||
    status.data !== null ||
    status.isError
  );
}

function useAppliedOnHosts(open: boolean): readonly string[] {
  const environments = useEnvironmentListQuery(open);
  const personalEnvironmentId =
    environments.data?.environments.find(
      (environment) => environment.ownerKind === "user",
    )?.environmentId ?? null;
  const hostLists = useEnvironmentHostLists(
    personalEnvironmentId === null ? [] : [personalEnvironmentId],
    open && personalEnvironmentId !== null,
  );
  if (personalEnvironmentId === null) return [];
  return appliedOnHostNames(
    hostLists.hostsByEnvironmentId.get(personalEnvironmentId) ?? [],
  );
}
