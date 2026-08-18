import { v4 as uuidv4 } from "uuid";
import { DEFAULT_TERMINAL_TITLE } from "@/lib/terminals/terminal-title";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";

export interface TerminalLaunchTarget {
  readonly hostId: string;
  readonly cwd: string;
}

/**
 * Mints a canonical host-authority ref for a user-created epic terminal.
 * `legacyFallback` keeps the released local fields so a downgraded host can
 * still spawn through the legacy tile path.
 */
export function buildTerminalTileRef(
  target: TerminalLaunchTarget,
): EpicTerminalRef {
  const name = DEFAULT_TERMINAL_TITLE;
  return {
    id: `term-${uuidv4()}`,
    instanceId: uuidv4(),
    type: "terminal",
    name,
    hostId: target.hostId,
    authority: "host",
    legacyFallback: {
      name,
      titleSource: "default",
      cwd: target.cwd,
    },
  };
}

/**
 * New epic terminals must dispatch `terminal.plain.create`, not
 * `importLegacy`. The pending-create mark is the create-vs-attach gate.
 */
export function mintNewEpicTerminalTile(
  target: TerminalLaunchTarget,
): EpicTerminalRef {
  const ref = buildTerminalTileRef(target);
  useEpicCanvasStore.getState().markArtifactPendingCreate(ref.id);
  return ref;
}
