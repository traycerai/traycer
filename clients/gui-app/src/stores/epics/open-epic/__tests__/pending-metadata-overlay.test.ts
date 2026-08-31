/**
 * Pure applier tests for `pending-metadata-overlay.ts`, against the
 * `landed`-flag contract (row-wins is unconditional for any authoritative
 * move that isn't an ACKED local target; a landed-only chain stays alive
 * until the host visibly catches up to its LAST landed target).
 *
 * Mutations are constructed by hand and folded over hand-built slices, so
 * these tests pin the anchoring/row-wins/dead-chain rules in isolation from
 * everything that stamps a mutation.
 */
import { describe, expect, it } from "vitest";
import {
  applyPendingOverlayToArtifacts,
  applyPendingOverlayToChats,
  applyPendingOverlayToEpicHeader,
  applyPendingOverlayToTuiAgents,
  collectDeadPendingMutations,
  EMPTY_PENDING_OVERLAY,
  pendingMutationCount,
  type PendingMetadataMutation,
  type PendingOverlayAuthoritativeState,
} from "@/stores/epics/open-epic/pending-metadata-overlay";
import type {
  ArtifactProjection,
  ArtifactsSlice,
  ChatProjection,
  ChatsSlice,
  EpicHeader,
  TerminalAgentsSlice,
  TuiAgentProjection,
} from "@/stores/epics/open-epic/types";

function makeArtifactProjection(
  id: string,
  title: string,
  parentId: string | null,
): ArtifactProjection {
  return {
    id,
    kind: "spec",
    title,
    folderName: "",
    parentId,
    artifactRoomId: null,
    createdAt: 0,
    updatedAt: 0,
    status: null,
    createdManually: false,
  };
}

function makeArtifactsSlice(
  entries: readonly ArtifactProjection[],
): ArtifactsSlice {
  const byId: Record<string, ArtifactProjection> = {};
  for (const entry of entries) byId[entry.id] = entry;
  return { byId, allIds: entries.map((e) => e.id) };
}

function makeChatProjection(
  id: string,
  title: string,
  parentId: string | null,
): ChatProjection {
  return {
    id,
    title,
    parentId,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: null,
    isTitleEditedByUser: false,
    settings: null,
    archivedAt: null,
  };
}

function makeChatsSlice(entries: readonly ChatProjection[]): ChatsSlice {
  const byId: Record<string, ChatProjection> = {};
  for (const entry of entries) byId[entry.id] = entry;
  return { byId, allIds: entries.map((e) => e.id) };
}

function makeTuiAgentProjection(
  id: string,
  title: string,
  parentId: string | null,
): TuiAgentProjection {
  return {
    id,
    docResident: false,
    origin: "registry",
    harnessId: "codex",
    title,
    parentId,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: "host-1",
    workspaceFolders: [],
    workspaceMode: undefined,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    archivedAt: null,
    profileId: null,
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
  };
}

function makeTuiAgentsSlice(
  entries: readonly TuiAgentProjection[],
): TerminalAgentsSlice {
  const byId: Record<string, TuiAgentProjection> = {};
  for (const entry of entries) byId[entry.id] = entry;
  return { byId, allIds: entries.map((e) => e.id) };
}

/**
 * `landed` is REQUIRED (no default params) - every call site states the
 * mutation's ack status explicitly, since that is exactly the axis the new
 * contract's anchoring rule pivots on.
 */
function rename(args: {
  readonly requestId: string;
  readonly nodeId: string;
  readonly title: string;
  readonly baseline: string;
  readonly landed: boolean;
}): PendingMetadataMutation {
  return { kind: "rename", ...args };
}

function reparent(args: {
  readonly requestId: string;
  readonly nodeId: string;
  readonly parentId: string | null;
  readonly baseline: string | null;
  readonly landed: boolean;
}): PendingMetadataMutation {
  return { kind: "reparent", ...args };
}

function epicTitle(args: {
  readonly requestId: string;
  readonly title: string;
  readonly baseline: string;
  readonly landed: boolean;
}): PendingMetadataMutation {
  return { kind: "epic-title", ...args };
}

function overlayOf(
  ...mutations: readonly PendingMetadataMutation[]
): ReadonlyMap<string, PendingMetadataMutation> {
  const map = new Map<string, PendingMetadataMutation>();
  for (const mutation of mutations) map.set(mutation.requestId, mutation);
  return map;
}

describe("applyPendingOverlayToArtifacts", () => {
  it("applies a pending (un-landed) rename to the row's title", () => {
    const artifacts = makeArtifactsSlice([
      makeArtifactProjection("a", "Original", null),
    ]);
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "Renamed",
        baseline: "Original",
        landed: false,
      }),
    );

    const result = applyPendingOverlayToArtifacts(artifacts, overlay);

    expect(result.byId.a.title).toBe("Renamed");
  });

  it("applies a pending reparent to the row's parentId", () => {
    const artifacts = makeArtifactsSlice([
      makeArtifactProjection("a", "A", null),
      makeArtifactProjection("b", "B", null),
    ]);
    const overlay = overlayOf(
      reparent({
        requestId: "r1",
        nodeId: "a",
        parentId: "b",
        baseline: null,
        landed: false,
      }),
    );

    const result = applyPendingOverlayToArtifacts(artifacts, overlay);

    expect(result.byId.a.parentId).toBe("b");
  });

  it("row-wins: an authoritative move off the baseline that matches no LANDED target drops the patch", () => {
    const artifacts = makeArtifactsSlice([
      makeArtifactProjection("a", "Someone else's title", null),
    ]);
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "Mine",
        baseline: "Original",
        landed: false,
      }),
    );

    const result = applyPendingOverlayToArtifacts(artifacts, overlay);

    expect(result.byId.a.title).toBe("Someone else's title");
  });

  it("row-wins is UNCONDITIONAL for a peer writing the same value as an in-flight (un-landed) local target - it is not yet ACKED", () => {
    const artifacts = makeArtifactsSlice([
      // A peer happens to write the exact same value our un-acked rename
      // asked for. Since OUR request has not landed, this must still read
      // as row-wins, not as "our value landed".
      makeArtifactProjection("a", "B", null),
    ]);
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: false,
      }),
    );

    const result = applyPendingOverlayToArtifacts(artifacts, overlay);

    expect(result.byId.a.title).toBe("B");
  });

  it("interleaving: a peer collision on an in-flight target drops the patch until OUR ack lands, then a later pending entry re-applies", () => {
    // Step 1: r1 is in flight (un-landed) for "B"; a peer's write also lands
    // on "B". Row-wins per the unconditional rule above.
    const peerCollision = makeArtifactsSlice([
      makeArtifactProjection("a", "B", null),
    ]);
    const overlayBeforeAck = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: false,
      }),
      rename({
        requestId: "r2",
        nodeId: "a",
        title: "C",
        baseline: "B",
        landed: false,
      }),
    );
    expect(
      applyPendingOverlayToArtifacts(peerCollision, overlayBeforeAck).byId.a
        .title,
    ).toBe("B");

    // Step 2: OUR ack for r1 lands (r1.landed = true). The SAME authoritative
    // value "B" is now a landed target, which anchors the chain, so the
    // still-pending r2 re-applies.
    const overlayAfterAck = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: true,
      }),
      rename({
        requestId: "r2",
        nodeId: "a",
        title: "C",
        baseline: "B",
        landed: false,
      }),
    );
    expect(
      applyPendingOverlayToArtifacts(peerCollision, overlayAfterAck).byId.a
        .title,
    ).toBe("C");
  });

  it("anchored via a landed target further back than the authoritative move: the still-pending entry applies", () => {
    const artifacts = makeArtifactsSlice([
      // Host has visibly landed the FIRST rename ("B"); r2 is still pending.
      makeArtifactProjection("a", "B", null),
    ]);
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: true,
      }),
      rename({
        requestId: "r2",
        nodeId: "a",
        title: "C",
        baseline: "B",
        landed: false,
      }),
    );

    const result = applyPendingOverlayToArtifacts(artifacts, overlay);

    expect(result.byId.a.title).toBe("C");
  });

  it("landed-only chain, not yet caught up to the LAST landed target: keeps showing that last target (ack proved the host has it; the slice is just stale)", () => {
    const artifacts = makeArtifactsSlice([
      // The host has acked both renames, but the projected row is still
      // showing the pre-chain baseline (slice hasn't caught up yet).
      makeArtifactProjection("a", "Original", null),
    ]);
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: true,
      }),
      rename({
        requestId: "r2",
        nodeId: "a",
        title: "C",
        baseline: "B",
        landed: true,
      }),
    );

    const result = applyPendingOverlayToArtifacts(artifacts, overlay);

    expect(result.byId.a.title).toBe("C");
  });

  it("landed-only chain, authoritative equals an INTERMEDIATE landed target (not baseline, not last): dead, row-wins on the intermediate value", () => {
    const artifacts = makeArtifactsSlice([
      // Host caught up to the FIRST ack ("B") but not yet the second ("C").
      // With NOTHING left in flight, landed-only anchoring is baseline
      // ALONE - "our intermediate echo" and "a peer wrote that value after
      // us" are indistinguishable, so this is treated as supersession.
      makeArtifactProjection("a", "B", null),
    ]);
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: true,
      }),
      rename({
        requestId: "r2",
        nodeId: "a",
        title: "C",
        baseline: "B",
        landed: true,
      }),
    );

    const result = applyPendingOverlayToArtifacts(artifacts, overlay);

    expect(result.byId.a.title).toBe("B");
  });

  it("landed-only chain, authoritative equals the LAST landed target: dead, shows the (now-matching) authoritative value", () => {
    const artifacts = makeArtifactsSlice([
      makeArtifactProjection("a", "C", null),
    ]);
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: true,
      }),
      rename({
        requestId: "r2",
        nodeId: "a",
        title: "C",
        baseline: "B",
        landed: true,
      }),
    );

    const result = applyPendingOverlayToArtifacts(artifacts, overlay);

    expect(result.byId.a.title).toBe("C");
  });

  it("landed-only chain, a peer overwrote past the chain entirely: dead, row-wins", () => {
    const artifacts = makeArtifactsSlice([
      makeArtifactProjection("a", "Someone else's title", null),
    ]);
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: true,
      }),
      rename({
        requestId: "r2",
        nodeId: "a",
        title: "C",
        baseline: "B",
        landed: true,
      }),
    );

    const result = applyPendingOverlayToArtifacts(artifacts, overlay);

    expect(result.byId.a.title).toBe("Someone else's title");
  });

  it("ignores an overlay entry naming a nodeId absent from the slice (Object.hasOwn guard)", () => {
    const artifacts = makeArtifactsSlice([
      makeArtifactProjection("a", "A", null),
    ]);
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "ghost",
        title: "Ghost",
        baseline: "Original",
        landed: false,
      }),
    );

    const result = applyPendingOverlayToArtifacts(artifacts, overlay);

    expect(result).toBe(artifacts);
  });

  it("preserves the whole slice reference when nothing is pending", () => {
    const artifacts = makeArtifactsSlice([
      makeArtifactProjection("a", "A", null),
    ]);

    const result = applyPendingOverlayToArtifacts(
      artifacts,
      EMPTY_PENDING_OVERLAY,
    );

    expect(result).toBe(artifacts);
  });

  it("preserves the whole slice reference when a landed-only chain is already caught up (dead, no-op display)", () => {
    const artifacts = makeArtifactsSlice([
      makeArtifactProjection("a", "C", null),
    ]);
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: true,
      }),
      rename({
        requestId: "r2",
        nodeId: "a",
        title: "C",
        baseline: "B",
        landed: true,
      }),
    );

    const result = applyPendingOverlayToArtifacts(artifacts, overlay);

    expect(result).toBe(artifacts);
  });

  it("only re-allocates the touched row; untouched siblings and allIds keep their reference", () => {
    const artifacts = makeArtifactsSlice([
      makeArtifactProjection("a", "Original", null),
      makeArtifactProjection("b", "B", null),
    ]);
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "Renamed",
        baseline: "Original",
        landed: false,
      }),
    );

    const result = applyPendingOverlayToArtifacts(artifacts, overlay);

    expect(result).not.toBe(artifacts);
    expect(result.byId.a).not.toBe(artifacts.byId.a);
    expect(result.byId.b).toBe(artifacts.byId.b);
    expect(result.allIds).toBe(artifacts.allIds);
  });
});

describe("applyPendingOverlayToChats", () => {
  it("applies a pending rename and reparent, preserving untouched rows", () => {
    const chats = makeChatsSlice([
      makeChatProjection("c1", "Original", null),
      makeChatProjection("c2", "Untouched", null),
    ]);
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "c1",
        title: "Renamed",
        baseline: "Original",
        landed: false,
      }),
      reparent({
        requestId: "r2",
        nodeId: "c1",
        parentId: "c2",
        baseline: null,
        landed: false,
      }),
    );

    const result = applyPendingOverlayToChats(chats, overlay);

    expect(result.byId.c1.title).toBe("Renamed");
    expect(result.byId.c1.parentId).toBe("c2");
    expect(result.byId.c2).toBe(chats.byId.c2);
  });

  it("preserves the slice reference with an empty overlay", () => {
    const chats = makeChatsSlice([makeChatProjection("c1", "C1", null)]);

    expect(applyPendingOverlayToChats(chats, EMPTY_PENDING_OVERLAY)).toBe(
      chats,
    );
  });
});

describe("applyPendingOverlayToTuiAgents", () => {
  it("applies a pending rename and reparent, preserving untouched rows", () => {
    const tuiAgents = makeTuiAgentsSlice([
      makeTuiAgentProjection("t1", "Original", null),
      makeTuiAgentProjection("t2", "Untouched", null),
    ]);
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "t1",
        title: "Renamed",
        baseline: "Original",
        landed: false,
      }),
      reparent({
        requestId: "r2",
        nodeId: "t1",
        parentId: "t2",
        baseline: null,
        landed: false,
      }),
    );

    const result = applyPendingOverlayToTuiAgents(tuiAgents, overlay);

    expect(result.byId.t1.title).toBe("Renamed");
    expect(result.byId.t1.parentId).toBe("t2");
    expect(result.byId.t2).toBe(tuiAgents.byId.t2);
  });

  it("preserves the slice reference with an empty overlay", () => {
    const tuiAgents = makeTuiAgentsSlice([
      makeTuiAgentProjection("t1", "T1", null),
    ]);

    expect(
      applyPendingOverlayToTuiAgents(tuiAgents, EMPTY_PENDING_OVERLAY),
    ).toBe(tuiAgents);
  });
});

describe("applyPendingOverlayToEpicHeader", () => {
  it("applies a pending epic-title change", () => {
    const epic: EpicHeader = { title: "Original", updatedAt: 0 };
    const overlay = overlayOf(
      epicTitle({
        requestId: "r1",
        title: "Renamed",
        baseline: "Original",
        landed: false,
      }),
    );

    const result = applyPendingOverlayToEpicHeader(epic, overlay);

    expect(result.title).toBe("Renamed");
    expect(result).not.toBe(epic);
  });

  it("row-wins for the epic title exactly as for a node rename", () => {
    const epic: EpicHeader = { title: "Someone else's title", updatedAt: 0 };
    const overlay = overlayOf(
      epicTitle({
        requestId: "r1",
        title: "Mine",
        baseline: "Original",
        landed: false,
      }),
    );

    const result = applyPendingOverlayToEpicHeader(epic, overlay);

    expect(result).toBe(epic);
    expect(result.title).toBe("Someone else's title");
  });

  it("preserves the header reference with an empty overlay", () => {
    const epic: EpicHeader = { title: "Original", updatedAt: 0 };

    expect(applyPendingOverlayToEpicHeader(epic, EMPTY_PENDING_OVERLAY)).toBe(
      epic,
    );
  });
});

describe("pendingMutationCount", () => {
  it("sums the entries in the overlay", () => {
    expect(pendingMutationCount(EMPTY_PENDING_OVERLAY)).toBe(0);
    expect(
      pendingMutationCount(
        overlayOf(
          rename({
            requestId: "r1",
            nodeId: "a",
            title: "A",
            baseline: "Orig",
            landed: false,
          }),
        ),
      ),
    ).toBe(1);
    expect(
      pendingMutationCount(
        overlayOf(
          rename({
            requestId: "r1",
            nodeId: "a",
            title: "A",
            baseline: "Orig",
            landed: false,
          }),
          reparent({
            requestId: "r2",
            nodeId: "b",
            parentId: null,
            baseline: "x",
            landed: false,
          }),
        ),
      ),
    ).toBe(2);
  });
});

function authoritativeState(overrides: {
  readonly artifacts?: ArtifactsSlice;
  readonly chats?: ChatsSlice;
  readonly tuiAgents?: TerminalAgentsSlice;
  readonly epicTitle?: string | null;
}): PendingOverlayAuthoritativeState {
  return {
    artifacts: overrides.artifacts ?? makeArtifactsSlice([]),
    chats: overrides.chats ?? makeChatsSlice([]),
    tuiAgents: overrides.tuiAgents ?? makeTuiAgentsSlice([]),
    epicTitle: overrides.epicTitle ?? null,
  };
}

describe("collectDeadPendingMutations", () => {
  it("reports every requestId of a landed-only chain that caught up to its last landed target", () => {
    const state = authoritativeState({
      artifacts: makeArtifactsSlice([makeArtifactProjection("a", "C", null)]),
    });
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: true,
      }),
      rename({
        requestId: "r2",
        nodeId: "a",
        title: "C",
        baseline: "Original",
        landed: true,
      }),
    );

    // Insertion order ("r1" before "r2") - `chainFor` walks the overlay Map
    // in stamp order and `collectDeadPendingMutations` pushes in chain order.
    expect(collectDeadPendingMutations(overlay, state)).toEqual(["r1", "r2"]);
  });

  it("does NOT report a landed-only chain still sitting at its ORIGINAL baseline (not yet caught up at all)", () => {
    const state = authoritativeState({
      // Landed-only anchoring is baseline ALONE - an intermediate landed
      // target ("B") would now be treated as supersession (see the applier
      // test), so "still alive" is only observable while the row hasn't
      // moved from its pre-chain value at all.
      artifacts: makeArtifactsSlice([
        makeArtifactProjection("a", "Original", null),
      ]),
    });
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: true,
      }),
      rename({
        requestId: "r2",
        nodeId: "a",
        title: "C",
        baseline: "Original",
        landed: true,
      }),
    );

    expect(collectDeadPendingMutations(overlay, state)).toEqual([]);
  });

  it("reports a landed-only chain whose row already caught up to an INTERMEDIATE landed target - supersession, not staleness", () => {
    const state = authoritativeState({
      artifacts: makeArtifactsSlice([makeArtifactProjection("a", "B", null)]),
    });
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: true,
      }),
      rename({
        requestId: "r2",
        nodeId: "a",
        title: "C",
        baseline: "Original",
        landed: true,
      }),
    );

    expect(collectDeadPendingMutations(overlay, state)).toEqual(["r1", "r2"]);
  });

  it("reports a landed-only chain a peer overwrote past entirely", () => {
    const state = authoritativeState({
      artifacts: makeArtifactsSlice([
        makeArtifactProjection("a", "Someone else's title", null),
      ]),
    });
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: true,
      }),
    );

    expect(collectDeadPendingMutations(overlay, state)).toEqual(["r1"]);
  });

  it("does NOT report a chain with a pending entry that is still ANCHORED (baseline unmoved)", () => {
    const state = authoritativeState({
      // The row still sits at the chain's baseline - the host hasn't moved,
      // so the un-landed entry is genuinely alive and must not be swept.
      artifacts: makeArtifactsSlice([
        makeArtifactProjection("a", "Original", null),
      ]),
    });
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: false,
      }),
    );

    expect(collectDeadPendingMutations(overlay, state)).toEqual([]);
  });

  it("SUPERSESSION IS TERMINAL: reports a chain with an un-landed entry once the row moves off-anchor - the un-acked entry's later retire finds nothing", () => {
    const state = authoritativeState({
      // The row already equals the pending entry's OWN target - but since
      // that entry has not landed (no ack), value equality does not anchor
      // it: an un-acked row this row-wins produces the same string a peer
      // could have written coincidentally, and the chain is dead either way.
      artifacts: makeArtifactsSlice([makeArtifactProjection("a", "B", null)]),
    });
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: false,
      }),
    );

    expect(collectDeadPendingMutations(overlay, state)).toEqual(["r1"]);
  });

  it("reports a landed-only chain whose node vanished from every slice", () => {
    // No artifact/chat/tuiAgent named "a" at all - the node was deleted.
    const state = authoritativeState({});
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "a",
        title: "B",
        baseline: "Original",
        landed: true,
      }),
    );

    expect(collectDeadPendingMutations(overlay, state)).toEqual(["r1"]);
  });

  it("epic-title chains follow the same rule, read from state.epicTitle", () => {
    const caughtUp = authoritativeState({ epicTitle: "New epic title" });
    const notCaughtUp = authoritativeState({ epicTitle: "Original" });
    const overlay = overlayOf(
      epicTitle({
        requestId: "r1",
        title: "New epic title",
        baseline: "Original",
        landed: true,
      }),
    );

    expect(collectDeadPendingMutations(overlay, caughtUp)).toEqual(["r1"]);
    expect(collectDeadPendingMutations(overlay, notCaughtUp)).toEqual([]);
  });

  it("independent chains on different nodes are judged independently", () => {
    const state = authoritativeState({
      artifacts: makeArtifactsSlice([
        makeArtifactProjection("dead-node", "Acked", null),
        makeArtifactProjection("alive-node", "Original", null),
      ]),
    });
    const overlay = overlayOf(
      rename({
        requestId: "r1",
        nodeId: "dead-node",
        title: "Acked",
        baseline: "Original",
        landed: true,
      }),
      rename({
        requestId: "r2",
        nodeId: "alive-node",
        title: "Still pending",
        baseline: "Original",
        landed: false,
      }),
    );

    expect(collectDeadPendingMutations(overlay, state)).toEqual(["r1"]);
  });

  it("returns an empty array for an empty overlay", () => {
    expect(
      collectDeadPendingMutations(
        EMPTY_PENDING_OVERLAY,
        authoritativeState({}),
      ),
    ).toEqual([]);
  });
});
