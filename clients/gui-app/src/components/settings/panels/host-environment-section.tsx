/**
 * Docs: see ../SETTINGS.md
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostNegotiatedMethodVersions } from "@/hooks/host/use-host-negotiated-method-version";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { localPickerRow } from "@/components/settings/environment/environment-picker-model";
import { usePreviewFeature } from "@/hooks/auth/use-preview-feature";

/** A computer whose own settings are not in Personal yet (it has a Local row). */
const RUNS_OWN_SETTINGS = "Runs its own settings, not in Personal yet";

/**
 * Which configuration THIS host runs, as a fact rather than a control:
 * `Runs Personal`, `Runs Acme` for a host an earlier build bound to a
 * team, or `Runs its own settings, not in Personal yet` on a computer with a
 * Local row (the Environment dropdown's rule), whatever it is bound to. A team cannot hold a computer in this version, so there is nothing
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
  // Without environments (unread included) a host runs nothing to name.
  const environments = usePreviewFeature("environments") === "on";
  const shown = usable && environments && scope.host?.kind !== "sandbox";
  const support = useHostMethodSupport(scope.hostId, "environment.host.read");
  const binding = useEnvironmentHostReadQuery(
    scope.client,
    scope.hostId,
    shown && support === true,
  );
  const status = useEnvironmentStatusRead(scope.client, scope.hostId, shown);
  const version =
    useHostNegotiatedMethodVersions(
      scope.hostId === null ? NO_HOSTS : [scope.hostId],
      "environment.status",
    ).get(scope.hostId ?? "") ?? null;
  if (!shown || support !== true || binding.data === undefined) {
    return null;
  }
  const local =
    scope.hostId !== null &&
    status.data !== null &&
    localPickerRow(
      { hostId: scope.hostId, name: scope.hostLabel },
      status.data,
      version,
    ) !== null;
  return (
    <p
      className="mb-4 shrink-0 text-ui-md font-semibold text-foreground"
      data-testid="host-environment-section"
    >
      {local
        ? RUNS_OWN_SETTINGS
        : `Runs ${runsLabel(binding.data.environment)}`}
    </p>
  );
}

const NO_HOSTS: readonly string[] = [];

function runsLabel(environment: EnvironmentDescriptor): string {
  return environment.ownerKind === "user" ? "Personal" : environment.label;
}
