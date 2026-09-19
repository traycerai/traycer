import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NavigateOptions,
  UseNavigateResult,
} from "@tanstack/react-router";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import {
  deleteComposerDraftRow,
  deleteLandingDraftRow,
  deleteNewChatDraftRow,
  openChatDraftRow,
  openNewChatDraftRow,
} from "@/lib/drafts/draft-inventory-actions";
import {
  acquireDraftMirrorSession,
  bindComposerDraftHost,
  bindNewChatDraftHost,
  releaseDraftMirrorSession,
  resetDraftMirrorCoordinatorForTests,
  unbindComposerDraftHost,
  unbindNewChatDraftHost,
} from "@/lib/drafts/draft-mirror-coordinator";
import { listDraftInventory } from "@/lib/drafts/draft-inventory";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import {
  landingDraftIsRetired,
  resetLandingDraftRetirementsForTests,
} from "@/lib/drafts/landing-draft-retirement";
import {
  composerSubmittedDraftDeleteIsPending,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";

// Passthrough by default; the finding-2 tests below gate a single call so a
// surface can bind WHILE the upload is still in flight - the exact race the
// `stillUnmounted` re-check exists for.
const draftBlobTransportMocks = vi.hoisted(() => ({
  putDraftBlobsForWrite:
    vi.fn<
      typeof import("@/lib/drafts/draft-blob-transport").putDraftBlobsForWrite
    >(),
}));
vi.mock("@/lib/drafts/draft-blob-transport", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/drafts/draft-blob-transport")>();
  draftBlobTransportMocks.putDraftBlobsForWrite.mockImplementation(
    actual.putDraftBlobsForWrite,
  );
  return {
    ...actual,
    putDraftBlobsForWrite: draftBlobTransportMocks.putDraftBlobsForWrite,
  };
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const HOST_ID = "host-actions";
const OTHER_HOST_ID = "host-other";
const CHAT_ID = "chat-actions";
const EPIC_ID = "epic-actions";

function typed(text: string) {
  return {
    type: "doc" as const,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

interface HostLog {
  readonly upserts: DraftWrite[];
  readonly deletes: string[];
  readonly retracts: string[];
  rows: DraftDocument[];
}

function emptyLog(): HostLog {
  return { upserts: [], deletes: [], retracts: [], rows: [] };
}

/**
 * The bare host client the actions reach for when the owner host has no mirror
 * session here - the whole point of the explicit routing (critique C1).
 */
function fakeClient(log: HostLog) {
  return {
    request: (method: string, params: unknown) => {
      if (method === "drafts.list") {
        return Promise.resolve({
          drafts: log.rows,
          tombstones: [],
          snapshotSeq: 0,
          scopeId: null,
        });
      }
      if (method === "drafts.upsert") {
        const write = (params as { draft: DraftWrite }).draft;
        log.upserts.push(write);
        const document: DraftDocument = {
          ...write,
          ownerHostId: HOST_ID,
          origin: "own",
          adoption: { state: "adopted", hostId: HOST_ID },
          publication: {
            status: "unpublished",
            lastPublishedAt: null,
            publishedRevision: null,
            halted: null,
          },
          revision: 1,
        };
        log.rows = [
          ...log.rows.filter((row) => row.draftId !== write.draftId),
          document,
        ];
        return Promise.resolve({ draft: document });
      }
      if (method === "drafts.delete") {
        const draftId = (params as { draftId: string }).draftId;
        log.deletes.push(draftId);
        const had = log.rows.some((row) => row.draftId === draftId);
        log.rows = log.rows.filter((row) => row.draftId !== draftId);
        return Promise.resolve({ deleted: had });
      }
      if (method === "drafts.retract") {
        const draftId = (params as { draftId: string }).draftId;
        log.retracts.push(draftId);
        return Promise.resolve({ retracted: true });
      }
      return Promise.reject(new Error(`unexpected ${String(method)}`));
    },
  };
}

function mountSession(log: HostLog) {
  return acquireDraftMirrorSession({
    hostId: HOST_ID,
    client: fakeClient(log) as never,
    streamClient: fakeDraftStreamClient(),
    timing: { debounceMs: 0, maxWaitMs: 0 },
  });
}

/** A chat draft published to the host, with its composer then UNMOUNTED. */
async function publishChatDraft(log: HostLog): Promise<string> {
  const session = mountSession(log);
  const store = useComposerDraftStore.getState();
  store.bindTarget(CHAT_ID, EPIC_ID);
  bindComposerDraftHost(CHAT_ID, HOST_ID);
  store.setSnapshot(CHAT_ID, typed("unsent"), null);
  const draftId = useComposerDraftStore.getState().drafts[CHAT_ID]?.draftId;
  if (draftId === undefined || draftId === null) {
    throw new Error("expected a draft id");
  }
  await session.flush([draftId]);
  expect(log.rows.map((row) => row.draftId)).toEqual([draftId]);
  // The tile closes: the coordinator can no longer resolve a host for this
  // chat's draft, which is exactly the state the drafts list acts in.
  unbindComposerDraftHost(CHAT_ID, HOST_ID);
  return draftId;
}

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
  resetLandingDraftRetirementsForTests();
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  useNewConversationModalStore.getState().resetForTests();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  window.localStorage.clear();
});

describe("deleteComposerDraftRow routes the host tombstone itself (critique C1)", () => {
  it("sends drafts.delete on the owner host client when no session is mounted, and settles the fence", async () => {
    const log = emptyLog();
    const draftId = await publishChatDraft(log);
    // Only the session for this host is gone now; the row and its id remain.
    releaseDraftMirrorSession(HOST_ID);
    const client = fakeClient(log);

    const outcome = deleteComposerDraftRow(
      {
        chatId: CHAT_ID,
        draftId,
        ownerHostId: HOST_ID,
        foreign: false,
      },
      client as never,
    );

    expect(outcome.deleted).toBe(true);
    await vi.waitFor(() => {
      expect(log.deletes).toEqual([draftId]);
    });
    expect(log.rows).toEqual([]);
    // The receipt the fence recorded is settled by the host's answer, so no
    // later session re-sends it.
    await vi.waitFor(() => {
      expect(composerSubmittedDraftDeleteIsPending(draftId)).toBe(false);
    });
    // The local row is empty and has surrendered its identity.
    const after = useComposerDraftStore.getState().drafts[CHAT_ID];
    expect(after?.draftId).toBeNull();
  });

  it("goes through the mounted session for the host when there is one", async () => {
    const log = emptyLog();
    const draftId = await publishChatDraft(log);

    deleteComposerDraftRow(
      { chatId: CHAT_ID, draftId, ownerHostId: HOST_ID, foreign: false },
      fakeClient(log) as never,
    );

    await vi.waitFor(() => {
      expect(log.deletes).toEqual([draftId]);
    });
    expect(log.rows).toEqual([]);
    await vi.waitFor(() => {
      expect(composerSubmittedDraftDeleteIsPending(draftId)).toBe(false);
    });
  });

  it("retracts a foreign row instead of deleting it, and offers no Undo", async () => {
    const log = emptyLog();
    const draftId = await publishChatDraft(log);
    releaseDraftMirrorSession(HOST_ID);
    const client = fakeClient(log);

    const outcome = deleteComposerDraftRow(
      { chatId: CHAT_ID, draftId, ownerHostId: OTHER_HOST_ID, foreign: true },
      client as never,
    );

    expect(outcome).toEqual({ deleted: true, undo: null });
    await vi.waitFor(() => {
      expect(log.retracts).toEqual([draftId]);
    });
    expect(log.deletes).toEqual([]);
  });

  it("Undo restores the buffer and bumps resetEpoch so every mounted sibling sees it", async () => {
    const log = emptyLog();
    const draftId = await publishChatDraft(log);
    releaseDraftMirrorSession(HOST_ID);
    const epochBefore =
      useComposerDraftStore.getState().drafts[CHAT_ID]?.resetEpoch ?? 0;

    const outcome = deleteComposerDraftRow(
      { chatId: CHAT_ID, draftId, ownerHostId: HOST_ID, foreign: false },
      fakeClient(log) as never,
    );
    if (!outcome.deleted || outcome.undo === null) {
      throw new Error("expected an undoable delete");
    }
    expect(outcome.undo()).toBe(true);

    const after = useComposerDraftStore.getState().drafts[CHAT_ID];
    expect(after?.content).toEqual(typed("unsent"));
    // `clearDraft` bumps it once, the restore again - what matters is that the
    // restore is observable to a sibling composer that never re-rendered.
    expect(after?.resetEpoch ?? 0).toBeGreaterThan(epochBefore + 1);
    // A fresh identity: the old id is on its way out as a tombstone.
    expect(after?.draftId).not.toBe(draftId);
  });

  it("Undo of an unmounted chat publishes the replacement row on the owner host, so it lists again", async () => {
    const log = emptyLog();
    const draftId = await publishChatDraft(log);
    releaseDraftMirrorSession(HOST_ID);

    const outcome = deleteComposerDraftRow(
      { chatId: CHAT_ID, draftId, ownerHostId: HOST_ID, foreign: false },
      fakeClient(log) as never,
    );
    if (!outcome.deleted || outcome.undo === null) {
      throw new Error("expected an undoable delete");
    }
    await vi.waitFor(() => {
      expect(log.deletes).toEqual([draftId]);
    });

    expect(outcome.undo()).toBe(true);

    // The fence left the row with no owner and no route (the composer is
    // unmounted, so `composerHostByChatId` has nothing for it). Without the
    // explicit upsert the restored row would sit local forever.
    await vi.waitFor(() => {
      expect(log.upserts.map((write) => write.kind)).toEqual([
        "chat-composer",
        "chat-composer",
      ]);
    });
    const restoredId =
      useComposerDraftStore.getState().drafts[CHAT_ID]?.draftId;
    expect(log.rows.map((row) => row.draftId)).toEqual([restoredId]);
    await vi.waitFor(() => {
      expect(
        useComposerDraftStore.getState().drafts[CHAT_ID]?.ownerHostId,
      ).toBe(HOST_ID);
    });
    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.origin).toBe(
      "own",
    );

    // And with the owner back, the read model lists it again.
    const rows = listDraftInventory({
      scope: { surface: "landing", activeDraftId: null },
      filter: "all",
      landing: [],
      composer: useComposerDraftStore.getState().drafts,
      newChat: {},
      openChatIds: new Set(),
      liveSessionHostIds: new Set([HOST_ID]),
    });
    expect(rows.map((row) => row.id)).toEqual([restoredId]);
  });
});

describe("deleteNewChatDraftRow reaches the host with the modal unmounted (critique C2)", () => {
  it("sends drafts.delete and the row does not come back on a later session", async () => {
    const log = emptyLog();
    const session = mountSession(log);
    bindNewChatDraftHost(EPIC_ID, HOST_ID);
    useNewConversationModalStore.getState().setContent(EPIC_ID, typed("later"));
    const draftId =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
        ?.draftId ?? null;
    if (draftId === null) throw new Error("expected a draft id");
    await session.flush([draftId]);
    expect(log.rows.map((row) => row.draftId)).toEqual([draftId]);
    // The modal closes. The host's session is still up (another tab in the
    // epic), but the epic's binding is gone - so `clearDraft`'s routed delete
    // resolves no host, and only this action's explicit request reaches it.
    unbindNewChatDraftHost(EPIC_ID, HOST_ID);

    const outcome = deleteNewChatDraftRow(
      { epicId: EPIC_ID, draftId, ownerHostId: HOST_ID },
      fakeClient(log) as never,
    );

    expect(outcome.deleted).toBe(true);
    await vi.waitFor(() => {
      expect(log.deletes).toEqual([draftId]);
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID],
    ).toBeUndefined();

    // The bootstrap replay is the channel a surviving host row would reach
    // `applyNewChatHostDocument` through. There is nothing left to replay.
    releaseDraftMirrorSession(HOST_ID);
    mountSession(log);
    await vi.waitFor(() => {
      expect(log.rows).toEqual([]);
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID],
    ).toBeUndefined();
  });

  it("Undo puts the patch back with its settings, mode and workspace, and republishes it under the owner", async () => {
    const log = emptyLog();
    const store = useNewConversationModalStore.getState();
    store.setContent(EPIC_ID, typed("later"));
    store.setComposerMode(EPIC_ID, "terminal");
    store.addResolvedFolders(
      EPIC_ID,
      { folders: [], folderInfoByPath: {}, primaryPath: null },
      [
        {
          path: "/repo",
          name: "repo",
          repoIdentifier: null,
          hostId: HOST_ID,
        },
      ],
    );
    const before =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    const draftId = before?.draftId ?? null;
    if (before === undefined || draftId === null) {
      throw new Error("expected a patch");
    }

    const outcome = deleteNewChatDraftRow(
      { epicId: EPIC_ID, draftId, ownerHostId: HOST_ID },
      fakeClient(log) as never,
    );
    if (!outcome.deleted || outcome.undo === null) {
      throw new Error("expected an undoable delete");
    }
    expect(outcome.undo()).toBe(true);

    const after =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    expect(after?.content).toEqual(typed("later"));
    expect(after?.composerMode).toBe("terminal");
    expect(after?.workspace).toEqual(before.workspace);

    // No modal is mounted for this epic, so nothing routes the restore: the
    // replacement row is written on the owner host's client here, and the
    // answer is what gives the patch an owner again (without one it lists
    // nowhere).
    await vi.waitFor(() => {
      expect(log.upserts.map((write) => write.kind)).toEqual(["new-chat"]);
    });
    expect(log.upserts[0]?.draftId).toBe(after?.draftId);
    expect(log.upserts[0]?.draftId).not.toBe(draftId);
    await vi.waitFor(() => {
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
          ?.ownerHostId,
      ).toBe(HOST_ID);
    });
  });
});

describe("deleteLandingDraftRow", () => {
  it("Undo re-installs the draft under a fresh id, keeping it put away", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setDraftContent(id, typed("kept"), null);
    useLandingDraftStore.getState().closeDraft(id);
    const draft = useLandingDraftStore
      .getState()
      .drafts.find((entry) => entry.id === id);
    if (draft === undefined) throw new Error("expected a draft");
    expect(draft.closed).toBe(true);

    const outcome = deleteLandingDraftRow(draft, null, null);
    if (!outcome.deleted || outcome.undo === null) {
      throw new Error("expected an undoable delete");
    }
    expect(useLandingDraftStore.getState().drafts).toEqual([]);

    expect(outcome.undo()).toBe(true);

    const restored = useLandingDraftStore.getState().drafts;
    expect(restored).toHaveLength(1);
    // A retirement receipt was written for the old id, so re-creating under it
    // would silently no-op - the fresh id is a constraint, not a preference.
    expect(landingDraftIsRetired(id)).toBe(true);
    expect(restored[0]?.id).not.toBe(id);
    expect(restored[0]?.closed).toBe(true);
    expect(restored[0]?.content).toEqual(typed("kept"));
    // Undo must never hijack the composer the user is typing in.
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
  });

  it("deletes nothing when there is no host to route through and the row is not ours alone", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setDraftContent(id, typed("kept"), null);
    const draft = useLandingDraftStore
      .getState()
      .drafts.find((entry) => entry.id === id);
    if (draft === undefined) throw new Error("expected a draft");

    const outcome = deleteLandingDraftRow(
      { ...draft, ownerHostId: OTHER_HOST_ID, origin: "replica" },
      null,
      null,
    );

    expect(outcome).toEqual({ deleted: false });
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
  });

  it("drops a foreign row's local mirror at once (D17a), no retract awaited", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setDraftContent(id, typed("kept"), null);
    useLandingDraftStore.setState((state) => ({
      drafts: state.drafts.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              origin: "replica" as const,
              ownerHostId: OTHER_HOST_ID,
            }
          : entry,
      ),
    }));
    const draft = useLandingDraftStore
      .getState()
      .drafts.find((entry) => entry.id === id);
    if (draft === undefined) throw new Error("expected a draft");

    const outcome = deleteLandingDraftRow(draft, HOST_ID, null);

    expect(outcome).toEqual({ deleted: true, undo: null });
    // No `await`: the local mirror and its tab are gone in this same tick,
    // not once a cloud retract answers.
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(landingDraftIsRetired(id)).toBe(true);
  });
});

/**
 * The real navigation seam - controller, coordinator and canvas store - with
 * only the router's navigate promise faked, because the bug being pinned here
 * is precisely that `openTile` alone creates the tile and never navigates when
 * the router is somewhere else.
 */
describe("openChatDraftRow navigates to the chat's epic, not just its canvas", () => {
  function makeNavigate() {
    const calls: NavigateOptions[] = [];
    const navigate = ((options: NavigateOptions) => {
      calls.push(options);
      return Promise.resolve();
    }) as UseNavigateResult<string>;
    return { calls, navigate };
  }

  function chatRow() {
    return {
      chatId: CHAT_ID,
      epicId: EPIC_ID,
      epicTitle: "Parser work",
      chatTitle: "Refactor the parser",
      ownerHostId: HOST_ID,
    };
  }

  function openedTile(tabId: string) {
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    const entries = Object.entries(canvas?.tilesByInstanceId ?? {});
    return entries.find(([, tile]) => tile?.id === CHAT_ID) ?? null;
  }

  beforeEach(async () => {
    useTabsStore.setState({
      version: 2,
      items: [],
      activeItemId: null,
      stripOrder: [],
      systemTabs: { history: null, settings: null },
    });
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    __resetTabSyncCoordinatorForTesting();
    __resetTabNavigationControllerForTesting();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
  });

  it("from the landing page: creates the epic tab, opens the tile there, and routes to it", () => {
    const nav = makeNavigate();

    expect(openChatDraftRow(nav.navigate, chatRow())).toBe(true);

    const tabId = useEpicCanvasStore.getState().resolveTabIdForEpic(EPIC_ID);
    expect(tabId).not.toBeNull();
    if (tabId === null) throw new Error("expected an epic tab");
    const tile = openedTile(tabId);
    expect(tile).not.toBeNull();
    if (tile === null) throw new Error("expected the chat tile");
    expect(tile[1]).toMatchObject({
      id: CHAT_ID,
      type: "chat",
      name: "Refactor the parser",
      hostId: HOST_ID,
    });
    // The half that `openTile` alone never did: one route write, carrying the
    // tab AND the tile it just opened.
    expect(nav.calls).toHaveLength(1);
    expect(nav.calls[0]?.params).toEqual({ epicId: EPIC_ID, tabId });
    const search = nav.calls[0]?.search;
    expect(isRecord(search) ? search.focusTileInstanceId : null).toBe(tile[0]);
  });

  it("from another epic: routes to the row's epic tab rather than leaving the user where they are", () => {
    const otherTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-elsewhere", "Elsewhere");
    const nav = makeNavigate();

    expect(openChatDraftRow(nav.navigate, chatRow())).toBe(true);

    const tabId = useEpicCanvasStore.getState().resolveTabIdForEpic(EPIC_ID);
    expect(tabId).not.toBeNull();
    if (tabId === null) throw new Error("expected an epic tab");
    expect(tabId).not.toBe(otherTabId);
    expect(openedTile(tabId)).not.toBeNull();
    expect(nav.calls).toHaveLength(1);
    expect(nav.calls[0]?.params).toEqual({ epicId: EPIC_ID, tabId });
  });

  it("refuses only the unaddressable row - a missing chat is the tile's own story to tell", () => {
    const nav = makeNavigate();

    const opened = openChatDraftRow(nav.navigate, {
      ...chatRow(),
      ownerHostId: null,
    });

    expect(opened).toBe(false);
    expect(nav.calls).toEqual([]);
  });
});

describe("openNewChatDraftRow requires the row's owner host (review finding 3)", () => {
  function makeNavigate() {
    const calls: NavigateOptions[] = [];
    const navigate = ((options: NavigateOptions) => {
      calls.push(options);
      return Promise.resolve();
    }) as UseNavigateResult<string>;
    return { calls, navigate };
  }

  beforeEach(async () => {
    useTabsStore.setState({
      version: 2,
      items: [],
      activeItemId: null,
      stripOrder: [],
      systemTabs: { history: null, settings: null },
    });
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    __resetTabSyncCoordinatorForTesting();
    __resetTabNavigationControllerForTesting();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
  });

  afterEach(() => {
    useNewConversationModalOpenStore.getState().close();
  });

  it("refuses a row with no owner host, opening neither the tab nor the modal", () => {
    const nav = makeNavigate();

    const opened = openNewChatDraftRow(nav.navigate, {
      epicId: EPIC_ID,
      epicTitle: "Parser work",
      ownerHostId: null,
    });

    expect(opened).toBe(false);
    expect(nav.calls).toEqual([]);
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
  });

  it("names the row's owner host on the modal request, not wherever the epic session resolves", () => {
    const nav = makeNavigate();

    const opened = openNewChatDraftRow(nav.navigate, {
      epicId: EPIC_ID,
      epicTitle: "Parser work",
      ownerHostId: OTHER_HOST_ID,
    });

    expect(opened).toBe(true);
    expect(nav.calls).toHaveLength(1);
    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      epicId: EPIC_ID,
      hostId: OTHER_HOST_ID,
    });
  });
});

describe("Undo does not overwrite work typed after the delete (review finding 1)", () => {
  it("chat: a replacement typed before Undo is preserved, not stomped by the deleted snapshot", async () => {
    const log = emptyLog();
    const draftId = await publishChatDraft(log);
    releaseDraftMirrorSession(HOST_ID);

    const outcome = deleteComposerDraftRow(
      { chatId: CHAT_ID, draftId, ownerHostId: HOST_ID, foreign: false },
      fakeClient(log) as never,
    );
    if (!outcome.deleted || outcome.undo === null) {
      throw new Error("expected an undoable delete");
    }

    // The user types into the now-empty buffer before pressing Undo - the
    // ordinary edit path, not an external replacement.
    useComposerDraftStore
      .getState()
      .setSnapshot(CHAT_ID, typed("new work"), null);

    expect(outcome.undo()).toBe(false);

    const after = useComposerDraftStore.getState().drafts[CHAT_ID];
    expect(after?.content).toEqual(typed("new work"));
  });

  it("new-agent: a replacement typed before Undo is preserved, not stomped by the deleted patch", () => {
    const log = emptyLog();
    const store = useNewConversationModalStore.getState();
    store.setContent(EPIC_ID, typed("later"));
    const before =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    const draftId = before?.draftId ?? null;
    if (before === undefined || draftId === null) {
      throw new Error("expected a patch");
    }

    const outcome = deleteNewChatDraftRow(
      { epicId: EPIC_ID, draftId, ownerHostId: HOST_ID },
      fakeClient(log) as never,
    );
    if (!outcome.deleted || outcome.undo === null) {
      throw new Error("expected an undoable delete");
    }

    // The user reopens the modal and types before pressing Undo.
    useNewConversationModalStore
      .getState()
      .setContent(EPIC_ID, typed("replacement"));

    expect(outcome.undo()).toBe(false);

    const after =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    expect(after?.content).toEqual(typed("replacement"));
  });
});

describe("Restoring a deleted draft re-checks the mount guard after the blob-upload await (review finding 2)", () => {
  it("chat: a session that binds mid-upload wins - the direct restore never also publishes", async () => {
    const log = emptyLog();
    const draftId = await publishChatDraft(log);
    releaseDraftMirrorSession(HOST_ID);
    const client = fakeClient(log);
    const requestSpy = vi.spyOn(client, "request");
    let resolveBlobs: () => void = () => undefined;
    draftBlobTransportMocks.putDraftBlobsForWrite.mockClear();
    draftBlobTransportMocks.putDraftBlobsForWrite.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBlobs = () => resolve([]);
        }),
    );

    const outcome = deleteComposerDraftRow(
      { chatId: CHAT_ID, draftId, ownerHostId: HOST_ID, foreign: false },
      client as never,
    );
    if (!outcome.deleted || outcome.undo === null) {
      throw new Error("expected an undoable delete");
    }
    await vi.waitFor(() => {
      expect(log.deletes).toEqual([draftId]);
    });

    expect(outcome.undo()).toBe(true);
    await vi.waitFor(() => {
      expect(draftBlobTransportMocks.putDraftBlobsForWrite).toHaveBeenCalled();
    });
    expect(requestSpy).not.toHaveBeenCalledWith(
      "drafts.upsert",
      expect.anything(),
    );

    // A session for the chat's host binds WHILE the upload is still
    // in-flight - the exact race the guard exists for.
    bindComposerDraftHost(CHAT_ID, HOST_ID);
    resolveBlobs();
    await vi.waitFor(() => {
      expect(draftBlobTransportMocks.putDraftBlobsForWrite).toHaveResolvedTimes(
        1,
      );
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(requestSpy).not.toHaveBeenCalledWith(
      "drafts.upsert",
      expect.anything(),
    );
  });

  it("new-agent: a modal that binds mid-upload wins - the direct restore never also publishes", async () => {
    const log = emptyLog();
    const store = useNewConversationModalStore.getState();
    store.setContent(EPIC_ID, typed("later"));
    const before =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    const draftId = before?.draftId ?? null;
    if (before === undefined || draftId === null) {
      throw new Error("expected a patch");
    }
    const client = fakeClient(log);
    const requestSpy = vi.spyOn(client, "request");
    let resolveBlobs: () => void = () => undefined;
    draftBlobTransportMocks.putDraftBlobsForWrite.mockClear();
    draftBlobTransportMocks.putDraftBlobsForWrite.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBlobs = () => resolve([]);
        }),
    );

    const outcome = deleteNewChatDraftRow(
      { epicId: EPIC_ID, draftId, ownerHostId: HOST_ID },
      client as never,
    );
    if (!outcome.deleted || outcome.undo === null) {
      throw new Error("expected an undoable delete");
    }

    expect(outcome.undo()).toBe(true);
    await vi.waitFor(() => {
      expect(draftBlobTransportMocks.putDraftBlobsForWrite).toHaveBeenCalled();
    });
    expect(requestSpy).not.toHaveBeenCalledWith(
      "drafts.upsert",
      expect.anything(),
    );

    // A modal for the epic binds WHILE the upload is still in-flight.
    bindNewChatDraftHost(EPIC_ID, HOST_ID);
    resolveBlobs();
    await vi.waitFor(() => {
      expect(draftBlobTransportMocks.putDraftBlobsForWrite).toHaveResolvedTimes(
        1,
      );
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(requestSpy).not.toHaveBeenCalledWith(
      "drafts.upsert",
      expect.anything(),
    );
  });
});
