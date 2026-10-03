import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import {
  __disposeAllXtermHostsForTests,
  __getXtermHostEntryForTests,
  acquireXtermHost,
  adoptWarmSessionInstance,
  createXtermRendererController,
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
import type { TerminalSessionKind } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  MAX_LINGERING_PLAIN_TERMINALS,
  PLAIN_TERMINAL_RELEASE_LINGER_MS,
} from "@/stores/terminals/terminal-session-registry";

function makeEntry(sessionId: string, hostId: string | null): XtermHostEntry {
  const term = new Terminal();
  return {
    sessionId,
    hostId,
    containerEl: document.createElement("div"),
    term,
    fitAddon: new FitAddon(),
    searchAddon: new SearchAddon(),
    // Canvas-free engine: this suite is about engine identity across rekeys,
    // not renderer lifetime, so the controller's loader reports the renderer
    // unavailable and it stays permanently DOM-rendered.
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
    disposeEngine: vi.fn(() => term.dispose()),
  };
}

function makeEntryForTests(): XtermHostEntry {
  return makeEntry("session-1", "host-1");
}

function createOwnedHandle(
  sessionId: string,
  kind: TerminalSessionKind,
): {
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
    kind,
    viewer: "presentation",
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
    releaseXtermHost("old-instance", true, false);

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
    releaseXtermHost("warm-source", true, false);
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
    const ownedA = createOwnedHandle(SHARED_ID, "terminal");
    registry.acquire("inst-a", () => ownedA.handle, HOST_A, "presentation");
    const engineA = acquireXtermHost("inst-a", () =>
      makeEntry(SHARED_ID, HOST_A),
    );
    releaseXtermHost("inst-a", true, false);
    registry.release("inst-a", ownedA.handle, true);

    adoptWarmSessionInstance(
      { hostId: HOST_B, sessionId: SHARED_ID },
      "inst-b",
    );

    expect(registry.get("inst-a")).toBe(ownedA.handle);
    expect(registry.get("inst-b")).toBeNull();
    expect(__getXtermHostEntryForTests("inst-a")).toBe(engineA);
    expect(__getXtermHostEntryForTests("inst-b")).toBeNull();
    // Release retagged the linger subscribe as cache (stream reopened); the
    // handle itself is still retained.
    expect(ownedA.closeCount()).toBe(1);
  });

  it("keeps host A's retained stream and engine after host B opens the same id", () => {
    const registry = __getTerminalSessionRegistryForTests();
    const ownedA = createOwnedHandle(SHARED_ID, "terminal");
    registry.acquire("inst-a", () => ownedA.handle, HOST_A, "presentation");
    const engineA = acquireXtermHost("inst-a", () =>
      makeEntry(SHARED_ID, HOST_A),
    );
    releaseXtermHost("inst-a", true, false);
    registry.release("inst-a", ownedA.handle, true);

    const ownedB = createOwnedHandle(SHARED_ID, "terminal");
    registry.acquire("inst-b", () => ownedB.handle, HOST_B, "presentation");
    const engineB = acquireXtermHost("inst-b", () =>
      makeEntry(SHARED_ID, HOST_B),
    );

    expect(__getXtermHostEntryForTests("inst-a")).toBe(engineA);
    expect(__getXtermHostEntryForTests("inst-b")).toBe(engineB);
    expect(engineB).not.toBe(engineA);
    expect(ownedA.closeCount()).toBe(1);
    expect(registry.get("inst-a")).toBe(ownedA.handle);
  });

  it("never seeds a subscribe grid from another host's same-id engine", () => {
    const engineA = acquireXtermHost("inst-a", () =>
      makeEntry(SHARED_ID, HOST_A),
    );
    releaseXtermHost("inst-a", true, false);

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
    const ownedA = createOwnedHandle(SHARED_ID, "terminal");
    registry.acquire("inst-a", () => ownedA.handle, HOST_A, "presentation");
    const engineA = acquireXtermHost("inst-a", () =>
      makeEntry(SHARED_ID, HOST_A),
    );
    releaseXtermHost("inst-a", true, false);
    registry.release("inst-a", ownedA.handle, true);

    adoptWarmSessionInstance(
      { hostId: HOST_A, sessionId: SHARED_ID },
      "inst-reopen",
    );

    expect(registry.get("inst-a")).toBeNull();
    expect(registry.get("inst-reopen")).toBe(ownedA.handle);
    expect(__getXtermHostEntryForTests("inst-reopen")).toBe(engineA);
    expect(ownedA.closeCount()).toBe(1);

    const revived = registry.acquire(
      "inst-reopen",
      () => {
        throw new Error("must reuse the adopted same-host handle");
      },
      HOST_A,
      "presentation",
    );
    expect(revived).toBe(ownedA.handle);
    registry.release("inst-reopen", ownedA.handle, true);
    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(ownedA.closeCount()).toBe(4);
  });
});

describe("xterm host disposal follows the shared terminal registry", () => {
  it("disposes a released terminal-agent's engine once the shared cap evicts it, not only on exit", () => {
    const registry = __getTerminalSessionRegistryForTests();
    const owned = createOwnedHandle("agent-session", "terminal-agent");
    registry.acquire(
      "agent-inst",
      () => owned.handle,
      "host-1",
      "presentation",
    );
    const engine = acquireXtermHost("agent-inst", () =>
      makeEntry("agent-session", "host-1"),
    );
    releaseXtermHost("agent-inst", true, false);
    registry.release("agent-inst", owned.handle, true);
    expect(__getXtermHostEntryForTests("agent-inst")).toBe(engine);

    // Fill the rest of the shared cap so the agent - released first - falls
    // out as the oldest lease-free entry. Agents no longer have their own
    // uncapped keep-warm class, so this must evict it exactly like a shell.
    const fillers = Array.from(
      { length: MAX_LINGERING_PLAIN_TERMINALS },
      (_unused, index) => createOwnedHandle(`filler-${index}`, "terminal"),
    );
    fillers.forEach((filler, index) => {
      registry.acquire(
        `filler-inst-${index}`,
        () => filler.handle,
        "host-1",
        "presentation",
      );
      registry.release(`filler-inst-${index}`, filler.handle, true);
    });

    expect(registry.get("agent-inst")).toBeNull();
    expect(engine.disposeEngine).toHaveBeenCalledTimes(1);
    expect(__getXtermHostEntryForTests("agent-inst")).toBeNull();
  });

  it("disposes a lingering terminal-agent's engine at TTL expiry, mirroring a plain terminal", () => {
    vi.useFakeTimers();
    const registry = __getTerminalSessionRegistryForTests();
    const owned = createOwnedHandle("agent-ttl-session", "terminal-agent");
    registry.acquire(
      "agent-ttl-inst",
      () => owned.handle,
      "host-1",
      "presentation",
    );
    const engine = acquireXtermHost("agent-ttl-inst", () =>
      makeEntry("agent-ttl-session", "host-1"),
    );
    releaseXtermHost("agent-ttl-inst", true, false);
    registry.release("agent-ttl-inst", owned.handle, true);

    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS - 1);
    expect(engine.disposeEngine).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(engine.disposeEngine).toHaveBeenCalledTimes(1);
    expect(__getXtermHostEntryForTests("agent-ttl-inst")).toBeNull();
  });
});
