import type { ReactNode } from "react";
import { MoveProgressLine } from "@/components/settings/move/move-progress-line";
import { hostSettingsCardState } from "@/components/settings/panels/host-overview-settings-card-model";
import { Button } from "@/components/ui/button";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

/**
 * The note above a provider's tabs while a Local row is picked: these
 * settings are that computer's own, and the verb that moves them. While the
 * move runs, or once it stopped, it reads as the Overview's settings card
 * does (`MoveProgressLine`), from that computer's own `environment.status`.
 * Nothing in a build without environments (`unreleased-features.ts`), where
 * every host is its own Local row and there is no Personal to move to.
 */
export function LocalRowNote(): ReactNode {
  const pick = useEnvironmentPick();
  const hostId =
    pick.kind === "local" && UNRELEASED_FEATURES_ENABLED ? pick.hostId : null;
  const client = useHostClientForHostId(hostId);
  const status = useEnvironmentStatusRead(client, hostId, hostId !== null);
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);
  if (pick.kind !== "local" || !UNRELEASED_FEATURES_ENABLED) return null;
  const state =
    status.data === null ? null : hostSettingsCardState(status.data);
  return (
    <div
      role="note"
      className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-ui-sm text-info-foreground"
      data-testid="local-row-note"
    >
      {state !== null &&
      (state.kind === "moving" || state.kind === "move_stopped") &&
      client !== null &&
      status.data !== null ? (
        <MoveProgressLine
          client={client}
          hostId={pick.hostId}
          hostName={pick.hostName}
          status={status.data}
          progress={state}
        />
      ) : (
        <>
          <span className="min-w-0 max-w-[72ch]">
            These settings are on {pick.hostName} only, not in Personal yet.
            Move them to Personal to use them on every computer and sandbox; you
            see every item first.
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
        </>
      )}
    </div>
  );
}
