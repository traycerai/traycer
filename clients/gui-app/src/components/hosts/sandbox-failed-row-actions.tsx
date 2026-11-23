import { useCallback, useState, type ReactNode } from "react";
import { useQueryClient, type Mutation } from "@tanstack/react-query";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { SandboxDestroyDialog } from "@/components/hosts/sandbox-confirm-dialogs";
import { SandboxOperationFailure } from "@/components/hosts/sandbox-operation-failure";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import {
  sandboxConfigurationOf,
  useSandboxConfigurations,
} from "@/hooks/sandboxes/use-sandbox-configurations";
import {
  sandboxCreatePressRequest,
  useSandboxCreate,
} from "@/hooks/sandboxes/use-sandbox-create-mutation";
import { useOffersAddCredits } from "@/hooks/sandboxes/use-team-billing-admin";
import { useSandboxDestroy } from "@/hooks/sandboxes/use-sandbox-destroy-mutation";
import { useSandboxOperation } from "@/hooks/sandboxes/use-sandbox-operation";
import { useIsMutatingOf } from "@/hooks/use-mutation-state-of";
import { sandboxMutationKeys } from "@/lib/query-keys";
import {
  sandboxCreateKey,
  sandboxRetryCreate,
} from "@/lib/sandboxes/sandbox-create-key";
import {
  sandboxRowActions,
  type SandboxPageConfiguration,
} from "@/lib/sandboxes/sandbox-row-lines";
import { sandboxVerbPendingLine } from "@/lib/sandboxes/sandbox-strings";
import { signedInUserId } from "@/lib/sandboxes/sandbox-account-fence";
import { useAuthStore } from "@/stores/auth/auth-store";
import { openSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";

/** A chat's Retry waits until its sandbox's environment is identified. */
export function SandboxFailedChatActions(props: {
  readonly summary: SandboxSummary;
}): ReactNode {
  const configurations = useSandboxConfigurations();
  const environments = useEnvironmentListQuery(
    props.summary.environmentId !== null,
  );
  const configuration = sandboxConfigurationOf(props.summary, configurations);
  // The resolver's Personal fallback is not proof: both personal sandboxes
  // and team pods can carry an environment id without a recorded creator,
  // and a missing environment id says nothing about whose it is.
  const personal =
    environments.data?.environments.some(
      (environment) =>
        environment.environmentId === props.summary.environmentId &&
        environment.ownerKind === "user",
    ) === true;
  const resolved =
    configuration?.kind === "personal" && !personal ? null : configuration;
  return (
    <SandboxFailedRowActions
      summary={props.summary}
      configuration={resolved}
      credits={resolved}
    />
  );
}

interface SandboxFailedRowActionsProps {
  readonly summary: SandboxSummary;
  /** `null` holds Retry back. */
  readonly configuration: SandboxPageConfiguration | null;
  readonly credits: SandboxPageConfiguration | null;
}

/** The failed-create row's safe actions, shared by Settings and the chat slot. */
export function SandboxFailedRowActions(
  props: SandboxFailedRowActionsProps,
): ReactNode {
  return <SandboxFailedRowControls key={props.summary.id} {...props} />;
}

function SandboxFailedRowControls(
  props: SandboxFailedRowActionsProps,
): ReactNode {
  const { summary, configuration, credits } = props;
  // Not known whose sandbox it is: worded as for someone who cannot buy.
  const buysTeamCredits = useOffersAddCredits(credits);
  const create = useSandboxCreate("toast", buysTeamCredits);
  const destroy = useSandboxDestroy(summary);
  const operation = useSandboxOperation(summary.id);
  const [destroyOpen, setDestroyOpen] = useState(false);
  const actions = sandboxRowActions({
    summary,
    unreachable: false,
    frozenOffersAddCredits: false,
    settingsFailed: false,
  });
  const pendingVerb = operation?.kind === "pending" ? operation.verb : null;
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const queryClient = useQueryClient();
  const baseKey = sandboxCreateKey("retry", summary.id);
  const predicate = useCallback(
    (mutation: Mutation) => {
      const variables = mutation.state.variables;
      if (
        typeof variables !== "object" ||
        variables === null ||
        !("request" in variables)
      )
        return false;
      if (
        "sourceSandboxId" in variables &&
        variables.sourceSandboxId === summary.id
      )
        return true;
      const { request } = variables;
      return (
        typeof request === "object" &&
        request !== null &&
        "clientRequestId" in request &&
        request.clientRequestId === baseKey
      );
    },
    [baseKey, summary.id],
  );
  const createFilter = {
    mutationKey: sandboxMutationKeys.create(userId),
    predicate,
  };
  const pendingCreates = useIsMutatingOf(createFilter);
  const busy = pendingVerb !== null || create.isPending || pendingCreates > 0;

  const retry = (): void => {
    if (configuration === null || actions.primary !== "retry" || busy) return;
    if (signedInUserId() !== userId || queryClient.isMutating(createFilter) > 0)
      return;
    create.mutate({
      request: sandboxCreatePressRequest(sandboxRetryCreate(summary), create),
      teamName: configuration.kind === "team" ? configuration.teamName : null,
      sourceSandboxId: summary.id,
    });
  };

  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
      {pendingVerb !== null || actions.primary === "retry" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="sandbox-row-retry"
          disabled={busy || configuration === null}
          onClick={retry}
        >
          {busy ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          {pendingVerb === null ? (
            "Retry"
          ) : (
            <span role="status">{sandboxVerbPendingLine(pendingVerb)}</span>
          )}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => openSandboxDetails(summary.id)}
      >
        Details
      </Button>
      {pendingVerb === null && actions.menu.includes("destroy") ? (
        <Button
          type="button"
          variant="destructive-ghost"
          size="sm"
          disabled={busy}
          data-testid="sandbox-row-menu-destroy"
          aria-label={`Destroy ${summary.displayName}`}
          onClick={() => setDestroyOpen(true)}
        >
          Destroy
        </Button>
      ) : null}
      <SandboxOperationFailure
        sandboxId={summary.id}
        name={summary.displayName}
        hostId={summary.hostId}
        configuration={credits ?? undefined}
        operation={operation}
        busy={busy}
        onRetry={
          operation?.kind === "failed" && operation.verb === "destroy"
            ? () => destroy.mutate(operation.destroyRequest)
            : null
        }
      />
      <SandboxDestroyDialog
        sandbox={summary}
        open={destroyOpen}
        onOpenChange={setDestroyOpen}
        onDestroyed={null}
      />
    </div>
  );
}
