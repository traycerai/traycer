import { unresolvedSetupText } from "@/components/settings/environment/environment-picker-model";
import type { ReactNode } from "react";
import { MoveProgressLine } from "@/components/settings/move/move-progress-line";
import { hostSettingsCardState } from "@/components/settings/panels/host-overview-settings-card-model";
import { Button } from "@/components/ui/button";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

/**
 * The note above a provider's tabs for a per-computer pick: unfinished setup,
 * or that the settings are that computer's own and the verb that moves the
 * computer to Personal.
 */
export function LocalRowNote(): ReactNode {
  const pick = useEnvironmentPick();
  const hostId = pick.kind === "local" ? pick.hostId : null;
  const client = useHostClientForHostId(hostId);
  const status = useEnvironmentStatusRead(client, hostId, hostId !== null);
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);
  if (pick.kind !== "local") return null;
  const setup = status.data === null ? null : unresolvedSetupText(status.data);
  if (setup !== null) {
    return (
      <p
        role="note"
        className="mb-3 text-ui-sm text-muted-foreground"
        data-testid="local-row-note"
      >
        {setup}
      </p>
    );
  }
  return (
    <div
      role="note"
      className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-ui-sm text-info-foreground"
      data-testid="local-row-note"
    >
      <MoveProgressOr hostId={pick.hostId} hostName={pick.hostName}>
        <span className="min-w-0 max-w-[72ch]">
          Settings on {pick.hostName} only. Move this computer to Personal to
          use the same settings on every computer and sandbox.
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="local-row-note-move"
          onClick={() =>
            openMoveSheet({ hostId: pick.hostId, hostName: pick.hostName })
          }
        >
          Move to Personal
        </Button>
      </MoveProgressOr>
    </div>
  );
}

/**
 * While the computer's move runs, or once it stopped, the line the Overview's
 * settings card shows (`MoveProgressLine`), read from that computer's own
 * `environment.status`; otherwise `children`, which offer the move.
 */
export function MoveProgressOr(props: {
  readonly hostId: string;
  readonly hostName: string;
  readonly children: ReactNode;
}): ReactNode {
  const client = useHostClientForHostId(props.hostId);
  const status = useEnvironmentStatusRead(client, props.hostId, true);
  if (client === null || status.data === null) return props.children;
  const state = hostSettingsCardState(status.data);
  if (state.kind !== "moving" && state.kind !== "move_stopped") {
    return props.children;
  }
  return (
    <MoveProgressLine
      client={client}
      hostId={props.hostId}
      hostName={props.hostName}
      status={status.data}
      progress={state}
    />
  );
}
