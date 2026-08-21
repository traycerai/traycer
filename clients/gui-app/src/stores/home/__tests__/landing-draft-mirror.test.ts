import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  acquireDraftMirrorSession,
  adoptUnadoptedLandingDraftsForHost,
  bindLandingAdoptionHost,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import {
  adoptLandingDraft,
  applyLandingHostDocument,
  collectLandingDirtyWrites,
  collectUnadoptedLandingDrafts,
  landingDraftRememberSynced,
  freshLandingMirrorState,
  MAX_LOCAL_ADOPTED_LANDING_MIRRORS,
  useLandingDraftStore,
  emptyLandingDraftWorkspaceSnapshot,
} from "@/stores/home/landing-draft-store";
import { EMPTY_LANDING_DRAFT_CONTENT } from "@/stores/home/landing-draft-content";
import { tabSourceRefs } from "@/stores/tabs/source-refs";

function fakeStream(): { subscribe: () => IStreamSession } {
  return {
    subscribe: () => ({
      sendClientFrame: () => undefined,
      onServerFrame: () => undefined,
      onStatusChange: () => undefined,
      requestReconnect: () => undefined,
      close: () => undefined,
      getNegotiatedSchemaVersion: () => ({ major: 1, minor: 0 }),
    }),
  };
}

describe("landing draft host-mirror bookkeeping", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetDraftMirrorCoordinatorForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
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
      streamClient: fakeStream() as never,
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
});
