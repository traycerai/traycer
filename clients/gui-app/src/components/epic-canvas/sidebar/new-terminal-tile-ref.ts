import { v4 as uuidv4 } from "uuid";
import { DEFAULT_TERMINAL_TITLE } from "@/lib/terminals/terminal-title";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";

export interface TerminalLaunchTarget {
  readonly hostId: string;
  readonly cwd: string;
}

export function buildTerminalTileRef(
  target: TerminalLaunchTarget,
): EpicTerminalRef {
  return {
    id: `term-${uuidv4()}`,
    instanceId: uuidv4(),
    type: "terminal",
    name: DEFAULT_TERMINAL_TITLE,
    titleSource: "default",
    hostId: target.hostId,
    cwd: target.cwd,
  };
}
