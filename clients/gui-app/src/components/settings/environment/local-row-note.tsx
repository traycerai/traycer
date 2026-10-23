import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

/**
 * The note above a provider's tabs while a Local row is picked: these
 * settings are that computer's own, and the verb that moves them.
 */
export function LocalRowNote(): ReactNode {
  const pick = useEnvironmentPick();
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);
  if (pick.kind !== "local") return null;
  return (
    <div
      role="note"
      className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-ui-sm text-info-foreground"
      data-testid="local-row-note"
    >
      <span className="min-w-0 max-w-[72ch]">
        These settings are on {pick.hostName} only. Personal's settings are not
        on it. Move them to Personal to use them on every computer and sandbox;
        you see every item first.
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
    </div>
  );
}
