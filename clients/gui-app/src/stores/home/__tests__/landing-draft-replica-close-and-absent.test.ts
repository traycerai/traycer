import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import {
  applyLandingHostDocument,
  collectLandingDirtyWrites,
  deleteLandingDraftOnHost,
  dropForeignLandingMirrorsAbsent,
  emptyLandingDraftWorkspaceSnapshot,
  EMPTY_LANDING_DRAFT_CONTENT,
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import {
  landingDraftIsRetired,
  pendingLandingDraftDeleteHostId,
  resetLandingDraftRetirementsForTests,
} from "@/lib/drafts/landing-draft-retirement";
import {
  setDraftLocalDeleteListener,
  setDraftLocalEditListener,
  setDraftLocalFlushListener,
  setLandingPlacementHostReader,
} from "@/lib/drafts/draft-local-edits";

const NON_EMPTY_CONTENT = {
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

function baseDraft(
  id: string,
  overrides: Partial<LandingDraftTab>,
): LandingDraftTab {
  return {
    id,
    content: NON_EMPTY_CONTENT,
    selection: null,
    lastTouchedAt: 0,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    adoption: { state: "unadopted" },
    hostRevision: 0,
    generation: 0,
    syncedGeneration: 0,
    ownerHostId: null,
    origin: null,
    supersedes: null,
    publication: null,
    confirmedHostBlobHashes: [],
    closed: false,
    ...overrides,
  };
}

describe("landing draft store: closeDraft origin behavior", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
    setDraftLocalEditListener(null);
    setDraftLocalFlushListener(null);
  });

  it("closing a replica row sets closed:true without bumping generation or notifying local-edit/flush listeners", () => {
    const notified: string[] = [];
    setDraftLocalEditListener((id) => notified.push(id));

    const draft = baseDraft("replica-1", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 3,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore.getState().closeDraft("replica-1");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "replica-1");
    expect(after).toBeDefined();
    expect(after?.closed).toBe(true);
    expect(after?.generation).toBe(3);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(notified).toEqual([]);
  });

  it("closing an own row bumps generation and notifies local-edit/flush listeners", () => {
    const notified: string[] = [];
    setDraftLocalEditListener((id) => notified.push(id));

    const draft = baseDraft("own-1", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore.getState().closeDraft("own-1");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-1");
    expect(after).toBeDefined();
    expect(after?.closed).toBe(true);
    expect(after?.generation).toBe(4);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(notified).toEqual(["own-1"]);
  });
});

describe("landing draft store: openDraft origin behavior", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
    setDraftLocalEditListener(null);
    setDraftLocalFlushListener(null);
  });

  it("reopening a closed replica is local view state: generation unchanged, no listener call", () => {
    const editNotified: string[] = [];
    const flushNotified: string[] = [];
    setDraftLocalEditListener((id) => editNotified.push(id));
    setDraftLocalFlushListener((id) => flushNotified.push(id));

    const draft = baseDraft("replica-1", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 3,
      closed: true,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: null });

    useLandingDraftStore.getState().openDraft("replica-1");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "replica-1");
    expect(after).toBeDefined();
    expect(after?.closed).toBe(false);
    expect(after?.generation).toBe(3);
    expect(useLandingDraftStore.getState().activeDraftId).toBe("replica-1");
    expect(editNotified).toEqual([]);
    expect(flushNotified).toEqual([]);
  });

  it("reopening a closed own row bumps generation and notifies", () => {
    const editNotified: string[] = [];
    const flushNotified: string[] = [];
    setDraftLocalEditListener((id) => editNotified.push(id));
    setDraftLocalFlushListener((id) => flushNotified.push(id));

    const draft = baseDraft("own-1", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
      closed: true,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: null });

    useLandingDraftStore.getState().openDraft("own-1");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-1");
    expect(after).toBeDefined();
    expect(after?.closed).toBe(false);
    expect(after?.generation).toBe(4);
    expect(useLandingDraftStore.getState().activeDraftId).toBe("own-1");
    expect(editNotified).toEqual(["own-1"]);
    expect(flushNotified).toEqual(["own-1"]);
  });
});

describe("landing draft store: setDraftSelection origin behavior", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
    setDraftLocalEditListener(null);
    setDraftLocalFlushListener(null);
  });

  it("setting selection on a replica row updates selection and lastTouchedAt without bumping generation or notifying local-edit", () => {
    const notified: string[] = [];
    setDraftLocalEditListener((id) => notified.push(id));

    const draft = baseDraft("replica-1", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 3,
      selection: null,
      lastTouchedAt: 0,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore
      .getState()
      .setDraftSelection("replica-1", { from: 1, to: 2 });

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "replica-1");
    expect(after).toBeDefined();
    expect(after?.selection).toEqual({ from: 1, to: 2 });
    expect(after?.generation).toBe(3);
    expect(after?.lastTouchedAt).toBeGreaterThan(0);
    expect(notified).toEqual([]);
  });

  it("setting selection on an own row bumps generation and notifies local-edit", () => {
    const notified: string[] = [];
    setDraftLocalEditListener((id) => notified.push(id));

    const draft = baseDraft("own-1", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
      selection: null,
      lastTouchedAt: 0,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore
      .getState()
      .setDraftSelection("own-1", { from: 1, to: 2 });

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-1");
    expect(after).toBeDefined();
    expect(after?.selection).toEqual({ from: 1, to: 2 });
    expect(after?.generation).toBe(4);
    expect(after?.lastTouchedAt).toBeGreaterThan(0);
    expect(notified).toEqual(["own-1"]);
  });
});

describe("landing draft store: dropForeignLandingMirrorsAbsent", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  it("drops the clean, unlisted foreign replica and keeps a dirty one, a listed one, an own row, and a same-host replica", () => {
    const cleanUnlistedForeign = baseDraft("clean-unlisted-foreign", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 2,
      syncedGeneration: 2,
    });
    const dirtyForeign = baseDraft("dirty-foreign", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 2,
    });
    const listedForeign = baseDraft("listed-foreign", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 2,
      syncedGeneration: 2,
    });
    const ownRow = baseDraft("own-row", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 2,
      syncedGeneration: 2,
    });
    const sameHostReplica = baseDraft("same-host-replica", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 2,
      syncedGeneration: 2,
    });

    useLandingDraftStore.setState({
      drafts: [
        cleanUnlistedForeign,
        dirtyForeign,
        listedForeign,
        ownRow,
        sameHostReplica,
      ],
      activeDraftId: null,
    });

    const result = dropForeignLandingMirrorsAbsent(
      "host-a",
      new Map([["listed-foreign", new Set(["host-b"])]]),
      (draft) => draft.origin === "replica",
    );

    expect(result).toEqual(["clean-unlisted-foreign"]);
    const ids = useLandingDraftStore.getState().drafts.map((d) => d.id);
    expect(ids).not.toContain("clean-unlisted-foreign");
    expect(ids).toContain("dirty-foreign");
    expect(ids).toContain("listed-foreign");
    expect(ids).toContain("own-row");
    expect(ids).toContain("same-host-replica");
  });

  it("keeps a clean, unlisted, foreign row when admit returns false", () => {
    const cleanUnlistedForeign = baseDraft("clean-unlisted-foreign-rejected", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 2,
      syncedGeneration: 2,
    });
    useLandingDraftStore.setState({
      drafts: [cleanUnlistedForeign],
      activeDraftId: null,
    });

    dropForeignLandingMirrorsAbsent("host-a", new Map(), () => false);

    const ids = useLandingDraftStore.getState().drafts.map((d) => d.id);
    expect(ids).toContain("clean-unlisted-foreign-rejected");
  });

  it("drops a clean foreign replica listed only under a different owner than its own, keeps it when listed under its own owner, and keeps an ownerHostId:null row listed under any owner", () => {
    const listedUnderWrongOwner = baseDraft("listed-under-wrong-owner", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-a",
      generation: 2,
      syncedGeneration: 2,
    });
    const listedUnderOwnOwner = baseDraft("listed-under-own-owner", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-a",
      generation: 2,
      syncedGeneration: 2,
    });
    const nullOwnerListed = baseDraft("null-owner-listed", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: null,
      generation: 2,
      syncedGeneration: 2,
    });

    useLandingDraftStore.setState({
      drafts: [listedUnderWrongOwner, listedUnderOwnOwner, nullOwnerListed],
      activeDraftId: null,
    });

    dropForeignLandingMirrorsAbsent(
      "host-a",
      new Map([
        ["listed-under-wrong-owner", new Set(["host-b"])],
        ["listed-under-own-owner", new Set(["host-a"])],
        ["null-owner-listed", new Set(["host-b"])],
      ]),
      (draft) => draft.origin === "replica",
    );

    const ids = useLandingDraftStore.getState().drafts.map((d) => d.id);
    // Same id listed, but only under an owner that is not this row's own
    // owner: the row is not admitted as "listed" and is dropped.
    expect(ids).not.toContain("listed-under-wrong-owner");
    // Listed under its own owner: kept.
    expect(ids).toContain("listed-under-own-owner");
    // No recorded owner: matches by id alone regardless of which owner it
    // is listed under.
    expect(ids).toContain("null-owner-listed");
  });

  it("never consults admit for a listed row, a dirty row, or a same-host row - each is retained before admit is reached", () => {
    const listed = baseDraft("listed-admit-not-consulted", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 2,
      syncedGeneration: 2,
    });
    const dirty = baseDraft("dirty-admit-not-consulted", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 2,
    });
    const sameHost = baseDraft("same-host-admit-not-consulted", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 2,
      syncedGeneration: 2,
    });
    useLandingDraftStore.setState({
      drafts: [listed, dirty, sameHost],
      activeDraftId: null,
    });

    const admitCalls: string[] = [];
    dropForeignLandingMirrorsAbsent(
      "host-a",
      new Map([["listed-admit-not-consulted", new Set(["host-b"])]]),
      (draft) => {
        admitCalls.push(draft.id);
        return true;
      },
    );

    expect(admitCalls).toEqual([]);
    const ids = useLandingDraftStore.getState().drafts.map((d) => d.id);
    expect(ids).toContain("listed-admit-not-consulted");
    expect(ids).toContain("dirty-admit-not-consulted");
    expect(ids).toContain("same-host-admit-not-consulted");
  });
});

describe("landing draft store: applyLandingHostDocument closed on the clean path", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
    setLandingPlacementHostReader(null);
  });

  it("keeps a clean replica row's closed:true on an incoming replica document, then keeps closed:true when a later own document lands on the (still-replica-origin) row", () => {
    const seeded = baseDraft("draft-1", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      hostRevision: 3,
      generation: 2,
      syncedGeneration: 2,
      closed: true,
    });
    useLandingDraftStore.setState({ drafts: [seeded], activeDraftId: null });

    const incomingReplica: DraftDocument = {
      draftId: "draft-1",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 5,
      lastTouchedAt: 99,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-b",
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      publication: {
        status: "current",
        lastPublishedAt: 100,
        publishedRevision: 5,
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

    applyLandingHostDocument(incomingReplica, EMPTY_LANDING_DRAFT_CONTENT);

    const afterReplica = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "draft-1");
    expect(afterReplica).toBeDefined();
    // Clean replica row: `closed` is kept from the existing row, not taken
    // from the incoming document's portable value.
    expect(afterReplica?.closed).toBe(true);

    const incomingOwn: DraftDocument = {
      draftId: "draft-1",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 6,
      lastTouchedAt: 100,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-a",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      publication: {
        status: "current",
        lastPublishedAt: 100,
        publishedRevision: 5,
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

    applyLandingHostDocument(incomingOwn, EMPTY_LANDING_DRAFT_CONTENT);

    const afterOwn = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "draft-1");
    expect(afterOwn).toBeDefined();
    // The EXISTING row (before this apply) still had origin "replica", so
    // `incomingClosedState` keeps its local `closed` even though the
    // incoming own document's portable value is false, and even though the
    // row's `origin` itself does follow the incoming document to "own".
    expect(afterOwn?.closed).toBe(true);
    expect(afterOwn?.origin).toBe("own");
  });

  it("keeps a reopened replica row's closed:false when a later own document (claim landing) lands with portable.closed:true", () => {
    const seeded = baseDraft("draft-2", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      hostRevision: 3,
      generation: 2,
      syncedGeneration: 2,
      closed: false,
    });
    useLandingDraftStore.setState({ drafts: [seeded], activeDraftId: null });

    const incomingOwn: DraftDocument = {
      draftId: "draft-2",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 6,
      lastTouchedAt: 100,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-a",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      publication: {
        status: "current",
        lastPublishedAt: 100,
        publishedRevision: 5,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: true,
      },
    };

    applyLandingHostDocument(incomingOwn, EMPTY_LANDING_DRAFT_CONTENT);

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "draft-2");
    expect(after).toBeDefined();
    // The existing row was origin "replica", so `closed` stays local (false)
    // even though the incoming own document's portable value is true; the
    // row's `origin` itself follows the incoming document to "own".
    expect(after?.closed).toBe(false);
    expect(after?.origin).toBe("own");
  });

  it("keeps an own row's closed:false when the landing placement has auto-followed away from its adoption host, then flips to the portable value once the placement matches it again", () => {
    setLandingPlacementHostReader(() => "host-b");
    const seeded = baseDraft("draft-3", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      hostRevision: 3,
      generation: 2,
      syncedGeneration: 2,
      closed: false,
    });
    useLandingDraftStore.setState({ drafts: [seeded], activeDraftId: null });

    const incomingOwnClosed: DraftDocument = {
      draftId: "draft-3",
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 4,
      lastTouchedAt: 100,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-a",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      publication: {
        status: "current",
        lastPublishedAt: 100,
        publishedRevision: 4,
        halted: null,
      },
      portable: {
        content: EMPTY_LANDING_DRAFT_CONTENT,
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: true,
      },
    };

    applyLandingHostDocument(incomingOwnClosed, EMPTY_LANDING_DRAFT_CONTENT);

    const afterForeign = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "draft-3");
    expect(afterForeign).toBeDefined();
    // The row is adopted on host-a but the placement has auto-followed to
    // host-b: foreign to the placement, so the incoming own document's
    // portable `closed:true` is not taken.
    expect(afterForeign?.closed).toBe(false);

    setLandingPlacementHostReader(() => "host-a");
    const incomingOwnClosedAgain: DraftDocument = {
      ...incomingOwnClosed,
      revision: 5,
    };

    applyLandingHostDocument(
      incomingOwnClosedAgain,
      EMPTY_LANDING_DRAFT_CONTENT,
    );

    const afterPlacementMatches = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "draft-3");
    expect(afterPlacementMatches).toBeDefined();
    // Contrast: with the placement back on host-a, the row is no longer
    // foreign, so the portable value is taken.
    expect(afterPlacementMatches?.closed).toBe(true);
  });
});

describe("landing draft store: collectLandingDirtyWrites excludes replica rows", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  it("excludes a dirty replica adopted on the given host, and includes a dirty own row adopted on it", () => {
    const dirtyReplica = baseDraft("dirty-replica", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 2,
    });
    const dirtyOwn = baseDraft("dirty-own", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 2,
    });

    useLandingDraftStore.setState({
      drafts: [dirtyReplica, dirtyOwn],
      activeDraftId: null,
    });

    const dirty = collectLandingDirtyWrites("host-b");
    const ids = dirty.map(({ draft }) => draft.id);

    expect(ids).not.toContain("dirty-replica");
    expect(ids).toContain("dirty-own");
  });
});

describe("landing draft store: closeDraft on empty content routes host delete only for own rows", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
    setDraftLocalDeleteListener(null);
  });

  it("destroys an empty replica row locally without routing a host delete", () => {
    const deleted: string[] = [];
    setDraftLocalDeleteListener((id) => deleted.push(id));

    const draft = baseDraft("replica-empty", {
      content: EMPTY_LANDING_DRAFT_CONTENT,
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 2,
      syncedGeneration: 2,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore.getState().closeDraft("replica-empty");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "replica-empty");
    expect(after).toBeUndefined();
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(landingDraftIsRetired("replica-empty")).toBe(true);
    expect(deleted).toEqual([]);
  });

  it("destroys an empty own adopted row locally and routes a host delete", () => {
    const deleted: string[] = [];
    setDraftLocalDeleteListener((id) => deleted.push(id));

    const draft = baseDraft("own-empty", {
      content: EMPTY_LANDING_DRAFT_CONTENT,
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 2,
      syncedGeneration: 2,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore.getState().closeDraft("own-empty");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-empty");
    expect(after).toBeUndefined();
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(landingDraftIsRetired("own-empty")).toBe(true);
    expect(deleted).toEqual(["own-empty"]);
  });
});

describe("landing draft store: deleteDraft never routes a replica's host delete through its adoption host", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
    setDraftLocalDeleteListener(null);
  });

  it("destroys a non-empty replica adopted on host-b locally with no pending host-route receipt, but still notifies local-delete for a best-effort retract", () => {
    const deleted: string[] = [];
    setDraftLocalDeleteListener((id) => deleted.push(id));

    const draft = baseDraft("replica-non-empty", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 3,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore.getState().deleteDraft("replica-non-empty");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "replica-non-empty");
    expect(after).toBeUndefined();
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(landingDraftIsRetired("replica-non-empty")).toBe(true);
    // Retired locally with no host-route receipt - ownership never moves,
    // so this row's `drafts.delete` never routes through its adoption host.
    expect(pendingLandingDraftDeleteHostId("replica-non-empty")).toBeNull();
    // The coordinator is still notified for any adopted row: it turns this
    // one into a best-effort `drafts.retract` through the placement host.
    expect(deleted).toEqual(["replica-non-empty"]);
  });

  it("contrast: destroys a non-empty own row adopted on host-a locally and still routes the host delete", () => {
    const deleted: string[] = [];
    setDraftLocalDeleteListener((id) => deleted.push(id));

    const draft = baseDraft("own-non-empty", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore.getState().deleteDraft("own-non-empty");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-non-empty");
    expect(after).toBeUndefined();
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(landingDraftIsRetired("own-non-empty")).toBe(true);
    expect(pendingLandingDraftDeleteHostId("own-non-empty")).toBe("host-a");
    expect(deleted).toEqual(["own-non-empty"]);
  });
});

describe("landing draft store: own row adopted on a host the landing placement has left", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
    setLandingPlacementHostReader(null);
    setDraftLocalDeleteListener(null);
    setDraftLocalEditListener(null);
    setDraftLocalFlushListener(null);
  });

  it("deleteDraft retires an own row adopted on host-a locally when the placement is host-b: no host-route receipt, but still notifies local-delete for a best-effort retract", () => {
    setLandingPlacementHostReader(() => "host-b");
    const deleted: string[] = [];
    setDraftLocalDeleteListener((id) => deleted.push(id));

    const draft = baseDraft("own-left-behind", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore.getState().deleteDraft("own-left-behind");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-left-behind");
    expect(after).toBeUndefined();
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(landingDraftIsRetired("own-left-behind")).toBe(true);
    // Foreign to the placement (adopted on a host it has left), so this row
    // is not deleted through its adoption host.
    expect(pendingLandingDraftDeleteHostId("own-left-behind")).toBeNull();
    // The coordinator is still notified for any adopted row: it turns this
    // one into a best-effort `drafts.retract` through the placement host.
    expect(deleted).toEqual(["own-left-behind"]);
  });

  it("contrast: deleteDraft routes the host delete when the placement is still host-a", () => {
    setLandingPlacementHostReader(() => "host-a");
    const deleted: string[] = [];
    setDraftLocalDeleteListener((id) => deleted.push(id));

    const draft = baseDraft("own-current-placement", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore.getState().deleteDraft("own-current-placement");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-current-placement");
    expect(after).toBeUndefined();
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(landingDraftIsRetired("own-current-placement")).toBe(true);
    expect(pendingLandingDraftDeleteHostId("own-current-placement")).toBe(
      "host-a",
    );
    expect(deleted).toEqual(["own-current-placement"]);
  });

  it("setDraftSelection on an own row adopted on host-a with placement host-b keeps generation unchanged and does not notify local-edit", () => {
    setLandingPlacementHostReader(() => "host-b");
    const notified: string[] = [];
    setDraftLocalEditListener((id) => notified.push(id));

    const draft = baseDraft("own-left-behind-sel", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
      selection: null,
      lastTouchedAt: 0,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore
      .getState()
      .setDraftSelection("own-left-behind-sel", { from: 1, to: 2 });

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-left-behind-sel");
    expect(after).toBeDefined();
    expect(after?.selection).toEqual({ from: 1, to: 2 });
    expect(after?.generation).toBe(3);
    expect(after?.lastTouchedAt).toBeGreaterThan(0);
    expect(notified).toEqual([]);
  });

  it("contrast: setDraftSelection bumps generation and notifies local-edit when the placement is still host-a", () => {
    setLandingPlacementHostReader(() => "host-a");
    const notified: string[] = [];
    setDraftLocalEditListener((id) => notified.push(id));

    const draft = baseDraft("own-current-placement-sel", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
      selection: null,
      lastTouchedAt: 0,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore
      .getState()
      .setDraftSelection("own-current-placement-sel", { from: 1, to: 2 });

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-current-placement-sel");
    expect(after).toBeDefined();
    expect(after?.selection).toEqual({ from: 1, to: 2 });
    expect(after?.generation).toBe(4);
    expect(after?.lastTouchedAt).toBeGreaterThan(0);
    expect(notified).toEqual(["own-current-placement-sel"]);
  });

  it("closeDraft on an own row adopted on host-a with placement host-b keeps generation unchanged and does not notify, and a subsequent openDraft likewise", () => {
    setLandingPlacementHostReader(() => "host-b");
    const editNotified: string[] = [];
    const flushNotified: string[] = [];
    setDraftLocalEditListener((id) => editNotified.push(id));
    setDraftLocalFlushListener((id) => flushNotified.push(id));

    const draft = baseDraft("own-left-behind-close", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore.getState().closeDraft("own-left-behind-close");

    const afterClose = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-left-behind-close");
    expect(afterClose).toBeDefined();
    expect(afterClose?.closed).toBe(true);
    expect(afterClose?.generation).toBe(3);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(editNotified).toEqual([]);
    expect(flushNotified).toEqual([]);

    useLandingDraftStore.getState().openDraft("own-left-behind-close");

    const afterOpen = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-left-behind-close");
    expect(afterOpen).toBeDefined();
    expect(afterOpen?.closed).toBe(false);
    expect(afterOpen?.generation).toBe(3);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(
      "own-left-behind-close",
    );
    expect(editNotified).toEqual([]);
    expect(flushNotified).toEqual([]);
  });

  it("a null placement reader treats an own row adopted on host-a as own: deleteDraft routes the host delete", () => {
    setLandingPlacementHostReader(() => null);
    const deleted: string[] = [];
    setDraftLocalDeleteListener((id) => deleted.push(id));

    const draft = baseDraft("own-null-placement", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore.getState().deleteDraft("own-null-placement");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-null-placement");
    expect(after).toBeUndefined();
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(landingDraftIsRetired("own-null-placement")).toBe(true);
    expect(pendingLandingDraftDeleteHostId("own-null-placement")).toBe(
      "host-a",
    );
    expect(deleted).toEqual(["own-null-placement"]);
  });
});

describe("landing draft store: deleteLandingDraftOnHost", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
    setLandingPlacementHostReader(null);
    setDraftLocalDeleteListener(null);
  });

  it("routes an own row adopted on host-b through host-b even though the placement reader names host-a", () => {
    setLandingPlacementHostReader(() => "host-a");
    const deleted: string[] = [];
    setDraftLocalDeleteListener((id) => deleted.push(id));

    const draft = baseDraft("own-adopted-host-b", {
      origin: "own",
      adoption: { state: "adopted", hostId: "host-b" },
      ownerHostId: "host-b",
      generation: 3,
      syncedGeneration: 3,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    deleteLandingDraftOnHost("own-adopted-host-b", "host-b");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "own-adopted-host-b");
    expect(after).toBeUndefined();
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(landingDraftIsRetired("own-adopted-host-b")).toBe(true);
    expect(pendingLandingDraftDeleteHostId("own-adopted-host-b")).toBe(
      "host-b",
    );
    expect(deleted).toEqual(["own-adopted-host-b"]);
  });

  it("routes a replica row adopted on host-a through host-b, unlike deleteDraft which retires it locally with a null host", () => {
    const deleted: string[] = [];
    setDraftLocalDeleteListener((id) => deleted.push(id));

    const draft = baseDraft("replica-adopted-host-a", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    deleteLandingDraftOnHost("replica-adopted-host-a", "host-b");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "replica-adopted-host-a");
    expect(after).toBeUndefined();
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(landingDraftIsRetired("replica-adopted-host-a")).toBe(true);
    expect(pendingLandingDraftDeleteHostId("replica-adopted-host-a")).toBe(
      "host-b",
    );
    expect(deleted).toEqual(["replica-adopted-host-a"]);
  });

  it("contrast: deleteDraft on the same replica row retires it locally with a null host, but still notifies local-delete for a best-effort retract", () => {
    const deleted: string[] = [];
    setDraftLocalDeleteListener((id) => deleted.push(id));

    const draft = baseDraft("replica-contrast", {
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 3,
      syncedGeneration: 3,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    useLandingDraftStore.getState().deleteDraft("replica-contrast");

    const after = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === "replica-contrast");
    expect(after).toBeUndefined();
    expect(landingDraftIsRetired("replica-contrast")).toBe(true);
    expect(pendingLandingDraftDeleteHostId("replica-contrast")).toBeNull();
    expect(deleted).toEqual(["replica-contrast"]);
  });

  it("is a no-op for a row that already has a local-only retirement receipt but no longer exists (a missing row is never re-armed)", () => {
    const deleted: string[] = [];
    setDraftLocalDeleteListener((id) => deleted.push(id));

    const draft = baseDraft("replica-empty-onhost", {
      content: EMPTY_LANDING_DRAFT_CONTENT,
      origin: "replica",
      adoption: { state: "adopted", hostId: "host-a" },
      ownerHostId: "host-a",
      generation: 2,
      syncedGeneration: 2,
    });
    useLandingDraftStore.setState({ drafts: [draft], activeDraftId: draft.id });

    // Closing the emptied replica from its tab retires it locally with no
    // owner: a receipt exists, but nothing is pending yet, and the row is
    // gone from the store.
    useLandingDraftStore.getState().closeDraft("replica-empty-onhost");
    expect(landingDraftIsRetired("replica-empty-onhost")).toBe(true);
    expect(pendingLandingDraftDeleteHostId("replica-empty-onhost")).toBeNull();
    expect(deleted).toEqual([]);

    // A missing row is a no-op: there is no row left to route a delete
    // through `host-b`, so the existing receipt is left exactly as it was.
    deleteLandingDraftOnHost("replica-empty-onhost", "host-b");

    expect(pendingLandingDraftDeleteHostId("replica-empty-onhost")).toBeNull();
    expect(deleted).toEqual([]);
  });

  it("does nothing when there is no row and no retirement receipt", () => {
    const deleted: string[] = [];
    setDraftLocalDeleteListener((id) => deleted.push(id));

    expect(landingDraftIsRetired("never-seen")).toBe(false);

    deleteLandingDraftOnHost("never-seen", "host-b");

    expect(landingDraftIsRetired("never-seen")).toBe(false);
    expect(pendingLandingDraftDeleteHostId("never-seen")).toBeNull();
    expect(deleted).toEqual([]);
  });
});
