import type { ReactNode } from "react";
import { DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import {
  findHostOption,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
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

/**
 * Host block for the workspace/worktree picker surfaces (composer, git-diff
 * panel, terminal creation, file tree, the fork dialogs). Choosing a host swaps
 * the app-wide active host via the directory binding; the host-scoped folder
 * queries underneath refetch automatically.
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
  const { openSettings } = useSystemTabModalActions();
  // The rows' presence dots come from the registry through a deliberately
  // NON-polling observer; every surface that shows the dots opts the window
  // into the liveness poll while it is on screen (the Settings sidebar's
  // rule, then the usage picker's and the shell host dialog's). This section
  // mounts only inside open pickers and fork dialogs, so the poll runs
  // exactly while someone is looking at the dots.
  useRegisteredHostsPollLiveness();
  return (
    <section
      data-testid="host-workspace-selector-host-section"
      className="w-full max-w-full min-w-0"
    >
      <DropdownMenuLabel className="px-1 text-ui-xs font-medium uppercase tracking-wide text-muted-foreground/70">
        Host
      </DropdownMenuLabel>
      <HostSwitcher
        hosts={props.hosts}
        // Here the check and the active host are the same fact: this picker
        // chooses where work LANDS, so the row it marks is the bound one.
        selected={findHostOption(props.hosts, props.activeHostId)}
        activeHostId={props.activeHostId}
        onSelect={props.onSelect}
        refusalByHostId={props.refusalByHostId}
        inertExceptHostId={props.inertExceptHostId}
        // Binding the window to a host it cannot dial is not a legal answer, so
        // those rows list with their reason and stay inert.
        intent="bind"
        action={{
          kind: "manage-hosts",
          onSelect: () => {
            // The host this surface is SHOWING travels with the jump - same
            // transfer as the usage popover's cross-scope links. Without it,
            // a stale explicit Settings pin lands Manage hosts on a machine
            // other than the one whose row launched it. In a fixed-scope
            // dialog `activeHostId` IS the pinned host, so the transfer is
            // right there too.
            if (props.activeHostId !== null) {
              useSettingsHostScopeStore
                .getState()
                .setScopedHostId(props.activeHostId);
            }
            openSettings({ section: "host", resetToGeneral: false });
          },
        }}
        // A field, like the workspace search directly beneath it: inside an
        // already-open panel a quiet fill does not read as a control at all.
        surface="field"
        isLoading={props.isLoading}
        listsFailed={props.listsFailed}
        onRetryLists={props.onRetryLists}
        disabled={props.disabled}
      />
    </section>
  );
}
