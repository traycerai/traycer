/**
 * Docs: see ../SETTINGS.md
 * Update that file whenever this settings surface changes.
 */
import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentDescriptor,
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
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
 * The list marks the one the host currently reports and binds on a click.
 * Nothing is pre-selected on the person's behalf - the marked row is the
 * host's own answer. A refusal from the host is shown in place, beside the
 * list.
 *
 * A sandbox shows nothing: whose bots it runs is settled by who pays for it.
 * A team's sandbox is placed in the team's environment when it is created,
 * and a person's sandbox is never rebound into a team. A team's bots run
 * only on the team's machines, so any other host is offered the personal
 * environment, plus the one it reports now so the marked row is never
 * hidden, with one line saying where a team's bots run. A host a team member
 * other than the reader added to a team is shown, not changed: only the
 * member who added it can move it (`canUnbind`). Below the picker, every
 * team's machines the reader may see (`EnvironmentMachinesList`) - admin
 * surface only; the bot flow never asks for a machine.
 *
 * Reads and writes go through the Settings scope's client, the host the
 * sidebar has selected, never the app-wide one. `following` (the scope is
 * the active host, through the ambient client) is as usable as `ready`. In a
 * build with a pool the binding is the pool's answer for this host
 * (`useEnvironmentHostReadQuery`); the bind still goes to the host, so the
 * section stays gated on the host's own environment block, whose
 * `environment.host.read` ships with `environment.host.bind`.
 */
export function HostEnvironmentSection(props: {
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  const headingId = useId();
  const usable = isHostScopeUsable(scope.status) && scope.client !== null;
  const sandbox = scope.host?.kind === "sandbox";
  const support = useHostMethodSupport(scope.hostId, "environment.host.read");
  const enabled = usable && !sandbox && support === true;
  const environments = useEnvironmentListQuery(scope.client, enabled);
  const binding = useEnvironmentHostReadQuery(
    scope.client,
    scope.hostId,
    enabled,
  );
  const hostListSupport = useHostMethodSupport(
    scope.hostId,
    "environment.host.list",
  );

  if (!usable || sandbox || support === null) return null;

  let body: ReactNode;
  if (!support) {
    body = (
      <p
        role="status"
        className="text-ui-xs text-muted-foreground"
        data-testid="host-environment-unsupported"
      >
        Update {scope.hostLabel} to run a team&apos;s bots from it.
      </p>
    );
  } else if (environments.isError || binding.isError) {
    body = (
      <p role="status" className="text-ui-xs text-destructive">
        Couldn&apos;t read whose bots this host runs.
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
          Runs bots for
        </h2>
      </div>
      {body}
    </section>
  );
}

function HostEnvironmentPicker(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly environments: ReadonlyArray<EnvironmentDescriptor>;
  readonly binding: EnvironmentHostBinding;
  readonly labelledBy: string;
}): ReactNode {
  const { client, hostId, environments, binding, labelledBy } = props;
  const bind = useEnvironmentHostBindMutation(client, hostId);
  const currentEnvironmentId = binding.environment.environmentId;
  // A team environment admits only the team's machines: this host is offered
  // the personal environment, plus whatever it reports now, so the marked row
  // is never hidden.
  const offered = environments.filter(
    (environment) =>
      environment.ownerKind === "user" ||
      environment.environmentId === currentEnvironmentId,
  );
  // Another member added this host to a team: it is listed, never moved from
  // here. Only the member who added it can change its environment.
  const locked = binding.explicit && !binding.canUnbind;
  const pendingId = bind.isPending ? bind.variables.environmentId : null;
  return (
    <>
      <ul
        className="flex flex-wrap gap-2"
        aria-labelledby={labelledBy}
        data-testid="host-environment-list"
      >
        {offered.map((environment) => {
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
                onClick={() =>
                  bind.mutate({ environmentId: environment.environmentId })
                }
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
      <p
        className="text-ui-xs text-muted-foreground"
        data-testid="host-environment-team-hosts-only"
      >
        A team&apos;s bots run on the team&apos;s machines.
      </p>
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
    </>
  );
}
