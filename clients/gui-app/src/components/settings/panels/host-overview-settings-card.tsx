import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { OverviewCardDetailsLine } from "@/components/settings/details/overview-card-details-line";
import { OverviewCardDatedLines } from "@/components/settings/environment/overview-card-dated-lines";
import { onSettingsDate } from "@/lib/settings/settings-date";
import { MoveProgressLine } from "@/components/settings/move/move-progress-line";
import { hostSettingsCardState } from "@/components/settings/panels/host-overview-settings-card-model";
import { Button } from "@/components/ui/button";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import type { HostRpcRegistry } from "@/lib/host";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

/**
 * The Overview's settings card: whether this computer's settings are its
 * own, moving, or moved, and the lines other tickets draw from their own
 * files: P5's dated lines (`OverviewCardDatedLines`) and P3's `Details`
 * (`OverviewCardDetailsLine`). Drawn above the Overview's tabs, so it reads
 * on whichever tab is showing (`HostOverviewSettingsCardSlot`).
 */
export function HostOverviewSettingsCard(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly hostName: string;
  readonly status: EnvironmentStatusResponseV11;
}): ReactNode {
  const lineProps = {
    client: props.client,
    hostId: props.hostId,
    hostName: props.hostName,
    status: props.status,
  };
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);
  const state = hostSettingsCardState(props.status);
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border/60 px-3 py-2 text-ui-sm empty:hidden"
      data-testid="host-settings-card"
    >
      {/* One line: `Settings on this computer only. · Details · Move to
          Personal`. */}
      {state.kind === "local" ? (
        <div className="flex flex-wrap items-center gap-1">
          <span data-testid="host-settings-card-local">
            Settings on this computer only.
          </span>
          <OverviewCardDetailsLine {...lineProps} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="host-settings-card-move"
            onClick={() =>
              openMoveSheet({ hostId: props.hostId, hostName: props.hostName })
            }
          >
            {state.verb === "finish_moving"
              ? "Finish moving"
              : "Move to Personal"}
          </Button>
        </div>
      ) : null}
      {state.kind === "moving" || state.kind === "move_stopped" ? (
        <MoveProgressLine {...lineProps} progress={state} />
      ) : null}
      {/* While moving the progress line carries the card's `Details`, and
          after a move the dated line does: `Moved to Personal on 12 Oct ·
          Details`. */}
      {state.kind === "moved" ? (
        <div className="flex flex-wrap items-center gap-1">
          <p data-testid="host-settings-card-moved">
            Moved to Personal {onSettingsDate(state.acceptedAt)}
          </p>
          <OverviewCardDetailsLine {...lineProps} />
        </div>
      ) : null}
      <OverviewCardDatedLines {...lineProps} />
      {state.kind === "moved" ||
      state.kind === "moving" ||
      state.kind === "move_stopped" ||
      state.kind === "local" ? null : (
        <OverviewCardDetailsLine {...lineProps} />
      )}
    </div>
  );
}

/**
 * The settings card where the Overview draws it, above the tabs: read through
 * the picked host, and nothing while the host cannot be read, predates
 * `environment.status`, or is a team's (whose own lines `Access and setup`
 * names under the team).
 */
export function HostOverviewSettingsCardSlot(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  readonly usable: boolean;
}): ReactNode {
  const status = useEnvironmentStatusRead(
    props.client,
    props.hostId,
    props.usable,
  );
  if (
    props.client === null ||
    props.hostId === null ||
    status.data === null ||
    status.data.principal?.kind === "team"
  ) {
    return null;
  }
  return (
    <HostOverviewSettingsCard
      client={props.client}
      hostId={props.hostId}
      hostName={props.hostName}
      status={status.data}
    />
  );
}
