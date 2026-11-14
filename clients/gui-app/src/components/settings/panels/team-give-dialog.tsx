import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentMoveOutcomeAnswer } from "@traycer/protocol/host/environment/move-contracts";
import {
  TEAM_TRANSFER_DISCLOSURE,
  TEAM_TRANSFER_DISCLOSURE_VERSION,
} from "@traycer/protocol/host/environment/team-transfer-disclosure";
import { needsUpdateSubtitle } from "@/components/settings/environment/environment-picker-model";
import { giveNotFinishedLine } from "@/components/settings/panels/team-give-copy";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEnvironmentMoveStartMutation } from "@/hooks/environment/use-environment-move-start-mutation";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { authQueryKeys } from "@/lib/query-keys";

/**
 * Giving a computer the person owns to one of their teams, from this app
 * whether or not it runs on that computer. The computer computes what the
 * give is (`environment.move.plan` for the team), the person reads the
 * disclosure and confirms, and the confirm stages, records the acceptance at
 * authn and starts it (`useEnvironmentMoveStartMutation`). A give uploads
 * nothing and has no per-row choice, so it stages no choices. Until the
 * computer answers `done`, the dialog reads the attempt's outcome.
 *
 * A computer whose disclosure is another version than this app's shows the
 * needs-an-update line and no confirm. One that answers `needs_person`, or no
 * longer holds the attempt, shows C7's line with the confirm beside it.
 *
 * Mounted while a team is chosen, keyed by it, so every give starts afresh.
 */
export function TeamGiveDialog(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly hostName: string;
  readonly team: EnvironmentDescriptorV11;
  readonly onClose: () => void;
  readonly onGiven: (team: EnvironmentDescriptorV11) => void;
}): ReactNode {
  const { team } = props;
  const target = {
    kind: "team",
    environmentId: team.environmentId,
    teamId: team.ownerId,
  } as const;
  const queryClient = useQueryClient();
  const runtime = useHostBinding();
  const plan = useHostQuery<HostRpcRegistry, "environment.move.plan">({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "environment.move.plan",
    params: { target },
    options: { refetchOnWindowFocus: false },
  });
  const start = useEnvironmentMoveStartMutation(props.client, null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [notFinished, setNotFinished] = useState(false);
  const outcome = useHostQuery<HostRpcRegistry, "environment.move.outcome">({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "environment.move.outcome",
    params: { attemptId: attemptId ?? "" },
    options: { enabled: attemptId !== null, poll: true },
  });
  const polled = attemptId === null ? undefined : outcome.data?.state;
  const given = polled === "done";
  const ended = polled === "needs_person" || polled === "not_found";
  const givenOnce = useRef(false);
  const { onGiven } = props;
  useEffect(() => {
    if (!given || givenOnce.current) return;
    givenOnce.current = true;
    void queryClient.invalidateQueries({
      queryKey: authQueryKeys.hostOwnershipAll(),
    });
    void runtime?.directory.refresh();
    onGiven(team);
  }, [given, onGiven, queryClient, runtime, team]);

  const settle = (answer: EnvironmentMoveOutcomeAnswer): void => {
    if (answer.state === "needs_person" || answer.state === "not_found") {
      setNotFinished(true);
      return;
    }
    // `done` reads the same through the outcome as `running`, so one path
    // ends the give.
    setAttemptId(answer.attemptId);
  };
  const confirm = (planHash: string): void => {
    setAttemptId(null);
    setNotFinished(false);
    start.mutate(
      { hostId: props.hostId, target, planHash, keyChoices: [] },
      {
        onSuccess: (result) => {
          if (result.kind === "started") settle(result.outcome);
          else {
            setNotFinished(true);
            void plan.refetch().catch(ignoreError);
          }
        },
      },
    );
  };

  const giving = start.isPending || (attemptId !== null && !given && !ended);
  const versionDiffers =
    plan.data !== undefined &&
    plan.data.disclosureVersion !== TEAM_TRANSFER_DISCLOSURE_VERSION;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !giving) props.onClose();
      }}
    >
      <DialogContent className="w-full sm:max-w-prose">
        <DialogHeader>
          <DialogTitle>
            Use {props.hostName} for {team.label}?
          </DialogTitle>
          <DialogDescription>
            The team will own this computer. Any member of the team can claim it
            as their own. Traycer restarts once on this computer.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-2 pl-5 text-ui-sm">
          {TEAM_TRANSFER_DISCLOSURE.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <GiveLines
          hostName={props.hostName}
          teamLabel={team.label}
          versionDiffers={versionDiffers}
          planError={plan.isError ? plan.error.message : null}
          onRetryPlan={() => void plan.refetch().catch(ignoreError)}
          notFinished={notFinished || ended}
          startError={start.isError ? start.error.message : null}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={giving}
            onClick={props.onClose}
          >
            Cancel
          </Button>
          {versionDiffers ? null : (
            <Button
              type="button"
              disabled={giving || plan.data === undefined}
              onClick={() => {
                if (plan.data !== undefined) confirm(plan.data.planHash);
              }}
            >
              {giving ? (
                <AgentSpinningDots
                  className={undefined}
                  testId="team-computer-transfer-progress"
                  variant={undefined}
                />
              ) : null}
              Confirm at this computer
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What the dialog says beside the disclosure, each only while it is true. */
function GiveLines(props: {
  readonly hostName: string;
  readonly teamLabel: string;
  readonly versionDiffers: boolean;
  readonly planError: string | null;
  readonly onRetryPlan: () => void;
  readonly notFinished: boolean;
  readonly startError: string | null;
}): ReactNode {
  return (
    <>
      {props.versionDiffers ? (
        <p className="text-ui-sm text-muted-foreground">
          {needsUpdateSubtitle(props.hostName)}
        </p>
      ) : null}
      {props.planError === null ? null : (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-ui-sm text-warning-foreground"
        >
          <span className="min-w-0">{props.planError}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={props.onRetryPlan}
          >
            Retry
          </Button>
        </div>
      )}
      {props.notFinished ? (
        <p
          role="alert"
          className="text-ui-sm text-destructive"
          data-testid="team-give-not-finished"
        >
          {giveNotFinishedLine(props.teamLabel)}
        </p>
      ) : null}
      {props.startError === null ? null : (
        <p role="alert" className="text-ui-sm text-destructive">
          {props.startError}
        </p>
      )}
    </>
  );
}
