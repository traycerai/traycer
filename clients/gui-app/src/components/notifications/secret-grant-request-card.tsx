import { useState, type ReactNode } from "react";
import type { SecretRequestDecision } from "@traycer/protocol/host/sandbox-secrets";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { SecretsDashboardLink } from "@/components/providers/secrets-dashboard-link";
import {
  useSecretRequestDecide,
  type SecretRequestDecideOutcome,
} from "@/hooks/sandboxes/use-secret-request-decide-mutation";
import {
  secretGrantDecisions,
  secretGrantDefaultConfirmation,
  secretGrantRequestDestination,
  secretGrantRequestReason,
  secretRequestDecidedByLine,
  secretRequestStatusLine,
  type SecretsNotificationDetail,
} from "@/lib/notifications/secrets-notification-detail";

type GrantRequestDetail = Extract<
  SecretsNotificationDetail,
  { kind: "grant-request" }
>;

/**
 * An agent's request for a secret, on its notification row: what it asked
 * for, where it would be used, which sandbox and why, and the three answers.
 * The answer goes to the broker with the user's bearer; nothing is granted
 * without it.
 *
 * `resolved` is the row's own state (the host recorded an answer, from this
 * card, the dashboard or another admin of the team): the answers are then
 * withdrawn and the card says who answered, when the row names them.
 *
 * On a team request the wider approval names the team and asks first: it
 * reaches every current and future sandbox of the team.
 */
export function SecretGrantRequestCard(props: {
  readonly detail: GrantRequestDetail;
  readonly resolved: boolean;
}): ReactNode {
  const { detail } = props;
  const decide = useSecretRequestDecide(detail.environmentId, detail.requestId);
  const [confirmingDefault, setConfirmingDefault] = useState(false);
  const confirmation = secretGrantDefaultConfirmation(
    detail.teamName,
    detail.secretName,
  );
  const answer = (decision: SecretRequestDecision): void => {
    if (
      decision === "approve_default" &&
      confirmation !== null &&
      !confirmingDefault
    ) {
      setConfirmingDefault(true);
      return;
    }
    setConfirmingDefault(false);
    decide.mutate(decision);
  };
  const destination = secretGrantRequestDestination(detail);
  const reason = secretGrantRequestReason(detail.reason);
  const outcome = decide.data ?? null;
  // A decision that landed, or a request that turned out closed, ends the
  // card's part; `secret-required` does not - the user can store a secret
  // and answer again.
  const answerable =
    !props.resolved && (outcome === null || outcome.kind === "secret-required");
  return (
    <div
      data-testid="secret-grant-request-card"
      className="flex flex-col gap-1.5 text-ui-xs"
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">Secret</dt>
        <dd className="break-words" data-testid="secret-grant-request-secret">
          {detail.secretName ?? "None stored for this destination yet"}
        </dd>
        {destination === null ? null : (
          <>
            <dt className="text-muted-foreground">Destination</dt>
            <dd
              className="break-words"
              data-testid="secret-grant-request-destination"
            >
              {destination}
            </dd>
          </>
        )}
        {detail.sandboxName === null ? null : (
          <>
            <dt className="text-muted-foreground">Sandbox</dt>
            <dd className="break-words">{detail.sandboxName}</dd>
          </>
        )}
        {reason === null ? null : (
          <>
            <dt className="text-muted-foreground">Why</dt>
            <dd
              className="break-words whitespace-pre-wrap"
              data-testid="secret-grant-request-reason"
            >
              {reason}
            </dd>
          </>
        )}
      </dl>
      {props.resolved ? <ResolvedByLine detail={detail} /> : null}
      <SecretGrantOutcomeLine outcome={outcome} />
      {answerable && confirmingDefault && confirmation !== null ? (
        <div
          data-testid="secret-grant-request-confirm-default"
          className="flex flex-col gap-1.5"
        >
          <p>{confirmation}</p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={decide.isPending}
              data-testid="secret-grant-request-confirm-default-yes"
              onClick={() => answer("approve_default")}
            >
              Approve for all
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="secret-grant-request-confirm-default-cancel"
              onClick={() => setConfirmingDefault(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {answerable && !confirmingDefault ? (
        <div className="flex flex-wrap gap-1.5">
          {secretGrantDecisions(detail.teamName).map(({ decision, label }) => (
            <Button
              key={decision}
              type="button"
              size="sm"
              variant={decisionVariant(decision)}
              disabled={decide.isPending}
              data-testid={`secret-grant-request-${decision}`}
              onClick={() => answer(decision)}
            >
              {decide.isPending && decide.variables === decision ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={`secret-grant-request-${decision}-spinner`}
                  variant={undefined}
                />
              ) : null}
              {label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function decisionVariant(
  decision: SecretRequestDecision,
): "default" | "outline" | "ghost" {
  if (decision === "approve") return "default";
  return decision === "approve_default" ? "outline" : "ghost";
}

function SecretGrantOutcomeLine(props: {
  readonly outcome: SecretRequestDecideOutcome | null;
}): ReactNode {
  const { outcome } = props;
  if (outcome === null) return null;
  if (outcome.kind === "secret-required") {
    return (
      <div
        data-testid="secret-grant-request-outcome"
        data-outcome="secret-required"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-warning-foreground"
      >
        <p className="min-w-0">
          There is no secret stored for this destination yet, so there is
          nothing to grant.
        </p>
        <SecretsDashboardLink
          testId="secret-grant-request-open-secrets"
          className={undefined}
        />
      </div>
    );
  }
  return (
    <p
      data-testid="secret-grant-request-outcome"
      data-outcome={outcome.kind}
      className="text-muted-foreground"
    >
      {outcomeText(outcome)}
    </p>
  );
}

function outcomeText(
  outcome: Exclude<SecretRequestDecideOutcome, { kind: "secret-required" }>,
): string {
  switch (outcome.kind) {
    case "decided":
      return secretRequestStatusLine(outcome.status);
    case "already":
      return `Already answered. ${
        secretRequestDecidedByLine(outcome.status, outcome.decidedBy) ??
        secretRequestStatusLine(outcome.status)
      }`;
    case "gone":
      return "This request is no longer open.";
  }
}

/** How a resolved row was settled, and by whom when its payload names them. */
function ResolvedByLine(props: {
  readonly detail: GrantRequestDetail;
}): ReactNode {
  const { decision, decidedBy } = props.detail;
  const line =
    decision === null
      ? null
      : (secretRequestDecidedByLine(decision, decidedBy) ??
        secretRequestStatusLine(decision));
  if (line === null) return null;
  return (
    <p
      data-testid="secret-grant-request-decided-by"
      className="text-muted-foreground"
    >
      {line}
    </p>
  );
}
