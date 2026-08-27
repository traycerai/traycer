/**
 * WHICH PLANE a sidebar reparent drop is committed to.
 *
 * The agent family's parent pointer moved to the host's record plane, so an
 * agent drop became an `epic.reparentChat` call instead of a Y write - and that
 * is right for every row the host actually has a record for. It is NOT right
 * for a terminal agent that is still only a `tuiAgents` doc entry: its binding
 * host predates the record channel, `epic.reparentChat@1.0` has no
 * terminal-agent arm there, and the call would fail where the doc write used to
 * work. So the commit routes on whether the row is registry-backed, and these
 * tests pin the answers - registry-backed agent, doc-only terminal agent
 * (Y-only; never `epic.reparentArtifact`), artifact (doc write +
 * `epic.reparentArtifact`; no client keeps the doc write).
 *
 * The registry module is the seam: the commit reads the live epic session
 * imperatively through it, so stubbing it is what lets a drop be committed
 * without an app shell.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys";
import type { TreeNode, TreeSlice } from "@/stores/epics/open-epic/types";

const seam = vi.hoisted(() => {
  // Typed through a helper rather than an `as TreeSlice` on the literal: the
  // literal alone infers `rootIds: never[]`, and the typed lint's `--fix`
  // strips the assertion it would otherwise need. Defined in here because the
  // hoisted factory runs before any module-level binding exists.
  const emptyTree = (): TreeSlice => ({
    rootIds: [],
    childrenByParent: {},
    nodeById: {},
  });
  return {
    emptyTree,
    reparentArtifact: vi.fn<(id: string, parentId: string | null) => boolean>(
      () => true,
    ),
    request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
    /** Ids the host serves as terminal-agent RECORDS (`epic.listTuiAgents`). */
    recordIds: [] as string[],
    /**
     * Ids present in the terminal-agent UNION (`state.tuiAgents`) with
     * `docResident: true` - the `@1.1` doc-resident remainder.
     * `isDocOnlyTerminalAgent` reads the UNION, never `tuiAgentRecords`, so a
     * routing test seeds this (not `recordIds`) to model that row.
     */
    docResidentIds: [] as string[],
    tree: emptyTree(),
    /** null models a session with no serving client. */
    hasClient: true,
    /**
     * The optimistic overlay's begin/retire pair (Phase 1.1). Only the
     * registry-backed agent branch calls these - the doc-write branch
     * (artifacts, doc-only terminal agents) is untouched by the overlay.
     */
    beginReparentMutation: vi.fn<
      (nodeId: string, parentId: string | null) => string | null
    >(() => "req-1"),
    retirePendingMutation: vi.fn<
      (requestId: string, outcome: "landed" | "failed") => boolean
    >(() => true),
  };
});

const handle = vi.hoisted(() => ({ marker: "handle" }));

vi.mock("@/lib/registries/epic-session-registry", () => ({
  getOpenEpicRegistry: () => ({
    peek: () => ({
      store: {
        getState: () => ({
          tree: seam.tree,
          tuiAgentRecords: {
            byId: Object.fromEntries(
              seam.recordIds.map((id) => [id, { id }] as const),
            ),
            allIds: seam.recordIds,
          },
          // The UNION `isDocOnlyTerminalAgent` actually reads. A registry id
          // projects `docResident: false`; a `docResidentIds` entry projects
          // `true` - the two lists are mutually exclusive in practice, same as
          // the real resolver (`epic-list-tui-agents-resolver.ts` excludes a
          // doc entry whose id is already a registry id).
          tuiAgents: {
            // The element type is stated because the two spreads below have
            // DIFFERENT tuple types (`docResident: false` vs `true`), and
            // `Object.fromEntries` infers `any` off that union rather than
            // widening it - which `no-unsafe-assignment` then rejects. The
            // homogeneous `tuiAgentRecords` map above needs no annotation.
            byId: Object.fromEntries<{ id: string; docResident: boolean }>([
              ...seam.recordIds.map(
                (id) => [id, { id, docResident: false }] as const,
              ),
              ...seam.docResidentIds.map(
                (id) => [id, { id, docResident: true }] as const,
              ),
            ]),
            allIds: [...seam.recordIds, ...seam.docResidentIds],
          },
          reparentArtifact: seam.reparentArtifact,
          beginReparentMutation: seam.beginReparentMutation,
          retirePendingMutation: seam.retirePendingMutation,
        }),
      },
      ...handle,
    }),
  }),
  getEpicSessionHandleHostClient: () =>
    seam.hasClient ? { request: seam.request } : null,
  // The host the session is stamped with - what the post-RPC invalidation
  // scopes the record query to.
  getEpicSessionHandleHostId: () => "host-1",
}));

const { commitSidebarReparentDrop } =
  await import("@/components/epic-canvas/dnd/root-dnd-commits");

function node(
  id: string,
  type: TreeNode["type"],
  parentId: string | null,
): TreeNode {
  return {
    id,
    parentId,
    title: id,
    type,
    status: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** A two-row tree: `child` at root, `parent` at root, same family. */
function treeOf(nodes: readonly TreeNode[]): TreeSlice {
  return {
    rootIds: nodes.map((n) => n.id),
    childrenByParent: {},
    nodeById: Object.fromEntries(nodes.map((n) => [n.id, n] as const)),
  };
}

const queryClient = new QueryClient();

function drop(sourceNodeId: string, newParentId: string | null): void {
  commitSidebarReparentDrop({
    epicId: "epic-1",
    sourceNodeId,
    newParentId,
    panelId: "chats",
    viewTabId: "tab-1",
    queryClient,
  });
}

beforeEach(() => {
  seam.reparentArtifact.mockClear();
  seam.reparentArtifact.mockReturnValue(true);
  seam.request.mockClear();
  seam.request.mockResolvedValue({ updated: true });
  seam.recordIds = [];
  seam.docResidentIds = [];
  seam.hasClient = true;
  seam.tree = seam.emptyTree();
  seam.beginReparentMutation.mockClear();
  seam.beginReparentMutation.mockReturnValue("req-1");
  seam.retirePendingMutation.mockClear();
  seam.retirePendingMutation.mockReturnValue(true);
});

describe("commitSidebarReparentDrop routes by which plane owns the pointer", () => {
  it("sends a registry-backed terminal agent through epic.reparentChat", async () => {
    seam.tree = treeOf([
      node("tui-1", "terminal-agent", null),
      node("tui-parent", "terminal-agent", null),
    ]);
    seam.recordIds = ["tui-1", "tui-parent"];
    seam.request.mockResolvedValueOnce({ updated: true });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    drop("tui-1", "tui-parent");

    // The optimistic overlay stamps BEFORE the RPC fires, so the row moves at
    // drop time rather than waiting on the round trip.
    expect(seam.beginReparentMutation).toHaveBeenCalledWith(
      "tui-1",
      "tui-parent",
    );
    expect(seam.beginReparentMutation.mock.invocationCallOrder[0]).toBeLessThan(
      seam.request.mock.invocationCallOrder[0],
    );

    expect(seam.request).toHaveBeenCalledWith("epic.reparentChat", {
      epicId: "epic-1",
      chatId: "tui-1",
      newParentId: "tui-parent",
    });
    expect(seam.reparentArtifact).not.toHaveBeenCalled();
    // On success the moved node's record query is re-asked on the session's
    // host, so a drop does not sit under its old parent until the 20s poll
    // when the push stream is down or negotiated below @1.1.
    await vi.waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: hostQueryKeys.methodScope("host-1", "epic.listTuiAgents"),
      });
    });
    // The RPC's ack retires the stamp as LANDED, not deleted - the overlay
    // stays applied until the invalidated record refetch actually lands the
    // moved pointer.
    expect(seam.retirePendingMutation).toHaveBeenCalledWith("req-1", "landed");
    invalidate.mockRestore();
  });

  it("retires the overlay stamp as FAILED when epic.reparentChat rejects", async () => {
    seam.tree = treeOf([
      node("tui-1", "terminal-agent", null),
      node("tui-parent", "terminal-agent", null),
    ]);
    seam.recordIds = ["tui-1", "tui-parent"];
    seam.request.mockRejectedValueOnce(new Error("host refused the move"));

    drop("tui-1", "tui-parent");

    expect(seam.beginReparentMutation).toHaveBeenCalledWith(
      "tui-1",
      "tui-parent",
    );
    await vi.waitFor(() => {
      expect(seam.retirePendingMutation).toHaveBeenCalledWith(
        "req-1",
        "failed",
      );
    });
  });

  it("writes the doc for a terminal agent the host serves no record for", () => {
    // The legacy-host case. `epic.listTuiAgents` is unsupported there, so the
    // record slice is empty and the agent renders from the doc's `tuiAgents`
    // map - which is also where its parent pointer still lives. Absent from
    // the union entirely, exactly like an `@1.0` host that sends no marker at
    // all - the `agent === undefined` arm of `isDocOnlyTerminalAgent`.
    //
    // Ablation: route every agent-family drop to the RPC and this drag calls a
    // released `@1.0` with a `chatId` naming no chat - a host error, where the
    // doc write it replaced worked.
    seam.tree = treeOf([
      node("tui-legacy", "terminal-agent", null),
      node("tui-parent", "terminal-agent", null),
    ]);
    seam.recordIds = [];

    drop("tui-legacy", "tui-parent");

    expect(seam.reparentArtifact).toHaveBeenCalledWith(
      "tui-legacy",
      "tui-parent",
    );
    // Q1: doc-only TUI stays Y-only. This RPC names an artifact id, not a
    // tuiAgents map entry — must not start sending `epic.reparentArtifact`.
    expect(seam.request).not.toHaveBeenCalled();
  });

  it("routes a docResident: true agent to the Y.Doc branch even though it is not absent from the union", () => {
    // `epic.listTuiAgents@1.1` unions the doc-resident remainder INTO the
    // same table `epic.listTuiAgents` records fill, so "absent from the
    // union" stopped being a reliable doc-only tell - this id is very much
    // present. `docResident` is the marker that survives the union, and this
    // pins the routing decision to IT rather than to presence.
    //
    // Ablation: revert to the pre-`@1.1` presence check
    // (`!Object.hasOwn(state.tuiAgentRecords.byId, id)`) and this agent reads
    // as registry-backed - the drop would call `epic.reparentChat` with a
    // `chatId` naming no registry chat, the exact host error `docResident`
    // exists to prevent.
    seam.tree = treeOf([
      node("tui-frozen", "terminal-agent", null),
      node("tui-parent", "terminal-agent", null),
    ]);
    seam.docResidentIds = ["tui-frozen"];

    drop("tui-frozen", "tui-parent");

    expect(seam.reparentArtifact).toHaveBeenCalledWith(
      "tui-frozen",
      "tui-parent",
    );
    expect(seam.request).not.toHaveBeenCalled();
  });

  it("sends a chat through epic.reparentChat even with no terminal records", () => {
    // Chats are NOT gated on the terminal-agent record slice: `epic.reparentChat`
    // has routed chats since chats-off-YJS, and a doc-only chat resolves through
    // the same storage seam on the host. Gating them too would restore the
    // silent no-op this branch exists to fix.
    seam.tree = treeOf([
      node("chat-1", "chat", null),
      node("chat-parent", "chat", null),
    ]);
    seam.recordIds = [];

    drop("chat-1", "chat-parent");

    expect(seam.request).toHaveBeenCalledWith("epic.reparentChat", {
      epicId: "epic-1",
      chatId: "chat-1",
      newParentId: "chat-parent",
    });
    expect(seam.reparentArtifact).not.toHaveBeenCalled();
  });

  it("dual-writes an artifact drop to the doc and epic.reparentArtifact", () => {
    // The store seam alone would stay green on a persist no-op: the RPC
    // assertion is the one that would have caught shipping the dual-write
    // with a mock that returned undefined (falsy → mutated guard skips RPC).
    seam.tree = treeOf([
      node("spec-1", "spec", null),
      node("spec-parent", "spec", null),
    ]);

    commitSidebarReparentDrop({
      epicId: "epic-1",
      sourceNodeId: "spec-1",
      newParentId: "spec-parent",
      panelId: "artifacts",
      viewTabId: "tab-1",
      queryClient,
    });

    expect(seam.reparentArtifact).toHaveBeenCalledWith("spec-1", "spec-parent");
    expect(seam.request).toHaveBeenCalledTimes(1);
    expect(seam.request).toHaveBeenCalledWith("epic.reparentArtifact", {
      epicId: "epic-1",
      artifactId: "spec-1",
      newParentId: "spec-parent",
    });
  });

  it("keeps the artifact doc write when the session has no client", () => {
    // Unlike a record-backed agent (silent cancel), an artifact pointer
    // still lives in the doc: no serving client skips the RPC, not the Y write.
    seam.tree = treeOf([
      node("spec-1", "spec", null),
      node("spec-parent", "spec", null),
    ]);
    seam.hasClient = false;

    commitSidebarReparentDrop({
      epicId: "epic-1",
      sourceNodeId: "spec-1",
      newParentId: "spec-parent",
      panelId: "artifacts",
      viewTabId: "tab-1",
      queryClient,
    });

    expect(seam.reparentArtifact).toHaveBeenCalledWith("spec-1", "spec-parent");
    expect(seam.request).not.toHaveBeenCalled();
  });

  it("does not fall back to a doc write when a record-backed agent has no client", () => {
    // A session with no serving client is a silent cancel, not a licence to
    // write the doc: the pointer for this row lives on the host, so a Y write
    // would be a no-op the user reads as a move.
    seam.tree = treeOf([
      node("tui-1", "terminal-agent", null),
      node("tui-parent", "terminal-agent", null),
    ]);
    seam.recordIds = ["tui-1", "tui-parent"];
    seam.hasClient = false;

    drop("tui-1", "tui-parent");

    expect(seam.request).not.toHaveBeenCalled();
    expect(seam.reparentArtifact).not.toHaveBeenCalled();
    // The no-client check runs before the overlay is even stamped - a silent
    // cancel must not leave a phantom pending mutation behind.
    expect(seam.beginReparentMutation).not.toHaveBeenCalled();
    expect(seam.retirePendingMutation).not.toHaveBeenCalled();
  });
});
