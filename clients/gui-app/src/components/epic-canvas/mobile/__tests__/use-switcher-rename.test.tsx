/**
 * Viewport-parity acceptance criterion for Phase 1.1: the narrow-viewport
 * rename path never had a local update at all before the optimistic overlay,
 * so this pins that `useSwitcherRename` now stamps + retires it exactly like
 * the desktop tab-strip rename does.
 *
 * Mocks ONLY the network layer (the three rename mutation hooks, the raw
 * terminal rename mutation, and the session host client); `useOpenEpicHandle`
 * is backed by a REAL `createOpenEpicStore` session so `beginRenameMutation` /
 * `retirePendingMutation` run for real against a real Y.Doc.
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
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";

const mocks = vi.hoisted(() => ({
  handle: { current: null as OpenEpicStoreHandle | null },
  chatCalls: [] as { readonly chatId: string; readonly title: string }[],
  tuiCalls: [] as { readonly tuiAgentId: string; readonly title: string }[],
  artifactCalls: [] as {
    readonly artifactId: string;
    readonly title: string;
  }[],
  terminalCalls: [] as { readonly sessionId: string; readonly title: string }[],
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

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({
    mutate: (variables: {
      readonly sessionId: string;
      readonly title: string;
    }) => {
      mocks.terminalCalls.push(variables);
    },
  }),
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));

import { useSwitcherRename } from "@/components/epic-canvas/mobile/use-switcher-rename";

const EPIC_ID = "epic-1";

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

describe("useSwitcherRename", () => {
  afterEach(() => {
    mocks.chatCalls = [];
    mocks.tuiCalls = [];
    mocks.artifactCalls = [];
    mocks.terminalCalls = [];
    mocks.pendingSettles = [];
    mocks.settleAs = "success";
    mocks.handle.current?.dispose();
    mocks.handle.current = null;
  });

  it("stamps a trimmed optimistic rename before the RPC fires, and marks it landed (not deleted) once the RPC settles OK", async () => {
    const handle = newSession();
    mocks.handle.current = handle;
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const { result, unmount } = renderHook(() => useSwitcherRename(EPIC_ID));

    act(() => {
      result.current("artifact", id, "  Trimmed title  ");
    });

    // The hook's own trim, same as `beginRenameMutation`'s.
    expect(mocks.artifactCalls).toEqual([
      { artifactId: id, title: "Trimmed title" },
    ]);
    // Optimistic value is visible BEFORE the RPC has settled.
    expect(handle.store.getState().artifacts.byId[id].title).toBe(
      "Trimmed title",
    );
    // No doc write at any point: the row's authoritative Y.Doc entry is
    // untouched, only the in-memory overlay changed.
    const rawArtifactsMap = handle.doc.getMap("epic").get("artifacts");
    if (!(rawArtifactsMap instanceof Y.Map)) throw new Error("expected map");
    const artifactsMap: Y.Map<unknown> = rawArtifactsMap;
    const rawEntry = artifactsMap.get(id);
    if (!(rawEntry instanceof Y.Map)) throw new Error("expected entry");
    const entry: Y.Map<unknown> = rawEntry;
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

  it("retires the pending mutation on a FAILED settle too (settle and rollback are the same call)", async () => {
    const handle = newSession();
    mocks.handle.current = handle;
    mocks.settleAs = "error";
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const { result, unmount } = renderHook(() => useSwitcherRename(EPIC_ID));

    act(() => {
      result.current("artifact", id, "Failed rename");
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
    const { result, unmount } = renderHook(() => useSwitcherRename(EPIC_ID));

    act(() => {
      result.current("artifact", id, "Unmount-race rename");
    });
    expect(handle.store.getState().artifacts.byId[id].title).toBe(
      "Unmount-race rename",
    );

    // The component is gone before the RPC promise settles. Retire is
    // driven by the mutateAsync promise chain, not by a React effect
    // cleanup, so it must still land against the (still-alive) store.
    unmount();

    await act(async () => {
      mocks.pendingSettles[0]?.();
      await flushMicrotasks();
    });

    expect(handle.store.getState().artifacts.byId[id].title).toBe("New spec");
  });

  it("two consecutive renames retire BOTH stamps, not just the latest", async () => {
    const handle = newSession();
    mocks.handle.current = handle;
    // ERROR settles for the same observability reason as the unmount test
    // above: a failed retire deletes immediately, so reaching "New spec"
    // after both settle proves BOTH stamps were retired, not just one.
    mocks.settleAs = "error";
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const { result, unmount } = renderHook(() => useSwitcherRename(EPIC_ID));

    act(() => {
      result.current("artifact", id, "First");
    });
    act(() => {
      result.current("artifact", id, "Second");
    });
    expect(mocks.artifactCalls).toEqual([
      { artifactId: id, title: "First" },
      { artifactId: id, title: "Second" },
    ]);
    expect(handle.store.getState().artifacts.byId[id].title).toBe("Second");
    expect(mocks.pendingSettles).toHaveLength(2);

    // Settle out of order (the second RPC beats the first back) to prove
    // retiring one doesn't depend on the other having settled already.
    await act(async () => {
      mocks.pendingSettles[1]?.();
      await flushMicrotasks();
    });
    await act(async () => {
      mocks.pendingSettles[0]?.();
      await flushMicrotasks();
    });

    // Both stamps retired - nothing leaked behind to shadow the
    // authoritative value.
    expect(handle.store.getState().artifacts.byId[id].title).toBe("New spec");
    unmount();
  });

  it("routes a chat rename through beginRenameMutation and the chat mutation", () => {
    const handle = newSession();
    mocks.handle.current = handle;
    const chatId = createArtifactInDocForTests(handle.doc, "chat", null);
    const { result, unmount } = renderHook(() => useSwitcherRename(EPIC_ID));

    act(() => {
      result.current("chat", chatId, "New chat name");
    });

    expect(mocks.chatCalls).toEqual([{ chatId, title: "New chat name" }]);
    expect(mocks.artifactCalls).toEqual([]);
    expect(mocks.tuiCalls).toEqual([]);
    unmount();
  });

  it("a REGISTRY-backed terminal-agent rename routes through beginRenameMutation and the tui-agent mutation", () => {
    const handle = newSession();
    mocks.handle.current = handle;
    // A registry row (docResident: false) is what routes to the RPC; a
    // doc-resident agent takes the doc-write branch instead (pinned in
    // `use-rename-canvas-tab.test.tsx`, whose hook shares the routing).
    handle.store.getState().applyTuiAgentRecords(
      [
        {
          tuiAgentId: "agent-1",
          ownerUserId: "user-1",
          hostId: "host-1",
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
          origin: "registry",
        },
      ],
      null,
    );
    const { result, unmount } = renderHook(() => useSwitcherRename(EPIC_ID));

    act(() => {
      result.current("terminal-agent", "agent-1", "New agent name");
    });

    expect(mocks.tuiCalls).toEqual([
      { tuiAgentId: "agent-1", title: "New agent name" },
    ]);
    unmount();
  });

  it("a raw terminal never stamps the overlay - it routes to the terminal mutation only", () => {
    const handle = newSession();
    mocks.handle.current = handle;
    const { result, unmount } = renderHook(() => useSwitcherRename(EPIC_ID));

    act(() => {
      result.current("terminal", "session-1", "New terminal name");
    });

    expect(mocks.terminalCalls).toEqual([
      { sessionId: "session-1", title: "New terminal name" },
    ]);
    expect(mocks.artifactCalls).toEqual([]);
    expect(mocks.chatCalls).toEqual([]);
    expect(mocks.tuiCalls).toEqual([]);
    unmount();
  });
});
