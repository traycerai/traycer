/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import { SandboxCostsPanel } from "@/components/hosts/sandbox-card";
import type { HostScopeSandbox } from "@/components/settings/host-scope/host-scope-model";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";

/** Overview ▸ Costs, sandbox hosts only: rate, today, the ledger, and the balance. */
export function HostOverviewCostsTab(props: {
  readonly sandbox: HostScopeSandbox;
}): ReactNode {
  return (
    <HostOverviewTabSections>
      <SandboxCostsPanel sandbox={props.sandbox} />
    </HostOverviewTabSections>
  );
}
