/**
 * The "Syncing…" strip over a LIVE editor (O4): turning the sync state on and
 * off shows and removes the strip, and the editor is never remounted across
 * either transition.
 *
 * The full `CollabTileBody` is rendered, with everything around the editor
 * mocked away: the strip's own subscription (`useEpicArtifactBodySyncing`,
 * `useLoadDeadline`, the sweep bar) stays REAL and reads a real zustand store
 * through the real `EpicSessionContext`. `EditorContent` is replaced by a
 * marker that counts mounts and unmounts, which is what "never remounted"
 * means for a component tree.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { LINK_DOWN_ESCALATION_MS } from "@/lib/link-down-escalation";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { CollabTileBody } from "../collab-tile-body";

const { editorLife, fakeEditor } = vi.hoisted(() => ({
  editorLife: { mounts: 0, unmounts: 0 },
  fakeEditor: { isEmpty: false, id: "fake-editor" },
}));

const ARTIFACT_ID = "artifact-1";
const TEST_ID = "collab-tile";

const roomDoc = new Y.Doc();
const roomFragment = roomDoc.getXmlFragment("body");
const roomAwareness = new Awareness(roomDoc);

vi.mock("@tiptap/react", () => ({
  EditorContent: function EditorContentMarker(): ReactNode {
    useEffect(() => {
      editorLife.mounts += 1;
      return () => {
        editorLife.unmounts += 1;
      };
    }, []);
    return <div data-testid="editor-content" />;
  },
}));

vi.mock("../use-collab-tile-editor", () => ({
  useCollabTileEditor: () => fakeEditor,
}));

vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  return {
    ...actual,
    // Everything the tile reads besides the strip's own selector.
    useEpicArtifactFragment: () => roomFragment,
    useEpicArtifactBodyAwareness: () => roomAwareness,
    useEpicArtifactBodyAvailability: () => "ready",
    useEpicArtifactBodySubscribeAnswered: () => true,
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
  artifactRooms: {
    stateByArtifactId: Record<string, "ready">;
    bodySyncingByArtifactId: Record<string, true>;
  };
};

interface TestHandle {
  readonly store: StoreApi<StoreState>;
  readonly epicId: string;
}

function makeHandle(): TestHandle {
  const store = createStore<StoreState>(() => ({
    artifactRooms: {
      stateByArtifactId: { [ARTIFACT_ID]: "ready" },
      bodySyncingByArtifactId: {},
    },
  }));
  return { store, epicId: "epic-1" };
}

/**
 * The tile reads only `handle.store` here - through the real selectors under
 * test - and the rest of the handle is the worker runtime this suite does not
 * start. The same narrowing the canvas suites use (`{} as OpenEpicStoreHandle`).
 */
function asOpenEpicHandle(handle: TestHandle): OpenEpicStoreHandle {
  return handle as OpenEpicStoreHandle;
}

function setSyncing(handle: TestHandle, on: boolean): void {
  act(() => {
    handle.store.setState({
      artifactRooms: {
        stateByArtifactId: { [ARTIFACT_ID]: "ready" },
        bodySyncingByArtifactId: on ? { [ARTIFACT_ID]: true } : {},
      },
    });
  });
}

const NODE: EpicNodeRef = {
  id: ARTIFACT_ID,
  type: "workspace-file",
  name: "notes.md",
  instanceId: "instance-1",
  hostId: "host-1",
  workspacePath: "/workspace",
  filePath: "notes.md",
};

function mountTile(handle: TestHandle) {
  return render(
    <EpicSessionContext.Provider value={asOpenEpicHandle(handle)}>
      <CollabTileBody
        node={NODE}
        viewTabId="view-1"
        tileId="tile-1"
        isActive
        testId={TEST_ID}
      />
    </EpicSessionContext.Provider>,
  );
}

const STRIP_ID = `${TEST_ID}-body-syncing`;

describe("CollabTileBody syncing strip", () => {
  beforeEach(() => {
    editorLife.mounts = 0;
    editorLife.unmounts = 0;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows a non-blocking strip while syncing and removes it when synced, never remounting the editor", () => {
    const handle = makeHandle();
    mountTile(handle);
    const editorBefore = screen.getByTestId("editor-content");
    expect(screen.queryByTestId(STRIP_ID)).toBeNull();
    expect(editorLife).toEqual({ mounts: 1, unmounts: 0 });

    setSyncing(handle, true);
    const strip = screen.getByTestId(STRIP_ID);
    expect(strip.textContent).toContain("Syncing…");
    expect(strip.className).toContain("pointer-events-none");
    expect(screen.getByTestId("editor-content")).toBe(editorBefore);
    expect(editorLife).toEqual({ mounts: 1, unmounts: 0 });

    setSyncing(handle, false);
    expect(screen.queryByTestId(STRIP_ID)).toBeNull();
    expect(screen.getByTestId("editor-content")).toBe(editorBefore);
    expect(editorLife).toEqual({ mounts: 1, unmounts: 0 });
  });

  it("escalates the label to 'Still syncing…' after LINK_DOWN_ESCALATION_MS", () => {
    vi.useFakeTimers();
    const handle = makeHandle();
    mountTile(handle);
    setSyncing(handle, true);
    expect(screen.getByTestId(STRIP_ID).textContent).toContain("Syncing…");
    expect(screen.getByTestId(STRIP_ID).textContent).not.toContain("Still");

    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
    });
    expect(screen.getByTestId(STRIP_ID).textContent).toContain(
      "Still syncing…",
    );
    expect(editorLife).toEqual({ mounts: 1, unmounts: 0 });
  });

  it("a body that starts out syncing mounts the strip over the editor at once", () => {
    const handle = makeHandle();
    handle.store.setState({
      artifactRooms: {
        stateByArtifactId: { [ARTIFACT_ID]: "ready" },
        bodySyncingByArtifactId: { [ARTIFACT_ID]: true },
      },
    });
    mountTile(handle);
    expect(screen.getByTestId(STRIP_ID)).toBeTruthy();
    expect(screen.getByTestId("editor-content")).toBeTruthy();
  });
});
