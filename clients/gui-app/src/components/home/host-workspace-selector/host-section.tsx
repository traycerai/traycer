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
  /**
   * The account's hosts, from `useHostOptions` — the same merged list Settings
   * and the usage popover read. This section used to take raw directory
   * entries, which is why a host you own but cannot dial right now was absent
   * here and present there: the picker in the composer said the machine did not
   * exist, the picker in Settings said it was offline.
   */
  readonly hosts: readonly HostScopeOption[];
  readonly activeHostId: string | null;
  readonly onSelect: (hostId: string) => void;
  /**
   * `bind` for the composer (window rebind). `pin` for git-diff / file-tree /
   * new-terminal (surface-local RPC scope). Both keep undialable rows inert
   * and omit the Active chip.
   */
  readonly intent: Extract<HostPickIntent, "bind" | "pin">;
  /**
   * Per-host reasons THIS surface cannot use a host — the chat fork dialog's
   * "needs update" for a target whose build predates the cross-host fork
   * contract. `NO_HOST_OPTION_REFUSALS` everywhere else.
   */
  readonly refusalByHostId: ReadonlyMap<string, string>;
  /**
   * Every row but this one goes inert, WITHOUT a word — a blocker owned by the
   * surface, not by any host. `null` imposes nothing. Kept separate from
   * `refusalByHostId` so a surface-level reason is never written onto a row as
   * if it were that host's fault.
   */
  readonly inertExceptHostId: string | null;
  /**
   * A pending submission (or a surface pinned to one host) owns the selection.
   * The control goes inert rather than accepting a click and discarding it.
   */
  readonly disabled: boolean;
  readonly isLoading: boolean;
  /** A host list request FAILED, so an empty `hosts` proves nothing. */
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
      disabled={props.disabled}
      keepFocusableWhenDisabled={props.keepFocusableWhenDisabled}
    />
  );
}

/**
 * Host block for the workspace/worktree picker surfaces (composer, git-diff
 * panel, terminal creation, file tree, the fork dialogs). What a click
 * writes is `intent`: `bind` rebinds the window; `pin` writes a surface pin.
 *
 * It is the same `HostSwitcher` the Settings rail and the usage popover mount —
 * one row of chrome that names the current host and opens the list — rather
 * than a flat list of every host inline. The flat list was fine at one host and
 * became the whole top of the panel at four, pushing the Workspaces section it
 * heads below the fold on exactly the accounts that own several machines.
 *
 * What stays local to this surface is only its framing: the "Host" heading that
 * pairs with "Workspaces" below it.
 */
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
