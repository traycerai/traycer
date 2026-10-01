/**
 * `collabTileNotice` is a pure function, and its own test file
 * (`collab-tile-availability-copy.test.ts`) exhaustively covers its
 * four-argument truth table. This suite covers what that pure-function test
 * cannot: the tile component reacting to a REAL run through the open-epic
 * store's lane pipeline, not a hand-mocked selector map.
 *
 * ## Why the store is real
 *
 * An earlier version of this suite mocked `useEpicArtifactFragment`,
 * `useEpicArtifactBodyAwareness`, `useEpicArtifactBodyAvailability` and
 * `useEpicArtifactBodySubscribeAnswered` with a mutable map and forced
 * `rerender()` calls to move between states. A reviewer correctly pointed out
 * that this bypasses the exact path the suite claims to cover: a non-terminal
 * `unavailable` body-lane frame (`terminal: false`) ->
 * `lane-body-translation.ts`'s `laneBodyTranslationOf` (-> `"retrying"`) ->
 * `epic-rooms-replica.ts`'s `applyAvailability` -> `tier.invalidate` (which
 * discards the local replica, so the fragment goes `null` UNDER a mounted
 * editor) -> a store publish -> the tile's own selectors picking that up and
 * re-rendering. A mocked-selector version can only prove the pure function and
 * the component agree on an outcome the TEST invented; it cannot tell a
 * correct translation from a broken one.
 *
 * So this suite opens a REAL store (`openStoreForTest`) with a REAL
 * in-process runtime, host and core, and fakes only the wire beneath the
 * typed stream clients - the same seam `lane-body-lease-survives-mount.test.ts`
 * and `lane-body-terminal-refusal-recovery.test.ts` fake. `CollabTileBody`
 * mounts for real inside `<EpicSessionContext.Provider value={handle}>`; its
 * own hooks take the body lease (nothing here calls
 * `acquireArtifactBodyLease` directly), and every frame delivered below
 * crosses the real lane adapter and translation layer before the tile ever
 * sees it.
 *
 * Case 2 is the transition a pure helper test cannot represent even with a
 * real store: a room leaving `ready` mid-mount, discarding its replica while
 * the SAME component instance is showing an editor over it, AND THEN COMING
 * BACK while the tile's lease was held continuously throughout - never
 * released, exactly as `useEpicArtifactBodyLease` holds it for a stable
 * artifact id. Case 1 is the adjacent trap - a COLD open reported `retrying`
 * must keep the skeleton, never jump straight to "Reconnecting…". Case 3 is
 * the id-scoping half: a tile handed a DIFFERENT artifact must not carry the
 * previous one's `bodyBoundOnce` history into the new document's first open.
 *
 * ## The recovery case 2's third beat pins
 *
 * A still-held lease used to have no way back once its room left `ready`:
 * `dropBodiesWhoseRoomIsGone` calls `bodyLeases.forget(docKey)`
 * (`store.ts`), and `forget()` used to delete the lease bridge's `entries`
 * record outright without moving it into the `awaiting` bucket
 * (`artifact-body-lease-bridge.ts`) - so `retryBodiesWhoseRoomBecameReady`,
 * which only ever walks `awaiting`, could never revive it, and nothing in
 * `CollabTileBody`'s hooks issues a fresh acquire for an artifact id that
 * never changed. `forget` now moves a still-held body into `awaiting` with
 * its lease count intact, so the very next `doc` frame re-materializes it
 * through the SAME lease the tile has held the whole time. Case 2's third
 * beat below re-seeds after the reconnect notice and asserts the editor
 * comes back - the component-level half of that fix; the store-level half,
 * including the observer-rebind proof that the recovered body keeps
 * receiving live updates, is
 * `lane-body-room-leaves-ready-recovery.test.ts`.
 *
 * Modeled on `collab-tile-body-syncing.test.tsx` for the surrounding mocks -
 * everything NOT on the body path: tiptap's `EditorContent`, the editor hook,
 * comments, host client, attachment scope, and so on - and on
 * `lane-body-lease-survives-mount.test.ts` /
 * `lane-body-terminal-refusal-recovery.test.ts` for the store harness and
 * frame construction.
 */
import {
  act,
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { ArtifactStreamCallbacks } from "@traycer-clients/shared/host-transport/artifact-stream-client";
import type {
  EpicStatusSnapshotFrame,
  EpicStatusStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import { artifactSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/artifact-subscribe";
import { epicStatusSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/status-subscribe";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicLaneSelectionSources } from "@/stores/epics/open-epic/runtime/epic-replica-runtime";
import { encodeDocStateVectorBase64 } from "@/stores/epics/open-epic/runtime/dirty-watermark";
import { absentLaneUnaries } from "@/stores/epics/open-epic/test-support/absent-lane-unaries";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { CollabTileBody } from "../collab-tile-body";

const { fakeEditor } = vi.hoisted(() => ({
  fakeEditor: { isEmpty: false, id: "fake-editor" },
}));

const TEST_ID = "collab-tile";
const EPOCH = "epoch-1";

vi.mock("@tiptap/react", () => ({
  EditorContent: () => <div data-testid="editor-content" />,
}));

vi.mock("../use-collab-tile-editor", () => ({
  useCollabTileEditor: () => fakeEditor,
}));

vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  return {
    ...actual,
    // The four body selectors (`useEpicArtifactFragment`,
    // `useEpicArtifactBodyAwareness`, `useEpicArtifactBodyAvailability`,
    // `useEpicArtifactBodySubscribeAnswered`) are LEFT REAL - see the header.
    // Only selectors that would need unrelated store content stay overridden:
    // a full state-lane snapshot for `snapshotLoaded`, and comment-room
    // durability, which this suite never seeds and never asserts on.
    useEpicSnapshotLoaded: () => true,
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

function statusSnapshot(): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV11.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: EPOCH,
    securityEpoch: 1,
    permissionRole: "editor",
    cloudSyncStatus: "connected",
    dirty: false,
    migration: null,
    deletion: { state: "none" },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a snapshot frame, got ${parsed.kind}`);
  }
  return parsed;
}

interface BodyRig {
  readonly handle: OpenedStoreForTest;
  /** The status lane names the epoch bodies attach under. */
  announceEpoch(): Promise<void>;
  /** The host reports a non-terminal `unavailable` on the lane that is open. */
  deliverUnavailable(artifactId: string, terminal: boolean): Promise<void>;
  /** The host serves this body on the lane that is open. */
  seedDoc(artifactId: string, docGuid: string): Promise<void>;
}

function createBodyRig(): BodyRig {
  let statusCallbacks: EpicStatusStreamCallbacks | null = null;
  // Captured PER ARTIFACT ID: a tile that switches artifacts opens a SECOND
  // lane for the new id, and seeding/refusing has to reach the right one.
  const bodyCallbacksByArtifactId = new Map<string, ArtifactStreamCallbacks>();

  const statusFactory: EpicStatusStreamClientFactory = (_epicId, callbacks) => {
    statusCallbacks = callbacks;
    return { close: () => undefined };
  };
  const stateFactory: EpicStateStreamClientFactory = () => ({
    close: () => undefined,
  });
  const artifactFactory: ArtifactStreamClientFactory = (request) => {
    bodyCallbacksByArtifactId.set(request.artifactId, request.callbacks);
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      close: () => undefined,
    };
  };

  const laneSelection: EpicLaneSelectionSources = {
    support: () => "unknown",
    subscribeSupport: () => () => {},
    unaries: absentLaneUnaries(),
    stateStreamClientFactory: stateFactory,
    statusStreamClientFactory: statusFactory,
    artifactStreamClientFactory: artifactFactory,
  };

  const handle = openStoreForTest({
    epicId: "epic-collab-tile-reconnect",
    userId: null,
    factories: {
      streamClientFactory: () => {
        throw new Error("the legacy stream must not open on the lane arm");
      },
      laneSelection,
    },
    writeCommand: null,
  });

  function liveStatus(): EpicStatusStreamCallbacks {
    if (statusCallbacks === null) throw new Error("no status client");
    return statusCallbacks;
  }

  function liveBody(artifactId: string): ArtifactStreamCallbacks {
    const callbacks = bodyCallbacksByArtifactId.get(artifactId);
    if (callbacks === undefined) {
      throw new Error(`no body lane was opened for ${artifactId}`);
    }
    return callbacks;
  }

  // Two drains, for the same reason the lease-survival and refusal-recovery
  // suites name theirs: a delivery can cause another - the projection lands
  // on the first drain, and the re-materialize (or invalidate) it triggers is
  // queued behind it.
  async function settle(): Promise<void> {
    await handle.flush();
    await handle.flush();
  }

  return {
    handle,
    async announceEpoch(): Promise<void> {
      await act(async () => {
        liveStatus().onSnapshot(statusSnapshot(), true);
        await settle();
      });
    },
    async deliverUnavailable(
      artifactId: string,
      terminal: boolean,
    ): Promise<void> {
      const parsed = artifactSubscribeServerFrameSchemaV10.parse({
        kind: "unavailable",
        hasBinaryPayload: false,
        authorityEpoch: EPOCH,
        artifactId,
        code: "bodyUnavailable",
        reason: "test",
        terminal,
      });
      if (parsed.kind !== "unavailable") {
        throw new Error(`expected an unavailable frame, got ${parsed.kind}`);
      }
      await act(async () => {
        liveBody(artifactId).onUnavailable(parsed);
        await settle();
      });
    },
    async seedDoc(artifactId: string, docGuid: string): Promise<void> {
      const donor = new Y.Doc();
      donor
        .getXmlFragment(artifactBodyFragmentName(artifactId))
        .insert(0, [new Y.XmlText("hello")]);
      const parsed = artifactSubscribeServerFrameSchemaV10.parse({
        kind: "doc",
        hasBinaryPayload: true,
        authorityEpoch: EPOCH,
        artifactId,
        docGuid,
        stateVectorBase64: encodeDocStateVectorBase64(donor),
      });
      if (parsed.kind !== "doc") {
        throw new Error(`expected a doc frame, got ${parsed.kind}`);
      }
      await act(async () => {
        liveBody(artifactId).onDoc(parsed, Y.encodeStateAsUpdate(donor));
        await settle();
      });
    },
  };
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

function tileElement(
  handle: OpenedStoreForTest,
  node: EpicNodeRef,
): ReactElement {
  return (
    <EpicSessionContext.Provider value={handle}>
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

/**
 * Lets a lease change (a fresh mount, or a rerender that swaps `node.id`)
 * cross the pipe: `useEpicArtifactBodyLease`'s layout effect calls
 * `acquireArtifactBodyLease` synchronously, but the attach itself is a worker
 * round trip that only advances on `flush()`.
 */
async function settleLeaseAttach(handle: OpenedStoreForTest): Promise<void> {
  await act(async () => {
    await handle.flush();
    await handle.flush();
  });
}

async function mountTile(
  handle: OpenedStoreForTest,
  node: EpicNodeRef,
): Promise<RenderResult> {
  const result = render(tileElement(handle, node));
  await settleLeaseAttach(handle);
  return result;
}

describe("CollabTileBody reconnect copy (real store, fake transport)", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    cleanup();
    for (const handle of opened.splice(0)) handle.dispose();
  });

  function rigUnderTest(): BodyRig {
    const rig = createBodyRig();
    opened.push(rig.handle);
    return rig;
  }

  it("a cold first open reported retrying keeps the skeleton, never a reconnect sentence", async () => {
    const rig = rigUnderTest();
    await rig.announceEpoch();
    await mountTile(rig.handle, NODE_A);

    // THE EDGE. Nothing has been seeded yet - this is the FIRST answer the
    // tile gets, and it must not read as a lost connection.
    await rig.deliverUnavailable(NODE_A.id, false);

    const loading = screen.getByTestId(`${TEST_ID}-loading`);
    expect(loading.dataset.bodyBoundOnce).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/reconnect/i)).toBeNull();
  });

  it("a real reconnect: editor, then 'Reconnecting…' once retrying is reached after a body was bound", async () => {
    const rig = rigUnderTest();
    await rig.announceEpoch();
    await mountTile(rig.handle, NODE_A);
    await rig.seedDoc(NODE_A.id, "guid-1");

    expect(screen.getByTestId("editor-content")).toBeTruthy();

    // THE TRANSITION a pure helper test cannot represent: the room leaves
    // `ready` while this exact component instance is showing the editor. If
    // `applyAvailability` -> `tier.invalidate` did not really discard the
    // replica, the editor marker would still be here and this assertion
    // would fail rather than the loading testid appearing.
    await rig.deliverUnavailable(NODE_A.id, false);

    const loading = screen.getByTestId(`${TEST_ID}-loading`);
    expect(loading.dataset.bodyBoundOnce).toBe("true");
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Reconnecting to this document…");

    // THE THIRD BEAT: the SAME held lease recovers once the room is ready
    // again, with no remount and no fresh acquire - `forget` moving the
    // still-held body back into `awaiting` is what makes this reachable.
    await rig.seedDoc(NODE_A.id, "guid-1");

    expect(screen.getByTestId("editor-content")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a different artifact does not inherit the previous one's bound-once history", async () => {
    const rig = rigUnderTest();
    await rig.announceEpoch();
    const result = await mountTile(rig.handle, NODE_A);
    await rig.seedDoc(NODE_A.id, "guid-1");
    expect(screen.getByTestId("editor-content")).toBeTruthy();

    // A prop change on the SAME mounted component - not a store poke, so a
    // plain `rerender()` is the right tool here.
    result.rerender(tileElement(rig.handle, NODE_B));
    await settleLeaseAttach(rig.handle);

    await rig.deliverUnavailable(NODE_B.id, false);

    const loading = screen.getByTestId(`${TEST_ID}-loading`);
    expect(loading.dataset.bodyBoundOnce).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/reconnect/i)).toBeNull();
  });
});
