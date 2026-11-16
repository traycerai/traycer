import { useEffect, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import {
  configurationRoleOf,
  mayChangeConfiguration,
} from "@/components/settings/environment/configuration-source";
import { ConfigurationWriteFeedback } from "@/components/settings/environment/configuration-write-feedback";
import { TeamReadFailed } from "@/components/settings/environment/team-read-failed";
import { heldCommandLine } from "@/components/settings/move/held-from-review";
import {
  HELD_COMMAND_CHOICES,
  RETROSPECTIVE_GOT_IT,
  RETROSPECTIVE_HELD_COMMANDS,
  type HeldApplyChoice,
} from "@/components/settings/move/retrospective-copy";
import { HeldList } from "@/components/settings/move/retrospective-sheet";
import { TeamReviewValueReadout } from "@/components/settings/move/team-review-value";
import type { TeamReviewEntry } from "@/components/settings/move/team-review-values";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { environmentReadData } from "@/hooks/environment/environment-read-data";
import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";
import { useRereadConfigurationOnFocus } from "@/hooks/environment/use-reread-configuration-on-focus";
import {
  useTeamEnvironmentReviewApply,
  useTeamEnvironmentReviewRead,
  type TeamReviewMutation,
} from "@/hooks/environment/use-team-environment-review";
import type { EnvironmentReviewTarget } from "@/stores/settings/retrospective-sheet-store";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

interface RefusedRevision {
  readonly heldRevision: number;
  readonly liveRevision: number | null;
}

const NO_ENTRIES: readonly TeamReviewEntry[] = [];

/** An addressed account review, independent of any connected computer. */
export function TeamEnvironmentReviewSession(props: {
  readonly target: EnvironmentReviewTarget;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const { target } = props;
  const source = useEnvironmentCloud();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  // An opening belongs to this displayed sign-in, including same-person reentry.
  const [origin] = useState<EnvironmentCloud | null>(() =>
    source === null ? null : source(),
  );
  const current =
    props.open &&
    authorized &&
    viewerId === target.viewerId &&
    origin?.onOriginSignIn() === true;
  const review = useTeamEnvironmentReviewRead(target.environmentId, current);
  const directory = useEnvironmentListQuery(current);
  const environment = environmentReadData(directory)?.environments.find(
    (row) =>
      row.environmentId === target.environmentId &&
      row.ownerKind === "organization",
  );
  const canEdit =
    directory.isFetchedAfterMount &&
    directory.isSuccess &&
    environment !== undefined &&
    mayChangeConfiguration(configurationRoleOf(environment));
  const refetchDirectory = directory.refetch;
  useEffect(() => {
    if (current) void refetchDirectory();
  }, [current, refetchDirectory]);
  const entries = environmentReadData(review) ?? NO_ENTRIES;
  const ready =
    current && !review.isPending && !review.isFetching && !review.isError;
  const choice = useTeamEnvironmentReviewApply(
    target.environmentId,
    target.viewerId,
    ready && canEdit,
    entries,
  );
  const [refused, setRefused] = useState<ReadonlyMap<string, RefusedRevision>>(
    () => new Map(),
  );
  useRereadConfigurationOnFocus(current ? target.environmentId : null);
  const retry = (): void => {
    void Promise.all([review.refetch(), directory.refetch()]);
  };
  const approveRefused = new Set(
    entries.flatMap(({ entry }) => {
      const previous = refused.get(entry.entryId);
      return previous !== undefined &&
        previous.heldRevision === entry.heldRevision &&
        previous.liveRevision === entry.liveRevision
        ? [entry.entryId]
        : [];
    }),
  );
  const onChoice = (heldId: string, action: HeldApplyChoice): void => {
    const row = entries.find((entry) => entry.entry.entryId === heldId);
    if (
      !ready ||
      !canEdit ||
      row === undefined ||
      (action === "approve" && approveRefused.has(heldId))
    )
      return;
    const { heldRevision, liveRevision } = row.entry;
    choice.mutate(
      { heldId, choice: action },
      {
        onSuccess: (answer) => {
          if (!origin?.onOriginSignIn() || answer.outcome !== "conflict")
            return;
          setRefused((previous) =>
            new Map(previous).set(heldId, { heldRevision, liveRevision }),
          );
        },
      },
    );
  };
  if (!current) return null;
  return (
    <TeamReviewDialog
      target={target}
      open={props.open}
      onOpenChange={props.onOpenChange}
      review={review}
      choice={choice}
      roleFailed={directory.isError}
      entries={entries}
      ready={ready}
      canEdit={canEdit}
      approveRefused={approveRefused}
      onChoice={onChoice}
      retry={retry}
    />
  );
}

function TeamReviewDialog(props: {
  readonly target: EnvironmentReviewTarget;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly review: UseQueryResult<readonly TeamReviewEntry[], HostRpcError>;
  readonly choice: TeamReviewMutation;
  readonly roleFailed: boolean;
  readonly entries: readonly TeamReviewEntry[];
  readonly ready: boolean;
  readonly canEdit: boolean;
  readonly approveRefused: ReadonlySet<string>;
  readonly onChoice: (heldId: string, action: HeldApplyChoice) => void;
  readonly retry: () => void;
}): ReactNode {
  const {
    target,
    review,
    choice,
    entries,
    ready,
    canEdit,
    approveRefused,
    onChoice,
    retry,
  } = props;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        layout="banded"
        className="flex max-h-[min(85dvh,44rem)] w-[min(92vw,40rem)] flex-col overflow-hidden sm:max-w-none"
      >
        <DialogHeader>
          <DialogTitle>Review</DialogTitle>
          <DialogDescription>{target.environmentName}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5">
          <h3 className="text-ui-sm font-medium">
            {RETROSPECTIVE_HELD_COMMANDS}
          </h3>
          {review.isFetching ? <MutedAgentSpinner /> : null}
          {review.isError || props.roleFailed ? (
            <TeamReadFailed
              message="Couldn't read these settings."
              onRetry={retry}
            />
          ) : null}
          {entries.map((row) => {
            const line = heldCommandLine(row.entry);
            const readable =
              row.proposed?.kind !== "unreadable" &&
              row.current?.kind !== "unreadable";
            return (
              <HeldList
                key={row.entry.entryId}
                rows={[
                  {
                    heldId: row.entry.entryId,
                    name: line.name,
                    detail: line.clause,
                  },
                ]}
                actions={
                  ready && canEdit && readable ? HELD_COMMAND_CHOICES : []
                }
                pendingId={choice.isPending ? choice.variables.heldId : null}
                approveRefused={approveRefused}
                onHeldApply={onChoice}
                renderDetails={() => (
                  <div className="flex flex-col gap-3 text-ui-sm">
                    <TeamReviewValueReadout
                      entry={row.entry}
                      value={row.proposed}
                      onRetry={retry}
                    />
                    <div className="flex flex-col gap-1">
                      <h4 className="font-medium">Current</h4>
                      <TeamReviewValueReadout
                        entry={row.entry}
                        value={row.current}
                        onRetry={retry}
                      />
                    </div>
                  </div>
                )}
              />
            );
          })}
          <ConfigurationWriteFeedback
            issue={
              choice.data?.outcome === "forbidden"
                ? { kind: "forbidden" }
                : null
            }
          />
          {choice.isError ? (
            <p role="status" className="text-ui-sm text-muted-foreground">
              Couldn't apply that choice.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            onClick={() => props.onOpenChange(false)}
          >
            {RETROSPECTIVE_GOT_IT}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
