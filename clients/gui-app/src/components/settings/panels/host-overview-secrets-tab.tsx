/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import { SandboxSecretsPanel } from "@/components/hosts/sandbox-card";
import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import type { HostScopeSandbox } from "@/components/settings/host-scope/host-scope-model";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";

/** Overview ▸ Secrets, sandbox hosts only: grants, readiness, and network events. */
export function HostOverviewSecretsTab(props: {
  readonly hostState: HostHealthState;
  readonly sandbox: HostScopeSandbox;
}): ReactNode {
  return (
    <HostOverviewTabSections>
      <SandboxSecretsPanel
        hostState={props.hostState}
        sandbox={props.sandbox}
      />
    </HostOverviewTabSections>
  );
}
