import type { ComponentProps, ReactNode } from "react";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { HostScopeConnecting } from "@/components/settings/host-scope/host-scope-gate";
import { HostAutoUpdateRow } from "@/components/settings/host-scope/host-registry-updates";
import type { UpdateHostVersionPolicyMutation } from "@/components/settings/host-scope/use-host-registry-update-mutation";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";
import { HostOverviewAnswerCard } from "@/components/settings/panels/host-overview-updates";
import {
  VersionPicker,
  type VersionPickerProps,
} from "@/components/settings/panels/host-overview-version-picker";

/**
 * Overview ▸ Updates, top to bottom: the answer card (only when the update
 * answer has news or an action - an update to install, a fix, a failure),
 * the auto-update policy, and installing one specific version, whose heading
 * carries Check now.
 *
 * The update IN FLIGHT is not here: its card sits in the notices strip above
 * the tab bar, on every tab, and the answer card and Check now go quiet while
 * it shows. The whole update story is still ONE hook instance up in the
 * panel, so the card, the answer and this list cannot disagree about what the
 * last check returned or which write is in flight.
 */
export interface HostOverviewUpdatesTabProps {
  /**
   * The answer card's inputs, or `null` while the host can't be reached or
   * is still connecting: the answer needs the host. The card itself decides
   * whether the answer is worth drawing.
   */
  readonly answerCard: ComponentProps<typeof HostOverviewAnswerCard> | null;
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
  /**
   * An update is running, waiting or restarting: the picker's Check now is
   * hidden, not disabled, for that span, as the answer card is.
   */
  readonly inFlight: boolean;
  /**
   * Why the version list is withheld; the account switch remains available.
   * `null` when it is not withheld, and when updates are not manageable here:
   * the answer card states that reason itself, directly above.
   */
  readonly versionFallback:
    | { readonly kind: "connecting"; readonly hostName: string }
    | { readonly kind: "unreachable"; readonly hostName: string }
    | null;
}

export function HostOverviewUpdatesTab(
  props: HostOverviewUpdatesTabProps,
): ReactNode {
  return (
    <HostOverviewTabSections>
      {props.answerCard === null ? null : (
        <HostOverviewAnswerCard {...props.answerCard} />
      )}
      {props.autoUpdate === null ? null : (
        <div className="rounded-md border border-border/40 px-4 py-3">
          <HostAutoUpdateRow
            item={props.autoUpdate.item}
            mutation={props.autoUpdate.mutation}
            className=""
          />
        </div>
      )}
      {props.versions === null ? null : (
        <VersionPicker {...props.versions} checkNowShown={!props.inFlight} />
      )}
      {props.versionFallback?.kind === "connecting" ? (
        <HostScopeConnecting hostName={props.versionFallback.hostName} />
      ) : null}
      {props.versionFallback?.kind === "unreachable" ? (
        <p className="text-ui-sm text-muted-foreground">
          Connect to {props.versionFallback.hostName} to choose a version.
        </p>
      ) : null}
    </HostOverviewTabSections>
  );
}
