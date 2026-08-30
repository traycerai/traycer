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
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

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
    /**
     * Chats the record plane STATED are doc-homed. Everything in
     * `recordIds` that is dropped as a chat projects `docResident: false`; an
     * id listed here projects `true`, which is what makes the chat arm of the
     * addressability gate reachable.
     */
    docHomedChatIds: [] as readonly string[],
    /**
     * T11's write-command queue, absent from this fake since it landed. Three
     * ARTIFACT tests in this file were failing on `enqueueWriteCommand is not a
     * function` before the chat gate existed - a stale fake, not a defect in
     * the code under test.
     */
    enqueueWriteCommand: vi.fn<(intent: unknown) => unknown>(() => null),
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
          // The chat half of the union the gate reads. `docResident` is the
          // fact `routeChatWrite` consults on a host that HAS a record plane;
          // on a host without one the gate never reaches it.
          chats: {
            byId: Object.fromEntries<{
              id: string;
              docResident: boolean | null;
            }>([
              ...seam.recordIds.map(
                (id) => [id, { id, docResident: false }] as const,
              ),
              ...seam.docHomedChatIds.map(
                (id) => [id, { id, docResident: true }] as const,
              ),
            ]),
            allIds: [...seam.recordIds, ...seam.docHomedChatIds],
          },
          reparentArtifact: seam.reparentArtifact,
          beginReparentMutation: seam.beginReparentMutation,
          retirePendingMutation: seam.retirePendingMutation,
          enqueueWriteCommand: seam.enqueueWriteCommand,
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

async function drop(
  sourceNodeId: string,
  newParentId: string | null,
): Promise<void> {
  await commitSidebarReparentDrop({
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
  seam.docHomedChatIds = [];
  seam.enqueueWriteCommand.mockClear();
  // The chat arm of the gate reads THIS host's negotiated record-plane
  // coverage, which is process-wide module state. Cleared per test so one
  // test's host cannot decide another's: with nothing recorded the host reads
  // as floor-era, which is the permissive arm.
  resetNegotiatedManifests();
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

    await drop("tui-1", "tui-parent");

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

    await drop("tui-1", "tui-parent");

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

  it("writes the doc for a terminal agent the host serves no record for", async () => {
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

    await drop("tui-legacy", "tui-parent");

    expect(seam.reparentArtifact).toHaveBeenCalledWith(
      "tui-legacy",
      "tui-parent",
    );
    // Q1: doc-only TUI stays Y-only. This RPC names an artifact id, not a
    // tuiAgents map entry — must not start sending `epic.reparentArtifact`.
    expect(seam.request).not.toHaveBeenCalled();
  });

  it("routes a docResident: true agent to the Y.Doc branch even though it is not absent from the union", async () => {
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

    await drop("tui-frozen", "tui-parent");

    expect(seam.reparentArtifact).toHaveBeenCalledWith(
      "tui-frozen",
      "tui-parent",
    );
    expect(seam.request).not.toHaveBeenCalled();
  });

  it("sends a doc-homed chat through epic.reparentChat on a FLOOR-ERA host", async () => {
    // No handshake recorded, so this host has no chat record plane at all -
    // and `epic.reparentChat` is on `RELEASED_FLOOR_METHOD_NAMES`, so it exists
    // there and resolves a doc chat through the host's own storage seam.
    //
    // Ablation: gate the chat arm on `docResident` ALONE and this drop stops
    // being sent - every chat reparent on every floor-era host silently
    // disabled, which is why the predicate reads the host's coverage first.
    seam.tree = treeOf([
      node("chat-doc", "chat", null),
      node("chat-parent", "chat", null),
    ]);
    seam.docHomedChatIds = ["chat-doc"];

    await drop("chat-doc", "chat-parent");

    expect(seam.request).toHaveBeenCalledWith("epic.reparentChat", {
      epicId: "epic-1",
      chatId: "chat-doc",
      newParentId: "chat-parent",
    });
  });

  it("REFUSES a doc-homed chat on a host that serves the chat record plane", async () => {
    // The plane exists and states this row lives in the doc, so the writer
    // cannot address it: `epic.reparentChat` would name no registry row and
    // fail HOST-SIDE, after the row rendered fine. Nothing is sent, and
    // nothing is written to the doc either - on a host with a record plane the
    // doc is not the authority, so a local write would lose to record-wins on
    // the next answer and read as an affordance that works while changing
    // nothing.
    recordNegotiatedHostMethods("host-1", [
      "epic.listChatRecords",
      "epic.reparentChat",
    ]);
    seam.tree = treeOf([
      node("chat-doc", "chat", null),
      node("chat-parent", "chat", null),
    ]);
    seam.docHomedChatIds = ["chat-doc"];

    await drop("chat-doc", "chat-parent");

    expect(seam.request).not.toHaveBeenCalled();
    expect(seam.reparentArtifact).not.toHaveBeenCalled();
    // No optimistic stamp either: an overlay patch for a mutation that is never
    // sent is a row that moves and then snaps back on the next answer.
    expect(seam.beginReparentMutation).not.toHaveBeenCalled();
  });

  it("still sends a STORE-homed chat on a host that serves the record plane", async () => {
    // The other half of the same host: the plane stated this row is in the
    // store, so it is addressable. Without this, the test above would pass just
    // as well against a gate that refused every chat on a record-plane host.
    recordNegotiatedHostMethods("host-1", [
      "epic.listChatRecords",
      "epic.reparentChat",
    ]);
    seam.tree = treeOf([
      node("chat-store", "chat", null),
      node("chat-parent", "chat", null),
    ]);
    seam.recordIds = ["chat-store"];

    await drop("chat-store", "chat-parent");

    expect(seam.request).toHaveBeenCalledWith("epic.reparentChat", {
      epicId: "epic-1",
      chatId: "chat-store",
      newParentId: "chat-parent",
    });
  });

  it("sends a chat through epic.reparentChat even with no terminal records", async () => {
    // Chats are NOT gated on the terminal-agent record slice: `epic.reparentChat`
    // has routed chats since chats-off-YJS, and a doc-only chat resolves through
    // the same storage seam on the host. Gating them too would restore the
    // silent no-op this branch exists to fix.
    seam.tree = treeOf([
      node("chat-1", "chat", null),
      node("chat-parent", "chat", null),
    ]);
    seam.recordIds = [];

    await drop("chat-1", "chat-parent");

    expect(seam.request).toHaveBeenCalledWith("epic.reparentChat", {
      epicId: "epic-1",
      chatId: "chat-1",
      newParentId: "chat-parent",
    });
    expect(seam.reparentArtifact).not.toHaveBeenCalled();
  });

  it("enqueues an artifact drop as a write command, with no direct doc write", async () => {
    // RETARGETED, not patched. T11 moved the artifact reparent off the
    // dual-write (a local `reparentArtifact` Y write PLUS an
    // `epic.reparentArtifact` RPC) onto the write-command queue, which owns
    // ordering, idempotency and the rejected/superseded lifecycle. The
    // assertion follows the seam: the command must carry the same intent the
    // direct pair used to express, and the direct Y write must NOT still
    // happen beside it - a doc write racing a queued command is exactly the
    // double-apply the queue exists to prevent.
    seam.tree = treeOf([
      node("spec-1", "spec", null),
      node("spec-parent", "spec", null),
    ]);

    await commitSidebarReparentDrop({
      epicId: "epic-1",
      sourceNodeId: "spec-1",
      newParentId: "spec-parent",
      panelId: "artifacts",
      viewTabId: "tab-1",
      queryClient,
    });

    expect(seam.enqueueWriteCommand).toHaveBeenCalledTimes(1);
    expect(seam.enqueueWriteCommand).toHaveBeenCalledWith({
      kind: "reparent-artifact",
      artifactId: "spec-1",
      parentId: "spec-parent",
    });
    // The queue is the only writer now. A surviving direct write would apply
    // the move twice - once locally, once when the command commits.
    expect(seam.reparentArtifact).not.toHaveBeenCalled();
    // And the RPC is the queue's to send, not this file's.
    expect(seam.request).not.toHaveBeenCalled();
  });

  it("still enqueues an artifact drop when the session has no client", async () => {
    // Unlike a record-backed agent (silent cancel), an artifact drop is always
    // accepted locally: the queue holds it and sends it when a transport comes
    // back, which is the whole point of an offline-tolerant write path. Before
    // T11 this branch asserted the doc write survived a missing client; the
    // command queue is now what survives it.
    seam.tree = treeOf([
      node("spec-1", "spec", null),
      node("spec-parent", "spec", null),
    ]);
    seam.hasClient = false;

    await commitSidebarReparentDrop({
      epicId: "epic-1",
      sourceNodeId: "spec-1",
      newParentId: "spec-parent",
      panelId: "artifacts",
      viewTabId: "tab-1",
      queryClient,
    });

    expect(seam.enqueueWriteCommand).toHaveBeenCalledWith({
      kind: "reparent-artifact",
      artifactId: "spec-1",
      parentId: "spec-parent",
    });
    expect(seam.reparentArtifact).not.toHaveBeenCalled();
    expect(seam.request).not.toHaveBeenCalled();
  });

  it("does not fall back to a doc write when a record-backed agent has no client", async () => {
    // A session with no serving client is a silent cancel, not a licence to
    // write the doc: the pointer for this row lives on the host, so a Y write
    // would be a no-op the user reads as a move.
    seam.tree = treeOf([
      node("tui-1", "terminal-agent", null),
      node("tui-parent", "terminal-agent", null),
    ]);
    seam.recordIds = ["tui-1", "tui-parent"];
    seam.hasClient = false;

    await drop("tui-1", "tui-parent");

    expect(seam.request).not.toHaveBeenCalled();
    expect(seam.reparentArtifact).not.toHaveBeenCalled();
    // The no-client check runs before the overlay is even stamped - a silent
    // cancel must not leave a phantom pending mutation behind.
    expect(seam.beginReparentMutation).not.toHaveBeenCalled();
    expect(seam.retirePendingMutation).not.toHaveBeenCalled();
  });
});
