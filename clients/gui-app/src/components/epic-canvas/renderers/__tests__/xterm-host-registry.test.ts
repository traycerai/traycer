import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import {
  __disposeAllXtermHostsForTests,
  acquireXtermHost,
  rekeyXtermHost,
  releaseXtermHost,
  type XtermHostEntry,
} from "@/components/epic-canvas/renderers/xterm-host-registry";

function makeEntry(): XtermHostEntry {
  const term = new Terminal();
  return {
    sessionId: "session-1",
    containerEl: document.createElement("div"),
    term,
    fitAddon: new FitAddon(),
    searchAddon: new SearchAddon(),
    canvasAddon: null,
    writerProxy: () => undefined,
    live: {
      onUserInput: () => undefined,
      onContainerResize: () => undefined,
      openExternalLink: () => undefined,
      getFindTargetId: () => null,
      onSearchResults: () => undefined,
    },
    controls: {
      fitToContainer: () => undefined,
      reconcileWithHost: () => undefined,
    },
    disposeEngine: vi.fn(() => term.dispose()),
  };
}

afterEach(() => {
  __disposeAllXtermHostsForTests();
});

describe("xterm host viewport continuity", () => {
  it("moves the same live xterm engine across a warm-session instance rekey", () => {
    const entry = acquireXtermHost("old-instance", makeEntry);
    // Release the React mount before a warm-session adoption. The engine keeps
    // xterm's normal-buffer viewport inside the Terminal object itself.
    releaseXtermHost("old-instance", true);

    expect(rekeyXtermHost("old-instance", "new-instance")).toBe(true);
    const reacquired = acquireXtermHost("new-instance", () => {
      throw new Error("Warm rekey must not construct a replacement engine");
    });

    expect(reacquired).toBe(entry);
    expect(reacquired.term).toBe(entry.term);
  });
});
