/**
 * Store integration for Phase 1.1's optimistic metadata overlay
 * (`beginRenameMutation` / `beginEpicTitleMutation` / `beginReparentMutation`
 * / `retirePendingMutation`). Drives a REAL `createOpenEpicStore` session
 * against a real Y.Doc - the same `newSession()` shape as
 * `epic-projector.test.ts` - so these assert the published projection, not a
 * mocked stand-in for it.
 */
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createArtifactInDocForTests } from "./projection-helpers-test-shims";
import {
  createOpenEpicStore,
  LOCAL_ORIGIN,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import {
  ensureMap,
  getEpicMap,
} from "@/stores/epics/open-epic/projection-helpers";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { ChatRecordSummary } from "@traycer/protocol/host/epic/chat-records";

function chatRecord(overrides: Partial<ChatRecordSummary>): ChatRecordSummary {
  return {
    chatId: "c",
    ownerUserId: "user-a",
    originHostId: "host-1",
    title: "A",
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

/**
 * Seeds an UNTITLED chat directly (raw `title: ""`) - the shim's
 * `createArtifactInDocForTests` always seeds a non-empty placeholder title,
 * so an untitled row needs its own helper.
 */
function createUntitledChatInDocForTests(doc: Y.Doc): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  doc.transact(() => {
    const chats = ensureMap(getEpicMap(doc), "chats");
    const entry = new Y.Map<unknown>();
    entry.set("id", id);
    entry.set("title", "");
    entry.set("parentId", null);
    entry.set("createdAt", now);
    entry.set("updatedAt", now);
    entry.set("messages", new Y.Array());
    chats.set(id, entry);
  }, LOCAL_ORIGIN);
  return id;
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(permissionRole: PermissionRole): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-test",
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
    permissionRole,
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

function newSession(permissionRole: PermissionRole): {
  handle: OpenEpicStoreHandle;
  callbacks: EpicStreamCallbacks;
} {
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
    epicId: "epic-test",
    streamClientFactory: factory,
    userId: null,
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  const seed = Y.encodeStateAsUpdate(new Y.Doc());
  captured.value.onSnapshot(makeMeta(permissionRole), seed);
  return { handle, callbacks: captured.value };
}

describe("beginRenameMutation", () => {
  it("shows the optimistic title synchronously, before any RPC settles", () => {
    const { handle } = newSession("editor");
    const id = createArtifactInDocForTests(handle.doc, "spec", null);

    const requestId = handle.store
      .getState()
      .beginRenameMutation(id, "Renamed live");

    expect(requestId).not.toBeNull();
    expect(handle.store.getState().tree.nodeById[id].title).toBe(
      "Renamed live",
    );
    expect(handle.store.getState().artifacts.byId[id].title).toBe(
      "Renamed live",
    );
    handle.dispose();
  });

  it("retiring as FAILED deletes the entry and reveals the authoritative value", () => {
    const { handle } = newSession("editor");
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const requestId = handle.store
      .getState()
      .beginRenameMutation(id, "Renamed live");
    if (requestId === null) throw new Error("expected a request id");

    const retired = handle.store
      .getState()
      .retirePendingMutation(requestId, "failed");

    expect(retired).toBe(true);
    // The authoritative doc row was never actually renamed, so a failed
    // retire reveals the ORIGINAL title.
    expect(handle.store.getState().artifacts.byId[id].title).toBe("New spec");
    handle.dispose();
  });

  it("retiring as LANDED, with no doc echo yet, keeps showing the acked target (the row IS the projection, not stale)", () => {
    const { handle } = newSession("editor");
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const requestId = handle.store
      .getState()
      .beginRenameMutation(id, "Renamed live");
    if (requestId === null) throw new Error("expected a request id");

    const retired = handle.store
      .getState()
      .retirePendingMutation(requestId, "landed");

    expect(retired).toBe(true);
    // The RPC acked, but the doc's row has not visibly caught up yet - the
    // landed-only chain keeps showing its last landed target.
    expect(handle.store.getState().artifacts.byId[id].title).toBe(
      "Renamed live",
    );
    handle.dispose();
  });

  it("no-ops against the DISPLAYED value, not the chain baseline - renaming back to the original while a landed rename awaits its echo stamps a real entry", () => {
    const { handle } = newSession("editor");
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const first = handle.store.getState().beginRenameMutation(id, "B");
    if (first === null) throw new Error("expected a request id");
    handle.store.getState().retirePendingMutation(first, "landed");
    // Landed, no doc echo yet - display shows "B".
    expect(handle.store.getState().artifacts.byId[id].title).toBe("B");

    // Renaming back to the ORIGINAL title ("New spec") differs from what is
    // DISPLAYED ("B"), so this must stamp a real entry - a baseline compare
    // would have wrongly no-op'd here (baseline IS "New spec"), leaving the
    // UI stuck on "B" until a full round trip.
    const second = handle.store.getState().beginRenameMutation(id, "New spec");

    expect(second).not.toBeNull();
    expect(handle.store.getState().artifacts.byId[id].title).toBe("New spec");
    handle.dispose();
  });

  it("once the doc echoes a landed mutation's target, the chain goes dead and is swept from the map", () => {
    const { handle } = newSession("editor");
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const requestId = handle.store
      .getState()
      .beginRenameMutation(id, "Renamed live");
    if (requestId === null) throw new Error("expected a request id");
    handle.store.getState().retirePendingMutation(requestId, "landed");

    // Simulate the doc echoing the host's own write of the acked value.
    const rawArtifactsMap = handle.doc.getMap("epic").get("artifacts");
    if (!(rawArtifactsMap instanceof Y.Map)) throw new Error("expected map");
    const artifactsMap: Y.Map<unknown> = rawArtifactsMap;
    const rawEntry = artifactsMap.get(id);
    if (!(rawEntry instanceof Y.Map)) throw new Error("expected entry");
    const entry: Y.Map<unknown> = rawEntry;
    handle.doc.transact(() => {
      entry.set("title", "Renamed live");
    });

    expect(handle.store.getState().artifacts.byId[id].title).toBe(
      "Renamed live",
    );
    // The chain is dead now - a plain (non-overlay) rename on the SAME node
    // must not be blocked or shadowed by a stale entry.
    expect(
      handle.store.getState().beginRenameMutation(id, "Plain rename"),
    ).not.toBeNull();
    handle.dispose();
  });

  it("retiring an unknown requestId is a no-op that returns false", () => {
    const { handle } = newSession("editor");

    expect(
      handle.store.getState().retirePendingMutation("ghost", "failed"),
    ).toBe(false);
    handle.dispose();
  });

  it("a chat (registry-backed row shape) also gets the optimistic overlay", () => {
    const { handle } = newSession("editor");
    const chatId = createArtifactInDocForTests(handle.doc, "chat", null);

    const requestId = handle.store
      .getState()
      .beginRenameMutation(chatId, "New chat title");

    expect(requestId).not.toBeNull();
    expect(handle.store.getState().chats.byId[chatId].title).toBe(
      "New chat title",
    );
    handle.dispose();
  });

  it("baseline comes from the RAW union row, not the tree's display fallback - an UNTITLED row's rename applies", () => {
    const { handle } = newSession("editor");
    const chatId = createUntitledChatInDocForTests(handle.doc);
    // The tree carries an "Untitled ..." display fallback for empty titles;
    // the raw row title is still "".
    expect(handle.store.getState().chats.byId[chatId].title).toBe("");

    const requestId = handle.store
      .getState()
      .beginRenameMutation(chatId, "Plan");

    // Before this fix, a baseline read off the tree's fallback string could
    // never match the row's actual "" title, so the patch silently never
    // applied.
    expect(requestId).not.toBeNull();
    expect(handle.store.getState().chats.byId[chatId].title).toBe("Plan");
    handle.dispose();
  });

  it("a second begin on the same node chains off the FIRST mutation's baseline, and survives retiring the first as LANDED", () => {
    const { handle } = newSession("editor");
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const first = handle.store.getState().beginRenameMutation(id, "B");
    if (first === null) throw new Error("expected a request id");
    const second = handle.store.getState().beginRenameMutation(id, "C");
    if (second === null) throw new Error("expected a request id");

    // The row shows the LATEST stamped value while both are pending.
    expect(handle.store.getState().artifacts.byId[id].title).toBe("C");

    // The host acks the FIRST rename's RPC ("B"). Retiring it as "landed"
    // (rather than deleting it outright) is exactly what keeps the still-
    // pending second entry anchored: the chain now has an explicit landed
    // target ("B") to anchor against, independent of whether the doc has
    // visibly echoed it yet.
    handle.store.getState().retirePendingMutation(first, "landed");
    expect(handle.store.getState().artifacts.byId[id].title).toBe("C");

    // The doc now echoes the host's write of "B" - the row moves off the
    // ORIGINAL baseline ("New spec") but lands on the chain's own (now
    // landed) first target, so the still-pending second entry still applies.
    const rawArtifactsMap = handle.doc.getMap("epic").get("artifacts");
    if (!(rawArtifactsMap instanceof Y.Map)) throw new Error("expected map");
    const artifactsMap: Y.Map<unknown> = rawArtifactsMap;
    const rawEntry = artifactsMap.get(id);
    if (!(rawEntry instanceof Y.Map)) throw new Error("expected entry");
    const entry: Y.Map<unknown> = rawEntry;
    handle.doc.transact(() => {
      entry.set("title", "B");
    });
    expect(handle.store.getState().artifacts.byId[id].title).toBe("C");

    // Finally the second's own RPC acks too and the doc echoes it - the
    // chain is now fully landed and caught up, so it goes dead.
    handle.store.getState().retirePendingMutation(second, "landed");
    handle.doc.transact(() => {
      entry.set("title", "C");
    });
    expect(handle.store.getState().artifacts.byId[id].title).toBe("C");
    handle.dispose();
  });

  it("shows the LAST-STAMPED target when the NEWER entry acks first, not the older still-pending one - an out-of-order ACK must not walk the display backward", () => {
    const { handle } = newSession("editor");
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const first = handle.store.getState().beginRenameMutation(id, "B");
    if (first === null) throw new Error("expected a request id");
    const second = handle.store.getState().beginRenameMutation(id, "C");
    if (second === null) throw new Error("expected a request id");
    expect(handle.store.getState().artifacts.byId[id].title).toBe("C");

    // The SECOND (newer) rename's RPC acks FIRST, while the first ("B") is
    // still pending. Filtering landed entries out of display selection (the
    // pre-fix behavior) would fall back to the still-pending "B" here -
    // regressing the newest thing the user asked for until "B" also settles.
    handle.store.getState().retirePendingMutation(second, "landed");
    expect(handle.store.getState().artifacts.byId[id].title).toBe("C");

    // "B" acks too - the chain is now fully landed. Continuity across the
    // final settle: still "C", the last-stamped target.
    handle.store.getState().retirePendingMutation(first, "landed");
    expect(handle.store.getState().artifacts.byId[id].title).toBe("C");
    handle.dispose();
  });

  it("returns null for a viewer role", () => {
    const { handle } = newSession("viewer");
    const id = createArtifactInDocForTests(handle.doc, "spec", null);

    expect(handle.store.getState().beginRenameMutation(id, "Nope")).toBeNull();
    handle.dispose();
  });

  it("returns null when the requested title already equals the current value", () => {
    const { handle } = newSession("editor");
    const id = createArtifactInDocForTests(handle.doc, "spec", null);

    expect(
      handle.store.getState().beginRenameMutation(id, "New spec"),
    ).toBeNull();
    handle.dispose();
  });

  it("returns null for an unknown nodeId", () => {
    const { handle } = newSession("editor");

    expect(
      handle.store.getState().beginRenameMutation("ghost", "Anything"),
    ).toBeNull();
    handle.dispose();
  });
});

describe("beginEpicTitleMutation", () => {
  it("shows the optimistic title in epic.title synchronously", () => {
    const { handle } = newSession("editor");
    handle.doc.transact(() => {
      handle.doc.getMap("epic").set("title", "Original epic title");
    });

    const requestId = handle.store
      .getState()
      .beginEpicTitleMutation("New epic title");

    expect(requestId).not.toBeNull();
    expect(handle.store.getState().epic.title).toBe("New epic title");
    handle.dispose();
  });

  it("returns null when the value already matches", () => {
    const { handle } = newSession("editor");
    handle.doc.transact(() => {
      handle.doc.getMap("epic").set("title", "Same title");
    });

    expect(
      handle.store.getState().beginEpicTitleMutation("Same title"),
    ).toBeNull();
    handle.dispose();
  });
});

describe("beginReparentMutation", () => {
  it("moves the node in the published tree", () => {
    const { handle } = newSession("editor");
    const parent = createArtifactInDocForTests(handle.doc, "spec", null);
    const child = createArtifactInDocForTests(handle.doc, "ticket", null);

    const requestId = handle.store
      .getState()
      .beginReparentMutation(child, parent);

    expect(requestId).not.toBeNull();
    const tree = handle.store.getState().tree;
    expect(tree.rootIds).not.toContain(child);
    expect(tree.childrenByParent[parent]).toContain(child);
    handle.dispose();
  });

  it("stale-parent case: a row whose RAW parentId points at a deleted node (tree promotes it to root) still reparents optimistically", () => {
    const { handle } = newSession("editor");
    // The raw doc parentId names a node that was never created - the tree
    // projector's `resolveEffectiveParent` cannot resolve it and promotes
    // this row to root, but the ARTIFACT'S OWN raw `parentId` field still
    // reads "deleted-parent" verbatim. The new baseline-capture contract
    // reads THAT raw value, not the tree's nulled effective parent.
    const orphan = createArtifactInDocForTests(
      handle.doc,
      "spec",
      "deleted-parent",
    );
    const newParent = createArtifactInDocForTests(handle.doc, "spec", null);
    expect(handle.store.getState().tree.rootIds).toContain(orphan);
    expect(handle.store.getState().artifacts.byId[orphan].parentId).toBe(
      "deleted-parent",
    );

    const requestId = handle.store
      .getState()
      .beginReparentMutation(orphan, newParent);

    expect(requestId).not.toBeNull();
    const tree = handle.store.getState().tree;
    expect(tree.rootIds).not.toContain(orphan);
    expect(tree.childrenByParent[newParent]).toContain(orphan);
    handle.dispose();
  });

  it("returns null for a cycle (parent is the node's own descendant)", () => {
    const { handle } = newSession("editor");
    const root = createArtifactInDocForTests(handle.doc, "spec", null);
    const child = createArtifactInDocForTests(handle.doc, "ticket", root);

    // Dropping `root` onto its own child would create a cycle.
    expect(
      handle.store.getState().beginReparentMutation(root, child),
    ).toBeNull();
    handle.dispose();
  });

  it("returns null for a cross-family move (artifact under a chat)", () => {
    const { handle } = newSession("editor");
    const artifact = createArtifactInDocForTests(handle.doc, "spec", null);
    const chat = createArtifactInDocForTests(handle.doc, "chat", null);

    expect(
      handle.store.getState().beginReparentMutation(artifact, chat),
    ).toBeNull();
    handle.dispose();
  });

  it("returns null for a same-parent move (no-op)", () => {
    const { handle } = newSession("editor");
    const parent = createArtifactInDocForTests(handle.doc, "spec", null);
    const child = createArtifactInDocForTests(handle.doc, "ticket", parent);

    expect(
      handle.store.getState().beginReparentMutation(child, parent),
    ).toBeNull();
    handle.dispose();
  });

  it("returns null for a viewer role", () => {
    const { handle } = newSession("viewer");
    const parent = createArtifactInDocForTests(handle.doc, "spec", null);
    const child = createArtifactInDocForTests(handle.doc, "ticket", null);

    expect(
      handle.store.getState().beginReparentMutation(child, parent),
    ).toBeNull();
    handle.dispose();
  });
});

describe("dispose", () => {
  it("clears the pending mutation map", () => {
    const { handle } = newSession("editor");
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const requestId = handle.store
      .getState()
      .beginRenameMutation(id, "Renamed live");
    if (requestId === null) throw new Error("expected a request id");

    handle.dispose();

    // Nothing left to retire - dispose already cleared it.
    expect(
      handle.store.getState().retirePendingMutation(requestId, "failed"),
    ).toBe(false);
  });
});

describe("detachTransport", () => {
  it("an un-landed entry survives detach, but its later 'landed' retire deletes instead of marking landed - the RPC still owns a terminal retire, but there is no attached projector left to keep it around for", () => {
    const { handle } = newSession("editor");
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const requestId = handle.store
      .getState()
      .beginRenameMutation(id, "Renamed live");
    if (requestId === null) throw new Error("expected a request id");

    handle.detachTransport();

    // Still shown - detach only sweeps already-LANDED entries, and this one
    // never landed.
    expect(handle.store.getState().artifacts.byId[id].title).toBe(
      "Renamed live",
    );

    // The RPC's own terminal retire arrives after detach. With no attached
    // projector, `retirePendingMutation` deletes rather than marking landed -
    // observable here only via the boolean return values below, since the
    // detached store no longer republishes a projection to inspect.
    expect(
      handle.store.getState().retirePendingMutation(requestId, "landed"),
    ).toBe(true);
    // The first call already deleted the entry, so a second terminal retire
    // for the same requestId finds nothing left.
    expect(
      handle.store.getState().retirePendingMutation(requestId, "failed"),
    ).toBe(false);

    handle.dispose();
  });
});

describe("landed-entry TTL", () => {
  it("a landed entry self-expires and row-wins once LANDED_MUTATION_TTL_MS passes with no echo - the bounded bridge for a peer's write-back to the baseline", () => {
    vi.useFakeTimers();
    try {
      const { handle } = newSession("editor");
      const id = createArtifactInDocForTests(handle.doc, "spec", null);
      const baseline = handle.store.getState().artifacts.byId[id].title;
      const requestId = handle.store
        .getState()
        .beginRenameMutation(id, "Renamed live");
      if (requestId === null) throw new Error("expected a request id");
      handle.store.getState().retirePendingMutation(requestId, "landed");
      expect(handle.store.getState().artifacts.byId[id].title).toBe(
        "Renamed live",
      );

      // 1ms shy of the TTL: the ack still outranks the still-baseline row.
      vi.advanceTimersByTime(29_999);
      expect(handle.store.getState().artifacts.byId[id].title).toBe(
        "Renamed live",
      );

      // Past the TTL: the entry expires, the row falls back to whatever the
      // doc actually holds (still `baseline` - our echo never came), and a
      // second terminal retire for the same requestId proves it is gone.
      vi.advanceTimersByTime(1);
      expect(handle.store.getState().artifacts.byId[id].title).toBe(baseline);
      expect(
        handle.store.getState().retirePendingMutation(requestId, "failed"),
      ).toBe(false);

      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is CHAIN-SCOPED: a landed entry re-arms instead of expiring while an un-landed sibling still anchors on it, and only expires once the chain drains", () => {
    vi.useFakeTimers();
    try {
      const { handle } = newSession("editor");
      const id = createArtifactInDocForTests(handle.doc, "spec", null);
      const baseline = handle.store.getState().artifacts.byId[id].title;

      const r1 = handle.store.getState().beginRenameMutation(id, "B");
      if (r1 === null) throw new Error("expected a request id");
      handle.store.getState().retirePendingMutation(r1, "landed");
      expect(handle.store.getState().artifacts.byId[id].title).toBe("B");

      // A second, still-PENDING mutation chains off the same node. It relies
      // on r1's landed target as part of its anchor set.
      const r2 = handle.store.getState().beginRenameMutation(id, "C");
      if (r2 === null) throw new Error("expected a request id");
      expect(handle.store.getState().artifacts.byId[id].title).toBe("C");

      // r1's TTL fires here. Before the chain-scoped fix this deleted r1
      // outright, stripping r2's anchor set and reading r2's own future echo
      // as off-anchor supersession. Now it finds r2 unsettled and re-arms
      // instead - r2 keeps showing normally.
      vi.advanceTimersByTime(30_000);
      expect(handle.store.getState().artifacts.byId[id].title).toBe("C");

      // r2 settles (terminal failure - the simplest way to drain it). r1 is
      // still landed and un-expired, so it keeps anchoring the display.
      handle.store.getState().retirePendingMutation(r2, "failed");
      expect(handle.store.getState().artifacts.byId[id].title).toBe("B");

      // r1's RE-ARMED timer's next fire (another full TTL later) finds no
      // unsettled sibling left and finally expires it, converging on the
      // authoritative value.
      vi.advanceTimersByTime(30_000);
      expect(handle.store.getState().artifacts.byId[id].title).toBe(baseline);
      expect(handle.store.getState().retirePendingMutation(r1, "failed")).toBe(
        false,
      );

      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is TAIL-owned and chain-ATOMIC: an out-of-order ACK must not walk the display backward through the chain's history", () => {
    vi.useFakeTimers();
    try {
      const { handle } = newSession("editor");
      const id = createArtifactInDocForTests(handle.doc, "spec", null);
      const baseline = handle.store.getState().artifacts.byId[id].title;

      const r1 = handle.store.getState().beginRenameMutation(id, "B");
      if (r1 === null) throw new Error("expected a request id");
      const r2 = handle.store.getState().beginRenameMutation(id, "C");
      if (r2 === null) throw new Error("expected a request id");
      expect(handle.store.getState().artifacts.byId[id].title).toBe("C");

      // r2 - the chain TAIL, last STAMPED - acks first, out of order. Its
      // own expiry timer arms now, for t=30_000.
      handle.store.getState().retirePendingMutation(r2, "landed");

      vi.advanceTimersByTime(10_000);
      // r1 acks ten seconds later. It is NOT the tail, so even once landed
      // it never owns the chain's deletion - only re-arming or standing
      // aside for the tail's timer.
      handle.store.getState().retirePendingMutation(r1, "landed");
      expect(handle.store.getState().artifacts.byId[id].title).toBe("C");

      // Just shy of r2's t=30_000 fire (20_000 more from t=10_000): still
      // the tail's target.
      vi.advanceTimersByTime(19_999);
      expect(handle.store.getState().artifacts.byId[id].title).toBe("C");

      // r2's timer fires at t=30_000. The whole chain is landed now and r2
      // is the tail, so it deletes BOTH entries atomically in one pass -
      // the display must never regress to r1's target "B" first, which
      // per-entry deletion (the pre-fix bug) would have done by deleting
      // only r2 here and leaving r1 to expire later.
      vi.advanceTimersByTime(1);
      expect(handle.store.getState().artifacts.byId[id].title).not.toBe("B");
      expect(handle.store.getState().artifacts.byId[id].title).toBe(baseline);

      expect(handle.store.getState().retirePendingMutation(r1, "failed")).toBe(
        false,
      );
      expect(handle.store.getState().retirePendingMutation(r2, "failed")).toBe(
        false,
      );

      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("chat-record revision guard protects a pending overlay chain from a delayed poll answer", () => {
  it("list P(rev1/A) -> push rev2/C -> delayed P lands -> C survives and the pending C->B overlay chain is not swept", () => {
    const { handle } = newSession("editor");
    const store = handle.store;

    store
      .getState()
      .applyChatRecords([chatRecord({ title: "A", revision: 1 })], null);
    // Captured BEFORE the push below - simulates a poll request dispatched
    // ahead of it, whose answer lands late.
    const fenceBeforePush = store.getState().peekChatIngestSeq();
    expect(store.getState().chats.byId.c.title).toBe("A");

    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: chatRecord({ title: "C", revision: 2 }),
    });
    expect(store.getState().chats.byId.c.title).toBe("C");

    const requestId = store.getState().beginRenameMutation("c", "B");
    if (requestId === null) throw new Error("expected a request id");
    expect(store.getState().chats.byId.c.title).toBe("B");

    // The delayed answer: fenced before the push, and still carrying the
    // row's now-stale revision.
    store
      .getState()
      .applyChatRecords(
        [chatRecord({ title: "A", revision: 1 })],
        fenceBeforePush,
      );

    // Rejected by the revision guard (item 2's monotonic merge) - the
    // authoritative row is still "C", so the pending chain stays ANCHORED on
    // its own baseline and the overlay keeps showing "B".
    expect(store.getState().chats.byId.c.title).toBe("B");

    // Proven not swept: the chain is still in the map to retire, and
    // retiring it reveals the authoritative "C" (never regressed to "A").
    expect(store.getState().retirePendingMutation(requestId, "failed")).toBe(
      true,
    );
    expect(store.getState().chats.byId.c.title).toBe("C");

    handle.dispose();
  });
});
