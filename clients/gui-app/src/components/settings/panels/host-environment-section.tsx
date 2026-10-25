/**
 * Docs: see ../SETTINGS.md
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * Which configuration THIS host runs, as a fact rather than a control:
 * `Runs Personal`, or `Runs Acme` for a host an earlier build bound to a
 * team. A team cannot hold a computer in this version, so there is nothing
 * to pick here.
 *
 * A sandbox shows nothing: its configuration is settled by who pays for it,
 * and its Overview names it.
 *
 * Read through the Settings scope's client, the host the sidebar has
 * selected, never the app-wide one. In a build with a pool the binding is the
 * pool's answer for this host (`useEnvironmentHostReadQuery`).
 */
export function HostEnvironmentSection(props: {
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  const usable = isHostScopeUsable(scope.status) && scope.client !== null;
  const sandbox = scope.host?.kind === "sandbox";
  const support = useHostMethodSupport(scope.hostId, "environment.host.read");
  const binding = useEnvironmentHostReadQuery(
    scope.client,
    scope.hostId,
    usable && !sandbox && support === true,
  );
  if (!usable || sandbox || support !== true || binding.data === undefined) {
    return null;
  }
  return (
    <p
      className="mb-4 shrink-0 text-ui-md font-semibold text-foreground"
      data-testid="host-environment-section"
    >
      Runs {runsLabel(binding.data.environment)}
    </p>
  );
}

function runsLabel(environment: EnvironmentDescriptor): string {
  return environment.ownerKind === "user" ? "Personal" : environment.label;
}
