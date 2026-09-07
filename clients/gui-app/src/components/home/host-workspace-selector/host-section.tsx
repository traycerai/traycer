import type { ReactNode } from "react";
import { DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import {
  HostSwitcher,
  type HostSwitcherSurface,
} from "@/components/settings/host-scope/host-switcher";
import {
  findHostOption,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import type { HostPickIntent } from "@/components/settings/host-scope/host-option-model";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import { useRegisteredHostsPollLiveness } from "@/hooks/auth/use-registered-hosts-query";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

interface HostSectionProps {
  /** The account's hosts, from `useHostOptions` - the same merged list Settings and the usage popover read. */
  readonly hosts: readonly HostScopeOption[];
  readonly activeHostId: string | null;
  readonly onSelect: (hostId: string) => void;
  /** Both keep undialable rows inert and omit the Active chip. */
  readonly intent: Extract<HostPickIntent, "bind" | "pin">;
  /** Per-host reasons this surface cannot use a host - the chat fork dialog's "needs update" for a target whose
   * build predates the cross-host fork contract. */
  readonly refusalByHostId: ReadonlyMap<string, string>;
  /** Every row but this one goes inert, without a word - a blocker owned by the surface, not by any host. */
  readonly inertExceptHostId: string | null;
  /** The control goes inert rather than accepting a click and discarding it. */
  readonly disabled: boolean;
  readonly isLoading: boolean;
  readonly listsFailed: boolean;
  readonly onRetryLists: () => void;
}

interface WorkspaceHostSwitcherProps extends HostSectionProps {
  readonly surface: Extract<HostSwitcherSurface, "field" | "inline">;
  readonly keepFocusableWhenDisabled?: boolean;
}

export function WorkspaceHostSwitcher(
  props: WorkspaceHostSwitcherProps,
): ReactNode {
  const { openSettings } = useSystemTabModalActions();
  useRegisteredHostsPollLiveness();
  return (
    <HostSwitcher
      hosts={props.hosts}
      selected={findHostOption(props.hosts, props.activeHostId)}
      activeHostId={props.activeHostId}
      onSelect={props.onSelect}
      refusalByHostId={props.refusalByHostId}
      inertExceptHostId={props.inertExceptHostId}
      intent={props.intent}
      action={{
        kind: "manage-hosts",
        onSelect: () => {
          if (props.activeHostId !== null) {
            useSettingsHostScopeStore
              .getState()
              .setScopedHostId(props.activeHostId);
          }
          openSettings({ section: "host", resetToGeneral: false });
        },
      }}
      surface={props.surface}
      isLoading={props.isLoading}
      listsFailed={props.listsFailed}
      onRetryLists={props.onRetryLists}
      updateViewForHost={null}
      disabled={props.disabled}
      keepFocusableWhenDisabled={props.keepFocusableWhenDisabled}
    />
  );
}

/** It is the same `HostSwitcher` the Settings rail and the usage popover mount - one row of chrome that names
 * the current host and opens the list - rather than a flat list of every host inline. */
export function HostSection(props: HostSectionProps): ReactNode {
  return (
    <section
      data-testid="host-workspace-selector-host-section"
      className="w-full max-w-full min-w-0"
    >
      <DropdownMenuLabel className="px-1 text-ui-xs font-medium uppercase tracking-wide text-muted-foreground/70">
        Host
      </DropdownMenuLabel>
      <WorkspaceHostSwitcher {...props} surface="field" />
    </section>
  );
}
