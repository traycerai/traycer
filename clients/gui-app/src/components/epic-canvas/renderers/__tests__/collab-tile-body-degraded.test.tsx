/**
 * The degraded band over a LIVE editor: a body the host has stopped trying to
 * keep current (`bodyDegraded`) shows a sentence in place of the sync sweep,
 * wins over it when both are set, and the editor is never remounted across
 * any transition.
 *
 * Same harness as `collab-tile-body-syncing.test.tsx`: the full
 * `CollabTileBody`, with the band's own subscription
 * (`useEpicArtifactBodyDegraded`, `useEpicArtifactBodySyncing`) REAL over a
 * real zustand store.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import type { ArtifactBodyDegradedReason } from "@traycer/protocol/host/epic/artifact-subscribe";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { CollabTileBody } from "../collab-tile-body";
import { collabTileDegradedNotice } from "../collab-tile-availability-copy";

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

type BodyState = {
  readonly syncing: boolean;
  readonly degraded: ArtifactBodyDegradedReason | null;
};

type StoreState = {
  artifactRooms: {
    stateByArtifactId: Record<string, "ready">;
    bodySyncingByArtifactId: Record<string, true>;
    bodyDegradedByArtifactId: Record<string, ArtifactBodyDegradedReason>;
  };
};

interface TestHandle {
  readonly store: StoreApi<StoreState>;
  readonly epicId: string;
}

function roomsFor(body: BodyState): StoreState["artifactRooms"] {
  return {
    stateByArtifactId: { [ARTIFACT_ID]: "ready" },
    bodySyncingByArtifactId: body.syncing ? { [ARTIFACT_ID]: true } : {},
    bodyDegradedByArtifactId:
      body.degraded === null ? {} : { [ARTIFACT_ID]: body.degraded },
  };
}

function makeHandle(): TestHandle {
  const store = createStore<StoreState>(() => ({
    artifactRooms: roomsFor({ syncing: false, degraded: null }),
  }));
  return { store, epicId: "epic-1" };
}

/** The tile reads only `handle.store` here, through the real selectors. */
function asOpenEpicHandle(handle: TestHandle): OpenEpicStoreHandle {
  return handle as OpenEpicStoreHandle;
}

function setBody(handle: TestHandle, body: BodyState): void {
  act(() => {
    handle.store.setState({ artifactRooms: roomsFor(body) });
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

const DEGRADED_ID = `${TEST_ID}-body-degraded`;
const SYNCING_ID = `${TEST_ID}-body-syncing`;
const REASONS: readonly ArtifactBodyDegradedReason[] = [
  "room-unavailable",
  "baseline-unavailable",
];

describe("CollabTileBody degraded band", () => {
  beforeEach(() => {
    editorLife.mounts = 0;
    editorLife.unmounts = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it.each(REASONS)(
    "says %s in a status band in place of the sweep, over the mounted editor",
    (reason) => {
      const handle = makeHandle();
      mountTile(handle);
      const editorBefore = screen.getByTestId("editor-content");
      expect(screen.queryByTestId(DEGRADED_ID)).toBeNull();

      setBody(handle, { syncing: false, degraded: reason });

      const band = screen.getByTestId(DEGRADED_ID);
      expect(band.getAttribute("role")).toBe("status");
      expect(band.getAttribute("data-reason")).toBe(reason);
      expect(band.textContent).toBe(collabTileDegradedNotice(reason));
      expect(screen.queryByTestId(SYNCING_ID)).toBeNull();
      expect(screen.getByTestId("editor-content")).toBe(editorBefore);
      expect(editorLife).toEqual({ mounts: 1, unmounts: 0 });
    },
  );

  it("wins over syncing when both are set, then yields to the sweep and to nothing as each clears", () => {
    const handle = makeHandle();
    mountTile(handle);
    const editorBefore = screen.getByTestId("editor-content");

    setBody(handle, { syncing: true, degraded: "room-unavailable" });
    expect(screen.getByTestId(DEGRADED_ID)).toBeTruthy();
    expect(screen.queryByTestId(SYNCING_ID)).toBeNull();

    setBody(handle, { syncing: true, degraded: null });
    expect(screen.queryByTestId(DEGRADED_ID)).toBeNull();
    expect(screen.getByTestId(SYNCING_ID).textContent).toContain("Syncing…");

    setBody(handle, { syncing: false, degraded: null });
    expect(screen.queryByTestId(DEGRADED_ID)).toBeNull();
    expect(screen.queryByTestId(SYNCING_ID)).toBeNull();

    expect(screen.getByTestId("editor-content")).toBe(editorBefore);
    expect(editorLife).toEqual({ mounts: 1, unmounts: 0 });
  });

  it("a body that starts out degraded mounts the band with the editor at once", () => {
    const handle = makeHandle();
    handle.store.setState({
      artifactRooms: roomsFor({
        syncing: false,
        degraded: "baseline-unavailable",
      }),
    });
    mountTile(handle);
    expect(screen.getByTestId(DEGRADED_ID).getAttribute("data-reason")).toBe(
      "baseline-unavailable",
    );
    expect(screen.getByTestId("editor-content")).toBeTruthy();
  });
});
