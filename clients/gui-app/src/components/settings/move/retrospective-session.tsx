import { useQueryClient } from "@tanstack/react-query";
import { invalidateEnvironmentReads } from "@/hooks/environment/use-environment-cloud";
import { useCallback, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentStatusResponseV13 } from "@traycer/protocol/host/environment-schemas";
import type { ReviewHeldEntry } from "@traycer-clients/shared/environment/environment-review";
import type { ConfigurationWriteIssue } from "@/components/settings/environment/configuration-write-issue";
import { TeamReadFailed } from "@/components/settings/environment/team-read-failed";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { stillLocalFromPlanes } from "@/components/settings/move/cohort-rows";
import { heldRowsFromReview } from "@/components/settings/move/held-from-review";
import {
  appliedOnHostNames,
  roomSharedLine,
  sharedInUseFromItems,
} from "@/components/settings/move/review-inventory";
import {
  DISCARD,
  HELD_COMMAND_CHOICES,
  keepOnComputerLabel,
  type HeldChoiceAction,
  type PersonalHeldChoice,
} from "@/components/settings/move/retrospective-copy";
import {
  RetrospectiveSheet,
  type HeldRow,
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
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
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
  const supportsKeep = useHostSupportsMethod(
    props.stopHostId,
    "environment.review.heldKeep",
  );
  const keepClient = supportsKeep ? props.stopClient : null;
  const heldApply = useEnvironmentReviewHeldApplyMutation(entries, keepClient);
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
  const { stillLocal, offerStop, teamOwned, sharedInUse, roomShared } =
    retrospectiveInventory(status.data);
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
  const onHeldApply = (heldId: string, choice: PersonalHeldChoice): void => {
    const openingId = opening.id;
    heldApply.mutate(
      { heldId, choice },
      {
        onSuccess: (answer) => {
          if (choice !== "approve" || answer.outcome !== "conflict") return;
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
        heldActions={(heldId) =>
          heldActions(
            entries.find((entry) => entry.entryId === heldId),
            keepClient === null ? null : props.stopHostId,
            props.hostName,
            teamOwned,
          )
        }
        heldIssue={heldApplyIssue(heldApply.data?.outcome)}
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

const DISCARD_VALUE = {
  choice: "discard",
  label: DISCARD,
  variant: undefined,
} as const;
const SHARE_VALUE = {
  choice: "approve",
  label: "Use everywhere",
  variant: "default",
} as const;

const NATIVE_KEPT_SETTING_KINDS: ReadonlySet<string> = new Set([
  "shell",
  "browser_agent_access",
  "agent_selection_guide",
  "agent_definition",
  "mcp_server",
  "fallback_policy",
  "pack_policy",
  "managed_profile",
]);

// Executable and unfamiliar kinds keep their approval labels without a Keep action.
const VALUE_REVIEW_KINDS: ReadonlySet<string> = new Set([
  "variable",
  "env_override",
  "browser_agent_access",
  "agent_memory",
  "agent_selection_guide",
  "fallback_policy",
  "pack_policy",
  "managed_profile",
  "sandbox_defaults",
  "storage_policy",
  "snapshot_policy",
]);

function heldActions(
  entry: ReviewHeldEntry | undefined,
  keepHostId: string | null,
  hostName: string,
  teamOwned: boolean,
): readonly HeldChoiceAction<PersonalHeldChoice>[] {
  if (entry === undefined || entry.sharingGeneration === null || teamOwned)
    return HELD_COMMAND_CHOICES;
  const keepableKind =
    entry.kind === "variable" ||
    entry.kind === "env_override" ||
    NATIVE_KEPT_SETTING_KINDS.has(entry.kind);
  if (!keepableKind || keepHostId === null || entry.hostId !== keepHostId) {
    return VALUE_REVIEW_KINDS.has(entry.kind)
      ? [DISCARD_VALUE, SHARE_VALUE]
      : HELD_COMMAND_CHOICES;
  }
  return [
    DISCARD_VALUE,
    {
      choice: "keep",
      label: keepOnComputerLabel(hostName),
      variant: undefined,
    },
    SHARE_VALUE,
  ];
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
function heldApplyIssue(outcome: string | undefined): ConfigurationWriteIssue {
  return outcome === "forbidden" ? { kind: "forbidden" } : null;
}

function retrospectiveInventory(status: EnvironmentStatusResponseV13 | null) {
  const planes = status === null ? null : planesFromStatus(status);
  const items = status?.items ?? [];
  return {
    stillLocal: planes === null ? [] : stillLocalFromPlanes(planes),
    offerStop: planes !== null && planesOfferStopSharing(planes),
    // A team's local planes are not the person's settings.
    teamOwned: status?.principal?.kind === "team",
    sharedInUse: sharedInUseFromItems(items),
    roomShared: roomSharedLine(planes, items),
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
