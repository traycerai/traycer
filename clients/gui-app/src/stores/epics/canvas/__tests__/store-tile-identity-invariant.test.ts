/**
 * Store-integration pins for the canvas-store-wide immutable tile identity
 * invariant (Ticket 21 slice 1). `tile-identity-invariant.test.ts` pins the
 * pure detection/policy functions in isolation; this file drives the SAME
 * invariant through the real store wiring: the wrapped internal `set()`
 * (every action below `updateTabCanvas` AND the handful of actions - like
 * `tearOffTabIntoNewHeaderTab` - that write `canvasByTabId` directly),
 * `applyEpicCanvasDesktopProjection`, and the persist `merge` hydration path.
 *
 * `import.meta.env.DEV` is true under Vitest, so every real ingress below
 * throws on a violation (the production fail-closed branch is pinned
 * directly on `enforceTileIdentityInvariant` in the pure-module test - it is
 * not reachable through this store without stubbing Vite's static env).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type Mock,
} from "vitest";
import { appLogger } from "@/lib/logger";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import {
  applyEpicCanvasDesktopProjection,
  resolveTabEpicIdentity,
  setEpicCanvasDesktopProjectionBridge,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import { serializeEpicCanvasState } from "@/stores/epics/canvas/migrate-canvas";
import { makeBlankTileRef } from "@/stores/epics/canvas/tile-schema/blank-tile";
import { makeCommGraphTileRef } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import { epicCanvasKey } from "@/lib/persist";
import type {
  BlankTileRef,
  CommGraphTileRef,
  EpicCanvasState,
  EpicCanvasTileRef,
  EpicNodeRef,
  EpicTerminalRef,
  WorkspaceFileRef,
} from "@/stores/epics/canvas/types";
import type {
  DesktopPerWindowSnapshot,
  DesktopPerWindowStatePatch,
} from "@/lib/windows/types";
import type { DesktopPerWindowProjectionBridge } from "@/lib/windows/per-window-projection-debounce";
import {
  CHAT_A,
  GIT_FILE_A,
  GIT_FILE_B,
  SNAPSHOT_BUNDLE_CHANGES,
  SPEC_A,
  SPEC_B,
  SPEC_C,
  TEST_HOST_ID,
} from "./canvas-test-fixtures";

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.persist.setOptions({ name: epicCanvasKey(null) });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

function requireCanvas(tabId: string): EpicCanvasState {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) throw new Error(`Expected canvas for ${tabId}`);
  return canvas;
}

function requireActivePaneId(tabId: string): string {
  const paneId = requireCanvas(tabId).activePaneId;
  if (paneId === null) throw new Error(`Expected active pane for ${tabId}`);
  return paneId;
}

/** Fixed-instanceId fixtures for every non-spec/chat kind the pure pins skipped. */
const TERMINAL_A: EpicTerminalRef = {
  id: "term-a",
  instanceId: "inst-term-a",
  type: "terminal",
  name: "shell-a",
  titleSource: "manual",
  hostId: TEST_HOST_ID,
  cwd: "/repo",
};
const TERMINAL_B: EpicTerminalRef = {
  id: "term-b",
  instanceId: "inst-term-b",
  type: "terminal",
  name: "shell-b",
  titleSource: "manual",
  hostId: TEST_HOST_ID,
  cwd: "/other",
};
const WORKSPACE_FILE_A: WorkspaceFileRef = {
  id: "workspace-file:test-host:/repo:src/a.ts",
  instanceId: "inst-ws-a",
  type: "workspace-file",
  name: "a.ts",
  hostId: TEST_HOST_ID,
  workspacePath: "/repo",
  filePath: "src/a.ts",
};
const WORKSPACE_FILE_B: WorkspaceFileRef = {
  id: "workspace-file:test-host:/repo:src/b.ts",
  instanceId: "inst-ws-b",
  type: "workspace-file",
  name: "b.ts",
  hostId: TEST_HOST_ID,
  workspacePath: "/repo",
  filePath: "src/b.ts",
};
const BLANK_A: BlankTileRef = {
  ...makeBlankTileRef(),
  id: "blank-a",
  instanceId: "inst-blank-a",
  hostId: UNKNOWN_HOST_PLACEHOLDER,
};
const BLANK_B: BlankTileRef = {
  ...makeBlankTileRef(),
  id: "blank-b",
  instanceId: "inst-blank-b",
  hostId: UNKNOWN_HOST_PLACEHOLDER,
};
const COMM_GRAPH_A: CommGraphTileRef = {
  ...makeCommGraphTileRef("epic-comm-a"),
  instanceId: "inst-comm-a",
};
const COMM_GRAPH_B: CommGraphTileRef = {
  ...makeCommGraphTileRef("epic-comm-b"),
  instanceId: "inst-comm-b",
};
const GIT_DIFF_A = { ...GIT_FILE_A, instanceId: "inst-git-a" };
const GIT_DIFF_B = { ...GIT_FILE_B, instanceId: "inst-git-b" };
const SNAPSHOT_A = {
  ...SNAPSHOT_BUNDLE_CHANGES,
  instanceId: "inst-snap-a",
};
const SNAPSHOT_B: typeof SNAPSHOT_BUNDLE_CHANGES = {
  ...SNAPSHOT_BUNDLE_CHANGES,
  id: `${SNAPSHOT_BUNDLE_CHANGES.id}:alt`,
  instanceId: "inst-snap-b",
  diff: {
    ...SNAPSHOT_BUNDLE_CHANGES.diff,
    chatId: "chat-2",
  },
};

/**
 * Open `seed` in epic-1, then try to open a same-instanceId repoint of
 * `collidingContent` into a second epic. Every free-form open path must throw.
 */
function expectOpenTileInTabRejectsRepoint(
  seed: EpicCanvasTileRef,
  collidingContent: EpicCanvasTileRef,
): void {
  const store = useEpicCanvasStore.getState();
  const tabId = store.openEpicTab("epic-seed", "Seed");
  store.openTileInTab(tabId, seed);
  const otherTabId = store.openEpicTab("epic-other", "Other");
  const colliding: EpicCanvasTileRef = {
    ...collidingContent,
    instanceId: seed.instanceId,
  };
  expect(() =>
    useEpicCanvasStore.getState().openTileInTab(otherTabId, colliding),
  ).toThrow(/identity invariant violated/i);
  expect(requireCanvas(tabId).tilesByInstanceId[seed.instanceId]).toEqual(seed);
  expect(requireCanvas(otherTabId).root).toBeNull();
}

describe("canvas tile identity invariant: internal mutation ingress", () => {
  it("throws when an internal mutation repoints an existing instanceId's content id", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(tabId, SPEC_A);
    const otherTabId = store.openEpicTab("epic-2", "Epic Bar");

    // Adversarial input: a caller-constructed node that reuses SPEC_A's
    // instanceId for a DIFFERENT content id. Nothing in the public action
    // API mints instanceIds itself - callers always supply them - so this is
    // exactly the shape a future bug (not today's code) could produce.
    const colliding: EpicNodeRef = { ...SPEC_B, instanceId: SPEC_A.instanceId };

    expect(() =>
      useEpicCanvasStore.getState().openTileInTab(otherTabId, colliding),
    ).toThrow(/identity invariant violated/i);

    // Rejected: tab B's canvas never received the colliding tile.
    expect(requireCanvas(otherTabId).root).toBeNull();
    // Tab A's original tile is untouched.
    expect(requireCanvas(tabId).tilesByInstanceId[SPEC_A.instanceId]).toEqual(
      SPEC_A,
    );
  });

  it("throws when an internal mutation repoints an existing instanceId's tile kind", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(tabId, SPEC_A);
    const otherTabId = store.openEpicTab("epic-2", "Epic Bar");
    const colliding: EpicNodeRef = {
      ...CHAT_A,
      instanceId: SPEC_A.instanceId,
    };

    expect(() =>
      useEpicCanvasStore.getState().openTileInTab(otherTabId, colliding),
    ).toThrow(/identity invariant violated/i);
  });

  it.each([
    {
      label: "git-diff",
      seed: GIT_DIFF_A,
      collidingContent: GIT_DIFF_B,
    },
    {
      label: "snapshot-diff",
      seed: SNAPSHOT_A,
      collidingContent: SNAPSHOT_B,
    },
    {
      label: "comm-graph",
      seed: COMM_GRAPH_A,
      collidingContent: COMM_GRAPH_B,
    },
    {
      label: "blank",
      seed: BLANK_A,
      collidingContent: BLANK_B,
    },
    {
      label: "workspace-file",
      seed: WORKSPACE_FILE_A,
      collidingContent: WORKSPACE_FILE_B,
    },
    {
      label: "terminal",
      seed: TERMINAL_A,
      collidingContent: TERMINAL_B,
    },
  ] as const)(
    "throws on a $label repoint (same instanceId, different content tuple)",
    ({ seed, collidingContent }) => {
      expectOpenTileInTabRejectsRepoint(seed, collidingContent);
    },
  );

  it("throws when restoreClosedTilePreview reopens a tampered closed-payload tuple", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const paneId = requireActivePaneId(tabId);
    store.closeCanvasTab(tabId, paneId, SPEC_A.instanceId);

    const closed =
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        SPEC_A.instanceId
      ];
    expect(closed?.node).toEqual(SPEC_A);

    // Adversarial: closed-payload map keeps the original instanceId key, but
    // the node tuple is rewritten to a different content id before restore.
    const tampered: EpicNodeRef = {
      ...SPEC_C,
      instanceId: SPEC_A.instanceId,
    };
    useEpicCanvasStore.setState((state) => ({
      closedTilePayloadsByTabId: {
        ...state.closedTilePayloadsByTabId,
        [tabId]: {
          ...(state.closedTilePayloadsByTabId[tabId] ?? {}),
          [SPEC_A.instanceId]: {
            node: tampered,
            pendingCreate: false,
          },
        },
      },
    }));

    // SPEC_A is no longer live, but SPEC_B is. Restoring the tampered
    // payload is fine for a free instanceId - re-open SPEC_A first so the
    // restore would repoint a live instanceId.
    useEpicCanvasStore.getState().openTileInTab(tabId, SPEC_A);
    expect(() =>
      useEpicCanvasStore
        .getState()
        .restoreClosedTilePreview(tabId, paneId, tampered),
    ).toThrow(/identity invariant violated/i);
    expect(requireCanvas(tabId).tilesByInstanceId[SPEC_A.instanceId]).toEqual(
      SPEC_A,
    );
  });

  it("throws when restoreClosedTilePreview collides with a live instanceId in another epic tab", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(tabId, SPEC_A);
    const otherTabId = store.openEpicTab("epic-2", "Epic Bar");
    store.openTileInTab(otherTabId, SPEC_B);
    const otherPaneId = requireActivePaneId(otherTabId);

    const colliding: EpicNodeRef = {
      ...SPEC_C,
      instanceId: SPEC_A.instanceId,
    };
    expect(() =>
      useEpicCanvasStore
        .getState()
        .restoreClosedTilePreview(otherTabId, otherPaneId, colliding),
    ).toThrow(/identity invariant violated/i);
    expect(requireCanvas(tabId).tilesByInstanceId[SPEC_A.instanceId]).toEqual(
      SPEC_A,
    );
    expect(
      requireCanvas(otherTabId).tilesByInstanceId[SPEC_A.instanceId],
    ).toBeUndefined();
  });

  it("throws when insertNodeOnTabStrip inserts a colliding instanceId", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(tabId, SPEC_A);
    const otherTabId = store.openEpicTab("epic-2", "Epic Bar");
    store.openTileInTab(otherTabId, SPEC_B);
    const otherPaneId = requireActivePaneId(otherTabId);
    const colliding: EpicNodeRef = {
      ...SPEC_C,
      instanceId: SPEC_A.instanceId,
    };

    expect(() =>
      useEpicCanvasStore
        .getState()
        .insertNodeOnTabStrip(otherTabId, otherPaneId, 0, colliding),
    ).toThrow(/identity invariant violated/i);
    expect(
      requireCanvas(otherTabId).tilesByInstanceId[SPEC_A.instanceId],
    ).toBeUndefined();
  });

  it("throws when splitPaneWithNode splits with a colliding instanceId", () => {
    // splitPaneWithTab only relocates an already-live instanceId (tuple
    // retained); the free-form node path that CAN introduce a colliding
    // instanceId is splitPaneWithNode.
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(tabId, SPEC_A);
    const otherTabId = store.openEpicTab("epic-2", "Epic Bar");
    store.openTileInTab(otherTabId, SPEC_B);
    const otherPaneId = requireActivePaneId(otherTabId);
    const colliding: EpicNodeRef = {
      ...SPEC_C,
      instanceId: SPEC_A.instanceId,
    };

    expect(() =>
      useEpicCanvasStore
        .getState()
        .splitPaneWithNode(otherTabId, otherPaneId, "right", colliding),
    ).toThrow(/identity invariant violated/i);
    expect(
      requireCanvas(otherTabId).tilesByInstanceId[SPEC_A.instanceId],
    ).toBeUndefined();
  });

  it("openTileInPane remints instanceId so a colliding input is not committed", () => {
    // openTileInPane deliberately mints a fresh instanceId (second view of
    // the same content is allowed). The input instanceId is ignored, so a
    // caller-supplied collision never reaches the identity check as a
    // repoint - pin that the action succeeds and the live seed is untouched.
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(tabId, SPEC_A);
    const otherTabId = store.openEpicTab("epic-2", "Epic Bar");
    store.openTileInTab(otherTabId, SPEC_B);
    const otherPaneId = requireActivePaneId(otherTabId);
    const collidingInput: EpicNodeRef = {
      ...SPEC_C,
      instanceId: SPEC_A.instanceId,
    };

    expect(() =>
      useEpicCanvasStore
        .getState()
        .openTileInPane(otherTabId, otherPaneId, collidingInput),
    ).not.toThrow();

    expect(requireCanvas(tabId).tilesByInstanceId[SPEC_A.instanceId]).toEqual(
      SPEC_A,
    );
    const otherTiles = requireCanvas(otherTabId).tilesByInstanceId;
    expect(otherTiles[SPEC_A.instanceId]).toBeUndefined();
    const opened = Object.values(otherTiles).find(
      (tile) => tile !== undefined && tile.id === SPEC_C.id,
    );
    expect(opened?.instanceId).not.toBe(SPEC_A.instanceId);
  });

  it("moveTabOnTabStrip and splitPaneWithTab retain tuples (no free-form instanceId mint)", () => {
    // These actions only relocate an already-live instanceId; they cannot
    // introduce a colliding free-form node. Pin that the relocates never
    // throw and the tuple is retained - the adversarial free-form path is
    // covered by insertNodeOnTabStrip / splitPaneWithNode above.
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const paneId = requireActivePaneId(tabId);

    expect(() =>
      useEpicCanvasStore.getState().splitPaneWithTab(tabId, {
        sourcePaneId: paneId,
        tabId: SPEC_B.instanceId,
        targetPaneId: paneId,
        position: "right",
      }),
    ).not.toThrow();

    const afterSplit = requireCanvas(tabId);
    const panes = collectPanes(afterSplit.root);
    expect(panes.length).toBeGreaterThan(1);
    const targetPane = panes.find((p) => p.id !== paneId);
    if (targetPane === undefined) throw new Error("expected split pane");

    expect(() =>
      useEpicCanvasStore.getState().moveTabOnTabStrip(tabId, {
        sourcePaneId: paneId,
        tabId: SPEC_A.instanceId,
        targetPaneId: targetPane.id,
        targetIndex: 0,
      }),
    ).not.toThrow();
    expect(requireCanvas(tabId).tilesByInstanceId[SPEC_A.instanceId]).toEqual(
      SPEC_A,
    );
    expect(requireCanvas(tabId).tilesByInstanceId[SPEC_B.instanceId]).toEqual(
      SPEC_B,
    );
  });
});

describe("canvas tile identity invariant: public setState ingress is always strict (no epicId allowance)", () => {
  // Every generic ingress (closure `set`, this public `setState` wrapper,
  // desktop projection, persisted hydration) is unconditionally strict - it
  // has no parameter that could ever let an epicId-only change through.
  // `resolveTabEpicIdentity` (its own describe block below) is the ONLY
  // function that changes a tab's epicId, and provenance is enforced by that
  // function being the sole caller of the module-private raw setter, not by
  // anything this generic path has to understand. These pins call
  // `useEpicCanvasStore.setState` directly to prove the generic path rejects
  // the shape regardless.
  it("rejects a pure epicId-only public setState for a genuine phase-migration tab", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openPhaseMigrationTabWithId(
      "tab-phase",
      "phase-1",
      "Migrating",
    );
    store.openTileInTab(tabId, SPEC_A);
    const before = requireCanvas(tabId);

    expect(() =>
      useEpicCanvasStore.setState((state) => {
        const current = state.tabsById[tabId];
        if (current === undefined) return state;
        return {
          tabsById: {
            ...state.tabsById,
            [tabId]: { ...current, epicId: "epic-real" },
          },
        };
      }),
    ).toThrow(/identity invariant violated/i);

    // Fail-closed: the tab's epicId and canvas are both untouched.
    expect(useEpicCanvasStore.getState().tabsById[tabId]?.epicId).toBe(
      "phase-1",
    );
    expect(requireCanvas(tabId)).toBe(before);
  });

  it("throws when a public setState bundles a phase tab's epicId change with a content-id repoint", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openPhaseMigrationTabWithId(
      "tab-phase",
      "phase-1",
      "Migrating",
    );
    store.openTileInTab(tabId, SPEC_A);
    const before = requireCanvas(tabId);

    // NOT a pure epicId-only resolution: the same setState also repoints the
    // tile's content id, so the tab-scoped allowance must not apply.
    expect(() =>
      useEpicCanvasStore.setState((state) => {
        const current = state.tabsById[tabId];
        const currentCanvas = state.canvasByTabId[tabId];
        if (current === undefined || currentCanvas === undefined) return state;
        return {
          tabsById: {
            ...state.tabsById,
            [tabId]: { ...current, epicId: "epic-real" },
          },
          canvasByTabId: {
            ...state.canvasByTabId,
            [tabId]: {
              ...currentCanvas,
              tilesByInstanceId: {
                ...currentCanvas.tilesByInstanceId,
                [SPEC_A.instanceId]: {
                  ...SPEC_B,
                  instanceId: SPEC_A.instanceId,
                },
              },
            },
          },
        };
      }),
    ).toThrow(/identity invariant violated/i);

    expect(requireCanvas(tabId)).toBe(before);
    expect(useEpicCanvasStore.getState().tabsById[tabId]?.epicId).toBe(
      "phase-1",
    );
  });

  it("throws when a public setState moves a phase tab's tile into a DIFFERENT existing tab's canvas", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openPhaseMigrationTabWithId(
      "tab-phase",
      "phase-1",
      "Migrating",
    );
    store.openTileInTab(tabId, SPEC_A);
    const otherTabId = store.openEpicTab("epic-other", "Other");
    const beforePhase = requireCanvas(tabId);
    const beforeOther = requireCanvas(otherTabId);

    // A canvas-only repoint: tabsById is untouched, but the instance now
    // lives under a DIFFERENT tab's canvas - not the sanctioned same-tab
    // resolution, even though tileKind/contentId/hostId all match.
    expect(() =>
      useEpicCanvasStore.setState((state) => {
        const targetCanvas = state.canvasByTabId[otherTabId];
        if (targetCanvas === undefined) return state;
        return {
          canvasByTabId: {
            ...state.canvasByTabId,
            [otherTabId]: {
              ...targetCanvas,
              tilesByInstanceId: {
                ...targetCanvas.tilesByInstanceId,
                [SPEC_A.instanceId]: SPEC_A,
              },
            },
          },
        };
      }),
    ).toThrow(/identity invariant violated/i);

    expect(requireCanvas(tabId)).toBe(beforePhase);
    expect(requireCanvas(otherTabId)).toBe(beforeOther);
  });
});

describe("canvas tile identity invariant: resolveTabEpicIdentity (the sole authorized epic-resolution path)", () => {
  // Provenance, not shape, is what authorizes an epicId-only change now -
  // this is the ONE function permitted to commit one, and it does so by
  // being the sole caller of the module-private raw setter, not by any
  // parameter. Both real callers publish success from a POST-commit
  // `getState()` read-back rather than trusting a return value from this
  // function (see their own doc comments in tab-command-coordinator.ts) -
  // their reentrant-race coverage lives in the tab-navigation adversarial and
  // phase-migration controller suites. These pins exercise
  // `resolveTabEpicIdentity` itself: the legitimate commit and its own
  // preconditions, observed through resulting store state (this function
  // returns void).
  let errorSpy: Mock<typeof appLogger.error>;

  beforeEach(() => {
    errorSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves a phase tab's epicId, reindexes mostRecentTabIdByEpicId, and leaves canvas untouched", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openPhaseMigrationTabWithId(
      "tab-phase",
      "phase-1",
      "Migrating",
    );
    store.openTileInTab(tabId, SPEC_A);
    const before = requireCanvas(tabId);

    expect(() =>
      resolveTabEpicIdentity(tabId, "phase-1", "epic-real"),
    ).not.toThrow();

    expect(useEpicCanvasStore.getState().tabsById[tabId]?.epicId).toBe(
      "epic-real",
    );
    expect(
      useEpicCanvasStore.getState().mostRecentTabIdByEpicId["epic-real"],
    ).toBe(tabId);
    expect(
      useEpicCanvasStore.getState().mostRecentTabIdByEpicId["phase-1"],
    ).toBeUndefined();
    expect(requireCanvas(tabId)).toBe(before);
    expect(requireCanvas(tabId).tilesByInstanceId[SPEC_A.instanceId]).toEqual(
      SPEC_A,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("is a silent no-op when the tab does not exist", () => {
    expect(() =>
      resolveTabEpicIdentity("tab-missing", "phase-1", "epic-real"),
    ).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("is a silent no-op when resolvedEpicId already matches the tab's current epicId (idempotent retry)", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openPhaseMigrationTabWithId(
      "tab-phase",
      "phase-1",
      "Migrating",
    );
    resolveTabEpicIdentity(tabId, "phase-1", "epic-real");
    errorSpy.mockClear();
    const before = useEpicCanvasStore.getState().tabsById[tabId];

    expect(() =>
      resolveTabEpicIdentity(tabId, "epic-real", "epic-real"),
    ).not.toThrow();

    expect(useEpicCanvasStore.getState().tabsById[tabId]).toBe(before);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("rejects and logs when the caller's expectedCurrentEpicId does not match the tab's actual current epicId", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openPhaseMigrationTabWithId(
      "tab-phase",
      "phase-1",
      "Migrating",
    );
    const before = useEpicCanvasStore.getState().tabsById[tabId];

    expect(() =>
      resolveTabEpicIdentity(tabId, "phase-stale", "epic-real"),
    ).not.toThrow();

    expect(useEpicCanvasStore.getState().tabsById[tabId]).toBe(before);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [, fields] = errorSpy.mock.calls[0] ?? [];
    expect(fields).toMatchObject({
      tabId,
      expectedCurrentEpicId: "phase-stale",
      actualCurrentEpicId: "phase-1",
      resolvedEpicId: "epic-real",
    });
  });
});

describe("canvas tile identity invariant: desktop-projection ingress", () => {
  it("throws when an incoming desktop snapshot repoints an existing instanceId", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic One");
    store.openTileInTab(tabId, SPEC_A);
    const before = requireCanvas(tabId);

    const repointed: EpicCanvasState = {
      ...before,
      tilesByInstanceId: {
        ...before.tilesByInstanceId,
        [SPEC_A.instanceId]: { ...SPEC_B, instanceId: SPEC_A.instanceId },
      },
    };
    const snapshot: DesktopPerWindowSnapshot = {
      epicTabs: [{ id: tabId, epicId: "epic-1", name: "Epic One" }],
      activeTabId: tabId,
      canvasByTabId: { [tabId]: serializeEpicCanvasState(repointed) },
      landingDrafts: [],
      activeLandingDraftId: null,
    };

    expect(() => applyEpicCanvasDesktopProjection(snapshot)).toThrow(
      /identity invariant violated/i,
    );
    // Fail-closed: the store's committed canvas is untouched by the rejected
    // projection (the updater threw before zustand ever assigned state).
    expect(requireCanvas(tabId)).toBe(before);
  });

  it("accepts a desktop snapshot for a genuinely NEW instanceId in a different tab", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic One");
    store.openTileInTab(tabId, SPEC_A);

    const snapshot: DesktopPerWindowSnapshot = {
      epicTabs: [
        { id: tabId, epicId: "epic-1", name: "Epic One" },
        { id: "tab-remote", epicId: "epic-remote", name: "Remote" },
      ],
      activeTabId: tabId,
      canvasByTabId: {
        [tabId]: serializeEpicCanvasState(requireCanvas(tabId)),
      },
      landingDrafts: [],
      activeLandingDraftId: null,
    };

    expect(() => applyEpicCanvasDesktopProjection(snapshot)).not.toThrow();
    expect(useEpicCanvasStore.getState().tabsById["tab-remote"]).toBeDefined();
  });

  it("throws when a projected OPEN tab collides with a HIDDEN (preserved) tab's live instanceId", () => {
    // closeTab hides a tab without discarding its canvas. Projection only
    // ships open tabs; preserved hidden canvases stay in memory. A projected
    // open tab that reuses a hidden tab's instanceId under a different tuple
    // must still trip the invariant (visible tabs alone look fine).
    const store = useEpicCanvasStore.getState();
    const visibleTabId = store.openEpicTab("epic-visible", "Visible");
    store.openTileInTab(visibleTabId, SPEC_B);
    const hiddenTabId = store.openEpicTab("epic-hidden", "Hidden");
    store.openTileInTab(hiddenTabId, SPEC_A);
    store.closeTab(hiddenTabId);

    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(
      hiddenTabId,
    );
    expect(useEpicCanvasStore.getState().tabsById[hiddenTabId]).toBeDefined();
    expect(
      requireCanvas(hiddenTabId).tilesByInstanceId[SPEC_A.instanceId],
    ).toEqual(SPEC_A);

    const beforeHidden = requireCanvas(hiddenTabId);
    const beforeVisible = requireCanvas(visibleTabId);
    const collidingCanvas: EpicCanvasState = {
      root: {
        kind: "pane",
        id: "pane-projected",
        tabInstanceIds: [SPEC_A.instanceId],
        activeTabId: SPEC_A.instanceId,
        previewTabId: null,
        activationHistory: [SPEC_A.instanceId],
      },
      activePaneId: "pane-projected",
      tilesByInstanceId: {
        [SPEC_A.instanceId]: { ...SPEC_C, instanceId: SPEC_A.instanceId },
      },
      sizesByGroupId: {},
    };
    const snapshot: DesktopPerWindowSnapshot = {
      epicTabs: [
        { id: visibleTabId, epicId: "epic-visible", name: "Visible" },
        { id: "tab-projected", epicId: "epic-projected", name: "Projected" },
      ],
      activeTabId: visibleTabId,
      canvasByTabId: {
        [visibleTabId]: serializeEpicCanvasState(beforeVisible),
        "tab-projected": serializeEpicCanvasState(collidingCanvas),
      },
      landingDrafts: [],
      activeLandingDraftId: null,
    };

    expect(() => applyEpicCanvasDesktopProjection(snapshot)).toThrow(
      /identity invariant violated/i,
    );
    // Fail-closed: hidden tab canvas and visible tab canvas stay put; the
    // colliding projected tab never lands.
    expect(requireCanvas(hiddenTabId)).toBe(beforeHidden);
    expect(requireCanvas(visibleTabId)).toBe(beforeVisible);
    expect(
      useEpicCanvasStore.getState().tabsById["tab-projected"],
    ).toBeUndefined();
  });

  it("throws when a projection reopens a HIDDEN tab with a repointed canvas (visible tabs stay clean)", () => {
    // closeTab preserves the tab + canvas. A desktop snapshot can re-list
    // that tab id among epicTabs with a different payload under the same
    // instanceId - visible-only data looks fine, but the reopened hidden
    // tab is the sole source of the violation.
    const store = useEpicCanvasStore.getState();
    const visibleTabId = store.openEpicTab("epic-visible", "Visible");
    store.openTileInTab(visibleTabId, SPEC_B);
    const hiddenTabId = store.openEpicTab("epic-hidden", "Hidden");
    store.openTileInTab(hiddenTabId, SPEC_A);
    store.closeTab(hiddenTabId);

    const beforeHidden = requireCanvas(hiddenTabId);
    const beforeVisible = requireCanvas(visibleTabId);
    const repointedHidden: EpicCanvasState = {
      ...beforeHidden,
      tilesByInstanceId: {
        ...beforeHidden.tilesByInstanceId,
        [SPEC_A.instanceId]: { ...SPEC_C, instanceId: SPEC_A.instanceId },
      },
    };
    const snapshot: DesktopPerWindowSnapshot = {
      epicTabs: [
        { id: visibleTabId, epicId: "epic-visible", name: "Visible" },
        { id: hiddenTabId, epicId: "epic-hidden", name: "Hidden" },
      ],
      activeTabId: visibleTabId,
      canvasByTabId: {
        [visibleTabId]: serializeEpicCanvasState(beforeVisible),
        [hiddenTabId]: serializeEpicCanvasState(repointedHidden),
      },
      landingDrafts: [],
      activeLandingDraftId: null,
    };

    expect(() => applyEpicCanvasDesktopProjection(snapshot)).toThrow(
      /identity invariant violated/i,
    );
    expect(requireCanvas(hiddenTabId)).toBe(beforeHidden);
    expect(requireCanvas(visibleTabId)).toBe(beforeVisible);
    expect(
      requireCanvas(hiddenTabId).tilesByInstanceId[SPEC_A.instanceId],
    ).toEqual(SPEC_A);
  });

  it("releases applyingDesktopProjection after a rejected inbound projection, so the next local mutation still reaches the bridge", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic One");
    store.openTileInTab(tabId, SPEC_A);

    const updates: Array<DesktopPerWindowStatePatch> = [];
    const bridge: DesktopPerWindowProjectionBridge = {
      update: (patch) => {
        updates.push(patch);
        return Promise.resolve();
      },
      flush: () => Promise.resolve(),
      dispose: () => {},
    };
    setEpicCanvasDesktopProjectionBridge(bridge);
    onTestFinished(() => setEpicCanvasDesktopProjectionBridge(null));

    const before = requireCanvas(tabId);
    const repointed: EpicCanvasState = {
      ...before,
      tilesByInstanceId: {
        ...before.tilesByInstanceId,
        [SPEC_A.instanceId]: { ...SPEC_B, instanceId: SPEC_A.instanceId },
      },
    };
    const snapshot: DesktopPerWindowSnapshot = {
      epicTabs: [{ id: tabId, epicId: "epic-1", name: "Epic One" }],
      activeTabId: tabId,
      canvasByTabId: { [tabId]: serializeEpicCanvasState(repointed) },
      landingDrafts: [],
      activeLandingDraftId: null,
    };

    expect(() => applyEpicCanvasDesktopProjection(snapshot)).toThrow(
      /identity invariant violated/i,
    );
    expect(updates).toHaveLength(0);

    // If `applyingDesktopProjection` stuck `true` after the throw above,
    // this valid local mutation would be silently suppressed too.
    useEpicCanvasStore.getState().openTileInTab(tabId, SPEC_C);
    expect(updates).toHaveLength(1);
  });

  it("throws when a desktop projection changes only a tab's epicId while its canvas stays identical (round-2 adversarial probe)", () => {
    // Round 1's shape-based allowance let exactly this through: same tab id,
    // identical canvas/instanceIds, only the projected epicId differs - a
    // stale or malformed desktop projection producing the same shape as a
    // legitimate coordinator resolution. Desktop projection has no route to
    // `resolveTabEpicIdentity`, so this must stay a violation.
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-old", "Epic Old");
    store.openTileInTab(tabId, SPEC_A);
    const before = requireCanvas(tabId);

    const snapshot: DesktopPerWindowSnapshot = {
      epicTabs: [{ id: tabId, epicId: "epic-new", name: "Epic Old" }],
      activeTabId: tabId,
      canvasByTabId: { [tabId]: serializeEpicCanvasState(before) },
      landingDrafts: [],
      activeLandingDraftId: null,
    };

    expect(() => applyEpicCanvasDesktopProjection(snapshot)).toThrow(
      /identity invariant violated/i,
    );
    // Fail-closed: the tab's epicId and canvas are both untouched.
    expect(useEpicCanvasStore.getState().tabsById[tabId]?.epicId).toBe(
      "epic-old",
    );
    expect(requireCanvas(tabId)).toBe(before);
  });
});

describe("canvas tile identity invariant: persisted-migration ingress", () => {
  let errorSpy: Mock<typeof appLogger.error>;

  beforeEach(() => {
    errorSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed when hydrated localStorage state repoints an instanceId already live in memory", async () => {
    // zustand's `persist` middleware swallows a `merge` throw internally
    // (`hydrate()` ends in a `.catch` with no configured `onRehydrateStorage`
    // rethrow) - `rehydrate()` itself resolves either way. The diagnostic
    // and the untouched in-memory state are what this pin actually verifies.
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic One");
    store.openTileInTab(tabId, SPEC_A);

    window.localStorage.setItem(
      epicCanvasKey(null),
      JSON.stringify({
        state: {
          tabsById: {
            "tab-persisted": {
              tabId: "tab-persisted",
              epicId: "epic-persisted",
              name: "Persisted",
            },
          },
          canvasByTabId: {
            "tab-persisted": serializeEpicCanvasState({
              root: {
                kind: "pane",
                id: "pane-persisted",
                tabInstanceIds: [SPEC_A.instanceId],
                activeTabId: SPEC_A.instanceId,
                previewTabId: null,
                activationHistory: [SPEC_A.instanceId],
              },
              activePaneId: "pane-persisted",
              tilesByInstanceId: {
                [SPEC_A.instanceId]: {
                  ...SPEC_C,
                  instanceId: SPEC_A.instanceId,
                },
              },
              sizesByGroupId: {},
            }),
          },
          openTabOrder: ["tab-persisted"],
          activeTabId: "tab-persisted",
          mostRecentTabIdByEpicId: { "epic-persisted": "tab-persisted" },
          artifactTreeByEpicId: {},
        },
        version: 1,
      }),
    );

    await useEpicCanvasStore.persist.rehydrate();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    // Fail-closed: the in-memory tile from before rehydration survives, and
    // the colliding persisted tab was never merged in.
    expect(requireCanvas(tabId).tilesByInstanceId[SPEC_A.instanceId]).toEqual(
      SPEC_A,
    );
    expect(
      useEpicCanvasStore.getState().tabsById["tab-persisted"],
    ).toBeUndefined();
  });

  it("fails closed when a parse/migrate-shaped legacy blob repoints a live instanceId", async () => {
    // Unlike the same-version pin above (which uses serializeEpicCanvasState),
    // this blob is a hand-rolled legacy shape: no activationHistory, raw tile
    // records (not schema-serialized), so sanitize → parseEpicCanvasState
    // (migrate-canvas) must normalize it before the merge-level check runs.
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic One");
    store.openTileInTab(tabId, SPEC_A);

    window.localStorage.setItem(
      epicCanvasKey(null),
      JSON.stringify({
        state: {
          tabsById: {
            "tab-legacy-migrate": {
              tabId: "tab-legacy-migrate",
              epicId: "epic-legacy-migrate",
              name: "Legacy Migrate",
              // Legacy field ignored by sanitize (removed from EpicViewTab).
              lastSeenAt: 1,
            },
          },
          canvasByTabId: {
            "tab-legacy-migrate": {
              root: {
                kind: "pane",
                id: "pane-legacy",
                tabInstanceIds: [SPEC_A.instanceId],
                activeTabId: SPEC_A.instanceId,
                previewTabId: null,
                // activationHistory intentionally omitted - parse seeds it.
              },
              activePaneId: "pane-legacy",
              tilesByInstanceId: {
                // Raw tile record (not serializeTileRef output) that reuses
                // the live instanceId under a different content id.
                [SPEC_A.instanceId]: {
                  id: SPEC_C.id,
                  instanceId: SPEC_A.instanceId,
                  type: SPEC_C.type,
                  name: SPEC_C.name,
                  hostId: SPEC_C.hostId,
                },
              },
              sizesByGroupId: {},
            },
          },
          openTabOrder: ["tab-legacy-migrate"],
          activeTabId: "tab-legacy-migrate",
          mostRecentTabIdByEpicId: {
            "epic-legacy-migrate": "tab-legacy-migrate",
          },
          artifactTreeByEpicId: {},
        },
        // Persist version stays 1 (canvas store has no multi-version migrate
        // fn); the "migration" here is parseEpicCanvasState's total parse /
        // reconcile path, which is what merge runs before the identity check.
        version: 1,
      }),
    );

    await useEpicCanvasStore.persist.rehydrate();

    expect(errorSpy).toHaveBeenCalled();
    const [, fields] = errorSpy.mock.calls[0] ?? [];
    expect(fields).toMatchObject({
      ingressContext: "persisted-migration",
      instanceId: SPEC_A.instanceId,
    });
    expect(requireCanvas(tabId).tilesByInstanceId[SPEC_A.instanceId]).toEqual(
      SPEC_A,
    );
    expect(
      useEpicCanvasStore.getState().tabsById["tab-legacy-migrate"],
    ).toBeUndefined();
  });

  it("completes hydration (hasHydrated + onFinishHydration) even when the merge is rejected", async () => {
    // zustand's `hydrate()` resets `hasHydrated` to `false` at the start of
    // every call and only flips it back once `merge()` returns normally and
    // `set(stateFromStorage, true)` runs. A throwing `merge()` (the old
    // behavior here) never reaches that point, so consumers gated on
    // hydration completion - history-prune-provider.tsx,
    // epic-tab-existence-reconciler.tsx - would hang forever.
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic One");
    store.openTileInTab(tabId, SPEC_A);

    window.localStorage.setItem(
      epicCanvasKey(null),
      JSON.stringify({
        state: {
          tabsById: {
            "tab-persisted": {
              tabId: "tab-persisted",
              epicId: "epic-persisted",
              name: "Persisted",
            },
          },
          canvasByTabId: {
            "tab-persisted": serializeEpicCanvasState({
              root: {
                kind: "pane",
                id: "pane-persisted",
                tabInstanceIds: [SPEC_A.instanceId],
                activeTabId: SPEC_A.instanceId,
                previewTabId: null,
                activationHistory: [SPEC_A.instanceId],
              },
              activePaneId: "pane-persisted",
              tilesByInstanceId: {
                [SPEC_A.instanceId]: {
                  ...SPEC_C,
                  instanceId: SPEC_A.instanceId,
                },
              },
              sizesByGroupId: {},
            }),
          },
          openTabOrder: ["tab-persisted"],
          activeTabId: "tab-persisted",
          mostRecentTabIdByEpicId: { "epic-persisted": "tab-persisted" },
          artifactTreeByEpicId: {},
        },
        version: 1,
      }),
    );

    let finished = false;
    const unsubscribe = useEpicCanvasStore.persist.onFinishHydration(() => {
      finished = true;
    });

    await useEpicCanvasStore.persist.rehydrate();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(useEpicCanvasStore.persist.hasHydrated()).toBe(true);
    expect(finished).toBe(true);
    // Fail-closed still holds: the rejected persisted state never merged in.
    expect(requireCanvas(tabId).tilesByInstanceId[SPEC_A.instanceId]).toEqual(
      SPEC_A,
    );
    expect(
      useEpicCanvasStore.getState().tabsById["tab-persisted"],
    ).toBeUndefined();

    unsubscribe();
  });
});

describe("canvas tile identity invariant: legitimate flows pass untouched", () => {
  it("header tear-off retains the exact tuple across the two-store write", () => {
    const store = useEpicCanvasStore.getState();
    const sourceTabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(sourceTabId, SPEC_A);
    const sourceGroupId = requireCanvas(sourceTabId).activePaneId;
    if (sourceGroupId === null) throw new Error("expected active group");

    expect(() =>
      useEpicCanvasStore.getState().tearOffTabIntoNewHeaderTab({
        sourceTabId,
        sourcePaneId: sourceGroupId,
        sourceTileTabId: SPEC_A.instanceId,
        insertIndex: 1,
      }),
    ).not.toThrow();
  });

  it("duplicateTab's freshly-minted instanceIds never collide with the source tab", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);

    expect(() =>
      useEpicCanvasStore.getState().duplicateTab(tabId),
    ).not.toThrow();
  });

  it("cross-pane move and edge split retain the moved instanceId's tuple", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(tabId, SPEC_A);
    const groupId = requireCanvas(tabId).activePaneId;
    if (groupId === null) throw new Error("expected active group");

    expect(() =>
      useEpicCanvasStore
        .getState()
        .splitPaneWithNode(tabId, groupId, "right", SPEC_B),
    ).not.toThrow();

    const canvas = requireCanvas(tabId);
    const panes = collectPanes(canvas.root);
    expect(panes.length).toBeGreaterThan(1);
    expect(canvas.tilesByInstanceId[SPEC_A.instanceId]).toEqual(SPEC_A);

    const targetPane = panes.find((p) => p.id !== groupId);
    if (targetPane === undefined) throw new Error("expected split pane");
    expect(() =>
      useEpicCanvasStore.getState().moveTabOnTabStrip(tabId, {
        sourcePaneId: groupId,
        tabId: SPEC_A.instanceId,
        targetPaneId: targetPane.id,
        targetIndex: 0,
      }),
    ).not.toThrow();
    const afterMove = requireCanvas(tabId);
    expect(afterMove.tilesByInstanceId[SPEC_A.instanceId]).toEqual(SPEC_A);
    const movedPane = findPaneById(afterMove.root, targetPane.id);
    expect(movedPane?.tabInstanceIds).toContain(SPEC_A.instanceId);
  });

  it("a tab switch (decision #17 unmount/remount) never touches the tuple", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic Foo");
    store.openTileInTab(tabId, SPEC_A);
    store.openTileInTab(tabId, SPEC_B);
    const groupId = requireCanvas(tabId).activePaneId;
    if (groupId === null) throw new Error("expected active group");

    expect(() =>
      useEpicCanvasStore
        .getState()
        .setActiveTileTab(tabId, groupId, SPEC_A.instanceId),
    ).not.toThrow();
    expect(requireCanvas(tabId).tilesByInstanceId[SPEC_A.instanceId]).toEqual(
      SPEC_A,
    );
  });

  it("chaos sequence of legitimate multi-tab/multi-epic ops never throws", () => {
    // Strongest regression pin for ordinary usage: a long realistic sequence
    // across several epics/tabs must never trip the identity choke point.
    expect(() => {
      const store = useEpicCanvasStore.getState();
      const tab1 = store.openEpicTab("epic-chaos-1", "Chaos One");
      const tab2 = store.openEpicTab("epic-chaos-2", "Chaos Two");
      const tab3 = store.openEpicTab("epic-chaos-3", "Chaos Three");

      for (let round = 0; round < 3; round += 1) {
        const suffix = String(round);
        const a: EpicNodeRef = {
          id: `chaos-a-${suffix}`,
          instanceId: `inst-chaos-a-${suffix}`,
          type: "spec",
          name: `Chaos A ${suffix}`,
          hostId: TEST_HOST_ID,
        };
        const b: EpicNodeRef = {
          id: `chaos-b-${suffix}`,
          instanceId: `inst-chaos-b-${suffix}`,
          type: "spec",
          name: `Chaos B ${suffix}`,
          hostId: TEST_HOST_ID,
        };
        const c: EpicNodeRef = {
          id: `chaos-c-${suffix}`,
          instanceId: `inst-chaos-c-${suffix}`,
          type: "chat",
          name: `Chaos C ${suffix}`,
          hostId: TEST_HOST_ID,
        };
        const d: EpicNodeRef = {
          id: `chaos-d-${suffix}`,
          instanceId: `inst-chaos-d-${suffix}`,
          type: "ticket",
          name: `Chaos D ${suffix}`,
          hostId: TEST_HOST_ID,
        };

        useEpicCanvasStore.getState().openTileInTab(tab1, a);
        useEpicCanvasStore.getState().openTileInTab(tab1, b);
        useEpicCanvasStore.getState().openTileInTab(tab2, c);
        useEpicCanvasStore.getState().openTileInTab(tab3, d);
        useEpicCanvasStore.getState().openTileInTab(tab2, GIT_DIFF_A);
        useEpicCanvasStore.getState().openTileInTab(tab3, TERMINAL_A);
        useEpicCanvasStore.getState().openTileInTab(tab1, WORKSPACE_FILE_A);

        const pane1 = requireActivePaneId(tab1);
        useEpicCanvasStore.getState().splitPaneWithNode(tab1, pane1, "right", {
          id: `chaos-split-${suffix}`,
          instanceId: `inst-chaos-split-${suffix}`,
          type: "spec",
          name: `Split ${suffix}`,
          hostId: TEST_HOST_ID,
        });

        const afterSplit = requireCanvas(tab1);
        const panes = collectPanes(afterSplit.root);
        if (panes.length < 2) {
          throw new Error("expected split to create a second pane");
        }
        const rightPane = panes.find((p) => p.id !== pane1);
        if (rightPane === undefined) {
          throw new Error("expected right pane");
        }

        useEpicCanvasStore.getState().moveTabOnTabStrip(tab1, {
          sourcePaneId: pane1,
          tabId: a.instanceId,
          targetPaneId: rightPane.id,
          targetIndex: 0,
        });
        useEpicCanvasStore
          .getState()
          .setActiveTileTab(tab1, rightPane.id, a.instanceId);
        useEpicCanvasStore
          .getState()
          .renameTab(tab1, `Chaos One renamed ${suffix}`);
        useEpicCanvasStore
          .getState()
          .renameArtifactInTab(tab1, a.id, `A renamed ${suffix}`);

        useEpicCanvasStore.getState().tearOffTabIntoNewHeaderTab({
          sourceTabId: tab2,
          sourcePaneId: requireActivePaneId(tab2),
          sourceTileTabId: c.instanceId,
          insertIndex: 1,
        });

        useEpicCanvasStore.getState().duplicateTab(tab3);

        const pane2 = requireActivePaneId(tab2);
        const tab2Canvas = requireCanvas(tab2);
        const closeTarget = Object.keys(tab2Canvas.tilesByInstanceId).at(0);
        if (closeTarget !== undefined) {
          useEpicCanvasStore
            .getState()
            .closeCanvasTab(tab2, pane2, closeTarget);
          const closed =
            useEpicCanvasStore.getState().closedTilePayloadsByTabId[tab2]?.[
              closeTarget
            ]?.node;
          if (closed !== undefined) {
            useEpicCanvasStore
              .getState()
              .restoreClosedTilePreview(tab2, pane2, closed);
          }
        }

        useEpicCanvasStore.getState().openTilePreviewInTab(tab1, {
          id: `chaos-preview-${suffix}`,
          instanceId: `inst-chaos-preview-${suffix}`,
          type: "review",
          name: `Preview ${suffix}`,
          hostId: TEST_HOST_ID,
        });
        useEpicCanvasStore.getState().setActiveTab(tab2);
        useEpicCanvasStore.getState().setActiveTab(tab3);
        useEpicCanvasStore.getState().setActiveTab(tab1);
        useEpicCanvasStore.getState().closeTab(tab3);
        useEpicCanvasStore.getState().setActiveTab(tab3);
      }
    }).not.toThrow();
  });
});
