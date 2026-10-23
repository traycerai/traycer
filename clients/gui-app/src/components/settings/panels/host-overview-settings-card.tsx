import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { OverviewCardDetailsLine } from "@/components/settings/details/overview-card-details-line";
import { OverviewCardDatedLines } from "@/components/settings/environment/overview-card-dated-lines";
import { hostSettingsCardState } from "@/components/settings/panels/host-overview-settings-card-model";
import { Button } from "@/components/ui/button";
import type { HostRpcRegistry } from "@/lib/host";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

/**
 * The Overview's settings card: whether this computer's settings are its
 * own, moving, or moved, and the lines other tickets draw from their own
 * files: P5's dated lines (`OverviewCardDatedLines`) and P3's `Details`
 * (`OverviewCardDetailsLine`). The progress row stands above today's setup
 * card, which keeps the steps and the Retry.
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
      {state.kind === "awaiting" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span data-testid="host-settings-card-local">
            Settings on this computer only.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="host-settings-card-move"
            onClick={() =>
              openMoveSheet({ hostId: props.hostId, hostName: props.hostName })
            }
          >
            Move to Personal
          </Button>
        </div>
      ) : null}
      {state.kind === "moving" ? (
        <p data-testid="host-settings-card-progress">
          Moving this computer's settings to Personal · {state.applied} of{" "}
          {state.total} items applied
        </p>
      ) : null}
      {state.kind === "moved" ? (
        <p data-testid="host-settings-card-moved">
          Moved to Personal on{" "}
          {new Date(state.acceptedAt).toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
          })}
        </p>
      ) : null}
      <OverviewCardDatedLines {...lineProps} />
      <OverviewCardDetailsLine {...lineProps} />
    </div>
  );
}
