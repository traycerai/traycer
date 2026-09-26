/**
 * `collabTileNotice` is a pure function, and its own test file
 * (`collab-tile-availability-copy.test.ts`) exhaustively covers its
 * four-argument truth table. What a pure-function test cannot represent is
 * the TRANSITION the production tile lives through: a room leaving `ready`
 * discards its local replica (`applyAvailability` -> `tier.invalidate`), so
 * the fragment goes `null` mid-lifetime and a MOUNTED editor falls back to
 * the pre-editor skeleton path - the same component instance, not a fresh
 * mount. Case 2 below is exactly that transition: a real editor, then a real
 * reconnect (`retrying` reached only after this tile has already shown a
 * body), then the editor again.
 *
 * Case 1 is the adjacent trap a helper test also cannot show end to end: a
 * COLD open reported `retrying` must keep the skeleton, never jump straight
 * to "Reconnecting…" - there is no prior connection to be RE-connecting to.
 * Case 3 is the id-scoping half: a tile handed a DIFFERENT artifact must not
 * carry the previous one's shown-once history into the new document's first
 * open.
 *
 * Modeled on `collab-tile-body-syncing.test.tsx`: the full `CollabTileBody`
 * renders, with everything around the pre-editor/editor swap mocked away.
 * Unlike that suite, the four selectors this module reads to decide the
 * swap - `useEpicArtifactFragment`, `useEpicArtifactBodyAwareness`,
 * `useEpicArtifactBodyAvailability`, `useEpicArtifactBodySubscribeAnswered` -
 * are driven by a mutable `vi.hoisted` map keyed by artifact id, mutated
 * between renders and read again via an explicit `rerender()`, so a test can
 * walk a tile through a live transition rather than assert only one static
 * frame.
 */
import {
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type { EpicArtifactRoomAvailability } from "@/stores/epics/open-epic/types";
import { CollabTileBody } from "../collab-tile-body";

interface ArtifactBodyTestState {
  readonly fragment: Y.XmlFragment | null;
  readonly awareness: Awareness | null;
  readonly availability: EpicArtifactRoomAvailability;
  readonly subscribeAnswered: boolean;
}

const bodyState = vi.hoisted(() => ({
  byArtifactId: {} as Record<string, ArtifactBodyTestState>,
}));

const { fakeEditor } = vi.hoisted(() => ({
  fakeEditor: { isEmpty: false, id: "fake-editor" },
}));

const TEST_ID = "collab-tile";

const roomDocA = new Y.Doc();
const roomFragmentA = roomDocA.getXmlFragment("body");
const roomAwarenessA = new Awareness(roomDocA);

vi.mock("@tiptap/react", () => ({
  EditorContent: () => <div data-testid="editor-content" />,
}));

vi.mock("../use-collab-tile-editor", () => ({
  useCollabTileEditor: () => fakeEditor,
}));

// Typed with an explicit `| undefined` return so every selector below reads
// through the SAME optional shape - an untyped `Record` index access is a
// guaranteed hit as far as the type checker is concerned, which would make
// the `?.` on a plain index expression flag as dead code on some but not all
// of the four call sites below.
function readBodyState(artifactId: string): ArtifactBodyTestState | undefined {
  return bodyState.byArtifactId[artifactId];
}

vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  return {
    ...actual,
    // The four selectors this suite drives through a transition - read from
    // the mutable hoisted map so a test can mutate it and force a fresh
    // render via `rerender()`.
    useEpicArtifactFragment: (artifactId: string | null) => {
      if (artifactId === null) return null;
      return readBodyState(artifactId)?.fragment ?? null;
    },
    useEpicArtifactBodyAwareness: (artifactId: string | null) => {
      if (artifactId === null) return null;
      return readBodyState(artifactId)?.awareness ?? null;
    },
    useEpicArtifactBodyAvailability: (
      artifactId: string | null,
    ): EpicArtifactRoomAvailability => {
      if (artifactId === null) return "unavailable";
      return readBodyState(artifactId)?.availability ?? "unavailable";
    },
    useEpicArtifactBodySubscribeAnswered: (artifactId: string | null) => {
      if (artifactId === null) return false;
      return readBodyState(artifactId)?.subscribeAnswered ?? false;
    },
    useEpicSnapshotLoaded: () => true,
    useChildIdsOf: () => [],
    useEpicPermissionRole: () => "owner",
    useOpenEpicId: () => "epic-1",
    useEpicCommentsHaveNoUsableRoom: () => false,
  };
});

vi.mock("@/components/comments", () => ({
  FloatingDraftPopover: () => null,
  ThreadAnchorHoverPopover: () => null,
}));
vi.mock("@/editor-core", () => ({
  applyCommentDecorationSnapshot: () => undefined,
  ArtifactLinkPopover: () => null,
  ArtifactToolbar: () => null,
  deriveCollabUser: () => ({ name: "Guest", color: "#000" }),
  updateArtifactToolbarPosition: () => undefined,
}));
vi.mock("@/hooks/comments/use-activate-comment-thread", () => ({
  useActivateCommentThread: () => () => undefined,
}));
vi.mock("@/hooks/comments/use-epic-comment-threads", () => ({
  useEpicCommentThreadsForClient: () => ({
    data: undefined,
    dataUpdatedAt: 0,
  }),
}));
vi.mock("@/hooks/comments/use-lane-comment-threads", () => ({
  resolveArtifactCommentThreads: () => ({ threads: null }),
  useEpicLaneCommentThreads: () => null,
  useEpicLaneCommentThreadsDroppedAt: () => null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
vi.mock("@/lib/attachments/use-artifact-attachment-scope-value", () => ({
  useArtifactAttachmentScopeValue: () => null,
}));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => false,
}));
vi.mock("@/hooks/scroll/use-native-div-scroll-restoration", () => ({
  useNativeDivScrollRestoration: () => ({
    scrollContainerRef: () => undefined,
    onScroll: () => undefined,
  }),
}));
vi.mock("@/lib/comments/comment-editor-registry", () => ({
  registerCommentEditor: () => () => undefined,
}));
vi.mock("@/lib/comments/start-comment-draft", () => ({
  startCommentDraft: () => ({ started: false }),
}));
vi.mock("@/components/epic-canvas/tile-find/tile-find-adapter-context", () => ({
  useRegisterTileFindAdapter: () => undefined,
}));
vi.mock("../use-artifact-doc-title-follow", () => ({
  useArtifactDocTitleFollow: () => undefined,
}));
vi.mock("../use-artifact-link-opener", () => ({
  useArtifactLinkOpener: () => ({ openLink: () => undefined }),
}));
vi.mock("../artifact-quote/artifact-quote-popover", () => ({
  ArtifactQuotePopover: () => null,
}));
vi.mock("../artifact-quote/use-artifact-quote-surface", () => ({
  useArtifactQuoteSurface: () => ({
    isOpen: false,
    snapshot: null,
    action: null,
    actions: { quoteToChat: () => undefined, quoteToNewChat: () => undefined },
    dismiss: () => undefined,
  }),
}));
vi.mock("@/hooks/artifacts/use-artifact-image-paste", () => ({
  useArtifactImagePaste: () => ({ supported: false, paste: {} }),
}));

type StoreState = {
  readonly artifactRooms: {
    readonly bodySyncingByArtifactId: Record<string, true>;
  };
};

interface TestHandle {
  readonly store: StoreApi<StoreState>;
  readonly epicId: string;
}

function makeHandle(): TestHandle {
  const store = createStore<StoreState>(() => ({
    artifactRooms: {
      bodySyncingByArtifactId: {},
    },
  }));
  return { store, epicId: "epic-1" };
}

/**
 * The tile reads only `handle.store` here - through the real
 * `useEpicArtifactBodySyncing` selector, the one selector this suite leaves
 * un-mocked - and the rest of the handle is the worker runtime this suite
 * does not start. The same narrowing the canvas suites use (`{} as
 * OpenEpicStoreHandle`).
 */
function asOpenEpicHandle(handle: TestHandle): OpenEpicStoreHandle {
  return handle as OpenEpicStoreHandle;
}

function setArtifactBody(
  artifactId: string,
  state: ArtifactBodyTestState,
): void {
  bodyState.byArtifactId[artifactId] = state;
}

const NODE_A: EpicNodeRef = {
  id: "artifact-a",
  type: "workspace-file",
  name: "notes-a.md",
  instanceId: "instance-a",
  hostId: "host-1",
  workspacePath: "/workspace",
  filePath: "notes-a.md",
};

const NODE_B: EpicNodeRef = {
  id: "artifact-b",
  type: "workspace-file",
  name: "notes-b.md",
  instanceId: "instance-b",
  hostId: "host-1",
  workspacePath: "/workspace",
  filePath: "notes-b.md",
};

function tileElement(handle: TestHandle, node: EpicNodeRef): ReactElement {
  return (
    <EpicSessionContext.Provider value={asOpenEpicHandle(handle)}>
      <CollabTileBody
        node={node}
        viewTabId="view-1"
        tileId="tile-1"
        isActive
        testId={TEST_ID}
      />
    </EpicSessionContext.Provider>
  );
}

function mountTile(handle: TestHandle, node: EpicNodeRef): RenderResult {
  return render(tileElement(handle, node));
}

describe("CollabTileBody reconnect copy", () => {
  beforeEach(() => {
    bodyState.byArtifactId = {};
  });

  afterEach(() => {
    cleanup();
  });

  it("a cold first open reported retrying keeps the skeleton, never a reconnect sentence", () => {
    setArtifactBody(NODE_A.id, {
      fragment: null,
      awareness: null,
      availability: "retrying",
      subscribeAnswered: true,
    });
    const handle = makeHandle();
    mountTile(handle, NODE_A);

    const loading = screen.getByTestId(`${TEST_ID}-loading`);
    expect(loading.dataset.bodyShownOnce).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/reconnect/i)).toBeNull();
  });

  it("a real reconnect: editor, then 'Reconnecting…' once retrying is reached after showing a body, then the editor again", () => {
    setArtifactBody(NODE_A.id, {
      fragment: roomFragmentA,
      awareness: roomAwarenessA,
      availability: "ready",
      subscribeAnswered: true,
    });
    const handle = makeHandle();
    const { rerender } = mountTile(handle, NODE_A);
    expect(screen.getByTestId("editor-content")).toBeTruthy();

    setArtifactBody(NODE_A.id, {
      fragment: null,
      awareness: null,
      availability: "retrying",
      subscribeAnswered: true,
    });
    rerender(tileElement(handle, NODE_A));

    const loading = screen.getByTestId(`${TEST_ID}-loading`);
    expect(loading.dataset.bodyShownOnce).toBe("true");
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Reconnecting to this document…");

    setArtifactBody(NODE_A.id, {
      fragment: roomFragmentA,
      awareness: roomAwarenessA,
      availability: "ready",
      subscribeAnswered: true,
    });
    rerender(tileElement(handle, NODE_A));
    expect(screen.getByTestId("editor-content")).toBeTruthy();
  });

  it("a different artifact does not inherit the previous one's shown-once history", () => {
    setArtifactBody(NODE_A.id, {
      fragment: roomFragmentA,
      awareness: roomAwarenessA,
      availability: "ready",
      subscribeAnswered: true,
    });
    const handle = makeHandle();
    const { rerender } = mountTile(handle, NODE_A);
    expect(screen.getByTestId("editor-content")).toBeTruthy();

    setArtifactBody(NODE_B.id, {
      fragment: null,
      awareness: null,
      availability: "retrying",
      subscribeAnswered: true,
    });
    rerender(tileElement(handle, NODE_B));

    const loading = screen.getByTestId(`${TEST_ID}-loading`);
    expect(loading.dataset.bodyShownOnce).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/reconnect/i)).toBeNull();
  });
});
