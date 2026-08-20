import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import {
  adoptUnadoptedLandingDraftsForHost,
  bindLandingAdoptionHost,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import {
  adoptLandingDraft,
  applyLandingHostDocument,
  collectLandingDirtyWrites,
  collectUnadoptedLandingDrafts,
  freshLandingMirrorState,
  MAX_LOCAL_ADOPTED_LANDING_MIRRORS,
  useLandingDraftStore,
  emptyLandingDraftWorkspaceSnapshot,
} from "@/stores/home/landing-draft-store";
import { EMPTY_LANDING_DRAFT_CONTENT } from "@/stores/home/landing-draft-content";

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
      },
    };
    applyLandingHostDocument(incoming, EMPTY_LANDING_DRAFT_CONTENT);
    const ids = useLandingDraftStore.getState().drafts.map((d) => d.id);
    expect(ids).toContain(unadopted);
    expect(ids).toContain("from-host");
    expect(ids).not.toContain("adopted-0");
  });

  it("does not LRU-evict an adopted draft that still carries blobHashes (T9 pins bytes)", () => {
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

  it("adopts a landing draft created after bind on the first dirty sync, not on bind", () => {
    bindLandingAdoptionHost("host-a");
    const id = useLandingDraftStore.getState().createDraft(null);
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === id)?.adoption,
    ).toEqual({ state: "unadopted" });
    // A sync for some other draft (empty wanted set) must not adopt this one.
    adoptUnadoptedLandingDraftsForHost("host-a", new Set());
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

    adoptUnadoptedLandingDraftsForHost("host-b", null);
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === id)?.adoption,
    ).toEqual({ state: "unadopted" });

    adoptUnadoptedLandingDraftsForHost("host-a", new Set([id]));
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === id)?.adoption,
    ).toEqual({ state: "adopted", hostId: "host-a" });
    expect(
      collectLandingDirtyWrites("host-a").map((row) => row.draft.id),
    ).toEqual([id]);
  });
});
