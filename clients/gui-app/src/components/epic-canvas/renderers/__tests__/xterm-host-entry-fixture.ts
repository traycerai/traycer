import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import {
  acquireXtermHost,
  createXtermRendererController,
} from "@/components/epic-canvas/renderers/xterm-host-registry";

/**
 * Registers a mounted, canvas-free xterm engine for `instanceId` in the real
 * engine registry and returns its `Terminal`, so a test can move the grid the
 * registry's peeks report. Mounted, so the registry's follower never reaps it
 * while the test advances timers.
 */
export function acquireMountedXtermEngine(input: {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly hostId: string;
  readonly cols: number;
  readonly rows: number;
}): Terminal {
  const term = new Terminal({ cols: input.cols, rows: input.rows });
  acquireXtermHost(input.instanceId, () => ({
    sessionId: input.sessionId,
    hostId: input.hostId,
    containerEl: document.createElement("div"),
    term,
    fitAddon: new FitAddon(),
    searchAddon: new SearchAddon(),
    rendererController: createXtermRendererController({
      loadCanvasAddon: () => null,
      refreshAllRows: () => undefined,
    }),
    writerProxy: () => undefined,
    live: {
      onUserInput: () => undefined,
      onContainerResize: () => undefined,
      openLink: () => undefined,
      getFindTargetId: () => null,
      onSearchResults: () => undefined,
    },
    controls: {
      fitToContainer: () => undefined,
      reconcileWithHost: () => undefined,
    },
    disposeEngine: () => term.dispose(),
  }));
  return term;
}
