import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  canReparent,
  writeReparent,
  type CanReparentResult,
} from "@/lib/epic-y-mutations";
import {
  CrossFamilyParentError,
  MissingNodeError,
  ReparentCycleError,
} from "@/lib/errors";

interface EpicNodeSeed {
  readonly id: string;
  readonly kind: "spec" | "ticket" | "story" | "review";
  readonly title: string;
  readonly parentId: string | null;
  readonly createdAt: number;
}

interface AgentSeed {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly createdAt: number;
}

function seedDoc(args: {
  artifacts?: ReadonlyArray<EpicNodeSeed>;
  chats?: ReadonlyArray<AgentSeed>;
  tuiAgents?: ReadonlyArray<AgentSeed>;
}): Y.Doc {
  const doc = new Y.Doc();
  const epic = doc.getMap("epic");
  if (args.artifacts && args.artifacts.length > 0) {
    const artifacts = new Y.Map<unknown>();
    for (const seed of args.artifacts) {
      const entry = new Y.Map<unknown>();
      entry.set("id", seed.id);
      entry.set("kind", seed.kind);
      entry.set("title", seed.title);
      entry.set("parentId", seed.parentId);
      entry.set("createdAt", seed.createdAt);
      entry.set("updatedAt", seed.createdAt);
      entry.set("content", new Y.XmlFragment());
      artifacts.set(seed.id, entry);
    }
    epic.set("artifacts", artifacts);
  }
  if (args.chats && args.chats.length > 0) {
    const chats = new Y.Map<unknown>();
    for (const seed of args.chats) {
      const entry = new Y.Map<unknown>();
      entry.set("id", seed.id);
      entry.set("title", seed.title);
      entry.set("parentId", seed.parentId);
      entry.set("createdAt", seed.createdAt);
      entry.set("updatedAt", seed.createdAt);
      entry.set("messages", new Y.Array());
      chats.set(seed.id, entry);
    }
    epic.set("chats", chats);
  }
  if (args.tuiAgents && args.tuiAgents.length > 0) {
    const tuiAgents = new Y.Map<unknown>();
    for (const seed of args.tuiAgents) {
      const entry = new Y.Map<unknown>();
      entry.set("id", seed.id);
      entry.set("title", seed.title);
      entry.set("parentId", seed.parentId);
      entry.set("createdAt", seed.createdAt);
      entry.set("updatedAt", seed.createdAt);
      tuiAgents.set(seed.id, entry);
    }
    epic.set("tuiAgents", tuiAgents);
  }
  return doc;
}

function getEntry(
  doc: Y.Doc,
  bucket: "artifacts" | "chats" | "tuiAgents",
  id: string,
): Y.Map<unknown> {
  const epic = doc.getMap("epic");
  const map = epic.get(bucket) as Y.Map<unknown>;
  const entry = map.get(id);
  if (!(entry instanceof Y.Map)) {
    throw new Error(`expected ${bucket}/${id} to be a Y.Map`);
  }
  return entry as Y.Map<unknown>;
}

describe("writeReparent", () => {
  it("moves an artifact under a new artifact parent and bumps updatedAt", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
        {
          id: "spec-b",
          kind: "spec",
          title: "B",
          parentId: null,
          createdAt: 2,
        },
        {
          id: "tic-1",
          kind: "ticket",
          title: "T1",
          parentId: "spec-a",
          createdAt: 3,
        },
      ],
    });
    const before = getEntry(doc, "artifacts", "tic-1").get(
      "updatedAt",
    ) as number;

    const mutated = writeReparent({
      doc,
      nodeId: "tic-1",
      newParentId: "spec-b",
    });

    expect(mutated).toBe(true);
    const entry = getEntry(doc, "artifacts", "tic-1");
    expect(entry.get("parentId")).toBe("spec-b");
    expect(entry.get("updatedAt")).toBeGreaterThanOrEqual(before);
  });

  it("moves a chat under a chat parent (agent-family nesting now allowed)", () => {
    const doc = seedDoc({
      chats: [
        { id: "chat-1", title: "C1", parentId: null, createdAt: 1 },
        { id: "chat-2", title: "C2", parentId: null, createdAt: 2 },
      ],
    });
    const mutated = writeReparent({
      doc,
      nodeId: "chat-2",
      newParentId: "chat-1",
    });
    expect(mutated).toBe(true);
    expect(getEntry(doc, "chats", "chat-2").get("parentId")).toBe("chat-1");
  });

  it("moves a terminal-agent under a chat parent (same agent family)", () => {
    const doc = seedDoc({
      chats: [{ id: "chat-1", title: "C", parentId: null, createdAt: 1 }],
      tuiAgents: [{ id: "agent-1", title: "G", parentId: null, createdAt: 2 }],
    });
    const mutated = writeReparent({
      doc,
      nodeId: "agent-1",
      newParentId: "chat-1",
    });
    expect(mutated).toBe(true);
    expect(getEntry(doc, "tuiAgents", "agent-1").get("parentId")).toBe(
      "chat-1",
    );
  });

  it("moves a node to root when newParentId is null", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
        {
          id: "tic-1",
          kind: "ticket",
          title: "T1",
          parentId: "spec-a",
          createdAt: 2,
        },
      ],
    });
    expect(writeReparent({ doc, nodeId: "tic-1", newParentId: null })).toBe(
      true,
    );
    expect(getEntry(doc, "artifacts", "tic-1").get("parentId")).toBeNull();
  });

  it("returns false (no-op) when the node is already parented under the target", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
        {
          id: "tic-1",
          kind: "ticket",
          title: "T1",
          parentId: "spec-a",
          createdAt: 2,
        },
      ],
    });
    const before = getEntry(doc, "artifacts", "tic-1").get("updatedAt");
    expect(writeReparent({ doc, nodeId: "tic-1", newParentId: "spec-a" })).toBe(
      false,
    );
    // updatedAt untouched on no-op.
    expect(getEntry(doc, "artifacts", "tic-1").get("updatedAt")).toBe(before);
  });

  it("throws MissingNodeError when the node id is unknown", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
      ],
    });
    expect(() =>
      writeReparent({ doc, nodeId: "ghost", newParentId: "spec-a" }),
    ).toThrow(MissingNodeError);
  });

  it("throws MissingNodeError when the proposed parent is unknown", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
      ],
    });
    expect(() =>
      writeReparent({ doc, nodeId: "spec-a", newParentId: "ghost" }),
    ).toThrow(MissingNodeError);
  });

  it("throws CrossFamilyParentError when nesting an artifact under a chat", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
      ],
      chats: [{ id: "chat-1", title: "C", parentId: null, createdAt: 2 }],
    });
    expect(() =>
      writeReparent({ doc, nodeId: "spec-a", newParentId: "chat-1" }),
    ).toThrow(CrossFamilyParentError);
  });

  it("throws CrossFamilyParentError when nesting a chat under an artifact (cross-panel now forbidden)", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
      ],
      chats: [{ id: "chat-1", title: "C", parentId: null, createdAt: 2 }],
    });
    expect(() =>
      writeReparent({ doc, nodeId: "chat-1", newParentId: "spec-a" }),
    ).toThrow(CrossFamilyParentError);
  });

  it("throws ReparentCycleError when newParent equals the node itself", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
      ],
    });
    expect(() =>
      writeReparent({ doc, nodeId: "spec-a", newParentId: "spec-a" }),
    ).toThrow(ReparentCycleError);
  });

  it("throws ReparentCycleError when newParent is an artifact descendant (A→B, attempt B→A)", () => {
    const doc = seedDoc({
      artifacts: [
        { id: "a", kind: "spec", title: "A", parentId: null, createdAt: 1 },
        { id: "b", kind: "ticket", title: "B", parentId: "a", createdAt: 2 },
      ],
    });
    expect(() => writeReparent({ doc, nodeId: "a", newParentId: "b" })).toThrow(
      ReparentCycleError,
    );
  });

  it("throws ReparentCycleError on an agent-family descendant cycle (chat A→B, attempt B→A)", () => {
    const doc = seedDoc({
      chats: [
        { id: "chat-a", title: "A", parentId: null, createdAt: 1 },
        { id: "chat-b", title: "B", parentId: "chat-a", createdAt: 2 },
      ],
    });
    // chat-b already descends from chat-a; moving chat-a under chat-b cycles.
    expect(() =>
      writeReparent({ doc, nodeId: "chat-a", newParentId: "chat-b" }),
    ).toThrow(ReparentCycleError);
  });

  it("does not mutate the doc when validation fails", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
      ],
      chats: [{ id: "chat-1", title: "C", parentId: null, createdAt: 2 }],
    });
    const beforeUpdated = getEntry(doc, "artifacts", "spec-a").get("updatedAt");
    expect(() =>
      writeReparent({ doc, nodeId: "spec-a", newParentId: "chat-1" }),
    ).toThrow(CrossFamilyParentError);
    expect(getEntry(doc, "artifacts", "spec-a").get("parentId")).toBeNull();
    expect(getEntry(doc, "artifacts", "spec-a").get("updatedAt")).toBe(
      beforeUpdated,
    );
  });

  it("emits a single Y.Doc update frame for one reparent", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
        {
          id: "spec-b",
          kind: "spec",
          title: "B",
          parentId: null,
          createdAt: 2,
        },
        {
          id: "tic-1",
          kind: "ticket",
          title: "T1",
          parentId: "spec-a",
          createdAt: 3,
        },
      ],
    });
    let updateCount = 0;
    const onUpdate = () => {
      updateCount += 1;
    };
    doc.on("update", onUpdate);
    writeReparent({ doc, nodeId: "tic-1", newParentId: "spec-b" });
    doc.off("update", onUpdate);
    expect(updateCount).toBe(1);
  });
});

describe("canReparent", () => {
  it("returns ok for a valid artifact move", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
        {
          id: "spec-b",
          kind: "spec",
          title: "B",
          parentId: null,
          createdAt: 2,
        },
      ],
    });
    expect(canReparent(doc, "spec-a", "spec-b")).toEqual({ ok: true });
  });

  it("returns ok for a chat under a chat", () => {
    const doc = seedDoc({
      chats: [
        { id: "chat-1", title: "C1", parentId: null, createdAt: 1 },
        { id: "chat-2", title: "C2", parentId: null, createdAt: 2 },
      ],
    });
    expect(canReparent(doc, "chat-2", "chat-1")).toEqual({ ok: true });
  });

  it("flags missing-node when the node is absent", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
      ],
    });
    expect(canReparent(doc, "ghost", null)).toEqual({
      ok: false,
      reason: "missing-node",
    });
  });

  it("flags missing-node when the parent is absent", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
      ],
    });
    expect(canReparent(doc, "spec-a", "ghost")).toEqual({
      ok: false,
      reason: "missing-node",
    });
  });

  it("flags cross-panel when an artifact targets a chat", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
      ],
      chats: [{ id: "chat-1", title: "C", parentId: null, createdAt: 2 }],
    });
    expect(canReparent(doc, "spec-a", "chat-1")).toEqual({
      ok: false,
      reason: "cross-panel",
    });
  });

  it("flags cross-panel when a chat targets an artifact", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
      ],
      chats: [{ id: "chat-1", title: "C", parentId: null, createdAt: 2 }],
    });
    expect(canReparent(doc, "chat-1", "spec-a")).toEqual({
      ok: false,
      reason: "cross-panel",
    });
  });

  it("flags cycle when target equals the node itself", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
      ],
    });
    expect(canReparent(doc, "spec-a", "spec-a")).toEqual({
      ok: false,
      reason: "cycle",
    });
  });

  it("flags cycle when target is an artifact descendant", () => {
    const doc = seedDoc({
      artifacts: [
        { id: "a", kind: "spec", title: "A", parentId: null, createdAt: 1 },
        { id: "b", kind: "ticket", title: "B", parentId: "a", createdAt: 2 },
        { id: "c", kind: "story", title: "C", parentId: "b", createdAt: 3 },
      ],
    });
    expect(canReparent(doc, "a", "c")).toEqual({ ok: false, reason: "cycle" });
  });

  it("flags cycle on an agent-family descendant (chat chain)", () => {
    const doc = seedDoc({
      chats: [
        { id: "chat-a", title: "A", parentId: null, createdAt: 1 },
        { id: "chat-b", title: "B", parentId: "chat-a", createdAt: 2 },
      ],
      tuiAgents: [
        { id: "agent-c", title: "C", parentId: "chat-b", createdAt: 3 },
      ],
    });
    // chat-a → agent-c would cycle (agent-c descends from chat-a via chat-b).
    expect(canReparent(doc, "chat-a", "agent-c")).toEqual({
      ok: false,
      reason: "cycle",
    });
  });

  it("flags same-parent when no movement would occur", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
        {
          id: "tic-1",
          kind: "ticket",
          title: "T1",
          parentId: "spec-a",
          createdAt: 2,
        },
      ],
    });
    expect(canReparent(doc, "tic-1", "spec-a")).toEqual({
      ok: false,
      reason: "same-parent",
    });
    // root → root no-op too.
    expect(canReparent(doc, "spec-a", null)).toEqual({
      ok: false,
      reason: "same-parent",
    });
  });

  it("does not mutate the doc when invoked", () => {
    const doc = seedDoc({
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: null,
          createdAt: 1,
        },
        {
          id: "spec-b",
          kind: "spec",
          title: "B",
          parentId: null,
          createdAt: 2,
        },
      ],
    });
    let updateCount = 0;
    doc.on("update", () => {
      updateCount += 1;
    });
    canReparent(doc, "spec-a", "spec-b");
    canReparent(doc, "spec-a", "ghost");
    canReparent(doc, "ghost", null);
    expect(updateCount).toBe(0);
  });

  it("does not falsely flag cycle when the parent chain contains a pre-existing cycle", () => {
    const doc = seedDoc({
      artifacts: [
        // Pre-existing a <-> b cycle (e.g. a concurrent-edit Yjs merge that
        // neither the host nor the projector breaks).
        { id: "a", kind: "spec", title: "A", parentId: "b", createdAt: 1 },
        { id: "b", kind: "spec", title: "B", parentId: "a", createdAt: 2 },
        // c hangs off the cycle; l is an unrelated leaf at root.
        { id: "c", kind: "ticket", title: "C", parentId: "a", createdAt: 3 },
        { id: "l", kind: "ticket", title: "L", parentId: null, createdAt: 4 },
      ],
    });
    // Moving l under c walks c -> a -> b -> a (revisit) without ever reaching
    // l, so it must be allowed - the chain looping is not l's descendant.
    expect(canReparent(doc, "l", "c")).toEqual({ ok: true });
    // A node caught in the cycle can still escape to a safe parent (the walk
    // from l never revisits a, so a is not flagged as l's descendant).
    expect(canReparent(doc, "a", "l")).toEqual({ ok: true });
  });

  it("surfaces cross-panel (not same-parent) when re-dropping onto a corrupt cross-family parent", () => {
    const doc = seedDoc({
      // Artifact whose parentId corruptly points at a chat (different family).
      artifacts: [
        {
          id: "spec-a",
          kind: "spec",
          title: "A",
          parentId: "chat-1",
          createdAt: 1,
        },
      ],
      chats: [{ id: "chat-1", title: "C", parentId: null, createdAt: 2 }],
    });
    // Re-dropping spec-a back onto chat-1 must report the real cross-family
    // reason, not be masked as a silent same-parent no-op.
    expect(canReparent(doc, "spec-a", "chat-1")).toEqual({
      ok: false,
      reason: "cross-panel",
    });
  });

  // Agreement guard: `canReparent` and `writeReparent` both delegate to the
  // shared `evaluateReparent` (so does the store's `reparentArtifactAction`),
  // so their accept/reject decisions must agree on every matrix cell.
  it("mirrors writeReparent decisions across the matrix", () => {
    const setup = () =>
      seedDoc({
        artifacts: [
          { id: "a", kind: "spec", title: "A", parentId: null, createdAt: 1 },
          { id: "b", kind: "ticket", title: "B", parentId: "a", createdAt: 2 },
        ],
        chats: [
          { id: "chat-1", title: "C1", parentId: null, createdAt: 3 },
          { id: "chat-2", title: "C2", parentId: null, createdAt: 4 },
        ],
      });

    const cases: ReadonlyArray<{
      nodeId: string;
      newParentId: string | null;
      expected: CanReparentResult;
      writeShouldThrow: boolean;
    }> = [
      // happy path: artifact → root.
      {
        nodeId: "b",
        newParentId: null,
        expected: { ok: true },
        writeShouldThrow: false,
      },
      // happy path: chat under chat (agent family).
      {
        nodeId: "chat-2",
        newParentId: "chat-1",
        expected: { ok: true },
        writeShouldThrow: false,
      },
      // same-parent: ok=false → write returns false (no throw).
      {
        nodeId: "b",
        newParentId: "a",
        expected: { ok: false, reason: "same-parent" },
        writeShouldThrow: false,
      },
      // cycle (self).
      {
        nodeId: "a",
        newParentId: "a",
        expected: { ok: false, reason: "cycle" },
        writeShouldThrow: true,
      },
      // cycle (descendant).
      {
        nodeId: "a",
        newParentId: "b",
        expected: { ok: false, reason: "cycle" },
        writeShouldThrow: true,
      },
      // cross-panel: artifact under chat.
      {
        nodeId: "a",
        newParentId: "chat-1",
        expected: { ok: false, reason: "cross-panel" },
        writeShouldThrow: true,
      },
      // cross-panel: chat under artifact.
      {
        nodeId: "chat-1",
        newParentId: "a",
        expected: { ok: false, reason: "cross-panel" },
        writeShouldThrow: true,
      },
      // missing parent.
      {
        nodeId: "a",
        newParentId: "ghost",
        expected: { ok: false, reason: "missing-node" },
        writeShouldThrow: true,
      },
      // missing node.
      {
        nodeId: "ghost",
        newParentId: "a",
        expected: { ok: false, reason: "missing-node" },
        writeShouldThrow: true,
      },
    ];

    for (const c of cases) {
      const doc = setup();
      expect(canReparent(doc, c.nodeId, c.newParentId)).toEqual(c.expected);
      if (c.writeShouldThrow) {
        expect(() =>
          writeReparent({
            doc,
            nodeId: c.nodeId,
            newParentId: c.newParentId,
          }),
        ).toThrow();
      } else {
        // ok or same-parent: write is non-throwing.
        expect(() =>
          writeReparent({
            doc,
            nodeId: c.nodeId,
            newParentId: c.newParentId,
          }),
        ).not.toThrow();
      }
    }
  });
});
