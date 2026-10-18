/**
 * Docs: see ../SETTINGS.md
 * Update that file whenever this settings surface changes.
 */
import { useId, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentDescriptor,
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import type { HostRegistryKind } from "@traycer/protocol/host/host-status";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { EnvironmentMachinesList } from "@/components/settings/panels/environment-machines-list";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { useEnvironmentHostBindMutation } from "@/hooks/bots/use-environment-host-bind-mutation";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { HostRpcRegistry } from "@/lib/host";
import { cn } from "@/lib/utils";

/**
 * Which environment THIS host runs (Tracy Bots). A host serves one
 * environment at a time: the personal one unless it was bound to a team.
 * The list shows every environment the person belongs to, marks the one the
 * host currently reports, and binds on a click. Nothing is pre-selected on
 * the person's behalf - the marked row is the host's own answer, and a team
 * becomes this host's environment only when the person picks it here. A
 * refusal from the host is shown in place, beside the list.
 *
 * Binding to a team asks first, in words that depend on what the host is: a
 * person's own machine serves the team's bots and skills and stays theirs; a
 * sandbox becomes the team's. A host a team member other than the reader
 * added to a team is shown, not changed: only the member who added it can
 * move it (`canUnbind`). Below the picker, every team's machines the reader
 * may see (`EnvironmentMachinesList`) - admin surface only; the bot flow
 * never asks for a machine.
 *
 * Reads and writes go through the Settings scope's client, the host the
 * sidebar has selected, never the app-wide one. `following` (the scope is
 * the active host, through the ambient client) is as usable as `ready`.
 */
export function HostEnvironmentSection(props: {
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  const headingId = useId();
  const usable = isHostScopeUsable(scope.status) && scope.client !== null;
  const support = useHostMethodSupport(scope.hostId, "environment.host.read");
  const enabled = usable && support === true;
  const environments = useEnvironmentListQuery(scope.client, enabled);
  const binding = useEnvironmentHostReadQuery(scope.client, enabled);
  const hostListSupport = useHostMethodSupport(
    scope.hostId,
    "environment.host.list",
  );
  const registeredHosts = useRegisteredHosts();
  const hostKind =
    registeredHosts.data?.hosts.find((host) => host.hostId === scope.hostId)
      ?.kind ?? null;

  if (!usable || support === null) return null;

  let body: ReactNode;
  if (!support) {
    body = (
      <p
        role="status"
        className="text-ui-xs text-muted-foreground"
        data-testid="host-environment-unsupported"
      >
        {scope.hostLabel} predates environments. Update it to run a team&apos;s
        bots from this host.
      </p>
    );
  } else if (environments.isError || binding.isError) {
    body = (
      <p role="status" className="text-ui-xs text-destructive">
        Couldn&apos;t read this host&apos;s environment.
      </p>
    );
  } else if (environments.data === undefined || binding.data === undefined) {
    body = (
      <div
        aria-busy="true"
        className="flex items-center py-1 text-muted-foreground"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  } else {
    body = (
      // Keyed by host: the bind mutation's pending and error state belong to
      // the host that received the bind, so switching the scope to another
      // host mounts a fresh picker with no feedback carried over.
      <>
        <HostEnvironmentPicker
          key={scope.hostId}
          client={scope.client}
          hostId={scope.hostId}
          hostLabel={scope.hostLabel}
          hostKind={hostKind}
          environments={environments.data.environments}
          binding={binding.data}
          labelledBy={headingId}
        />
        <EnvironmentMachinesList
          client={scope.client}
          environments={environments.data.environments}
          enabled={hostListSupport === true}
        />
      </>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="mb-4 flex shrink-0 flex-col gap-2 border-b border-border/60 pb-4"
      data-testid="host-environment-section"
    >
      <div className="min-w-0">
        <h2 id={headingId} className="text-ui-md font-semibold text-foreground">
          Environment
        </h2>
        <p className="mt-1 text-ui-xs text-muted-foreground">
          The bots {scope.hostLabel} runs belong to this environment, and so do
          the agent instructions below.
        </p>
      </div>
      {body}
    </section>
  );
}

function HostEnvironmentPicker(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostLabel: string;
  /** The host's registry kind; `null` when the registry has not said. */
  readonly hostKind: HostRegistryKind | null;
  readonly environments: ReadonlyArray<EnvironmentDescriptor>;
  readonly binding: EnvironmentHostBinding;
  readonly labelledBy: string;
}): ReactNode {
  const {
    client,
    hostId,
    hostLabel,
    hostKind,
    environments,
    binding,
    labelledBy,
  } = props;
  const bind = useEnvironmentHostBindMutation(client, hostId);
  const [confirming, setConfirming] = useState<EnvironmentDescriptor | null>(
    null,
  );
  const currentEnvironmentId = binding.environment.environmentId;
  // Another member added this host to a team: it is listed, never moved from
  // here. Only the member who added it can change its environment.
  const locked = binding.explicit && !binding.canUnbind;
  const pendingId = bind.isPending ? bind.variables.environmentId : null;
  const choose = (environment: EnvironmentDescriptor): void => {
    if (environment.ownerKind === "organization") {
      setConfirming(environment);
      return;
    }
    bind.mutate({ environmentId: environment.environmentId });
  };
  return (
    <>
      <ul
        className="flex flex-wrap gap-2"
        aria-labelledby={labelledBy}
        data-testid="host-environment-list"
      >
        {environments.map((environment) => {
          const current = environment.environmentId === currentEnvironmentId;
          return (
            <li key={environment.environmentId}>
              <button
                type="button"
                aria-pressed={current}
                data-testid="host-environment-option"
                data-environment-id={environment.environmentId}
                disabled={current || locked || bind.isPending}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-ui-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2 disabled:cursor-default",
                  current
                    ? "border-foreground/20 bg-foreground/8 text-foreground"
                    : "border-border/60 text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
                )}
                onClick={() => choose(environment)}
              >
                {current ? (
                  <Check className="size-3.5" aria-hidden="true" />
                ) : null}
                <span>{environment.label}</span>
                <Badge variant="muted" size="xs">
                  {environment.ownerKind === "organization"
                    ? "Team"
                    : "Personal"}
                </Badge>
                {pendingId === environment.environmentId ? (
                  <AgentSpinningDots
                    className={undefined}
                    testId={undefined}
                    variant={undefined}
                  />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {locked ? (
        <p
          className="text-ui-xs text-muted-foreground"
          data-testid="host-environment-locked"
        >
          Only the member who added this machine to {binding.environment.label}{" "}
          can change it.
        </p>
      ) : null}
      {bind.error === null ? null : (
        <p
          role="alert"
          className="text-ui-xs text-destructive"
          data-testid="host-environment-refusal"
        >
          {bind.error.message}
        </p>
      )}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Run {confirming?.label ?? ""}&apos;s bots on {hostLabel}?
            </DialogTitle>
            <DialogDescription data-testid="host-environment-confirm-copy">
              {confirming === null
                ? null
                : bindConfirmationCopy(hostLabel, confirming.label, hostKind)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              data-testid="host-environment-confirm"
              onClick={() => {
                if (confirming === null) return;
                bind.mutate({ environmentId: confirming.environmentId });
                setConfirming(null);
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * What binding a host to a team does to it, by kind: a person's own machine
 * serves the team and stays theirs; a sandbox becomes the team's. A host
 * whose kind the registry has not said gets the sentence true of both.
 */
function bindConfirmationCopy(
  hostLabel: string,
  teamLabel: string,
  hostKind: HostRegistryKind | null,
): string {
  switch (hostKind) {
    case "personal":
      return `${hostLabel} will run ${teamLabel}'s bots and skills. It stays yours; only you see it here and can change this.`;
    case "sandbox":
      return `${hostLabel} becomes ${teamLabel}'s: every member sees it, and the team's bots and tasks can run on it.`;
    case null:
      return `${hostLabel} will run ${teamLabel}'s bots and skills.`;
  }
}
