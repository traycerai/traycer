import { useCallback, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { stillLocalFromPlanes } from "@/components/settings/move/cohort-rows";
import { heldRowsFromReview } from "@/components/settings/move/held-from-review";
import { HeldSecretBindingDialog } from "@/components/settings/move/held-secret-binding-dialog";
import {
  appliedOnHostNames,
  roomSharedLine,
  sharedInUseFromItems,
} from "@/components/settings/move/review-inventory";
import type { HeldApplyChoice } from "@/components/settings/move/retrospective-copy";
import { reviewEvidence } from "@/components/settings/move/review-v11";
import {
  RetrospectiveSheet,
  type HeldRow,
} from "@/components/settings/move/retrospective-sheet";
import { StopSharingSession } from "@/components/settings/move/stop-sharing-session";
import { planesFromStatus } from "@/components/settings/move/status-planes";
import { useEnvironmentHostLists } from "@/hooks/bots/use-environment-host-lists-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentReviewHeldApplyMutation } from "@/hooks/environment/use-environment-review-held-apply-mutation";
import { useEnvironmentReviewRecordMutation } from "@/hooks/environment/use-environment-review-record-mutation";
import {
  useEnvironmentReviewRead,
  useEnvironmentStatusRead,
} from "@/hooks/environment/use-environment-reads";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

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
  const appliedOn = useAppliedOnHosts(
    props.client,
    props.reviewHostId,
    props.open,
  );
  const record = useEnvironmentReviewRecordMutation(props.client);
  const heldApply = useEnvironmentReviewHeldApplyMutation(props.client);
  const recordMutate = record.mutate;
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);
  const [stopOpen, setStopOpen] = useState(false);
  const [bindingHeld, setBindingHeld] = useState<{
    readonly id: string;
    readonly name: string;
  } | null>(null);

  const onShown = useCallback((): void => {
    recordMutate({ event: "shown" });
  }, [recordMutate]);

  const entries = review.data?.entries ?? [];
  const held = props.held ?? heldRowsFromReview(entries);
  const planes = status.data === null ? null : planesFromStatus(status.data);
  const stillLocal = planes === null ? [] : stillLocalFromPlanes(planes);
  const statusItems = status.data?.items ?? [];
  const sharedInUse = sharedInUseFromItems(statusItems);
  const roomShared = roomSharedLine(planes, statusItems);
  const evidence =
    review.data === null
      ? { version: null, at: null }
      : reviewEvidence(review.data);
  const heldPendingId = heldApply.isPending ? heldApply.variables.heldId : null;

  const onHeldApply = (heldId: string, choice: HeldApplyChoice): void => {
    if (choice === "secret") {
      const row = held.find((entry) => entry.heldId === heldId);
      if (row !== undefined) setBindingHeld({ id: heldId, name: row.name });
      return;
    }
    heldApply.mutate({ heldId, choice });
  };

  return (
    <>
      <RetrospectiveSheet
        open={props.open}
        hostName={props.hostName}
        evidence={evidence}
        sharedInUse={sharedInUse}
        roomShared={roomShared}
        appliedOn={appliedOn}
        held={held}
        stillLocal={stillLocal}
        heldPendingId={heldPendingId}
        onOpenChange={props.onOpenChange}
        onShown={onShown}
        onAcknowledged={() => {
          recordMutate({ event: "acknowledged" });
        }}
        onHeldApply={onHeldApply}
        onMoveToPersonal={() => {
          if (props.stopHostId !== null)
            openMoveSheet({
              hostId: props.stopHostId,
              hostName: props.hostName,
            });
        }}
        onStopSharing={() => setStopOpen(true)}
      />
      <StopSharingSession
        client={props.stopClient}
        hostId={props.stopHostId}
        hostName={props.hostName}
        open={stopOpen}
        onOpenChange={setStopOpen}
      />
      <HeldSecretBindingDialog
        open={bindingHeld !== null}
        heldId={bindingHeld?.id ?? ""}
        heldName={bindingHeld?.name ?? ""}
        pending={heldApply.isPending}
        onOpenChange={(open) => {
          if (!open) setBindingHeld(null);
        }}
        onApply={(request) => {
          heldApply.mutate(request, {
            onSuccess: () => setBindingHeld(null),
          });
        }}
      />
    </>
  );
}

function useAppliedOnHosts(
  client: HostClient<HostRpcRegistry>,
  reviewHostId: string | null,
  open: boolean,
): readonly string[] {
  const listSupported = useHostMethodSupport(reviewHostId, "environment.list");
  const environments = useEnvironmentListQuery(
    client,
    open && listSupported === true,
  );
  const personalEnvironmentId =
    environments.data?.environments.find(
      (environment) => environment.ownerKind === "user",
    )?.environmentId ?? null;
  const hostListSupported = useHostMethodSupport(
    reviewHostId,
    "environment.host.list",
  );
  const hostLists = useEnvironmentHostLists(
    client,
    personalEnvironmentId === null ? [] : [personalEnvironmentId],
    open && personalEnvironmentId !== null && hostListSupported === true,
  );
  if (personalEnvironmentId === null) return [];
  return appliedOnHostNames(
    hostLists.hostsByEnvironmentId.get(personalEnvironmentId) ?? [],
  );
}
