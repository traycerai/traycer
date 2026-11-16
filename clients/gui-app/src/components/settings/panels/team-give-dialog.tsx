import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentMoveOutcomeAnswer } from "@traycer/protocol/host/environment/move-contracts";
import {
  TEAM_TRANSFER_DISCLOSURE,
  TEAM_TRANSFER_DISCLOSURE_VERSION,
} from "@traycer/protocol/host/environment/team-transfer-disclosure";
import { needsUpdateSubtitle } from "@/components/settings/environment/environment-picker-model";
import {
  giveNotFinishedLine,
  TEAM_TRANSFER_NOT_CONFIRMED,
} from "@/components/settings/panels/team-give-copy";
import { ClaimRunningWork } from "@/components/settings/team/claim-running-work";
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
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";

/**
 * Giving a computer the person owns to one of their teams, from this app
 * whether or not it runs on that computer. The computer computes what the
 * give is (`environment.move.plan` for the team), the person reads the
 * disclosure and confirms, and the confirm stages, records the acceptance at
 * authn and starts it (`useEnvironmentMoveStartMutation`). A give uploads
 * nothing and has no per-row choice, so it stages no choices. Until the
 * computer answers `done`, the dialog reads the attempt's outcome from
 * `environment.status@1.3`'s `move`, on that read's own poll: the give adds
 * no timer of its own. A done attempt is reported as given only after one
 * fresh authn read confirms that this computer belongs to the chosen team,
 * on the sign-in that confirmed the give.
 *
 * A computer whose disclosure is another version than this app's shows the
 * needs-an-update line and no confirm. One that answers `needs_person`, or no
 * longer holds the attempt, shows C7's line with the confirm beside it. A
 * status answer naming no attempt, or another one, says the attempt is not
 * held only when it was read after the start answered; one read before could
 * still name the previous attempt.
 *
 * Beside the disclosure and outside its hashed text, the computer's own count
 * of the chats running on it under its current owner (`ClaimRunningWork`,
 * shared with the claim confirm), asked each time the dialog opens.
 *
 * Mounted while a team is chosen, keyed by it, so every give starts afresh.
 */
export function TeamGiveDialog(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly hostName: string;
  /** The environment the computer is in now, whose running chats the give stops. */
  readonly currentEnvironmentId: string | null;
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
  const runtime = useHostBinding();
  const plan = useHostQuery<HostRpcRegistry, "environment.move.plan">({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "environment.move.plan",
    // A give hands the computer nothing of Personal.
    params: { target, personal: null },
    options: { refetchOnWindowFocus: false },
  });
  const start = useEnvironmentMoveStartMutation(props.client, null);
  const [attempt, setAttempt] = useState<GiveAttempt | null>(null);
  const [notFinished, setNotFinished] = useState(false);
  const originAttempt = shownGiveAttempt(
    attempt,
    props.hostId,
    team.environmentId,
  );
  const { given, ended, reread } = useGiveAttempt(
    originAttempt?.press.client ?? props.client,
    originAttempt,
  );
  const ownership = useGiveOwnership(attempt, originAttempt, given);

  const settle = (
    answer: EnvironmentMoveOutcomeAnswer,
    press: GivePress,
  ): void => {
    if (answer.state === "needs_person" || answer.state === "not_found") {
      setNotFinished(true);
      return;
    }
    // `done` reads the same through the status as `running`, so one path
    // ends the give. The re-read cancels one already in flight, so every
    // answer after `startedAt` was asked after the start.
    setAttempt({ attemptId: answer.attemptId, startedAt: Date.now(), press });
    reread();
  };
  const confirm = (planHash: string): void => {
    if (runtime === null) return;
    const userId = runtime.auth.currentAuthEra().identity;
    const operation = runtime.auth.environmentCloud();
    if (userId === null || !operation.onOriginSignIn()) return;
    const press: GivePress = {
      runtime,
      operation,
      userId,
      client: props.client,
      hostId: props.hostId,
      team,
      onGiven: props.onGiven,
    };
    setAttempt(null);
    setNotFinished(false);
    start.mutate(
      {
        hostId: props.hostId,
        target,
        planHash,
        keyChoices: [],
        personal: null,
      },
      {
        onSuccess: (result) => {
          if (
            result.kind === "sign_in_changed" ||
            !press.operation.onOriginSignIn()
          )
            return;
          if (result.kind === "started") settle(result.outcome, press);
          else {
            setNotFinished(true);
            void plan.refetch().catch(ignoreError);
          }
        },
      },
    );
  };

  const giving =
    start.isPending ||
    (originAttempt !== null && !given && !ended) ||
    (originAttempt !== null && ownership.isFetching);
  const startError = start.isError ? start.error.message : null;
  const ownershipNotConfirmed =
    originAttempt !== null && ownership.data === "not_confirmed";
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
        <ClaimRunningWork
          hostId={props.hostId}
          environmentId={props.currentEnvironmentId}
        />
        <GiveLines
          hostName={props.hostName}
          teamLabel={team.label}
          versionDiffers={versionDiffers}
          planError={plan.isError ? plan.error.message : null}
          onRetryPlan={() => void plan.refetch().catch(ignoreError)}
          notFinished={notFinished || ended}
          startError={
            ownershipNotConfirmed ? TEAM_TRANSFER_NOT_CONFIRMED : startError
          }
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

interface GivePress {
  readonly runtime: HostRuntimeBinding<HostRpcRegistry>;
  readonly operation: EnvironmentCloud;
  readonly userId: string;
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly team: EnvironmentDescriptorV11;
  readonly onGiven: (team: EnvironmentDescriptorV11) => void;
}

interface GiveAttempt {
  readonly attemptId: string;
  readonly startedAt: number;
  readonly press: GivePress;
}

type GiveOwnership = "confirmed" | "not_confirmed" | "sign_in_changed";

function shownGiveAttempt(
  attempt: GiveAttempt | null,
  hostId: string,
  environmentId: string,
): GiveAttempt | null {
  return attempt !== null &&
    attempt.press.hostId === hostId &&
    attempt.press.team.environmentId === environmentId &&
    attempt.press.operation.onOriginSignIn()
    ? attempt
    : null;
}

function useGiveOwnership(
  attempt: GiveAttempt | null,
  originAttempt: GiveAttempt | null,
  given: boolean,
): UseQueryResult<GiveOwnership> {
  const queryClient = useQueryClient();
  const ownership = useQuery(
    // The immutable attempt id owns its private press capture, not cache data.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryOptions<GiveOwnership>({
      queryKey: authQueryKeys.hostOwnershipAfterMove(
        attempt?.press.runtime.auth ?? null,
        attempt?.press.userId ?? null,
        attempt?.press.hostId ?? null,
        attempt?.attemptId ?? null,
      ),
      queryFn: async () => {
        if (attempt === null) return "sign_in_changed";
        const { press } = attempt;
        if (!press.operation.onOriginSignIn()) return "sign_in_changed";
        const era = press.runtime.auth.currentAuthEra();
        if (era.identity !== press.userId) return "sign_in_changed";
        try {
          const result = await press.runtime.auth.readHostOwnership(
            press.hostId,
            era,
          );
          if (!press.operation.onOriginSignIn()) return "sign_in_changed";
          return result.kind === "ok" &&
            result.host.hostId === press.hostId &&
            result.host.owner.kind === "team" &&
            result.host.owner.id === press.team.ownerId
            ? "confirmed"
            : "not_confirmed";
        } catch {
          return press.operation.onOriginSignIn()
            ? "not_confirmed"
            : "sign_in_changed";
        }
      },
      // One read for this attempt, never an earlier Overview read or a poll.
      enabled: (query) =>
        given &&
        attempt !== null &&
        attempt.press.operation.onOriginSignIn() &&
        query.state.data === undefined,
      retry: false,
      staleTime: Infinity,
      gcTime: 0,
      refetchOnMount: false,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
    }),
  );
  const givenOnce = useRef(false);
  useEffect(() => {
    if (
      !given ||
      ownership.data !== "confirmed" ||
      givenOnce.current ||
      attempt === null ||
      originAttempt === null ||
      !attempt.press.operation.onOriginSignIn()
    )
      return;
    givenOnce.current = true;
    void queryClient.invalidateQueries({
      queryKey: authQueryKeys.hostOwnershipAll(),
    });
    void attempt.press.runtime.directory.refresh();
    attempt.press.onGiven(attempt.press.team);
  }, [attempt, given, originAttempt, ownership.data, queryClient]);
  return ownership;
}

/**
 * Where the started give stands, from `environment.status`'s `move` on that
 * read's own poll. `reread` asks again at once, cancelling a read in flight.
 */
function useGiveAttempt(
  client: HostClient<HostRpcRegistry>,
  attempt: GiveAttempt | null,
): { readonly given: boolean; readonly ended: boolean; reread: () => void } {
  const status = useHostQuery<HostRpcRegistry, "environment.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.status",
    params: {},
    options: { enabled: attempt !== null, poll: true },
  });
  const move = status.data?.move ?? null;
  const own =
    attempt !== null && move?.attemptId === attempt.attemptId ? move : null;
  const notHeld =
    attempt !== null &&
    own === null &&
    status.data !== undefined &&
    status.dataUpdatedAt > attempt.startedAt;
  return {
    given: own?.state === "done",
    ended: own?.state === "needs_person" || notHeld,
    reread: () => void status.refetch().catch(ignoreError),
  };
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
