/**
 * Host-binding-survives-restart guard (ticket 12).
 *
 * Per CLAUDE.md: every
 * `EpicNodeRef` variant - chat, artifact, terminal, terminal-agent,
 * and workspace-file - carries a `readonly hostId: string` set at
 * open time, and the binding never changes for the lifetime of that
 * tile. After a restart the persisted tile keeps its bound `hostId`.
 *
 * `useHostReachability(hostId)` reports `unreachable` (dead-tile banner)
 * ONLY when the directory HAS a live host but not this bound one. A
 * resolved-but-EMPTY directory means the local host has not published yet
 * and reports `host-starting` (a non-fatal waiting state), never a per-tab
 * death - see the `host-starting` case below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasState,
  EpicNodeRef,
  EpicViewTab,
  WorkspaceFileRef,
} from "@/stores/epics/canvas/types";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";

const directoryEntries = vi.hoisted(() => ({
  current: [] as ReadonlyArray<HostDirectoryEntry>,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: directoryEntries.current,
    fetchStatus: "success",
    isFetching: false,
    isLoading: false,
  }),
}));

const SOURCE_HOST = "host-A";
const REPLACEMENT_HOST = "host-B";

const TERMINAL_REF: EpicNodeRef = {
  id: "term-1",
  instanceId: "inst-term-1",
  type: "terminal",
  name: "shell",
  titleSource: "manual",
  hostId: SOURCE_HOST,
  cwd: "/work/repo",
};

const CHAT_REF: EpicNodeRef = {
  id: "chat-1",
  instanceId: "inst-chat-1",
  type: "chat",
  name: "chat",
  hostId: SOURCE_HOST,
};

const WORKSPACE_FILE_REF: WorkspaceFileRef = {
  id: "workspace-file:host-A:/work/repo:src/index.ts",
  instanceId: "inst-file-1",
  type: "workspace-file",
  name: "index.ts",
  hostId: SOURCE_HOST,
  workspacePath: "/work/repo",
  filePath: "src/index.ts",
};

function resetCanvas(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

interface CanvasSnapshot {
  readonly tabsById: Record<string, EpicViewTab>;
  readonly canvasByTabId: Record<string, EpicCanvasState>;
  readonly openTabOrder: ReadonlyArray<string>;
  readonly activeTabId: string | null;
}

function snapshotCanvas(): CanvasSnapshot {
  const state = useEpicCanvasStore.getState();
  const cloned: unknown = JSON.parse(
    JSON.stringify({
      tabsById: state.tabsById,
      canvasByTabId: state.canvasByTabId,
      openTabOrder: state.openTabOrder,
      activeTabId: state.activeTabId,
    }),
  );
  return cloned as CanvasSnapshot;
}

describe("host binding survives restart", () => {
  beforeEach(() => {
    directoryEntries.current = [];
    resetCanvas();
  });

  afterEach(() => {
    directoryEntries.current = [];
    resetCanvas();
    vi.restoreAllMocks();
  });

  it("preserves the bound hostId on persisted tiles after a setState rehydration", () => {
    // Open a tab with three tiles bound to SOURCE_HOST, including a
    // workspace-file tab (renderer-local kind that must also survive).
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-1", "Epic Foo");
    useEpicCanvasStore.getState().openTileInTab(tabId, TERMINAL_REF);
    useEpicCanvasStore.getState().openTileInTab(tabId, CHAT_REF);
    useEpicCanvasStore.getState().openTileInTab(tabId, WORKSPACE_FILE_REF);

    const persisted = snapshotCanvas();
    resetCanvas();
    expect(useEpicCanvasStore.getState().tabsById).toEqual({});

    // Simulate a hydrate from persisted snapshot.
    useEpicCanvasStore.setState(
      {
        tabsById: persisted.tabsById,
        canvasByTabId: persisted.canvasByTabId,
        openTabOrder: persisted.openTabOrder,
        activeTabId: persisted.activeTabId,
      },
      false,
    );

    const tab = useEpicCanvasStore.getState().tabsById[tabId];
    if (tab === undefined) throw new Error("expected hydrated tab");
    expect(tab.tabId).toBe(tabId);
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas === undefined) throw new Error("expected hydrated canvas");
    const tiles = collectPanes(canvas.root).flatMap((pane) =>
      paneTabRefs(canvas, pane),
    );
    const terminalTile = tiles.find((t) => t.id === TERMINAL_REF.id);
    const chatTile = tiles.find((t) => t.id === CHAT_REF.id);
    const fileTile = tiles.find((t) => t.id === WORKSPACE_FILE_REF.id);
    expect(terminalTile?.hostId ?? null).toBe(SOURCE_HOST);
    expect(chatTile?.hostId ?? null).toBe(SOURCE_HOST);
    expect(fileTile?.hostId ?? null).toBe(SOURCE_HOST);
    if (fileTile && fileTile.type === "workspace-file") {
      expect(fileTile.workspacePath).toBe(WORKSPACE_FILE_REF.workspacePath);
      expect(fileTile.filePath).toBe(WORKSPACE_FILE_REF.filePath);
    } else {
      throw new Error("expected workspace-file tile in rehydrated tab");
    }
  });

  it("useHostReachability reports `host-starting` (never `unreachable`) while the directory is empty", () => {
    // An empty directory means the local host has not published yet
    // (boot / ensure / post-wake) - no bound host's fate is knowable, so
    // the verdict must stay non-fatal. The 2026-07-14 incident rendered
    // every tab's death banner from exactly this transient window.
    directoryEntries.current = [];

    const { result } = renderHook(() => useHostReachability(SOURCE_HOST));

    expect(result.current.status).toBe("host-starting");
    expect(result.current.hostLabel).toBe(SOURCE_HOST);
  });

  it("useHostReachability reports `unreachable` when the directory only knows a different host", () => {
    directoryEntries.current = [
      {
        hostId: REPLACEMENT_HOST,
        label: "Replacement",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:5002/rpc",
        version: "1.0.0",
        transportDialability: "dialable",
      },
    ];

    const { result } = renderHook(() => useHostReachability(SOURCE_HOST));

    expect(result.current.status).toBe("unreachable");
    expect(result.current.hostLabel).toBe(SOURCE_HOST);
  });

  it("useHostReachability reports `host-starting` for this machine's not-yet-published local row", () => {
    // This exact shape - `kind: "local"` with no `websocketUrl` - is produced
    // by one thing only: `HostDirectoryService.snapshot()` standing the
    // registry's twin of THIS machine in for a local snapshot that has not
    // arrived. It used to assert `unreachable`, and int #48 is why that had to
    // change: the substitution fires for boot, for a restart, and for a host
    // merely busy enough to lose a probe, so a verdict of "dead" locked every
    // chat on a demonstrably healthy machine to its published copy.
    //
    // `host-starting` is the same answer the empty-directory arm has given
    // since 2026-07-14 for the same unknowable state; the twin just makes the
    // directory non-empty so that arm cannot see it. This does not weaken the
    // 2026-08-08 protection either - with no `websocketUrl` there is nothing
    // to dial, so no tile can spin against a corpse.
    directoryEntries.current = [
      {
        hostId: SOURCE_HOST,
        label: "Local",
        kind: "local",
        websocketUrl: null,
        version: "1.0.0",
        transportDialability: "not-dialable",
      },
    ];

    const { result } = renderHook(() => useHostReachability(SOURCE_HOST));

    expect(result.current.status).toBe("host-starting");
    expect(result.current.hostLabel).toBe("Local");
  });

  it("useHostReachability still reports `unreachable` for a routable host marked not-dialable", () => {
    // The 2026-08-08 guard proper: a host the directory can still describe -
    // it has an endpoint - and explicitly marks not-dialable is
    // high-confidence evidence of death, and must keep locking.
    directoryEntries.current = [
      {
        hostId: SOURCE_HOST,
        label: "Local",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:5001/rpc",
        version: "1.0.0",
        transportDialability: "not-dialable",
      },
    ];

    const { result } = renderHook(() => useHostReachability(SOURCE_HOST));

    expect(result.current.status).toBe("unreachable");
  });

  it("useHostReachability reports `reachable` when the bound host is back online", () => {
    directoryEntries.current = [
      {
        hostId: SOURCE_HOST,
        label: "Local",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:5001/rpc",
        version: "1.0.0",
        transportDialability: "dialable",
      },
    ];

    const { result } = renderHook(() => useHostReachability(SOURCE_HOST));

    expect(result.current.status).toBe("reachable");
    expect(result.current.hostLabel).toBe("Local");
  });

  it("answers a remote entry from its directory status (unavailable => unreachable)", () => {
    // SUPERSEDES the earlier pin ("does not treat a remote presence-lease
    // status as tab reachability"). That rule predates the unified sidebar
    // handing this hook LOCK-BADGE and LIVE-VS-COPY ROUTING duties: with
    // remote entries hardwired "reachable", an unavailable owner's rows
    // carried no lock, routed to a LIVE tab, and dialed a dead host forever
    // (two-slot live check, 2026-08-08). A populated directory explicitly
    // marking a host unavailable is high-confidence evidence, and every
    // consumer of "unreachable" degrades recoverably - the badge and
    // routing flip back on the next directory refresh, and the dead-tile
    // banner is reactive, never a tab kill. The 2026-07-14 incident's
    // protection lives in the EMPTY-directory arm ("host-starting"),
    // which is untouched.
    directoryEntries.current = [
      {
        hostId: SOURCE_HOST,
        label: "Remote",
        kind: "remote",
        websocketUrl: "wss://relay.traycer.invalid/attach",
        version: "1.0.0",
        transportDialability: "not-dialable",
      },
    ];

    const { result } = renderHook(() => useHostReachability(SOURCE_HOST));

    expect(result.current.status).toBe("unreachable");
    expect(result.current.hostLabel).toBe("Remote");
  });

  it("answers reachable for an AVAILABLE remote entry", () => {
    directoryEntries.current = [
      {
        hostId: SOURCE_HOST,
        label: "Remote",
        kind: "remote",
        websocketUrl: "wss://relay.traycer.invalid/attach",
        version: "1.0.0",
        transportDialability: "dialable",
      },
    ];

    const { result } = renderHook(() => useHostReachability(SOURCE_HOST));

    expect(result.current.status).toBe("reachable");
    expect(result.current.hostLabel).toBe("Remote");
  });
});
