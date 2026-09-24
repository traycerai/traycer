import type { ReactNode } from "react";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { HostAutoUpdateRow } from "@/components/settings/host-scope/host-registry-updates";
import type { UpdateHostVersionPolicyMutation } from "@/components/settings/host-scope/use-host-registry-update-mutation";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";
import {
  VersionPicker,
  type VersionPickerProps,
} from "@/components/settings/panels/host-overview-version-picker";

/**
 * Overview ▸ Updates: the decisions behind the answer on Status - the
 * auto-update policy, and installing one specific version.
 *
 * Both used to sit behind Installation's collapsed Advanced disclosure; they
 * are shown open here, since a tab of their own is already the click the
 * disclosure cost. Both halves of the update story are still ONE hook instance
 * up in the panel, so this list and the answer on Status cannot disagree about
 * what the last check returned or which write is in flight.
 */
export interface HostOverviewUpdatesTabProps {
  /**
   * The account's auto-update policy, or `null` for a host with no registry
   * row. An account write, so it needs no route to the host: it stays while
   * the host cannot be reached.
   */
  readonly autoUpdate: {
    readonly item: HostListItem;
    readonly mutation: UpdateHostVersionPolicyMutation;
  } | null;
  /**
   * The version picker, or `null` while the host cannot be reached or its
   * updates cannot be managed from here. Picking a version means asking the
   * host which ones exist, so an unreachable host gets no picker at all.
   */
  readonly versions: VersionPickerProps | null;
}

export function HostOverviewUpdatesTab(
  props: HostOverviewUpdatesTabProps,
): ReactNode {
  return (
    <HostOverviewTabSections>
      {props.autoUpdate === null ? null : (
        <HostAutoUpdateRow
          item={props.autoUpdate.item}
          mutation={props.autoUpdate.mutation}
          className=""
        />
      )}
      {props.versions === null ? null : <VersionPicker {...props.versions} />}
    </HostOverviewTabSections>
  );
}
