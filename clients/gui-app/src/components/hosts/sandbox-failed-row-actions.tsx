import { useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { SandboxDestroyDialog } from "@/components/hosts/sandbox-confirm-dialogs";
import { SandboxOperationFailure } from "@/components/hosts/sandbox-operation-failure";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  sandboxConfigurationOf,
  useSandboxConfigurations,
} from "@/hooks/sandboxes/use-sandbox-configurations";
import { useSandboxCreate } from "@/hooks/sandboxes/use-sandbox-create-mutation";
import { useSandboxDestroy } from "@/hooks/sandboxes/use-sandbox-destroy-mutation";
import { useSandboxOperation } from "@/hooks/sandboxes/use-sandbox-operation";
import {
  sandboxRowActions,
  type SandboxPageConfiguration,
} from "@/lib/sandboxes/sandbox-row-lines";
import { sandboxVerbPendingLine } from "@/lib/sandboxes/sandbox-strings";
import { createErrorNeedsFreshKey } from "@/lib/sandboxes/staged-sandbox-run";
import { openSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";

/** A chat's Retry waits until its sandbox's environment is identified. */
export function SandboxFailedChatActions(props: {
  readonly summary: SandboxSummary;
}): ReactNode {
  const { configurations } = useSandboxConfigurations();
  const environments = useEnvironmentListQuery(
    useTabHostClient(),
    props.summary.environmentId !== null,
  );
  const configuration = sandboxConfigurationOf(props.summary, configurations);
  // The resolver's Personal fallback is not proof: both personal sandboxes
  // and team pods can carry an environment id without a recorded creator.
  const personal =
    props.summary.environmentId === null ||
    environments.data?.environments.some(
      (environment) =>
        environment.environmentId === props.summary.environmentId &&
        environment.ownerKind === "user",
    ) === true;
  const resolved =
    configuration?.kind === "personal" && !personal ? null : configuration;
  return (
    <SandboxFailedRowActions summary={props.summary} configuration={resolved} />
  );
}

/** The failed-create row's safe actions, shared by Settings and the chat slot. */
export function SandboxFailedRowActions(props: {
  readonly summary: SandboxSummary;
  readonly configuration: SandboxPageConfiguration | null;
}): ReactNode {
  const { summary, configuration } = props;
  const create = useSandboxCreate();
  const destroy = useSandboxDestroy(summary);
  const operation = useSandboxOperation(summary.id);
  const [destroyOpen, setDestroyOpen] = useState(false);
  // An unanswered request may already have created a sandbox. Reuse its key
  // until the server accepts it or refuses it before creating anything.
  const retryKey = useRef<string | null>(null);
  const actions = sandboxRowActions({
    summary,
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
  });
  const pendingVerb = operation?.kind === "pending" ? operation.verb : null;
  const busy = pendingVerb !== null || create.isPending;

  const retry = (): void => {
    if (configuration === null || actions.primary !== "retry" || busy) return;
    if (retryKey.current === null) retryKey.current = uuidv4();
    create.mutate(
      {
        request: {
          os: summary.os,
          cpus: summary.cpus,
          memoryMb: summary.memoryMb,
          diskMb: summary.diskMb,
          region: summary.region,
          displayName: summary.displayName,
          idleMinutes: summary.idleMinutes,
          burst: false,
          createdByHostId: null,
          createdByAgentId: null,
          environmentId: summary.environmentId,
          // A row's null is never; on a create, null uses the default.
          destroyAfterRestingMinutes: summary.destroyAfterRestingMinutes ?? 0,
          createdByTaskId: null,
          clientRequestId: retryKey.current,
        },
        teamName: configuration.kind === "team" ? configuration.teamName : null,
      },
      {
        onSuccess: () => {
          retryKey.current = null;
        },
        onError: (error) => {
          if (createErrorNeedsFreshKey(error)) retryKey.current = null;
        },
      },
    );
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`More actions for ${summary.displayName}`}
            data-testid="sandbox-row-menu"
          >
            <MoreHorizontal className="size-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid="sandbox-row-menu-content">
          <DropdownMenuItem
            data-testid="sandbox-row-menu-details"
            onSelect={() => openSandboxDetails(summary.id)}
          >
            Details
          </DropdownMenuItem>
          {pendingVerb === null && actions.menu.includes("destroy") ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={busy}
                data-testid="sandbox-row-menu-destroy"
                onSelect={() => setDestroyOpen(true)}
              >
                Destroy
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <SandboxOperationFailure
        sandboxId={summary.id}
        name={summary.displayName}
        hostId={summary.hostId}
        configuration={configuration ?? undefined}
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
