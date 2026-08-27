/**
 * Viewport-parity twin of `use-switcher-rename.test.tsx`: the wide-viewport
 * (desktop) tab-strip rename must stamp + retire the same optimistic overlay
 * as the mobile switcher does, so a resize never changes what feedback a
 * rename gets. See the module doc on `use-rename-canvas-tab.ts`.
 *
 * Mocks ONLY the network layer (the three rename mutation hooks);
 * `useOpenEpicHandle` is backed by a REAL `createOpenEpicStore` session and
 * `useEpicCanvasStore` is the real Zustand canvas store.
 *
 * Call sites use `void mutateAsync(vars).then(landed, failed)`, and
 * `retirePendingMutation` takes a required `outcome` argument. Mocks below
 * expose `mutateAsync` returning a controllable Promise instead of a
 * synchronous `mutate`.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createArtifactInDocForTests } from "@/stores/epics/open-epic/__tests__/projection-helpers-test-shims";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { TuiAgentRecordSummaryV11 } from "@traycer/protocol/host/epic/tui-agent-records";
import type {
  EpicArtifactRef,
  EpicTerminalRef,
} from "@/stores/epics/canvas/types";

const mocks = vi.hoisted(() => ({
  handle: { current: null as OpenEpicStoreHandle | null },
  chatCalls: [] as { readonly chatId: string; readonly title: string }[],
  tuiCalls: [] as { readonly tuiAgentId: string; readonly title: string }[],
  artifactCalls: [] as {
    readonly artifactId: string;
    readonly title: string;
  }[],
  settleAs: "success",
  /**
   * One settle function per `mutateAsync` call, in call order - a queue
   * rather than a single slot, so a test firing two consecutive renames can
   * settle each independently and assert BOTH stamps retire.
   */
  pendingSettles: [] as (() => void)[],
}));

/** Await two microtask turns - enough for `resolve()`/`reject()` to run the
 * chained `.then(landed, failed)` handler in the hook under test. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeMutateAsync<TVariables>(
  onCall: (variables: TVariables) => void,
): (variables: TVariables) => Promise<void> {
  return (variables: TVariables) => {
    onCall(variables);
    return new Promise<void>((resolve, reject) => {
      mocks.pendingSettles.push(() => {
        if (mocks.settleAs === "success") {
          resolve();
        } else {
          reject(new Error("mock mutation failure"));
        }
      });
    });
  };
}

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => {
    if (mocks.handle.current === null) throw new Error("no handle seeded");
    return mocks.handle.current;
  },
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicRenameChat: () => ({
    mutateAsync: makeMutateAsync(
      (variables: { readonly chatId: string; readonly title: string }) => {
        mocks.chatCalls.push({
          chatId: variables.chatId,
          title: variables.title,
        });
      },
    ),
  }),
}));

vi.mock("@/hooks/epic/use-epic-tui-agent-mutations", () => ({
  useEpicRenameTuiAgent: () => ({
    mutateAsync: makeMutateAsync(
      (variables: { readonly tuiAgentId: string; readonly title: string }) => {
        mocks.tuiCalls.push({
          tuiAgentId: variables.tuiAgentId,
          title: variables.title,
        });
      },
    ),
  }),
}));

vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicRenameArtifact: () => ({
    mutateAsync: makeMutateAsync(
      (variables: { readonly artifactId: string; readonly title: string }) => {
        mocks.artifactCalls.push({
          artifactId: variables.artifactId,
          title: variables.title,
        });
      },
    ),
  }),
}));

import { useRenameCanvasTab } from "@/components/epic-canvas/canvas/use-rename-canvas-tab";

const EPIC_ID = "epic-1";
const VIEW_TAB_ID = "tab-1";
const HOST_ID = "host-1";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Epic test",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

function newSession(): OpenEpicStoreHandle {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: factory,
    userId: null,
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  return handle;
}

/** A REGISTRY row (docResident: false) - the shape that routes to the RPC. */
function agentRecord(tuiAgentId: string): TuiAgentRecordSummaryV11 {
  return {
    tuiAgentId,
    ownerUserId: "user-1",
    hostId: HOST_ID,
    harnessId: "claude",
    harnessSessionId: null,
    parentId: null,
    title: "An agent",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    workspaceFolders: [],
    workspaceMode: null,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    revision: 1,
    docResident: false,
  };
}

/** A DOC-RESIDENT agent: a `tuiAgents` Y.Map entry, no registry row. */
function createTerminalAgentInDocForTests(doc: Y.Doc): string {
  const id = "doc-agent-1";
  const agent = new Y.Map<unknown>();
  agent.set("id", id);
  agent.set("harnessId", "codex");
  agent.set("title", "Doc agent");
  agent.set("parentId", null);
  agent.set("createdAt", 1);
  agent.set("updatedAt", 1);
  agent.set("hostId", HOST_ID);
  agent.set("workspaceFolders", ["/repo"]);
  agent.set("model", null);
  agent.set("reasoningEffort", null);
  agent.set("agentMode", "regular");
  agent.set("harnessSessionId", null);
  agent.set("terminalShellCommand", null);
  agent.set("terminalShellArgs", null);
  const tuiAgents = new Y.Map<unknown>();
  tuiAgents.set(id, agent);
  doc.getMap("epic").set("tuiAgents", tuiAgents);
  return id;
}

function artifactTile(id: string): EpicArtifactRef {
  return {
    id,
    instanceId: "inst-1",
    type: "spec",
    name: "Spec",
    hostId: HOST_ID,
  };
}

function chatTile(id: string): EpicArtifactRef {
  return {
    id,
    instanceId: "inst-2",
    type: "chat",
    name: "Chat",
    hostId: HOST_ID,
  };
}

function terminalAgentTile(id: string): EpicArtifactRef {
  return {
    id,
    instanceId: "inst-3",
    type: "terminal-agent",
    name: "Agent",
    hostId: HOST_ID,
  };
}

function terminalTile(id: string): EpicTerminalRef {
  return {
    id,
    instanceId: "inst-4",
    type: "terminal",
    name: "Terminal",
    hostId: HOST_ID,
    titleSource: "default",
    cwd: "/repo",
  };
}

describe("useRenameCanvasTab", () => {
  afterEach(() => {
    mocks.chatCalls = [];
    mocks.tuiCalls = [];
    mocks.artifactCalls = [];
    mocks.pendingSettles = [];
    mocks.settleAs = "success";
    mocks.handle.current?.dispose();
    mocks.handle.current = null;
  });

  it("stamps a trimmed optimistic rename before the RPC fires, and marks it landed (not deleted) once the RPC settles OK", async () => {
    const handle = newSession();
    mocks.handle.current = handle;
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const { result, unmount } = renderHook(() =>
      useRenameCanvasTab(EPIC_ID, VIEW_TAB_ID),
    );

    act(() => {
      result.current(artifactTile(id), "  Trimmed title  ");
    });

    // The mutation call carries the hook's own TRIMMED title.
    expect(mocks.artifactCalls).toEqual([
      { artifactId: id, title: "Trimmed title" },
    ]);
    // Optimistic value is visible BEFORE the RPC has settled.
    expect(handle.store.getState().artifacts.byId[id].title).toBe(
      "Trimmed title",
    );
    const rawArtifactsMap = handle.doc.getMap("epic").get("artifacts");
    if (!(rawArtifactsMap instanceof Y.Map)) throw new Error("expected map");
    const artifactsMap: Y.Map<unknown> = rawArtifactsMap;
    const rawEntry = artifactsMap.get(id);
    if (!(rawEntry instanceof Y.Map)) throw new Error("expected entry");
    const entry: Y.Map<unknown> = rawEntry;
    // No doc write at any point - only the in-memory overlay changed.
    expect(entry.get("title")).toBe("New spec");

    await act(async () => {
      mocks.pendingSettles[0]?.();
      await flushMicrotasks();
    });

    // A "landed" retire is NOT a deletion (item 8 of the contract): the
    // entry survives until the doc visibly echoes the ack, so the row keeps
    // showing the optimistic value here. If the hook wired success to
    // `retirePendingMutation(id, "failed")` instead of `"landed"` by
    // mistake, this would immediately revert to "New spec" and fail.
    expect(handle.store.getState().artifacts.byId[id].title).toBe(
      "Trimmed title",
    );
    unmount();
  });

  it("retires the pending mutation on a FAILED settle too", async () => {
    const handle = newSession();
    mocks.handle.current = handle;
    mocks.settleAs = "error";
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const { result, unmount } = renderHook(() =>
      useRenameCanvasTab(EPIC_ID, VIEW_TAB_ID),
    );

    act(() => {
      result.current(artifactTile(id), "Failed rename");
    });
    expect(handle.store.getState().artifacts.byId[id].title).toBe(
      "Failed rename",
    );

    await act(async () => {
      mocks.pendingSettles[0]?.();
      await flushMicrotasks();
    });

    expect(handle.store.getState().artifacts.byId[id].title).toBe("New spec");
    unmount();
  });

  it("retire still fires after the hook's component UNMOUNTS before settle", async () => {
    const handle = newSession();
    mocks.handle.current = handle;
    // An ERROR settle is used here (not the default success) because only
    // a failed retire is immediately OBSERVABLE through the store (it
    // deletes the entry outright) - a landed retire keeps the row showing
    // the optimistic value either way, which would prove nothing about
    // whether retire actually ran post-unmount.
    mocks.settleAs = "error";
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const { result, unmount } = renderHook(() =>
      useRenameCanvasTab(EPIC_ID, VIEW_TAB_ID),
    );

    act(() => {
      result.current(artifactTile(id), "Unmount-race rename");
    });
    expect(handle.store.getState().artifacts.byId[id].title).toBe(
      "Unmount-race rename",
    );

    unmount();

    await act(async () => {
      mocks.pendingSettles[0]?.();
      await flushMicrotasks();
    });

    expect(handle.store.getState().artifacts.byId[id].title).toBe("New spec");
  });

  it("two consecutive tab renames retire BOTH stamps, not just the latest", async () => {
    const handle = newSession();
    mocks.handle.current = handle;
    // ERROR settles for the same observability reason as the unmount test
    // above: a failed retire deletes immediately, so reaching "New spec"
    // after both settle proves BOTH stamps were retired, not just one.
    mocks.settleAs = "error";
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const { result, unmount } = renderHook(() =>
      useRenameCanvasTab(EPIC_ID, VIEW_TAB_ID),
    );

    act(() => {
      result.current(artifactTile(id), "First");
    });
    act(() => {
      result.current(artifactTile(id), "Second");
    });
    expect(mocks.artifactCalls).toEqual([
      { artifactId: id, title: "First" },
      { artifactId: id, title: "Second" },
    ]);
    expect(handle.store.getState().artifacts.byId[id].title).toBe("Second");
    expect(mocks.pendingSettles).toHaveLength(2);

    await act(async () => {
      mocks.pendingSettles[1]?.();
      await flushMicrotasks();
    });
    await act(async () => {
      mocks.pendingSettles[0]?.();
      await flushMicrotasks();
    });

    expect(handle.store.getState().artifacts.byId[id].title).toBe("New spec");
    unmount();
  });

  it("routes a chat tab rename through beginRenameMutation and the chat mutation", () => {
    const handle = newSession();
    mocks.handle.current = handle;
    const chatId = createArtifactInDocForTests(handle.doc, "chat", null);
    const { result, unmount } = renderHook(() =>
      useRenameCanvasTab(EPIC_ID, VIEW_TAB_ID),
    );

    act(() => {
      result.current(chatTile(chatId), "New chat name");
    });

    expect(mocks.chatCalls).toEqual([{ chatId, title: "New chat name" }]);
    expect(mocks.artifactCalls).toEqual([]);
    unmount();
  });

  it("routes a REGISTRY-backed terminal-agent tab rename through beginRenameMutation and the tui-agent mutation", () => {
    const handle = newSession();
    mocks.handle.current = handle;
    // A registry row (docResident: false) is what routes to the RPC; an
    // agent absent from the union - or doc-resident - takes the doc-write
    // branch instead, which the next test pins.
    handle.store
      .getState()
      .applyTuiAgentRecords([agentRecord("agent-1")], null);
    const { result, unmount } = renderHook(() =>
      useRenameCanvasTab(EPIC_ID, VIEW_TAB_ID),
    );

    act(() => {
      result.current(terminalAgentTile("agent-1"), "New agent name");
    });

    expect(mocks.tuiCalls).toEqual([
      { tuiAgentId: "agent-1", title: "New agent name" },
    ]);
    unmount();
  });

  it("routes a DOC-RESIDENT terminal agent through the doc write, never epic.renameTuiAgent", () => {
    // An agent whose title still lives in the epic Y.Doc (bound to an
    // un-upgraded peer host) has no registry row on the serving host -
    // `epic.renameTuiAgent` would refuse it (E_AGENT_NOT_LOCAL) and the
    // overlay would only ever roll back. The hook routes it to the direct
    // doc write instead, exactly as the reparent commit does.
    const handle = newSession();
    mocks.handle.current = handle;
    const agentId = createTerminalAgentInDocForTests(handle.doc);
    const { result, unmount } = renderHook(() =>
      useRenameCanvasTab(EPIC_ID, VIEW_TAB_ID),
    );

    act(() => {
      result.current(terminalAgentTile(agentId), "Doc agent name");
    });

    expect(mocks.tuiCalls).toEqual([]);
    expect(handle.store.getState().tuiAgents.byId[agentId].title).toBe(
      "Doc agent name",
    );
    unmount();
  });

  it("a raw terminal tab is a no-op: no overlay stamp, no RPC", () => {
    const handle = newSession();
    mocks.handle.current = handle;
    const { result, unmount } = renderHook(() =>
      useRenameCanvasTab(EPIC_ID, VIEW_TAB_ID),
    );

    act(() => {
      result.current(terminalTile("session-1"), "New terminal name");
    });

    expect(mocks.artifactCalls).toEqual([]);
    expect(mocks.chatCalls).toEqual([]);
    expect(mocks.tuiCalls).toEqual([]);
    unmount();
  });

  it("calls renameArtifactInTab (the persisted tab snapshot) only on the RPC's SUCCESS arm - not before settle, not on failure", async () => {
    const handle = newSession();
    mocks.handle.current = handle;
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const renameArtifactInTabSpy = vi.spyOn(
      useEpicCanvasStore.getState(),
      "renameArtifactInTab",
    );
    const { result, unmount } = renderHook(() =>
      useRenameCanvasTab(EPIC_ID, VIEW_TAB_ID),
    );

    act(() => {
      result.current(artifactTile(id), "New spec title");
    });
    // Not called before the mutateAsync promise settles - the overlay is the
    // live feedback, this is the persisted fallback.
    expect(renameArtifactInTabSpy).not.toHaveBeenCalled();

    await act(async () => {
      mocks.pendingSettles[0]?.();
      await flushMicrotasks();
    });
    expect(renameArtifactInTabSpy).toHaveBeenCalledWith(
      VIEW_TAB_ID,
      id,
      "New spec title",
    );

    renameArtifactInTabSpy.mockClear();
    mocks.settleAs = "error";
    act(() => {
      result.current(artifactTile(id), "Rejected title");
    });
    await act(async () => {
      mocks.pendingSettles[1]?.();
      await flushMicrotasks();
    });
    // A failed RPC never writes the persisted snapshot - it has no rollback
    // path, so writing it speculatively would strand a rejected title.
    expect(renameArtifactInTabSpy).not.toHaveBeenCalled();

    renameArtifactInTabSpy.mockRestore();
    unmount();
  });

  it("a race between two in-flight renames of one node: only the LATEST-STAMPED settle writes the persisted snapshot, regardless of settle order", async () => {
    const handle = newSession();
    mocks.handle.current = handle;
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const renameArtifactInTabSpy = vi.spyOn(
      useEpicCanvasStore.getState(),
      "renameArtifactInTab",
    );
    const { result, unmount } = renderHook(() =>
      useRenameCanvasTab(EPIC_ID, VIEW_TAB_ID),
    );

    act(() => {
      result.current(artifactTile(id), "B");
    });
    act(() => {
      result.current(artifactTile(id), "C");
    });
    expect(mocks.pendingSettles).toHaveLength(2);

    // The NEWER rename ("C") settles FIRST - RPC settles are unordered, and
    // this is the ordinary case, not even the regression: it must write.
    await act(async () => {
      mocks.pendingSettles[1]?.();
      await flushMicrotasks();
    });
    expect(renameArtifactInTabSpy).toHaveBeenCalledTimes(1);
    expect(renameArtifactInTabSpy).toHaveBeenCalledWith(VIEW_TAB_ID, id, "C");

    // The OLDER rename's success arm ("B") settles SECOND, after "C" already
    // wrote. Before `isLatestRenameStamp`, this unconditionally overwrote
    // the snapshot with its own captured "B" - the persisted fallback would
    // regress behind the row/overlay (both still showing "C") and resurface
    // stale on the next cold render. The guard must suppress it.
    await act(async () => {
      mocks.pendingSettles[0]?.();
      await flushMicrotasks();
    });
    expect(renameArtifactInTabSpy).toHaveBeenCalledTimes(1);
    expect(renameArtifactInTabSpy).toHaveBeenCalledWith(VIEW_TAB_ID, id, "C");

    renameArtifactInTabSpy.mockRestore();
    unmount();
  });

  it("resolving two in-flight renames in STAMP order still suppresses the older one - the guard reads stamp order, not settle order", async () => {
    // The literal reverse of the race test above: proves the guard is not
    // accidentally keyed on WHICH settle callback ran first. Both orderings
    // of two CONCURRENTLY in-flight renames of one node produce exactly ONE
    // write (the latest-stamped one) - the fix's whole point is that no
    // interleaving of two in-flight renames ever produces two writes, since
    // that unordered race between two live writes was the bug. A true
    // "two writes" case needs the renames to not overlap at all - see the
    // sequential test below.
    const handle = newSession();
    mocks.handle.current = handle;
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const renameArtifactInTabSpy = vi.spyOn(
      useEpicCanvasStore.getState(),
      "renameArtifactInTab",
    );
    const { result, unmount } = renderHook(() =>
      useRenameCanvasTab(EPIC_ID, VIEW_TAB_ID),
    );

    act(() => {
      result.current(artifactTile(id), "B");
    });
    act(() => {
      result.current(artifactTile(id), "C");
    });
    expect(mocks.pendingSettles).toHaveLength(2);

    await act(async () => {
      mocks.pendingSettles[0]?.();
      await flushMicrotasks();
    });
    // "B" was not the latest STAMPED rename at settle time ("C" already was),
    // so it is suppressed even though it happens to settle first.
    expect(renameArtifactInTabSpy).not.toHaveBeenCalled();

    await act(async () => {
      mocks.pendingSettles[1]?.();
      await flushMicrotasks();
    });
    expect(renameArtifactInTabSpy).toHaveBeenCalledTimes(1);
    expect(renameArtifactInTabSpy).toHaveBeenCalledWith(VIEW_TAB_ID, id, "C");

    renameArtifactInTabSpy.mockRestore();
    unmount();
  });

  it("two SEQUENTIAL (non-overlapping) renames of one node both write - the guard must not suppress an ordinary, non-racing rename", async () => {
    const handle = newSession();
    mocks.handle.current = handle;
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const renameArtifactInTabSpy = vi.spyOn(
      useEpicCanvasStore.getState(),
      "renameArtifactInTab",
    );
    const { result, unmount } = renderHook(() =>
      useRenameCanvasTab(EPIC_ID, VIEW_TAB_ID),
    );

    act(() => {
      result.current(artifactTile(id), "B");
    });
    await act(async () => {
      mocks.pendingSettles[0]?.();
      await flushMicrotasks();
    });
    expect(renameArtifactInTabSpy).toHaveBeenCalledTimes(1);
    expect(renameArtifactInTabSpy).toHaveBeenNthCalledWith(
      1,
      VIEW_TAB_ID,
      id,
      "B",
    );

    // Fired only AFTER the first fully settled, so the two chains never
    // overlap - the second is trivially the only (and therefore latest)
    // pending rename by the time it settles.
    act(() => {
      result.current(artifactTile(id), "C");
    });
    await act(async () => {
      mocks.pendingSettles[1]?.();
      await flushMicrotasks();
    });
    expect(renameArtifactInTabSpy).toHaveBeenCalledTimes(2);
    expect(renameArtifactInTabSpy).toHaveBeenNthCalledWith(
      2,
      VIEW_TAB_ID,
      id,
      "C",
    );

    renameArtifactInTabSpy.mockRestore();
    unmount();
  });

  it("still writes the persisted snapshot when the authoritative echo lands BEFORE the RPC settles and kills the chain - the stamp TOMBSTONE survives the dead sweep", async () => {
    const handle = newSession();
    mocks.handle.current = handle;
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    // A typed pass-through capture rather than reading
    // `spy.mock.results[0].value`, which the lint config flags as an unsafe
    // `any` read: the hook does not expose its request id, and the stamp is
    // what the tombstone assertion below needs.
    const stampedRequestIds: Array<string | null> = [];
    const realBeginRenameMutation = handle.store.getState().beginRenameMutation;
    const beginRenameMutationSpy = vi
      .spyOn(handle.store.getState(), "beginRenameMutation")
      .mockImplementation((nodeId, nextTitle) => {
        const stamped = realBeginRenameMutation(nodeId, nextTitle);
        stampedRequestIds.push(stamped);
        return stamped;
      });
    const renameArtifactInTabSpy = vi.spyOn(
      useEpicCanvasStore.getState(),
      "renameArtifactInTab",
    );
    const { result, unmount } = renderHook(() =>
      useRenameCanvasTab(EPIC_ID, VIEW_TAB_ID),
    );

    act(() => {
      result.current(artifactTile(id), "B");
    });
    const requestId = stampedRequestIds[0] ?? null;
    if (requestId === null) {
      throw new Error("expected a request id");
    }

    // The authoritative row echoes "B" - our own target - BEFORE the RPC
    // promise settles. The chain has no landed member yet, so the row
    // reaching our own target reads as off-anchor supersession (row-wins,
    // not "our echo") and the dead sweep kills it.
    const rawArtifactsMap = handle.doc.getMap("epic").get("artifacts");
    if (!(rawArtifactsMap instanceof Y.Map)) throw new Error("expected map");
    const artifactsMap: Y.Map<unknown> = rawArtifactsMap;
    const rawEntry = artifactsMap.get(id);
    if (!(rawEntry instanceof Y.Map)) throw new Error("expected entry");
    const entry: Y.Map<unknown> = rawEntry;
    act(() => {
      handle.doc.transact(() => {
        entry.set("title", "B");
        entry.set("updatedAt", 123);
      });
    });

    // Confirms the chain actually died: nothing left to retire.
    expect(
      handle.store.getState().retirePendingMutation(requestId, "landed"),
    ).toBe(false);

    // The RPC's own success arm runs now. Under the old CHAIN-based guard
    // (`isLatestPendingRename`), a dead chain answered "not latest" here and
    // the persisted-tab write - the only one a successful rename ever gets -
    // was skipped. The tombstone (`isLatestRenameStamp`) survives the sweep,
    // so the write goes through.
    await act(async () => {
      mocks.pendingSettles[0]?.();
      await flushMicrotasks();
    });
    expect(renameArtifactInTabSpy).toHaveBeenCalledWith(VIEW_TAB_ID, id, "B");

    beginRenameMutationSpy.mockRestore();
    renameArtifactInTabSpy.mockRestore();
    unmount();
  });
});
