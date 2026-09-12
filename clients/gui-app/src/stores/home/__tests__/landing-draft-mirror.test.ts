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
  pendingLandingDraftDeleteIdsForHost,
  resetLandingDraftRetirementsForTests,
  retireLandingDraft,
} from "@/lib/drafts/landing-draft-retirement";
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

function controlledStream(): {
  readonly client: never;
  readonly started: { value: boolean };
} {
  const started = { value: false };
  const session: IStreamSession = {
    sendClientFrame: () => undefined,
    onServerFrame: (_handler: ServerFrameHandler) => undefined,
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

    const incoming: DraftDocument = {
      draftId: id,
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 2,
      lastTouchedAt: 99,
      workspace: null,
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

  it("keeps the host revision frontier when subscribe rows arrive out of order", () => {
    const id = "landing-revision-frontier";
    const base = {
      draftId: id,
      kind: "landing" as const,
      target: { epicId: null, chatId: null, blockId: null },
      revision: 0,
      lastTouchedAt: 1,
      workspace: null,
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
    expect(pendingLandingDraftDeleteIdsForHost(hostId)).toEqual([id]);
  });

  it("consumes an unknown-owner retirement when its first owner document arrives", async () => {
    const hostId = "host-recovered-owner";
    const id = "unknown-owner-retirement";
    const deletes: string[] = [];
    retireLandingDraft(id, null);
    expect(pendingLandingDraftDeleteIdsForHost(hostId)).toEqual([]);

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
      expect(pendingLandingDraftDeleteIdsForHost(hostId)).toEqual([]);
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

    await ingestCloudDraftSummary({
      hostId: "host-a",
      summary,
      document,
    });
    expect(useLandingDraftStore.getState().drafts).toEqual([]);

    completeLandingDraftDelete(id);
    expect(landingDraftIsRetired(id)).toBe(true);
    expect(pendingLandingDraftDeleteIdsForHost("host-a")).toEqual([]);
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
    expect(pendingLandingDraftDeleteIdsForHost(hostId)).toEqual([id]);

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
    expect(pendingLandingDraftDeleteIdsForHost(hostId)).toEqual([]);
    expect(landingDraftIsRetired(id)).toBe(true);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });
});
