import { useCallback } from "react";
import { useStagedSandboxHandoff } from "@/components/composer/use-staged-sandbox-send";
import { mintNewEpicTerminalTile } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { useFolderlessTerminalTarget } from "@/components/epic-canvas/sidebar/use-folderless-terminal-target";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import {
  useSurfaceHostPin,
  useTabSurfaceKey,
} from "@/hooks/host/use-surface-host-pin";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { useStagedSandbox } from "@/stores/composer/staged-sandbox-store";

function noopPrepareHandoff(): void {}

/**
 * Phase 2 of the new-terminal picker's staged sandbox, owned by the epic tab
 * rather than by the picker: the popover, or the phone's dialog, may close
 * while the sandbox boots, and the terminal still opens once it is ready. It
 * opens in the sandbox's own folderless directory, whatever workspace rows
 * the task binds on other hosts.
 */
export function NewTerminalStagedHandoff(props: {
  readonly epicId: string;
  readonly tabId: string;
}): null {
  const { epicId, tabId } = props;
  const surfaceKey = useTabSurfaceKey("new-terminal", tabId);
  const pin = useSurfaceHostPin(surfaceKey);
  const stage = useStagedSandbox(surfaceKey);
  const target = useFolderlessTerminalTarget(
    epicId,
    stage?.createdHostId ?? null,
  );
  const { openTile } = useEpicTileNavigation();
  const launch = useCallback((): boolean => {
    if (target === null) return false;
    openTile(
      tileIntent(
        mintNewEpicTerminalTile({ ...target, epicId }),
        { tabId },
        "explicit",
        "direct_ui",
      ),
    );
    return true;
  }, [epicId, openTile, tabId, target]);
  useStagedSandboxHandoff({
    surfaceKey,
    resolvedHostId: pin.resolvedHostId,
    canSubmit: target !== null,
    submit: launch,
    prepareHandoff: noopPrepareHandoff,
    ownerId: null,
  });
  return null;
}
