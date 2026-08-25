/**
 * Task 4.3a: the one live pairing where `canReparentProjected` (the projected
 * TREE) and `evaluateReparent` (the Y.Doc's `artifacts`/`chats`/`tuiAgents`
 * maps) genuinely disagree - a doc-only terminal agent dropped onto a
 * RECORD-BACKED chat. Both nodes sit in the projected tree, same family
 * ("agent"), no cycle, so the projected gate in `commitSidebarReparentDrop`
 * says yes. The chat has no Y.Doc `chats` entry (chat-sync-v2: creation no
 * longer writes one), so the doc-based `reparentArtifact` throws
 * `MissingNodeError`.
 *
 * A live `createOpenEpicStore` (not the routing suite's store stub) drives the
 * REAL throw: `chat-records-union.test.ts` already proves
 * `applyChatRecords` puts a chat in `state.tree` with no doc entry
 * ("gives a swept chat back its record, its tree row and its parent"), and
 * this reuses exactly that seam - the chat here just never had a doc entry to
 * begin with. The terminal agent is seeded straight into the doc's `tuiAgents`
 * map (`projectTerminalAgent` always stamps `docResident: true` for a doc
 * entry - see `root-dnd-commits.ts`'s `isDocOnlyTerminalAgent`), mirroring
 * `epic-projector.test.ts`'s `makeTerminalAgentEntry`.
 *
 * Before the fix this call escaped uncaught out of `commitSidebarReparentDrop`
 * and, one level up, skipped `handleDragEnd`'s cleanup - see
 * `root-dnd-provider-sidebar-reparent-cleanup.test.tsx` for the drag-lifecycle
 * half.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { ChatRecordSummary } from "@traycer/protocol/host/epic/chat-records";
import { QueryClient } from "@tanstack/react-query";
import { commitSidebarReparentDrop } from "@/components/epic-canvas/dnd/root-dnd-commits";
import { appLogger } from "@/lib/logger";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";

const seam = vi.hoisted(() => ({
  request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
  hasClient: true,
}));

vi.mock("@/lib/registries/epic-session-registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/registries/epic-session-registry")
    >();
  return {
    ...actual,
    getEpicSessionHandleHostClient: () =>
      seam.hasClient ? { request: seam.request } : null,
  };
});

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-1",
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
    epicId: "epic-1",
    streamClientFactory: factory,
    userId: null,
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  const seed = Y.encodeStateAsUpdate(new Y.Doc());
  captured.value.onSnapshot(makeMeta(), seed);
  return handle;
}

/**
 * A doc-only terminal-agent entry, minimal enough for `projectTerminalAgent`
 * to accept it (`harnessId: "codex"` tolerates a null `harnessSessionId`).
 * Mirrors `epic-projector.test.ts`'s `makeTerminalAgentEntry` - there is no
 * exported shim for this, unlike `createArtifactInDocForTests` for
 * artifacts/chats.
 */
function makeTerminalAgentEntry(id: string, title: string): Y.Map<unknown> {
  const agent = new Y.Map<unknown>();
  agent.set("id", id);
  agent.set("harnessId", "codex");
  agent.set("title", title);
  agent.set("parentId", null);
  agent.set("createdAt", 1);
  agent.set("updatedAt", 1);
  agent.set("hostId", "host-1");
  agent.set("workspaceFolders", ["/repo"]);
  agent.set("model", null);
  agent.set("reasoningEffort", null);
  agent.set("agentMode", "regular");
  agent.set("harnessSessionId", null);
  agent.set("terminalShellCommand", null);
  agent.set("terminalShellArgs", null);
  return agent;
}

function chatRecord(overrides: Partial<ChatRecordSummary>): ChatRecordSummary {
  return {
    chatId: "chat-1",
    ownerUserId: "user-a",
    originHostId: "host-1",
    title: "A chat",
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    runSettingsSummary: "claude",
    revision: 1,
    visibility: "private",
    origin: "own",
    ...overrides,
  };
}

const queryClient = new QueryClient();

describe("commitSidebarReparentDrop when the projected gate and the doc evaluator disagree", () => {
  afterEach(() => {
    __getOpenEpicRegistryForTests().disposeAll();
  });

  beforeEach(() => {
    seam.request.mockClear();
    seam.request.mockResolvedValue({ updated: true });
    seam.hasClient = true;
  });

  it("swallows the doc evaluator's throw for a doc-only terminal agent dropped onto a record-backed chat, and leaves the tree untouched", () => {
    const handle = newSession();

    // The source: a doc-only terminal agent. No `epic.listTuiAgents` row for
    // it, so `projectTerminalAgent`'s doc projection is the only source and
    // `docResident` reads true.
    const tuiAgents = new Y.Map<unknown>();
    tuiAgents.set("agent-1", makeTerminalAgentEntry("agent-1", "Agent"));
    handle.doc.getMap("epic").set("tuiAgents", tuiAgents);

    // The new parent: a RECORD-backed chat with no Y.Doc `chats` entry at
    // all - the ordinary post-chat-sync-v2 shape. `applyChatRecords` is the
    // same real store action `chat-records-union.test.ts` uses to prove a
    // record-only chat lands in `state.tree`.
    handle.store
      .getState()
      .applyChatRecords([chatRecord({ chatId: "chat-parent" })]);

    __getOpenEpicRegistryForTests().acquireMounted("epic-1", () => handle);

    const before = handle.store.getState();
    expect(before.docChats.allIds).toEqual([]);
    expect(before.tree.nodeById["chat-parent"]).toBeDefined();
    expect(before.tree.nodeById["agent-1"].parentId).toBeNull();

    const expand = vi.spyOn(useEpicSidebarExpansionStore.getState(), "expand");
    const errorSpy = vi.spyOn(appLogger, "error");

    expect(() =>
      commitSidebarReparentDrop({
        epicId: "epic-1",
        sourceNodeId: "agent-1",
        newParentId: "chat-parent",
        panelId: "chats",
        viewTabId: "tab-1",
        queryClient,
      }),
    ).not.toThrow();

    // Neither of the two RPCs this branch could reach fires - the throw is
    // caught before either `epic.reparentChat` (agent-family fast path) or
    // `epic.reparentArtifact` (the dual-write after a successful doc write)
    // is ever requested.
    expect(seam.request).not.toHaveBeenCalled();

    // The doc write itself never landed: `reparentArtifactAction` throws
    // INSIDE `doc.transact` before setting `parentId`, so the agent's tree
    // row - and its doc entry - keep their original parent.
    const after = handle.store.getState();
    expect(after.tree.nodeById["agent-1"].parentId).toBeNull();
    expect(
      (tuiAgents.get("agent-1") as Y.Map<unknown>).get("parentId"),
    ).toBeNull();

    // The commit returns before the reveal-under-new-parent step, so the
    // would-be new parent never gets an `expand` call.
    expect(expand).not.toHaveBeenCalled();

    // The rejection is logged - the signal that the two evaluators drifted -
    // never toasted (this file's "invalid drop = silent cancel" rule).
    expect(errorSpy).toHaveBeenCalledWith(
      "[epic-dnd] doc reparent rejected after the projected gate passed",
      expect.objectContaining({
        epicId: "epic-1",
        sourceNodeId: "agent-1",
        newParentId: "chat-parent",
      }),
      expect.anything(),
    );
  });
});
