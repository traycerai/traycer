import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import {
  __disposeAllXtermHostsForTests,
  __getXtermHostEntryForTests,
  acquireXtermHost,
  adoptWarmSessionInstance,
  hasPeerXtermHostForSession,
  peekXtermHostGridForSession,
  rekeyXtermHost,
  releaseXtermHost,
  type XtermHostEntry,
} from "@/components/epic-canvas/renderers/xterm-host-registry";
import {
  __getTerminalSessionRegistryForTests,
  disposeAllTerminalSessions,
} from "@/lib/registries/terminal-session-registry";
import {
  createTerminalSessionStore,
  type TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import { PLAIN_TERMINAL_RELEASE_LINGER_MS } from "@/stores/terminals/terminal-session-registry";

function makeEntry(sessionId: string, hostId: string | null): XtermHostEntry {
  const term = new Terminal();
  return {
    sessionId,
    hostId,
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

function makeEntryForTests(): XtermHostEntry {
  return makeEntry("session-1", "host-1");
}

function createOwnedHandle(sessionId: string): {
  readonly handle: TerminalSessionStoreHandle;
  readonly closeCount: () => number;
} {
  let closeCount = 0;
  const handle = createTerminalSessionStore({
    scope: { kind: "epic", epicId: "epic-1" },
    sessionId,
    cols: 80,
    rows: 24,
    reattachMode: "fresh",
    kind: "terminal",
    streamClientFactory: () => ({
      sendAction: () => undefined,
      close: () => {
        closeCount += 1;
      },
    }),
  });
  return { handle, closeCount: () => closeCount };
}

afterEach(() => {
  __disposeAllXtermHostsForTests();
  disposeAllTerminalSessions();
  vi.useRealTimers();
});

describe("xterm host viewport continuity", () => {
  it("moves the same live xterm engine across a warm-session instance rekey", () => {
    const entry = acquireXtermHost("old-instance", makeEntryForTests);
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

  it("refuses to rekey an engine that is still mounted", () => {
    const entry = acquireXtermHost("mounted-source", makeEntryForTests);

    expect(rekeyXtermHost("mounted-source", "new-instance")).toBe(false);
    expect(acquireXtermHost("mounted-source", makeEntryForTests)).toBe(entry);
  });

  it("refuses an occupied destination without losing the warm source", () => {
    const source = acquireXtermHost("warm-source", makeEntryForTests);
    releaseXtermHost("warm-source", true);
    const destination = acquireXtermHost("occupied-target", makeEntryForTests);

    expect(rekeyXtermHost("warm-source", "occupied-target")).toBe(false);
    expect(acquireXtermHost("warm-source", makeEntryForTests)).toBe(source);
    expect(acquireXtermHost("occupied-target", makeEntryForTests)).toBe(
      destination,
    );
  });
});

describe("xterm host fleet identity", () => {
  const SHARED_ID = "shared-term";
  const HOST_A = "host-a";
  const HOST_B = "host-b";

  it("does not let host B adopt, rekey, or release host A's warm engine or stream", () => {
    const registry = __getTerminalSessionRegistryForTests();
    const ownedA = createOwnedHandle(SHARED_ID);
    registry.acquire("inst-a", () => ownedA.handle, HOST_A);
    const engineA = acquireXtermHost("inst-a", () =>
      makeEntry(SHARED_ID, HOST_A),
    );
    releaseXtermHost("inst-a", true);
    registry.release("inst-a", ownedA.handle);

    adoptWarmSessionInstance(
      { hostId: HOST_B, sessionId: SHARED_ID },
      "inst-b",
    );

    expect(registry.get("inst-a")).toBe(ownedA.handle);
    expect(registry.get("inst-b")).toBeNull();
    expect(__getXtermHostEntryForTests("inst-a")).toBe(engineA);
    expect(__getXtermHostEntryForTests("inst-b")).toBeNull();
    expect(ownedA.closeCount()).toBe(0);
  });

  it("keeps host A's retained stream and engine after host B opens the same id", () => {
    const registry = __getTerminalSessionRegistryForTests();
    const ownedA = createOwnedHandle(SHARED_ID);
    registry.acquire("inst-a", () => ownedA.handle, HOST_A);
    const engineA = acquireXtermHost("inst-a", () =>
      makeEntry(SHARED_ID, HOST_A),
    );
    releaseXtermHost("inst-a", true);
    registry.release("inst-a", ownedA.handle);

    const ownedB = createOwnedHandle(SHARED_ID);
    registry.acquire("inst-b", () => ownedB.handle, HOST_B);
    const engineB = acquireXtermHost("inst-b", () =>
      makeEntry(SHARED_ID, HOST_B),
    );

    expect(__getXtermHostEntryForTests("inst-a")).toBe(engineA);
    expect(__getXtermHostEntryForTests("inst-b")).toBe(engineB);
    expect(engineB).not.toBe(engineA);
    expect(ownedA.closeCount()).toBe(0);
    expect(registry.get("inst-a")).toBe(ownedA.handle);
  });

  it("never seeds a subscribe grid from another host's same-id engine", () => {
    const engineA = acquireXtermHost("inst-a", () =>
      makeEntry(SHARED_ID, HOST_A),
    );
    releaseXtermHost("inst-a", true);

    expect(
      peekXtermHostGridForSession({ hostId: HOST_A, sessionId: SHARED_ID }),
    ).toEqual({ cols: engineA.term.cols, rows: engineA.term.rows });
    expect(
      peekXtermHostGridForSession({ hostId: HOST_B, sessionId: SHARED_ID }),
    ).toBeNull();
  });

  it("does not treat a different host's same-id engine as a peer that suppresses repair", () => {
    const engineA = acquireXtermHost("inst-a", () =>
      makeEntry(SHARED_ID, HOST_A),
    );
    const engineB = acquireXtermHost("inst-b", () =>
      makeEntry(SHARED_ID, HOST_B),
    );

    expect(
      hasPeerXtermHostForSession(
        { hostId: HOST_B, sessionId: SHARED_ID },
        engineB.containerEl,
      ),
    ).toBe(false);
    expect(
      hasPeerXtermHostForSession(
        { hostId: HOST_A, sessionId: SHARED_ID },
        engineA.containerEl,
      ),
    ).toBe(false);

    const peerA = acquireXtermHost("inst-a-split", () =>
      makeEntry(SHARED_ID, HOST_A),
    );
    expect(
      hasPeerXtermHostForSession(
        { hostId: HOST_A, sessionId: SHARED_ID },
        engineA.containerEl,
      ),
    ).toBe(true);
    expect(peerA.sessionId).toBe(SHARED_ID);
  });

  it("still adopts a same-host warm engine and keeps the linger clock", () => {
    vi.useFakeTimers();
    const registry = __getTerminalSessionRegistryForTests();
    const ownedA = createOwnedHandle(SHARED_ID);
    registry.acquire("inst-a", () => ownedA.handle, HOST_A);
    const engineA = acquireXtermHost("inst-a", () =>
      makeEntry(SHARED_ID, HOST_A),
    );
    releaseXtermHost("inst-a", true);
    registry.release("inst-a", ownedA.handle);

    adoptWarmSessionInstance(
      { hostId: HOST_A, sessionId: SHARED_ID },
      "inst-reopen",
    );

    expect(registry.get("inst-a")).toBeNull();
    expect(registry.get("inst-reopen")).toBe(ownedA.handle);
    expect(__getXtermHostEntryForTests("inst-reopen")).toBe(engineA);
    expect(ownedA.closeCount()).toBe(0);

    const revived = registry.acquire(
      "inst-reopen",
      () => {
        throw new Error("must reuse the adopted same-host handle");
      },
      HOST_A,
    );
    expect(revived).toBe(ownedA.handle);
    registry.release("inst-reopen", ownedA.handle);
    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(ownedA.closeCount()).toBe(1);
  });
});
