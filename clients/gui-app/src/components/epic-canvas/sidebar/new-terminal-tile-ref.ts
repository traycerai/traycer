import { v4 as uuidv4 } from "uuid";
import { DEFAULT_TERMINAL_TITLE } from "@/lib/terminals/terminal-title";
import {
  acceptEpicTerminalDurableCreate,
  EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_COLS,
  EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_ROWS,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";

export interface TerminalLaunchTarget {
  readonly hostId: string;
  readonly cwd: string;
}

export interface MintNewEpicTerminalTileTarget extends TerminalLaunchTarget {
  readonly epicId: string;
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
 * `importLegacy`. The pending-create mark is the create-vs-attach gate, and
 * the session-level create coordinator owns the job so tab unmount cannot
 * cancel it.
 */
export function mintNewEpicTerminalTile(
  target: MintNewEpicTerminalTileTarget,
): EpicTerminalRef {
  const ref = buildTerminalTileRef(target);
  useEpicCanvasStore.getState().markTerminalPendingCreate(ref.hostId, ref.id);
  acceptEpicTerminalDurableCreate({
    hostId: ref.hostId,
    terminalId: ref.id,
    epicId: target.epicId,
    cwd: target.cwd,
    cols: EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_COLS,
    rows: EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_ROWS,
  });
  return ref;
}
