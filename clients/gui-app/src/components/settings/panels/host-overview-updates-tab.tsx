import type { ReactNode } from "react";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { HostScopeConnecting } from "@/components/settings/host-scope/host-scope-gate";
import { HostAutoUpdateRow } from "@/components/settings/host-scope/host-registry-updates";
import type { UpdateHostVersionPolicyMutation } from "@/components/settings/host-scope/use-host-registry-update-mutation";
import {
  describeOverviewDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
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
   * The version picker, or `null` while the host connects, restarts, cannot
   * be reached, or cannot manage updates here. Picking a version means asking
   * the host which ones exist, so an unreachable host gets no picker at all.
   */
  readonly versions: VersionPickerProps | null;
  /** Why the version list is withheld; the account switch remains available. */
  readonly versionFallback:
    | { readonly kind: "connecting"; readonly hostName: string }
    | { readonly kind: "unreachable"; readonly hostName: string }
    | {
        readonly kind: "degraded";
        readonly hostName: string;
        readonly reason: OverviewDegradeReason;
      }
    | null;
}

export function HostOverviewUpdatesTab(
  props: HostOverviewUpdatesTabProps,
): ReactNode {
  return (
    <HostOverviewTabSections>
      {props.autoUpdate === null ? null : (
        <div className="rounded-md border border-border/40 px-4 py-3">
          <HostAutoUpdateRow
            item={props.autoUpdate.item}
            mutation={props.autoUpdate.mutation}
            className=""
          />
        </div>
      )}
      {props.versions === null ? null : <VersionPicker {...props.versions} />}
      {props.versionFallback?.kind === "connecting" ? (
        <HostScopeConnecting hostName={props.versionFallback.hostName} />
      ) : null}
      {props.versionFallback?.kind === "unreachable" ? (
        <p className="text-ui-sm text-muted-foreground">
          Connect to {props.versionFallback.hostName} to choose a version.
        </p>
      ) : null}
      {props.versionFallback?.kind === "degraded" ? (
        <p className="text-ui-sm text-muted-foreground">
          {describeOverviewDegrade(
            props.versionFallback.reason,
            props.versionFallback.hostName,
          )}
        </p>
      ) : null}
    </HostOverviewTabSections>
  );
}
