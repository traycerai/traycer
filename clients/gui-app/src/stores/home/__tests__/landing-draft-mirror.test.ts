import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { DraftDocument } from "@traycer/protocol/host";
import type {
  IStreamSession,
  ServerFrameHandler,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import {
  acquireDraftMirrorSession,
  adoptUnadoptedLandingDraftsForHost,
  applyIncomingDraftDocument,
  bindLandingAdoptionHost,
  ingestCloudDraftSummary,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import {
  completeLandingDraftDelete,
  landingDraftIsRetired,
  pendingLandingDraftDeleteHostId,
  pendingLandingDraftDeletesForHost,
  resetLandingDraftRetirementsForTests,
  retireLandingDraft,
} from "@/lib/drafts/landing-draft-retirement";
import { notifyDraftLocalDelete } from "@/lib/drafts/draft-local-edits";
import { scopedPersistKey, STORE_KEYS } from "@/lib/persist";
import {
  adoptLandingDraft,
  applyLandingHostDocument,
  collectLandingDirtyWrites,
  collectUnadoptedLandingDrafts,
  landingDraftIsDirty,
  landingDraftRememberSynced,
  freshLandingMirrorState,
  MAX_LOCAL_ADOPTED_LANDING_MIRRORS,
  useLandingDraftStore,
  emptyLandingDraftWorkspaceSnapshot,
} from "@/stores/home/landing-draft-store";
import {
  recordClosedHeaderTab,
  useTabRecoveryHistory,
} from "@/lib/tab-recovery/history";
import { EMPTY_LANDING_DRAFT_CONTENT } from "@/stores/home/landing-draft-content";
import { tabSourceRefs } from "@/stores/tabs/source-refs";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import {
  flattenLayoutRefs,
  tabRefKey,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";

function controlledStream(): {
  readonly client: never;
  readonly started: { value: boolean };
  readonly emit: (frame: Parameters<ServerFrameHandler>[0]) => void;
} {
  const started = { value: false };
  let onFrame: ServerFrameHandler | null = null;
  const session: IStreamSession = {
    sendClientFrame: () => undefined,
    onServerFrame: (handler: ServerFrameHandler) => {
      onFrame = handler;
    },
    onStatusChange: () => undefined,
    requestReconnect: () => undefined,
    close: () => undefined,
    getNegotiatedSchemaVersion: () => ({ major: 1, minor: 0 }),
  };
  return {
    client: {
      subscribe: () => {
        started.value = true;
        return session;
      },
    } as never,
    started,
    emit: (frame) => {
      onFrame?.(frame, null);
    },
  };
}

describe("landing draft host-mirror bookkeeping", () => {
  beforeEach(() => {
    installFreshIndexedDb();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useTabRecoveryHistory.setState({ entries: [], ready: true });
    resetLandingDraftRetirementsForTests();
    resetDraftMirrorCoordinatorForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useTabRecoveryHistory.setState({ entries: [], ready: true });
    resetLandingDraftRetirementsForTests();
    resetDraftMirrorCoordinatorForTests();
  });

  it("createDraft starts unadopted so typing never requires a host", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    const draft = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === id);
    expect(draft?.adoption).toEqual({ state: "unadopted" });
    expect(collectLandingDirtyWrites("host-a")).toEqual([]);
    useLandingDraftStore
      .getState()
      .setDraftContent(id, EMPTY_LANDING_DRAFT_CONTENT, { from: 1, to: 1 });
    expect(collectUnadoptedLandingDrafts().map((d) => d.id)).toEqual([id]);
  });

  it("adopted drafts upsert to that host; dropLocalMirror does not host-delete", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    adoptLandingDraft(id, "host-a");
    useLandingDraftStore.getState().setDraftContent(
      id,
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "x" }] },
        ],
      },
      { from: 1, to: 2 },
    );
    expect(
      collectLandingDirtyWrites("host-a").map((row) => row.draft.id),
    ).toEqual([id]);
    useLandingDraftStore.getState().dropLocalMirror(id);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  it("LRU drops only local adopted mirrors, never unadopted drafts", () => {
    const unadopted = useLandingDraftStore.getState().createDraft(null);
    for (let index = 0; index < MAX_LOCAL_ADOPTED_LANDING_MIRRORS; index += 1) {
      useLandingDraftStore.setState((state) => ({
        drafts: [
          ...state.drafts,
          {
            id: `adopted-${index}`,
            content: EMPTY_LANDING_DRAFT_CONTENT,
            selection: null,
            lastTouchedAt: index,
            settings: null,
            composerMode: "chat",
            workspace: emptyLandingDraftWorkspaceSnapshot(),
            ...freshLandingMirrorState(),
            adoption: { state: "adopted", hostId: "host-a" },
          },
        ],
      }));
    }
    const incoming: DraftDocument = {
      draftId: "from-host",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 1,
      lastTouchedAt: 99,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-a",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      publication: {
        status: "unpublished",
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };
    applyLandingHostDocument(incoming, EMPTY_LANDING_DRAFT_CONTENT);
    const ids = useLandingDraftStore.getState().drafts.map((d) => d.id);
    expect(ids).toContain(unadopted);
    expect(ids).toContain("from-host");
    expect(ids).not.toContain("adopted-0");
  });

  it("does not LRU-evict an adopted draft whose image hashes are not yet on the host", () => {
    const hash = "ab".repeat(32);
    const imageContent = {
      type: "doc" as const,
      content: [
        {
          type: "imageAttachment",
          attrs: {
            id: "img-1",
            fileName: "shot.png",
            hash,
            mimeType: "image/png",
          },
        },
      ],
    };
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "with-images",
          content: imageContent,
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
        },
      ],
      activeDraftId: null,
    });
    for (let index = 0; index < MAX_LOCAL_ADOPTED_LANDING_MIRRORS; index += 1) {
      useLandingDraftStore.setState((state) => ({
        drafts: [
          ...state.drafts,
          {
            id: `adopted-${index}`,
            content: EMPTY_LANDING_DRAFT_CONTENT,
            selection: null,
            lastTouchedAt: index + 1,
            settings: null,
            composerMode: "chat",
            workspace: emptyLandingDraftWorkspaceSnapshot(),
            ...freshLandingMirrorState(),
            adoption: { state: "adopted", hostId: "host-a" },
          },
        ],
      }));
    }
    const incoming: DraftDocument = {
      draftId: "from-host",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 1,
      lastTouchedAt: 99,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-a",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      publication: {
        status: "unpublished",
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };
    applyLandingHostDocument(incoming, EMPTY_LANDING_DRAFT_CONTENT);
    const ids = useLandingDraftStore.getState().drafts.map((d) => d.id);
    expect(ids).toContain("with-images");
    expect(ids).toContain("from-host");
    expect(ids).not.toContain("adopted-0");
    const pinned = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === "with-images");
    expect(pinned?.content).toEqual(imageContent);
  });

  it("does not LRU-evict an adopted mirror still referenced by recovery", () => {
    const referencedId = "recovery-draft";
    useLandingDraftStore.setState({
      drafts: [
        {
          id: referencedId,
          content: EMPTY_LANDING_DRAFT_CONTENT,
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
        },
      ],
      activeDraftId: null,
    });
    recordClosedHeaderTab({
      kind: "draft",
      draftId: referencedId,
      hostId: "host-a",
      index: 0,
    });
    for (let index = 0; index < MAX_LOCAL_ADOPTED_LANDING_MIRRORS; index += 1) {
      useLandingDraftStore.setState((state) => ({
        drafts: [
          ...state.drafts,
          {
            id: `adopted-${index}`,
            content: EMPTY_LANDING_DRAFT_CONTENT,
            selection: null,
            lastTouchedAt: index + 1,
            settings: null,
            composerMode: "chat",
            workspace: emptyLandingDraftWorkspaceSnapshot(),
            ...freshLandingMirrorState(),
            adoption: { state: "adopted", hostId: "host-a" },
          },
        ],
      }));
    }
    const incoming: DraftDocument = {
      draftId: "from-host",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 1,
      lastTouchedAt: 99,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-a",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      publication: {
        status: "unpublished",
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };

    applyLandingHostDocument(incoming, EMPTY_LANDING_DRAFT_CONTENT);

    const ids = useLandingDraftStore.getState().drafts.map((draft) => draft.id);
    expect(ids).toContain(referencedId);
    expect(ids).toContain("from-host");
    expect(ids).not.toContain("adopted-0");
  });

  it("LRU-evicts an adopted image draft once its hashes are confirmed on the host", () => {
    const hash = "cd".repeat(32);
    const imageContent = {
      type: "doc" as const,
      content: [
        {
          type: "imageAttachment",
          attrs: {
            id: "img-1",
            fileName: "shot.png",
            hash,
            mimeType: "image/png",
          },
        },
      ],
    };
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "with-images",
          content: imageContent,
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
          confirmedHostBlobHashes: [hash],
        },
      ],
      activeDraftId: null,
    });
    for (let index = 0; index < MAX_LOCAL_ADOPTED_LANDING_MIRRORS; index += 1) {
      useLandingDraftStore.setState((state) => ({
        drafts: [
          ...state.drafts,
          {
            id: `adopted-${index}`,
            content: EMPTY_LANDING_DRAFT_CONTENT,
            selection: null,
            lastTouchedAt: index + 1,
            settings: null,
            composerMode: "chat",
            workspace: emptyLandingDraftWorkspaceSnapshot(),
            ...freshLandingMirrorState(),
            adoption: { state: "adopted", hostId: "host-a" },
          },
        ],
      }));
    }
    const incoming: DraftDocument = {
      draftId: "from-host",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 1,
      lastTouchedAt: 99,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-a",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      publication: {
        status: "unpublished",
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };
    applyLandingHostDocument(incoming, EMPTY_LANDING_DRAFT_CONTENT);
    const ids = useLandingDraftStore.getState().drafts.map((d) => d.id);
    expect(ids).toContain("from-host");
    expect(ids).not.toContain("with-images");
  });

  it("does not count replica mirrors toward the cap, even when applying one more replica document", () => {
    for (
      let index = 0;
      index <= MAX_LOCAL_ADOPTED_LANDING_MIRRORS;
      index += 1
    ) {
      useLandingDraftStore.setState((state) => ({
        drafts: [
          ...state.drafts,
          {
            id: `replica-${index}`,
            content: EMPTY_LANDING_DRAFT_CONTENT,
            selection: null,
            lastTouchedAt: index,
            settings: null,
            composerMode: "chat",
            workspace: emptyLandingDraftWorkspaceSnapshot(),
            ...freshLandingMirrorState(),
            adoption: { state: "adopted", hostId: "host-b" },
            origin: "replica",
          },
        ],
      }));
    }
    // Seeded MAX_LOCAL_ADOPTED_LANDING_MIRRORS + 1 clean replica rows - already
    // more than the cap, but replicas are never counted toward it.
    const incoming: DraftDocument = {
      draftId: "from-host-replica",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 1,
      lastTouchedAt: 999,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-b",
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      publication: {
        status: "unpublished",
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };
    applyLandingHostDocument(incoming, EMPTY_LANDING_DRAFT_CONTENT);
    const ids = useLandingDraftStore.getState().drafts.map((d) => d.id);
    expect(ids).toHaveLength(MAX_LOCAL_ADOPTED_LANDING_MIRRORS + 2);
    for (
      let index = 0;
      index <= MAX_LOCAL_ADOPTED_LANDING_MIRRORS;
      index += 1
    ) {
      expect(ids).toContain(`replica-${index}`);
    }
    expect(ids).toContain("from-host-replica");
  });

  it("still evicts the oldest own mirror past the cap when an unrelated replica document arrives", () => {
    for (
      let index = 0;
      index <= MAX_LOCAL_ADOPTED_LANDING_MIRRORS;
      index += 1
    ) {
      useLandingDraftStore.setState((state) => ({
        drafts: [
          ...state.drafts,
          {
            id: `own-${index}`,
            content: EMPTY_LANDING_DRAFT_CONTENT,
            selection: null,
            lastTouchedAt: index,
            settings: null,
            composerMode: "chat",
            workspace: emptyLandingDraftWorkspaceSnapshot(),
            ...freshLandingMirrorState(),
            adoption: { state: "adopted", hostId: "host-a" },
            origin: "own",
          },
        ],
      }));
    }
    // Seeded MAX_LOCAL_ADOPTED_LANDING_MIRRORS + 1 clean own rows - already one
    // over the cap on its own. The incoming document here is a REPLICA (a
    // different id, different owning host), so it does not itself add to the
    // counted own set; it only serves to trigger the eviction pass.
    const incoming: DraftDocument = {
      draftId: "from-host-replica-trigger",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 1,
      lastTouchedAt: 999,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-b",
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      publication: {
        status: "unpublished",
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };
    applyLandingHostDocument(incoming, EMPTY_LANDING_DRAFT_CONTENT);
    const ids = useLandingDraftStore.getState().drafts.map((d) => d.id);
    expect(ids).not.toContain("own-0");
    for (
      let index = 1;
      index <= MAX_LOCAL_ADOPTED_LANDING_MIRRORS;
      index += 1
    ) {
      expect(ids).toContain(`own-${index}`);
    }
    expect(ids).toContain("from-host-replica-trigger");
    expect(ids.filter((id) => id.startsWith("own-"))).toHaveLength(
      MAX_LOCAL_ADOPTED_LANDING_MIRRORS,
    );
  });

  it("adopts a landing draft created after bind on the first dirty sync, not on bind", async () => {
    bindLandingAdoptionHost("host-a");
    const id = useLandingDraftStore.getState().createDraft(null);
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === id)?.adoption,
    ).toEqual({ state: "unadopted" });
    // A sync for some other draft (empty wanted set) must not adopt this one.
    await adoptUnadoptedLandingDraftsForHost("host-a", new Set());
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === id)?.adoption,
    ).toEqual({ state: "unadopted" });

    useLandingDraftStore.getState().setDraftContent(
      id,
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        ],
      },
      { from: 1, to: 6 },
    );
    expect(collectUnadoptedLandingDrafts().map((d) => d.id)).toEqual([id]);
    expect(collectLandingDirtyWrites("host-a")).toEqual([]);

    await adoptUnadoptedLandingDraftsForHost("host-b", null);
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === id)?.adoption,
    ).toEqual({ state: "unadopted" });

    await adoptUnadoptedLandingDraftsForHost("host-a", new Set([id]));
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === id)?.adoption,
    ).toEqual({ state: "adopted", hostId: "host-a" });
    expect(
      collectLandingDirtyWrites("host-a").map((row) => row.draft.id),
    ).toEqual([id]);
  });

  it("deleteDraft of an adopted landing draft calls drafts.delete before dropping the row", async () => {
    const deletes: string[] = [];
    acquireDraftMirrorSession({
      hostId: "host-a",
      client: {
        request: (method: string, params: unknown) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: [],
              tombstones: [],
              snapshotSeq: 0,
              scopeId: "scp_TESTDRAFTSSCOPEID000001",
            });
          }
          if (method === "drafts.delete") {
            deletes.push((params as { draftId: string }).draftId);
            return Promise.resolve({ deleted: true });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: undefined,
    });
    await Promise.resolve();

    const id = useLandingDraftStore.getState().createDraft(null);
    adoptLandingDraft(id, "host-a");
    useLandingDraftStore.getState().deleteDraft(id);

    await vi.waitFor(() => {
      expect(deletes).toEqual([id]);
    });
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  it("keeps recovery when deleteDraft has no local mirror to destroy", () => {
    const id = "missing-local-draft";
    recordClosedHeaderTab({
      kind: "draft",
      draftId: id,
      hostId: "host-a",
      index: 0,
    });

    useLandingDraftStore.getState().deleteDraft(id);

    expect(useTabRecoveryHistory.getState().entries).toHaveLength(1);
  });

  it("prunes recovery when an authoritative host tombstone has no local mirror", () => {
    const id = "host-deleted-draft";
    recordClosedHeaderTab({
      kind: "draft",
      draftId: id,
      hostId: "host-a",
      index: 0,
    });

    useLandingDraftStore.getState().applyHostDelete(id);

    expect(useTabRecoveryHistory.getState().entries).toEqual([]);
  });

  it("inbound closed:true hides the draft locally and clears activeDraftId", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setDraftContent(
      id,
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        ],
      },
      { from: 1, to: 6 },
    );
    adoptLandingDraft(id, "host-a");
    landingDraftRememberSynced(id, 1, Number.POSITIVE_INFINITY);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(id);

    const incoming: Extract<DraftDocument, { readonly kind: "landing" }> = {
      draftId: id,
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 2,
      lastTouchedAt: 99,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-a",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      publication: {
        status: "unpublished",
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "hello" }] },
          ],
        },
        selection: { from: 1, to: 6 },
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: true,
      },
    };
    applyLandingHostDocument(incoming, incoming.portable.content);

    const draft = useLandingDraftStore
      .getState()
      .drafts.find((row) => row.id === id);
    expect(draft?.closed).toBe(true);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(
      tabSourceRefs().some((ref) => ref.kind === "draft" && ref.id === id),
    ).toBe(false);
  });

  it("fences a host upsert whose image read finishes after landing deletion", async () => {
    const stream = controlledStream();
    const hostId = "host-late-image";
    const id = "late-image-landing";
    const hash = "ef".repeat(32);
    let releaseReadBlob:
      | ((response: { readonly ok: false; readonly reason: "missing" }) => void)
      | undefined;
    const readBlob = new Promise<{
      readonly ok: false;
      readonly reason: "missing";
    }>((resolve) => {
      releaseReadBlob = resolve;
    });
    let readBlobStarted = false;
    const client = {
      request: (method: string, params: unknown) => {
        if (method === "drafts.list") {
          return Promise.resolve({
            drafts: [],
            tombstones: [],
            snapshotSeq: 0,
            scopeId: null,
          });
        }
        if (method === "drafts.readBlob") {
          readBlobStarted = true;
          void params;
          return readBlob;
        }
        if (method === "drafts.delete")
          return Promise.resolve({ deleted: true });
        return Promise.reject(new Error(`unexpected ${method}`));
      },
    };
    acquireDraftMirrorSession({
      hostId,
      client: client as never,
      streamClient: stream.client,
      timing: undefined,
    });
    await vi.waitFor(() => {
      expect(stream.started.value).toBe(true);
    });

    const initial: DraftDocument = {
      draftId: id,
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 1,
      lastTouchedAt: 1,
      workspace: null,
      supersedes: null,
      ownerHostId: hostId,
      origin: "own",
      adoption: { state: "adopted", hostId },
      publication: {
        status: "unpublished",
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };
    await applyIncomingDraftDocument(initial);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);

    const delayed = applyIncomingDraftDocument({
      ...initial,
      revision: 2,
      portable: {
        ...initial.portable,
        blobHashes: [hash],
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "old host body" }],
            },
          ],
        },
      },
    });
    await vi.waitFor(() => {
      expect(readBlobStarted).toBe(true);
    });
    useLandingDraftStore.getState().deleteDraft(id);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    releaseReadBlob?.({ ok: false, reason: "missing" });
    await delayed;

    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(landingDraftIsRetired(id)).toBe(true);
  });

  it("keeps the host revision frontier for direct host-document application", () => {
    const id = "landing-revision-frontier";
    const base = {
      draftId: id,
      kind: "landing" as const,
      target: { epicId: null, chatId: null, blockId: null },
      revision: 0,
      lastTouchedAt: 1,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-frontier",
      origin: "own" as const,
      adoption: { state: "adopted" as const, hostId: "host-frontier" },
      publication: {
        status: "unpublished" as const,
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat" as const,
        blobHashes: [],
        closed: false,
      },
    } satisfies DraftDocument;
    const row = (
      revision: number,
      text: string,
    ): Extract<DraftDocument, { readonly kind: "landing" }> => ({
      ...base,
      revision,
      portable: {
        ...base.portable,
        content: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        },
      },
    });

    const newest = row(13, "newest");
    const older = row(11, "older");
    const middle = row(12, "middle");
    applyLandingHostDocument(newest, newest.portable.content);
    applyLandingHostDocument(older, older.portable.content);
    applyLandingHostDocument(middle, middle.portable.content);

    const draft = useLandingDraftStore
      .getState()
      .drafts.find((entry) => entry.id === id);
    expect(draft?.hostRevision).toBe(13);
    expect(draft?.content).toEqual(newest.portable.content);
  });

  it("keeps the latest landing row when real subscribe applies finish images out of order", async () => {
    const hostId = "host-stream-frontier";
    const id = "stream-frontier";
    type MissingBlobResponse = {
      readonly ok: false;
      readonly reason: "missing";
    };
    const hashes = new Map<
      string,
      { readonly resolve: (response: MissingBlobResponse) => void }
    >();
    const readBlobStarted = new Set<string>();
    const readBlob = (hash: string): Promise<MissingBlobResponse> => {
      let resolve: (response: MissingBlobResponse) => void = () => undefined;
      const promise = new Promise<MissingBlobResponse>((nextResolve) => {
        resolve = nextResolve;
      });
      hashes.set(hash, { resolve });
      readBlobStarted.add(hash);
      return promise;
    };
    const stream = controlledStream();
    const client = {
      request: (method: string, params: unknown) => {
        if (method === "drafts.list") {
          return Promise.resolve({
            drafts: [],
            tombstones: [],
            snapshotSeq: 0,
            scopeId: null,
          });
        }
        if (method === "drafts.readBlob") {
          return readBlob((params as { readonly sha256: string }).sha256);
        }
        return Promise.reject(new Error(`unexpected ${method}`));
      },
    };
    acquireDraftMirrorSession({
      hostId,
      client: client as never,
      streamClient: stream.client,
      timing: undefined,
    });
    await vi.waitFor(() => {
      expect(stream.started.value).toBe(true);
    });

    const base = {
      draftId: id,
      kind: "landing" as const,
      target: { epicId: null, chatId: null, blockId: null },
      revision: 0,
      lastTouchedAt: 1,
      workspace: null,
      supersedes: null,
      ownerHostId: hostId,
      origin: "own" as const,
      adoption: { state: "adopted" as const, hostId },
      publication: {
        status: "unpublished" as const,
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat" as const,
        blobHashes: [] as string[],
        closed: false,
      },
    } satisfies DraftDocument;
    const row = (
      revision: number,
      hash: string,
      text: string,
    ): Extract<DraftDocument, { readonly kind: "landing" }> => ({
      ...base,
      revision,
      portable: {
        ...base.portable,
        blobHashes: [hash],
        content: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        },
      },
    });
    const hash11 = "aa".repeat(32);
    const hash12 = "bb".repeat(32);
    const hash13 = "cc".repeat(32);
    const row11 = row(11, hash11, "older");
    const row12 = row(12, hash12, "middle");
    const row13 = row(13, hash13, "newest");

    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 11,
      draftId: id,
      revision: row11.revision,
      draft: row11,
    });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 12,
      draftId: id,
      revision: row12.revision,
      draft: row12,
    });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 13,
      draftId: id,
      revision: row13.revision,
      draft: row13,
    });
    await vi.waitFor(() => {
      expect(readBlobStarted).toEqual(new Set([hash11, hash12, hash13]));
    });

    hashes.get(hash13)?.resolve({
      ok: false,
      reason: "missing",
    });
    hashes.get(hash11)?.resolve({
      ok: false,
      reason: "missing",
    });
    hashes.get(hash12)?.resolve({
      ok: false,
      reason: "missing",
    });
    // Let all three detached frame handlers consume their delayed reads and
    // complete their landing-store attempts before checking the frontier.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await vi.waitFor(() => {
      const draft = useLandingDraftStore
        .getState()
        .drafts.find((entry) => entry.id === id);
      expect(draft?.hostRevision).toBe(13);
      expect(draft?.content).toEqual(row13.portable.content);
    });
  });

  describe("cloud ingest ordering: same-revision heads fenced by the ingest sequence token", () => {
    type MissingBlobResponse = {
      readonly ok: false;
      readonly reason: "missing";
    };

    function mountIngestOrderingHost(hostId: string): {
      readonly pending: Map<
        string,
        { readonly resolve: (response: MissingBlobResponse) => void }
      >;
    } {
      const pending = new Map<
        string,
        { readonly resolve: (response: MissingBlobResponse) => void }
      >();
      const readBlob = (hash: string): Promise<MissingBlobResponse> => {
        let resolve: (response: MissingBlobResponse) => void = () => undefined;
        const promise = new Promise<MissingBlobResponse>((nextResolve) => {
          resolve = nextResolve;
        });
        pending.set(hash, { resolve });
        return promise;
      };
      const client = {
        request: (method: string, params: unknown) => {
          if (method === "drafts.readBlob") {
            return readBlob((params as { readonly sha256: string }).sha256);
          }
          return Promise.reject(new Error(`unexpected ${method}`));
        },
      };
      acquireDraftMirrorSession({
        hostId,
        client: client as never,
        streamClient: fakeDraftStreamClient(),
        timing: undefined,
      });
      return { pending };
    }

    function landingHeadWith(input: {
      readonly hostId: string;
      readonly draftId: string;
      readonly hash: string;
      readonly text: string;
    }): Extract<DraftDocument, { readonly kind: "landing" }> {
      return {
        draftId: input.draftId,
        kind: "landing",
        target: { epicId: null, chatId: null, blockId: null },
        revision: 0,
        lastTouchedAt: 1,
        workspace: null,
        supersedes: null,
        ownerHostId: input.hostId,
        origin: "own",
        adoption: { state: "adopted", hostId: input.hostId },
        publication: {
          status: "unpublished",
          lastPublishedAt: null,
          publishedRevision: null,
          halted: null,
        },
        portable: {
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: input.text }],
              },
            ],
          },
          selection: null,
          runSettings: null,
          composerMode: "chat",
          blobHashes: [input.hash],
          closed: false,
        },
      };
    }

    it("drops an older landing head whose blob read resolves after a newer apply of the same row", async () => {
      const hostId = "host-ingest-ordering-newer-first";
      const id = "ingest-ordering-newer-first";
      const { pending } = mountIngestOrderingHost(hostId);
      const hashOld = "11".repeat(32);
      const hashNew = "22".repeat(32);
      const older = landingHeadWith({
        hostId,
        draftId: id,
        hash: hashOld,
        text: "old",
      });
      const newer = landingHeadWith({
        hostId,
        draftId: id,
        hash: hashNew,
        text: "new",
      });

      const applyOlder = applyIncomingDraftDocument(older);
      const applyNewer = applyIncomingDraftDocument(newer);

      await vi.waitFor(() => {
        expect(pending.has(hashOld)).toBe(true);
        expect(pending.has(hashNew)).toBe(true);
      });

      // The newer apply's blob read resolves and is awaited first; the older
      // apply's resolves after. Both heads carry revision 0 (a cloud head),
      // so revision alone cannot fence the older one out - only the ingest
      // sequence token reserved at apply-start can.
      pending.get(hashNew)?.resolve({ ok: false, reason: "missing" });
      await applyNewer;
      pending.get(hashOld)?.resolve({ ok: false, reason: "missing" });
      await applyOlder;

      const draft = useLandingDraftStore
        .getState()
        .drafts.find((entry) => entry.id === id);
      expect(draft?.content).toEqual(newer.portable.content);
    });

    it("contrast: resolving the blob reads in apply order also lands on the newer content", async () => {
      const hostId = "host-ingest-ordering-natural-order";
      const id = "ingest-ordering-natural-order";
      const { pending } = mountIngestOrderingHost(hostId);
      const hashOld = "33".repeat(32);
      const hashNew = "44".repeat(32);
      const older = landingHeadWith({
        hostId,
        draftId: id,
        hash: hashOld,
        text: "old",
      });
      const newer = landingHeadWith({
        hostId,
        draftId: id,
        hash: hashNew,
        text: "new",
      });

      const applyOlder = applyIncomingDraftDocument(older);
      const applyNewer = applyIncomingDraftDocument(newer);

      await vi.waitFor(() => {
        expect(pending.has(hashOld)).toBe(true);
        expect(pending.has(hashNew)).toBe(true);
      });

      pending.get(hashOld)?.resolve({ ok: false, reason: "missing" });
      await applyOlder;
      pending.get(hashNew)?.resolve({ ok: false, reason: "missing" });
      await applyNewer;

      const draft = useLandingDraftStore
        .getState()
        .drafts.find((entry) => entry.id === id);
      expect(draft?.content).toEqual(newer.portable.content);
    });
  });

  it("removes a dirty row on an external retirement event without losing the owner delete retry", () => {
    const hostId = "host-window-owner";
    const id = useLandingDraftStore.getState().createDraft(null);
    const key = scopedPersistKey(
      STORE_KEYS.landingDraftRetirement,
      encodeURIComponent(id),
    );
    adoptLandingDraft(id, hostId);
    useLandingDraftStore.getState().setDraftContent(
      id,
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "dirty" }] },
        ],
      },
      null,
    );
    expect(landingDraftIsRetired(id)).toBe(false);

    const newValue = JSON.stringify({
      hostId,
      pendingDelete: true,
      ownerResolved: false,
    });
    window.localStorage.setItem(key, newValue);
    expect(landingDraftIsDirty(id)).toBe(false);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));

    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(landingDraftIsRetired(id)).toBe(true);
    expect(
      pendingLandingDraftDeletesForHost(hostId).map((entry) => entry.draftId),
    ).toEqual([id]);
  });

  it("consumes an unknown-owner retirement when its first owner document arrives", async () => {
    const hostId = "host-recovered-owner";
    const id = "unknown-owner-retirement";
    const deletes: string[] = [];
    retireLandingDraft(id, null);
    expect(pendingLandingDraftDeletesForHost(hostId)).toEqual([]);

    const stream = controlledStream();
    acquireDraftMirrorSession({
      hostId,
      client: {
        request: (method: string, params: unknown) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: [],
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          if (method === "drafts.delete") {
            deletes.push((params as { readonly draftId: string }).draftId);
            return Promise.resolve({ deleted: true });
          }
          return Promise.reject(new Error(`unexpected ${method}`));
        },
      } as never,
      streamClient: stream.client,
      timing: undefined,
    });
    await vi.waitFor(() => {
      expect(stream.started.value).toBe(true);
    });

    const incoming: DraftDocument = {
      draftId: id,
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 4,
      lastTouchedAt: 1,
      workspace: null,
      supersedes: null,
      ownerHostId: hostId,
      origin: "replica",
      adoption: { state: "adopted", hostId },
      publication: {
        status: "unpublished",
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };
    await applyIncomingDraftDocument(incoming);

    await vi.waitFor(() => {
      expect(deletes).toEqual([id]);
    });
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(landingDraftIsRetired(id)).toBe(true);
    await vi.waitFor(() => {
      expect(pendingLandingDraftDeletesForHost(hostId)).toEqual([]);
    });
  });

  it("keeps a landing retirement receipt after cloud ingest and host-delete ACK", async () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    adoptLandingDraft(id, "host-a");
    useLandingDraftStore.getState().deleteDraft(id);
    expect(landingDraftIsRetired(id)).toBe(true);

    const summary: CloudChatSummary = {
      identity: {
        taskId: "scp_TESTDRAFTSSCOPEID000001",
        chatId: id,
        ownerUserId: "user-1",
      },
      ownerHostId: "host-b",
      createdAt: 1,
      visibility: "private",
      title: null,
      isTitleEditedByUser: false,
      parentChatId: null,
      isArchived: false,
      runSettingsSummary: null,
      metadataUpdatedAt: 1,
      headSha256: "ab".repeat(32),
      publishedAt: 1,
      throughRecordSeq: 1,
      isOwnedByViewer: true,
    };
    const document: DraftDocument = {
      draftId: id,
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 0,
      lastTouchedAt: 2,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-b",
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      publication: {
        status: "current",
        lastPublishedAt: 1,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "cloud body" }],
            },
          ],
        },
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };

    // Ownership never moves: the cloud head names a different host (host-b)
    // than the receipt (host-a), but that does not retarget anything - the
    // receipt still names host-a, and the document (a different id's owner
    // entirely, from this device's perspective) is rejected outright since
    // the id is retired.
    await ingestCloudDraftSummary({
      hostId: "host-a",
      summary,
      document,
    });
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(
      pendingLandingDraftDeletesForHost("host-a").map((entry) => entry.draftId),
    ).toEqual([id]);
    expect(pendingLandingDraftDeletesForHost("host-b")).toEqual([]);

    completeLandingDraftDelete(id);
    expect(landingDraftIsRetired(id)).toBe(true);
    expect(pendingLandingDraftDeletesForHost("host-a")).toEqual([]);
    await ingestCloudDraftSummary({
      hostId: "host-a",
      summary,
      document,
    });
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  it("retries a row-free landing retirement after host restart and retains its receipt", async () => {
    const hostId = "host-retry-row-free";
    const id = "row-free-retirement";
    const deletes: string[] = [];
    retireLandingDraft(id, hostId);
    expect(
      pendingLandingDraftDeletesForHost(hostId).map((entry) => entry.draftId),
    ).toEqual([id]);

    acquireDraftMirrorSession({
      hostId,
      client: {
        request: (method: string, params: unknown) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: [],
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          if (method === "drafts.delete") {
            deletes.push((params as { readonly draftId: string }).draftId);
            return Promise.resolve({ deleted: true });
          }
          return Promise.reject(new Error(`unexpected ${method}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: undefined,
    });
    await vi.waitFor(() => {
      expect(deletes).toEqual([id]);
    });
    expect(pendingLandingDraftDeletesForHost(hostId)).toEqual([]);
    expect(landingDraftIsRetired(id)).toBe(true);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  describe("re-key: a host re-mint inherits the ancestor's open/active tab", () => {
    it("a subscribe delete of an open, active row followed by an upsert naming it as supersedes ends with the new row open and activated", async () => {
      const activateTabSpy = vi
        .spyOn(tabCommandCoordinator, "activateTab")
        .mockReturnValue(null);
      try {
        const hostId = "host-rekey";
        const oldId = "rekey-old";
        const newId = "rekey-new";
        const stream = controlledStream();
        acquireDraftMirrorSession({
          hostId,
          client: {
            request: (method: string) => {
              if (method === "drafts.list") {
                return Promise.resolve({
                  drafts: [],
                  tombstones: [],
                  snapshotSeq: 0,
                  scopeId: null,
                });
              }
              return Promise.reject(new Error(`unexpected ${method}`));
            },
          } as never,
          streamClient: stream.client,
          timing: undefined,
        });
        await vi.waitFor(() => {
          expect(stream.started.value).toBe(true);
        });

        // A locally-known row for the ancestor id: open and active, as it
        // would be after this device created or ingested it earlier.
        useLandingDraftStore.setState({
          drafts: [
            {
              id: oldId,
              content: EMPTY_LANDING_DRAFT_CONTENT,
              selection: null,
              lastTouchedAt: 0,
              settings: null,
              composerMode: "chat",
              workspace: emptyLandingDraftWorkspaceSnapshot(),
              ...freshLandingMirrorState(),
              adoption: { state: "adopted", hostId },
              origin: "own",
              ownerHostId: hostId,
            },
          ],
          activeDraftId: oldId,
        });

        stream.emit({
          kind: "delete",
          hasBinaryPayload: false,
          storeSeq: 1,
          draftId: oldId,
          revision: 1,
        });

        await vi.waitFor(() => {
          expect(
            useLandingDraftStore.getState().drafts.some((d) => d.id === oldId),
          ).toBe(false);
        });

        const newDocument: Extract<
          DraftDocument,
          { readonly kind: "landing" }
        > = {
          draftId: newId,
          kind: "landing",
          target: { epicId: null, chatId: null, blockId: null },
          revision: 1,
          lastTouchedAt: 2,
          workspace: null,
          supersedes: oldId,
          ownerHostId: hostId,
          origin: "own",
          adoption: { state: "adopted", hostId },
          publication: {
            status: "unpublished",
            lastPublishedAt: null,
            publishedRevision: null,
            halted: null,
          },
          portable: {
            content: EMPTY_LANDING_DRAFT_CONTENT,
            selection: null,
            runSettings: null,
            composerMode: "chat",
            blobHashes: [],
            closed: false,
          },
        };
        stream.emit({
          kind: "upsert",
          hasBinaryPayload: false,
          storeSeq: 2,
          draftId: newId,
          revision: newDocument.revision,
          draft: newDocument,
        });

        await vi.waitFor(() => {
          const draft = useLandingDraftStore
            .getState()
            .drafts.find((d) => d.id === newId);
          expect(draft?.closed).toBe(false);
        });
        expect(activateTabSpy).toHaveBeenCalledWith({
          kind: "draft",
          draftId: newId,
          settings: null,
          create: false,
        });
      } finally {
        activateTabSpy.mockRestore();
      }
    });

    it("an upsert naming a closed or unknown ancestor id applies as a plain insert and does not activate", async () => {
      const activateTabSpy = vi
        .spyOn(tabCommandCoordinator, "activateTab")
        .mockReturnValue(null);
      try {
        const hostId = "host-rekey-plain";
        const newId = "rekey-plain-new";
        const stream = controlledStream();
        acquireDraftMirrorSession({
          hostId,
          client: {
            request: (method: string) => {
              if (method === "drafts.list") {
                return Promise.resolve({
                  drafts: [],
                  tombstones: [],
                  snapshotSeq: 0,
                  scopeId: null,
                });
              }
              return Promise.reject(new Error(`unexpected ${method}`));
            },
          } as never,
          streamClient: stream.client,
          timing: undefined,
        });
        await vi.waitFor(() => {
          expect(stream.started.value).toBe(true);
        });

        const document: Extract<DraftDocument, { readonly kind: "landing" }> = {
          draftId: newId,
          kind: "landing",
          target: { epicId: null, chatId: null, blockId: null },
          revision: 1,
          lastTouchedAt: 1,
          workspace: null,
          supersedes: "never-seen-ancestor",
          ownerHostId: hostId,
          origin: "own",
          adoption: { state: "adopted", hostId },
          publication: {
            status: "unpublished",
            lastPublishedAt: null,
            publishedRevision: null,
            halted: null,
          },
          portable: {
            content: EMPTY_LANDING_DRAFT_CONTENT,
            selection: null,
            runSettings: null,
            composerMode: "chat",
            blobHashes: [],
            closed: false,
          },
        };
        stream.emit({
          kind: "upsert",
          hasBinaryPayload: false,
          storeSeq: 1,
          draftId: newId,
          revision: document.revision,
          draft: document,
        });

        await vi.waitFor(() => {
          expect(
            useLandingDraftStore.getState().drafts.some((d) => d.id === newId),
          ).toBe(true);
        });
        expect(activateTabSpy).not.toHaveBeenCalled();
      } finally {
        activateTabSpy.mockRestore();
      }
    });
  });

  describe("re-key (fixup D): an upsert naming supersedes before the ancestor's delete frame", () => {
    function layoutOf(): PersistedTabStripLayout {
      const state = useTabsStore.getState();
      return {
        version: 2,
        items: state.items,
        activeItemId: state.activeItemId,
        systemTabs: state.systemTabs,
      };
    }

    beforeEach(async () => {
      useTabsStore.setState({
        version: 2,
        items: [],
        activeItemId: null,
        systemTabs: { history: null, settings: null },
        activationHistory: [],
        stripOrder: [],
      });
      __resetTabSyncCoordinatorForTesting();
      installTabSyncCoordinator({ readyPromise: Promise.resolve() });
      await Promise.resolve();
      await Promise.resolve();
    });

    afterEach(() => {
      useTabsStore.setState({
        version: 2,
        items: [],
        activeItemId: null,
        systemTabs: { history: null, settings: null },
        activationHistory: [],
        stripOrder: [],
      });
      __resetTabSyncCoordinatorForTesting();
    });

    it("re-keys the strip item onto the successor at the same position, keeps it open and active, retires the ancestor, and the trailing delete is a no-op", async () => {
      const hostId = "host-rekey-inplace";
      const oldId = "rekey-inplace-old";
      const newId = "rekey-inplace-new";
      const siblingId = "rekey-inplace-sibling";

      // Two open draft tabs side by side, so the re-keyed item's position is
      // observable: the sibling first, then the ancestor - and the ancestor
      // is the one left active.
      tabCommandCoordinator.activateTab({
        kind: "draft",
        draftId: siblingId,
        settings: null,
        create: true,
      });
      tabCommandCoordinator.activateTab({
        kind: "draft",
        draftId: oldId,
        settings: null,
        create: true,
      });

      const siblingRef: TabRef = { kind: "draft", id: siblingId };
      const oldRef: TabRef = { kind: "draft", id: oldId };
      expect(flattenLayoutRefs(layoutOf()).map(tabRefKey)).toEqual(
        [siblingRef, oldRef].map(tabRefKey),
      );
      expect(useLandingDraftStore.getState().activeDraftId).toBe(oldId);

      const stream = controlledStream();
      acquireDraftMirrorSession({
        hostId,
        client: {
          request: (method: string) => {
            if (method === "drafts.list") {
              return Promise.resolve({
                drafts: [],
                tombstones: [],
                snapshotSeq: 0,
                scopeId: null,
              });
            }
            return Promise.reject(new Error(`unexpected ${method}`));
          },
        } as never,
        streamClient: stream.client,
        timing: undefined,
      });
      await vi.waitFor(() => {
        expect(stream.started.value).toBe(true);
      });

      const newDocument: Extract<DraftDocument, { readonly kind: "landing" }> =
        {
          draftId: newId,
          kind: "landing",
          target: { epicId: null, chatId: null, blockId: null },
          revision: 1,
          lastTouchedAt: 2,
          workspace: null,
          supersedes: oldId,
          ownerHostId: hostId,
          origin: "own",
          adoption: { state: "adopted", hostId },
          publication: {
            status: "unpublished",
            lastPublishedAt: null,
            publishedRevision: null,
            halted: null,
          },
          portable: {
            content: EMPTY_LANDING_DRAFT_CONTENT,
            selection: null,
            runSettings: null,
            composerMode: "chat",
            blobHashes: [],
            closed: false,
          },
        };
      // The new order: the upsert naming `supersedes` arrives BEFORE the
      // ancestor's delete frame, so the ancestor is still open here and the
      // in-place re-key path runs instead of the old inherit-on-delete path.
      stream.emit({
        kind: "upsert",
        hasBinaryPayload: false,
        storeSeq: 1,
        draftId: newId,
        revision: newDocument.revision,
        draft: newDocument,
      });

      await vi.waitFor(() => {
        expect(
          useLandingDraftStore.getState().drafts.some((d) => d.id === newId),
        ).toBe(true);
      });

      const newRef: TabRef = { kind: "draft", id: newId };
      expect(flattenLayoutRefs(layoutOf()).map(tabRefKey)).toEqual(
        [siblingRef, newRef].map(tabRefKey),
      );
      expect(
        useLandingDraftStore.getState().drafts.some((d) => d.id === oldId),
      ).toBe(false);
      expect(landingDraftIsRetired(oldId)).toBe(true);
      const newDraftRow = useLandingDraftStore
        .getState()
        .drafts.find((d) => d.id === newId);
      expect(newDraftRow?.closed).toBe(false);
      expect(useLandingDraftStore.getState().activeDraftId).toBe(newId);

      // The trailing delete frame for the now-retired ancestor changes
      // nothing: no throw, and the layout stays exactly as re-keyed.
      stream.emit({
        kind: "delete",
        hasBinaryPayload: false,
        storeSeq: 2,
        draftId: oldId,
        revision: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(flattenLayoutRefs(layoutOf()).map(tabRefKey)).toEqual(
        [siblingRef, newRef].map(tabRefKey),
      );
      expect(
        useLandingDraftStore.getState().drafts.some((d) => d.id === newId),
      ).toBe(true);
    });
  });

  describe("routeLocalDelete: retract receipt lifecycle on a foreign row", () => {
    const PLACEMENT = "host-placement-retract";

    it("deleting a foreign row records a retract receipt on the placement host and completes it on the host's answer", async () => {
      type RetractResponse = { readonly retracted: boolean };
      const retracts: string[] = [];
      let resolveRetract: (response: RetractResponse) => void = () => undefined;
      const retract = (draftId: string): Promise<RetractResponse> => {
        retracts.push(draftId);
        return new Promise<RetractResponse>((nextResolve) => {
          resolveRetract = nextResolve;
        });
      };
      acquireDraftMirrorSession({
        hostId: PLACEMENT,
        client: {
          request: (method: string, params: unknown) => {
            if (method === "drafts.list") {
              return Promise.resolve({
                drafts: [],
                tombstones: [],
                snapshotSeq: 0,
                scopeId: null,
              });
            }
            if (method === "drafts.retract") {
              return retract((params as { draftId: string }).draftId);
            }
            return Promise.reject(new Error(`unexpected ${String(method)}`));
          },
        } as never,
        streamClient: fakeDraftStreamClient(),
        timing: { debounceMs: 0, maxWaitMs: 0 },
      });
      bindLandingAdoptionHost(PLACEMENT);

      const id = "placement-retract-receipt";
      useLandingDraftStore.setState({
        drafts: [
          {
            id,
            content: EMPTY_LANDING_DRAFT_CONTENT,
            selection: null,
            lastTouchedAt: 0,
            settings: null,
            composerMode: "chat" as const,
            workspace: emptyLandingDraftWorkspaceSnapshot(),
            ...freshLandingMirrorState(),
            adoption: { state: "adopted" as const, hostId: "host-owner" },
            origin: "replica" as const,
            ownerHostId: "host-owner",
          },
        ],
        activeDraftId: null,
      });

      notifyDraftLocalDelete(id);

      await vi.waitFor(() => {
        expect(retracts).toEqual([id]);
      });
      expect(
        pendingLandingDraftDeletesForHost(PLACEMENT).find(
          (entry) => entry.draftId === id,
        ),
      ).toEqual({ draftId: id, retract: true });
      expect(pendingLandingDraftDeleteHostId(id)).toBe(PLACEMENT);
      expect(landingDraftIsRetired(id)).toBe(true);

      resolveRetract({ retracted: true });

      await vi.waitFor(() => {
        expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
      });
      expect(landingDraftIsRetired(id)).toBe(true);
    });
  });
});
