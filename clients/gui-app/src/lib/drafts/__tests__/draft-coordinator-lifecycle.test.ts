import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  acquireDraftMirrorSession,
  applyIncomingDraftDocument,
  bindComposerDraftHost,
  bindInterviewDraftHost,
  bindLandingAdoptionHost,
  cloudDraftIngestSeq,
  collectDraftMirrorDirtyWrites,
  deleteLandingDraftThroughHost,
  ingestCloudDraftSummary,
  releaseDraftMirrorSession,
  resetDraftMirrorCoordinatorForTests,
  submitComposerDraft,
  sweepAbsentCloudDraftMirrors,
  unbindInterviewDraftHost,
} from "@/lib/drafts/draft-mirror-coordinator";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import { notifyDraftLocalDelete } from "@/lib/drafts/draft-local-edits";
import {
  landingDraftIsRetired,
  pendingLandingDraftDeleteHostId,
  resetLandingDraftRetirementsForTests,
} from "@/lib/drafts/landing-draft-retirement";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useInterviewDraftStore } from "@/stores/composer/interview-draft-store";
import {
  adoptLandingDraft,
  emptyLandingDraftWorkspaceSnapshot,
  freshLandingMirrorState,
  landingDraftRememberSynced,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";

const HOST_ID = "host-lifecycle";
const CHAT_ID = "chat-1";
const BLOCK_ID = "block-1";
const EPIC_ID = "epic-1";

function typed(text: string) {
  return {
    type: "doc" as const,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

interface HostLog {
  readonly upserts: DraftWrite[];
  readonly deletes: string[];
  rows: DraftDocument[];
  deleteFailures: number;
}

function mountSession(log: HostLog) {
  return acquireDraftMirrorSession({
    hostId: HOST_ID,
    client: {
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
          log.rows = [document];
          return Promise.resolve({ draft: document });
        }
        if (method === "drafts.delete") {
          const draftId = (params as { draftId: string }).draftId;
          log.deletes.push(draftId);
          if (log.deleteFailures > 0) {
            log.deleteFailures -= 1;
            return Promise.reject(new Error("offline"));
          }
          log.rows = log.rows.filter((row) => row.draftId !== draftId);
          return Promise.resolve({ deleted: true });
        }
        return Promise.reject(new Error(`unexpected ${String(method)}`));
      },
    } as never,
    streamClient: fakeDraftStreamClient(),
    timing: { debounceMs: 0, maxWaitMs: 0 },
  });
}

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  useInterviewDraftStore.setState({ draftsByChat: {} });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  resetLandingDraftRetirementsForTests();
});

describe("interview host binding", () => {
  it("survives one duplicate view unmounting while another is still open", () => {
    useInterviewDraftStore.getState().bindTarget(CHAT_ID, BLOCK_ID, EPIC_ID);
    useInterviewDraftStore.getState().saveDraft(CHAT_ID, BLOCK_ID, {
      pageIndex: 0,
      answers: [
        {
          questionIdentity: "q-1",
          selected: ["Beta"],
          selectedOptionIndices: [1],
          otherText: "",
          otherSelected: false,
        },
      ],
    });

    // Two live views of the same interview: split panes, or the same chat in
    // two windows.
    bindInterviewDraftHost(CHAT_ID, BLOCK_ID, HOST_ID);
    bindInterviewDraftHost(CHAT_ID, BLOCK_ID, HOST_ID);
    unbindInterviewDraftHost(CHAT_ID, BLOCK_ID, HOST_ID);

    // The surviving view still syncs. Without ref counting the first unmount
    // dropped the single entry and this collection came back empty.
    expect(
      collectDraftMirrorDirtyWrites(HOST_ID).map((entry) => entry.write.kind),
    ).toEqual(["interview"]);

    unbindInterviewDraftHost(CHAT_ID, BLOCK_ID, HOST_ID);
    expect(collectDraftMirrorDirtyWrites(HOST_ID)).toEqual([]);
  });
});

describe("submitComposerDraft", () => {
  it("does not tombstone a draft the user re-created during finalization", async () => {
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    mountSession(log);
    bindComposerDraftHost(CHAT_ID, HOST_ID);

    const store = useComposerDraftStore.getState();
    store.bindTarget(CHAT_ID, EPIC_ID);
    store.setSnapshot(CHAT_ID, typed("sent message"), { from: 1, to: 13 });
    const submittedDraftId =
      useComposerDraftStore.getState().drafts[CHAT_ID]?.draftId ?? null;
    expect(submittedDraftId).not.toBeNull();

    const finalize = submitComposerDraft(CHAT_ID);
    // The keystroke that lands while the flush/delete round-trip is still in
    // flight. It must not ride the submitted id.
    useComposerDraftStore
      .getState()
      .setSnapshot(CHAT_ID, typed("next message"), { from: 1, to: 13 });
    const nextDraftId =
      useComposerDraftStore.getState().drafts[CHAT_ID]?.draftId;
    expect(nextDraftId).toBeDefined();
    expect(nextDraftId).not.toBe(submittedDraftId);
    await finalize;

    expect(log.deletes).toEqual([submittedDraftId]);
    // The new content is still owed to the host - the tombstone above did not
    // mark it synced.
    expect(
      collectDraftMirrorDirtyWrites(HOST_ID).map(
        (entry) => entry.write.draftId,
      ),
    ).toEqual([nextDraftId]);
  });

  it("keeps submitted text cleared across an offline delete and bootstrap replay", async () => {
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 1,
    };
    const firstSession = mountSession(log);
    bindComposerDraftHost(CHAT_ID, HOST_ID);
    const store = useComposerDraftStore.getState();
    store.bindTarget(CHAT_ID, EPIC_ID);
    store.setSnapshot(CHAT_ID, typed("accepted steer"), { from: 1, to: 14 });
    const draftId = readDraftId();
    await firstSession.flush([draftId]);

    await submitComposerDraft(CHAT_ID);
    const epochAfterSubmit = readDraft().resetEpoch;
    expect(readDraft().content).not.toEqual(typed("accepted steer"));
    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[draftId],
    ).toEqual({ hostId: HOST_ID, retract: false });

    releaseDraftMirrorSession(HOST_ID);
    mountSession(log);
    await expect.poll(() => log.rows.length).toBe(0);

    expect(readDraft().content).not.toEqual(typed("accepted steer"));
    expect(readDraft().resetEpoch).toBe(epochAfterSubmit);
    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[draftId],
    ).toBeUndefined();
  });

  it("suppresses a late subscribe or cloud replay while deletion is fenced", async () => {
    const store = useComposerDraftStore.getState();
    store.bindTarget(CHAT_ID, EPIC_ID);
    store.setSnapshot(CHAT_ID, typed("submitted"), { from: 1, to: 10 });
    const draftId = readDraftId();
    store.clearDraft(CHAT_ID);
    store.fenceAndDetachSubmittedDraft(CHAT_ID, draftId, HOST_ID);
    const epochAfterSubmit = readDraft().resetEpoch;

    await applyIncomingDraftDocument({
      draftId,
      kind: "chat-composer",
      target: { epicId: EPIC_ID, chatId: CHAT_ID, blockId: null },
      revision: 3,
      lastTouchedAt: 1,
      workspace: null,
      supersedes: null,
      ownerHostId: HOST_ID,
      origin: "own",
      adoption: { state: "adopted", hostId: HOST_ID },
      publication: {
        status: "unpublished",
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: typed("submitted"),
        selection: { from: 1, to: 10 },
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    });

    expect(readDraft().content).not.toEqual(typed("submitted"));
    expect(readDraft().resetEpoch).toBe(epochAfterSubmit);
  });
});

interface ForeignSubmitLog {
  readonly retracts: string[];
  readonly deletes: string[];
  retractFailures: number;
}

function mountTabHostSession(hostId: string, log: ForeignSubmitLog) {
  return acquireDraftMirrorSession({
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
        if (method === "drafts.retract") {
          const draftId = (params as { draftId: string }).draftId;
          if (log.retractFailures > 0) {
            log.retractFailures -= 1;
            return Promise.reject(new Error("offline"));
          }
          log.retracts.push(draftId);
          return Promise.resolve({ retracted: true });
        }
        if (method === "drafts.delete") {
          log.deletes.push((params as { draftId: string }).draftId);
          return Promise.resolve({ deleted: true });
        }
        return Promise.reject(new Error(`unexpected ${String(method)}`));
      },
    } as never,
    streamClient: fakeDraftStreamClient(),
    timing: { debounceMs: 0, maxWaitMs: 0 },
  });
}

async function applyForeignComposerDocument(params: {
  readonly draftId: string;
  readonly ownerHostId: string;
  readonly origin: "own" | "replica";
}): Promise<void> {
  await applyIncomingDraftDocument({
    draftId: params.draftId,
    kind: "chat-composer",
    target: { epicId: EPIC_ID, chatId: CHAT_ID, blockId: null },
    revision: 1,
    lastTouchedAt: 1,
    workspace: null,
    supersedes: null,
    ownerHostId: params.ownerHostId,
    origin: params.origin,
    adoption: { state: "adopted", hostId: params.ownerHostId },
    publication: {
      status: "current",
      lastPublishedAt: 1,
      publishedRevision: 1,
      halted: null,
    },
    portable: {
      content: typed("foreign body"),
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  });
}

describe("submitComposerDraft: a row the tab host does not own (fixup B)", () => {
  const TAB_HOST = "host-tab";

  it("a replica row retracts through the tab host instead of deleting, dropping the id with no pending delete", async () => {
    const log: ForeignSubmitLog = {
      retracts: [],
      deletes: [],
      retractFailures: 0,
    };
    mountTabHostSession(TAB_HOST, log);
    bindComposerDraftHost(CHAT_ID, TAB_HOST);

    const draftId = "foreign-submit-replica";
    await applyForeignComposerDocument({
      draftId,
      ownerHostId: "host-owner",
      origin: "replica",
    });

    await submitComposerDraft(CHAT_ID);

    expect(
      useComposerDraftStore.getState().drafts[CHAT_ID]?.draftId,
    ).toBeNull();
    // The fake answers the retract, so the pending entry - not just the
    // draft binding - is expected to drain once that answer lands.
    await vi.waitFor(() => {
      expect(log.retracts).toEqual([draftId]);
      expect(
        useComposerDraftStore.getState().pendingSubmittedDraftDeletes[draftId],
      ).toBeUndefined();
    });
    expect(log.deletes).toEqual([]);
  });

  it("a failed retract stays pending and is retried by the session", async () => {
    const log: ForeignSubmitLog = {
      retracts: [],
      deletes: [],
      retractFailures: 1,
    };
    mountTabHostSession(TAB_HOST, log);
    bindComposerDraftHost(CHAT_ID, TAB_HOST);

    const draftId = "foreign-submit-retract-retry";
    await applyForeignComposerDocument({
      draftId,
      ownerHostId: "host-owner",
      origin: "replica",
    });

    await submitComposerDraft(CHAT_ID);

    await vi.waitFor(() => {
      expect(
        useComposerDraftStore.getState().pendingSubmittedDraftDeletes[draftId],
      ).toEqual({ hostId: TAB_HOST, retract: true });
    });
    expect(log.retracts).toEqual([]);

    // The bootstrap retry path: releasing and remounting the session runs
    // `retryPendingDeletes`, which retries the still-pending retract - this
    // time the fake answers it.
    releaseDraftMirrorSession(TAB_HOST);
    mountTabHostSession(TAB_HOST, log);

    await vi.waitFor(() => {
      expect(log.retracts).toEqual([draftId]);
      expect(
        useComposerDraftStore.getState().pendingSubmittedDraftDeletes[draftId],
      ).toBeUndefined();
    });
  });

  it("an own row whose owner differs from the tab host also retracts through the tab host instead of deleting", async () => {
    const log: ForeignSubmitLog = {
      retracts: [],
      deletes: [],
      retractFailures: 0,
    };
    mountTabHostSession(TAB_HOST, log);
    bindComposerDraftHost(CHAT_ID, TAB_HOST);

    const draftId = "foreign-submit-own-elsewhere";
    await applyForeignComposerDocument({
      draftId,
      ownerHostId: "host-other",
      origin: "own",
    });

    await submitComposerDraft(CHAT_ID);

    expect(
      useComposerDraftStore.getState().drafts[CHAT_ID]?.draftId,
    ).toBeNull();
    await vi.waitFor(() => {
      expect(log.retracts).toEqual([draftId]);
      expect(
        useComposerDraftStore.getState().pendingSubmittedDraftDeletes[draftId],
      ).toBeUndefined();
    });
    expect(log.deletes).toEqual([]);
  });

  it("contrast: an own row owned by the tab host itself still goes through drafts.delete", async () => {
    const log: ForeignSubmitLog = {
      retracts: [],
      deletes: [],
      retractFailures: 0,
    };
    mountTabHostSession(TAB_HOST, log);
    bindComposerDraftHost(CHAT_ID, TAB_HOST);

    const draftId = "own-submit-on-tab-host";
    await applyForeignComposerDocument({
      draftId,
      ownerHostId: TAB_HOST,
      origin: "own",
    });

    await submitComposerDraft(CHAT_ID);

    expect(log.deletes).toEqual([draftId]);
    expect(log.retracts).toEqual([]);
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: (value: T) => resolveFn(value) };
}

interface DeferredForeignSubmitLog {
  readonly retracts: string[];
  readonly deletes: string[];
  readonly upserts: DraftWrite[];
  readonly deferredRetracts: Map<string, Deferred<{ retracted: boolean }>>;
}

// `mountTabHostSession`'s fake has no way to hold a `drafts.retract` open, and
// every existing caller resolves it immediately - adding that here rather
// than threading a knob through `ForeignSubmitLog` keeps the six passing
// fixup-B/round-3 cases untouched. This also answers `drafts.upsert`, which
// `mountTabHostSession` does not: the one test below that needs this fixture
// edits the row while the retract is parked, and with zero debounce that
// edit's dirty write reaches the session as an upsert.
function mountTabHostSessionWithDeferredRetract(
  hostId: string,
  log: DeferredForeignSubmitLog,
) {
  return acquireDraftMirrorSession({
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
        if (method === "drafts.retract") {
          const draftId = (params as { draftId: string }).draftId;
          log.retracts.push(draftId);
          const deferred = log.deferredRetracts.get(draftId);
          if (deferred !== undefined) return deferred.promise;
          return Promise.resolve({ retracted: true });
        }
        if (method === "drafts.delete") {
          log.deletes.push((params as { draftId: string }).draftId);
          return Promise.resolve({ deleted: true });
        }
        if (method === "drafts.upsert") {
          const write = (params as { draft: DraftWrite }).draft;
          log.upserts.push(write);
          const document: DraftDocument = {
            ...write,
            ownerHostId: hostId,
            origin: "own",
            adoption: { state: "adopted", hostId },
            publication: {
              status: "unpublished",
              lastPublishedAt: null,
              publishedRevision: null,
              halted: null,
            },
            revision: 1,
          };
          return Promise.resolve({ draft: document });
        }
        return Promise.reject(new Error(`unexpected ${String(method)}`));
      },
    } as never,
    streamClient: fakeDraftStreamClient(),
    timing: { debounceMs: 0, maxWaitMs: 0 },
  });
}

describe("submitComposerDraft: an unacknowledged fork (fixup round 3)", () => {
  const TAB_HOST = "host-tab-fork";

  it("retracts the ancestor through the tab host and deletes the fresh id", async () => {
    const log: ForeignSubmitLog = {
      retracts: [],
      deletes: [],
      retractFailures: 0,
    };
    mountTabHostSession(TAB_HOST, log);
    bindComposerDraftHost(CHAT_ID, TAB_HOST);

    await applyForeignComposerDocument({
      draftId: "ancestor-row",
      ownerHostId: "host-owner",
      origin: "replica",
    });

    useComposerDraftStore.getState().detachDraftIdentity(CHAT_ID);
    const freshId =
      useComposerDraftStore.getState().drafts[CHAT_ID]?.draftId ?? null;
    expect(freshId).not.toBeNull();
    expect(freshId).not.toBe("ancestor-row");

    await submitComposerDraft(CHAT_ID);

    expect(log.retracts).toEqual(["ancestor-row"]);
    expect(log.deletes).toEqual([freshId]);
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ID]?.draftId,
    ).toBeNull();
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ID]?.supersedes,
    ).toBeNull();
    if (freshId === null) throw new Error("expected a fresh draftId");
    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[freshId],
    ).toBeUndefined();
    // The fake answered the ancestor's retract too - its receipt drains
    // under its own (ancestor) id, distinct from the fresh id's delete.
    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[
        "ancestor-row"
      ],
    ).toBeUndefined();
  });

  it("a failed ancestor retract stays pending under the ancestor id", async () => {
    const log: ForeignSubmitLog = {
      retracts: [],
      deletes: [],
      retractFailures: 1,
    };
    mountTabHostSession(TAB_HOST, log);
    bindComposerDraftHost(CHAT_ID, TAB_HOST);

    await applyForeignComposerDocument({
      draftId: "ancestor-row-retry",
      ownerHostId: "host-owner",
      origin: "replica",
    });

    useComposerDraftStore.getState().detachDraftIdentity(CHAT_ID);
    const freshId =
      useComposerDraftStore.getState().drafts[CHAT_ID]?.draftId ?? null;
    expect(freshId).not.toBeNull();
    if (freshId === null) throw new Error("expected a fresh draftId");

    await submitComposerDraft(CHAT_ID);

    await vi.waitFor(() => {
      expect(
        useComposerDraftStore.getState().pendingSubmittedDraftDeletes[
          "ancestor-row-retry"
        ],
      ).toEqual({ hostId: TAB_HOST, retract: true });
    });
    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[freshId],
    ).toBeUndefined();
    expect(log.deletes).toEqual([freshId]);
    expect(log.retracts).toEqual([]);
  });

  it("an edit typed during the awaited ancestor retract lands on a fresh id and is not tombstoned", async () => {
    const log: DeferredForeignSubmitLog = {
      retracts: [],
      deletes: [],
      upserts: [],
      deferredRetracts: new Map(),
    };
    const deferredRetract = createDeferred<{ retracted: boolean }>();
    log.deferredRetracts.set("ancestor-row", deferredRetract);
    mountTabHostSessionWithDeferredRetract(TAB_HOST, log);
    bindComposerDraftHost(CHAT_ID, TAB_HOST);

    await applyForeignComposerDocument({
      draftId: "ancestor-row",
      ownerHostId: "host-owner",
      origin: "replica",
    });

    useComposerDraftStore.getState().detachDraftIdentity(CHAT_ID);
    const freshId =
      useComposerDraftStore.getState().drafts[CHAT_ID]?.draftId ?? null;
    expect(freshId).not.toBeNull();
    if (freshId === null) throw new Error("expected a fresh draftId");

    // Not awaited: `submitComposerDraft` reads `before` and fences the row
    // synchronously before it ever suspends on the ancestor retract, so the
    // fence has already run by the time this line returns.
    const submit = submitComposerDraft(CHAT_ID);

    await vi.waitFor(() => {
      expect(log.retracts).toContain("ancestor-row");
    });

    // The fence retires the id before the ancestor retract is awaited - the
    // row already shows no draftId while submit is parked on the deferred
    // retract.
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ID]?.draftId,
    ).toBeNull();

    // The keystroke that lands while the retract round trip is still open.
    useComposerDraftStore
      .getState()
      .setSnapshot(CHAT_ID, typed("after submit"), { from: 1, to: 1 });

    const editedRow = useComposerDraftStore.getState().drafts[CHAT_ID];
    if (editedRow === undefined) throw new Error("expected an edited row");
    const editedId = editedRow.draftId;
    expect(editedId).not.toBeNull();
    expect(editedId).not.toBe(freshId);
    expect(editedRow.supersedes).toBeNull();
    expect(editedRow.generation).toBeGreaterThan(editedRow.syncedGeneration);

    deferredRetract.resolve({ retracted: true });
    await submit;

    expect(log.retracts).toEqual(["ancestor-row"]);
    // The fresh id's delete, not the edited id's - the edit that landed
    // during the awaited retract must not ride the fresh id's tombstone, and
    // must not be tombstoned under its own id either.
    expect(log.deletes).toEqual([freshId]);
    const finalRow = useComposerDraftStore.getState().drafts[CHAT_ID];
    if (finalRow === undefined) {
      throw new Error("expected the edited row to survive");
    }
    expect(finalRow.draftId).toBe(editedId);
    expect(finalRow.content).toEqual(typed("after submit"));
    if (editedId === null) throw new Error("expected an edited id");
    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[editedId],
    ).toBeUndefined();
    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[freshId],
    ).toBeUndefined();
  });
});

describe("deleteLandingDraftThroughHost", () => {
  const HOST_B = "host-b";

  function ownAdoptedLandingRow(id: string, hostId: string) {
    return {
      id,
      content: typed("own body"),
      selection: null,
      lastTouchedAt: 0,
      settings: null,
      composerMode: "chat" as const,
      workspace: emptyLandingDraftWorkspaceSnapshot(),
      ...freshLandingMirrorState(),
      adoption: { state: "adopted" as const, hostId },
      origin: "own" as const,
      ownerHostId: hostId,
      closed: true,
    };
  }

  function mountHostSession(hostId: string, log: HostLog) {
    return acquireDraftMirrorSession({
      hostId,
      client: {
        request: (method: string, params: unknown) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: log.rows,
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          if (method === "drafts.delete") {
            const draftId = (params as { draftId: string }).draftId;
            log.deletes.push(draftId);
            log.rows = log.rows.filter((row) => row.draftId !== draftId);
            return Promise.resolve({ deleted: true });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });
  }

  function fakeDirectClient(
    respond: (draftId: string) => Promise<{ deleted: boolean }>,
  ) {
    return {
      request: (method: string, params: unknown) => {
        if (method === "drafts.delete") {
          return respond((params as { draftId: string }).draftId);
        }
        return Promise.reject(new Error(`unexpected ${String(method)}`));
      },
    } as never;
  }

  it("no session mounted: a resolved drafts.delete({ deleted: true }) removes the row, sends { draftId }, and completes the receipt", async () => {
    const id = "direct-delete-true";
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });
    const requested: string[] = [];
    const client = fakeDirectClient((draftId) => {
      requested.push(draftId);
      return Promise.resolve({ deleted: true });
    });

    deleteLandingDraftThroughHost(id, HOST_B, client);

    expect(
      useLandingDraftStore.getState().drafts.some((draft) => draft.id === id),
    ).toBe(false);

    await vi.waitFor(() => {
      expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
    });
    expect(requested).toEqual([id]);
  });

  it("no session mounted: a resolved drafts.delete({ deleted: false }) also completes the receipt - absent is as final as deleted, so a later document from another host does not route a delete there", async () => {
    const id = "direct-delete-false";
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });
    const client = fakeDirectClient(() => Promise.resolve({ deleted: false }));

    deleteLandingDraftThroughHost(id, HOST_B, client);

    // Ownership never moves, so host-b answering `deleted: false` (the row
    // is not on the host that owns it) is as final as `deleted: true`: the
    // receipt completes rather than going back to owner-unresolved.
    await vi.waitFor(() => {
      expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
    });
    expect(landingDraftIsRetired(id)).toBe(true);

    // A later document from another host is rejected (the id is retired)
    // and does not reopen the completed receipt or install a visible row.
    const document = landingCloudDocument(id, "host-c", "cloud body host-c");
    await applyIncomingDraftDocument(document);

    expect(
      useLandingDraftStore.getState().drafts.some((draft) => draft.id === id),
    ).toBe(false);
    expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
  });

  it("no session mounted: a rejected drafts.delete leaves the receipt pending on host-b", async () => {
    const id = "direct-delete-rejects";
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });
    const client = fakeDirectClient(() => Promise.reject(new Error("offline")));

    deleteLandingDraftThroughHost(id, HOST_B, client);

    // Let the rejected direct request settle before asserting the receipt is
    // still pending - nothing else would flip it here.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pendingLandingDraftDeleteHostId(id)).toBe(HOST_B);
  });

  it("a mounted session for host-b handles the delete itself; the direct client is never called", async () => {
    const id = "session-mounted-delete";
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    mountHostSession(HOST_B, log);
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });
    const client = fakeDirectClient(() => {
      throw new Error(
        "must not call the direct client while a session is mounted",
      );
    });

    deleteLandingDraftThroughHost(id, HOST_B, client);

    await vi.waitFor(() => {
      expect(log.deletes).toEqual([id]);
    });
    await vi.waitFor(() => {
      expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
    });
  });

  it("a mounted session's drafts.delete answering absent also completes the receipt via the store's deleteDraft; a later host-c document does not route a delete there", async () => {
    const id = "route-local-delete-absent";
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    acquireDraftMirrorSession({
      hostId: HOST_B,
      client: {
        request: (method: string, params: unknown) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: log.rows,
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          if (method === "drafts.delete") {
            const draftId = (params as { draftId: string }).draftId;
            log.deletes.push(draftId);
            return Promise.resolve({ deleted: false });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });
    // Let the session's own bootstrap (list + retryPendingDeletes) finish
    // before the draft exists, so it has nothing to observe and cannot
    // race the delete this test drives below.
    await new Promise((resolve) => setTimeout(resolve, 0));

    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });

    useLandingDraftStore.getState().deleteDraft(id);

    await vi.waitFor(() => {
      expect(log.deletes).toEqual([id]);
    });
    await vi.waitFor(() => {
      expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
    });
    expect(landingDraftIsRetired(id)).toBe(true);

    // Completed, not merely unresolved: a later document from another host
    // is rejected (the id is retired) and must not reopen the receipt.
    const document = landingCloudDocument(id, "host-c", "cloud body host-c");
    await applyIncomingDraftDocument(document);

    expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
  });

  it("client is null and no session is mounted: the row is removed locally, the receipt stays pending on host-b, and nothing throws", () => {
    const id = "null-client-no-session";
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });

    expect(() => deleteLandingDraftThroughHost(id, HOST_B, null)).not.toThrow();

    expect(
      useLandingDraftStore.getState().drafts.some((draft) => draft.id === id),
    ).toBe(false);
    expect(pendingLandingDraftDeleteHostId(id)).toBe(HOST_B);
  });

  it("an explicit host on the receipt takes precedence over the placement/foreign rule (fixup C): host-b deletes its own row while host-a, the placement, is never asked to retract", async () => {
    const HOST_A = "host-a-placement";
    const retracts: string[] = [];
    acquireDraftMirrorSession({
      hostId: HOST_A,
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
            retracts.push((params as { draftId: string }).draftId);
            return Promise.resolve({ retracted: true });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });
    bindLandingAdoptionHost(HOST_A);

    const id = "explicit-host-precedence";
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    mountHostSession(HOST_B, log);
    // Own on host-b, but the placement (host-a) is a DIFFERENT host, which
    // would make this row read as foreign from the placement's point of
    // view - if the explicit receipt host below did not take precedence.
    useLandingDraftStore.setState({
      drafts: [ownAdoptedLandingRow(id, HOST_B)],
      activeDraftId: null,
    });

    deleteLandingDraftThroughHost(id, HOST_B, null);

    await vi.waitFor(() => {
      expect(log.deletes).toEqual([id]);
    });
    await vi.waitFor(() => {
      expect(pendingLandingDraftDeleteHostId(id)).toBeNull();
    });
    expect(retracts).toEqual([]);
  });
});

function landingCloudSummary(document: DraftDocument): CloudChatSummary {
  return {
    identity: {
      taskId: "scp_TESTDRAFTSSCOPEID000001",
      chatId: document.draftId,
      ownerUserId: "user-1",
    },
    ownerHostId: document.ownerHostId,
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
}

function landingCloudDocument(
  draftId: string,
  ownerHostId: string,
  text: string,
): DraftDocument {
  return {
    draftId,
    kind: "landing",
    target: { epicId: null, chatId: null, blockId: null },
    revision: 1,
    lastTouchedAt: 2,
    workspace: null,
    supersedes: null,
    ownerHostId,
    origin: "replica",
    adoption: { state: "adopted", hostId: ownerHostId },
    publication: {
      status: "current",
      lastPublishedAt: 1,
      publishedRevision: null,
      halted: null,
    },
    portable: {
      content: typed(text),
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

describe("session/write plane: fork carries supersedes", () => {
  it("a forked landing row's first collected write names its ancestor; the next write after landingDraftRememberSynced carries none", () => {
    const sourceId = useLandingDraftStore.getState().createDraft(null);
    const nextId = "session-write-plane-fork";
    expect(useLandingDraftStore.getState().forkDraft(sourceId, nextId)).toBe(
      true,
    );
    adoptLandingDraft(nextId, HOST_ID);

    const firstWrite = collectDraftMirrorDirtyWrites(HOST_ID).find(
      (entry) => entry.write.draftId === nextId,
    );
    expect(firstWrite?.write.supersedes).toBe(sourceId);

    const generationAfterFork =
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === nextId)?.generation ?? 0;
    landingDraftRememberSynced(nextId, 1, generationAfterFork);
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === nextId)?.supersedes,
    ).toBeNull();

    // A fresh edit after the ACK is dirty again but owes the host nothing
    // about an ancestor - the pointer was one-shot and is already spent.
    useLandingDraftStore
      .getState()
      .setDraftContent(nextId, typed("edited after sync"), null);
    const secondWrite = collectDraftMirrorDirtyWrites(HOST_ID).find(
      (entry) => entry.write.draftId === nextId,
    );
    expect(secondWrite?.write.supersedes).toBeNull();
  });

  it("routeLocalDelete retracts a foreign landing row through the placement host's client instead of calling drafts.delete", async () => {
    const id = "foreign-delete-retract";
    const retracts: string[] = [];
    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    acquireDraftMirrorSession({
      hostId: "host-placement",
      client: {
        request: (method: string, params: unknown) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: log.rows,
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          if (method === "drafts.retract") {
            retracts.push((params as { draftId: string }).draftId);
            return Promise.resolve({ retracted: true });
          }
          if (method === "drafts.delete") {
            log.deletes.push((params as { draftId: string }).draftId);
            return Promise.resolve({ deleted: true });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });
    bindLandingAdoptionHost("host-placement");

    useLandingDraftStore.setState({
      drafts: [
        {
          id,
          content: typed("replica body"),
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
    expect(log.deletes).toEqual([]);
  });
});

describe("sweepAbsentCloudDraftMirrors", () => {
  it("drops a clean replica adopted on host-a that is not listed, at fenceSeq 0", () => {
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "sweep-replica",
          content: typed("cloud body"),
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
          origin: "replica",
          ownerHostId: "host-b",
        },
      ],
      activeDraftId: null,
    });

    sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0);

    const ids = useLandingDraftStore.getState().drafts.map((d) => d.id);
    expect(ids).not.toContain("sweep-replica");
  });

  it("fences a row ingested since the directory's snapshot: retained at the ingest's own seq, dropped once the fence catches up", async () => {
    const id = "sweep-fenced";
    const document = landingCloudDocument(id, "host-b", "cloud body");
    await ingestCloudDraftSummary({
      hostId: "host-a",
      summary: landingCloudSummary(document),
      document,
    });
    const seqAfterIngest = cloudDraftIngestSeq();
    expect(seqAfterIngest).toBeGreaterThan(0);

    sweepAbsentCloudDraftMirrors("host-a", new Map(), seqAfterIngest - 1);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
      id,
    );

    sweepAbsentCloudDraftMirrors("host-a", new Map(), seqAfterIngest);
    expect(
      useLandingDraftStore.getState().drafts.map((d) => d.id),
    ).not.toContain(id);
  });

  it("drops a clean own row adopted on host-a, published, not listed, with no mirror session on host-a", () => {
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "sweep-own-published",
          content: typed("own body"),
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
          origin: "own",
          ownerHostId: "host-a",
          publication: {
            status: "current",
            lastPublishedAt: 1,
            publishedRevision: 1,
            halted: null,
          },
        },
      ],
      activeDraftId: null,
    });

    sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0);

    expect(
      useLandingDraftStore.getState().drafts.map((d) => d.id),
    ).not.toContain("sweep-own-published");
  });

  it("retains a clean own row adopted on host-a whose publication is unpublished", () => {
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "sweep-own-unpublished",
          content: typed("own body"),
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
          origin: "own",
          ownerHostId: "host-a",
          publication: {
            status: "unpublished",
            lastPublishedAt: null,
            publishedRevision: null,
            halted: null,
          },
        },
      ],
      activeDraftId: null,
    });

    sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0);

    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
      "sweep-own-unpublished",
    );
  });

  it("retains a clean, published own row adopted on host-a when a mirror session is mounted for host-a", () => {
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "sweep-own-session-mounted",
          content: typed("own body"),
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
          origin: "own",
          ownerHostId: "host-a",
          publication: {
            status: "current",
            lastPublishedAt: 1,
            publishedRevision: 1,
            halted: null,
          },
        },
      ],
      activeDraftId: null,
    });

    const log: HostLog = {
      upserts: [],
      deletes: [],
      rows: [],
      deleteFailures: 0,
    };
    acquireDraftMirrorSession({
      hostId: "host-a",
      client: {
        request: (method: string) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: log.rows,
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });

    sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0);

    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
      "sweep-own-session-mounted",
    );
  });

  it("cloudDraftIngestSeq starts at 0 after reset and is 1 after one successful ingest", async () => {
    expect(cloudDraftIngestSeq()).toBe(0);

    const document = landingCloudDocument("seq-check", "host-b", "cloud body");
    await ingestCloudDraftSummary({
      hostId: "host-a",
      summary: landingCloudSummary(document),
      document,
    });

    expect(cloudDraftIngestSeq()).toBe(1);
  });

  it("reserves the ingest sequence before the apply resolves, fencing a concurrent sweep against a pre-existing clean replica row", async () => {
    const id = "sweep-fenced-before-await";
    useLandingDraftStore.setState({
      drafts: [
        {
          id,
          content: typed("cloud body"),
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
          adoption: { state: "adopted", hostId: "host-a" },
          origin: "replica",
          ownerHostId: "host-b",
        },
      ],
      activeDraftId: null,
    });

    const document = landingCloudDocument(id, "host-b", "cloud body");
    const ingest = ingestCloudDraftSummary({
      hostId: "host-a",
      summary: landingCloudSummary(document),
      document,
    });

    // The sequence is reserved synchronously, before the apply's await
    // settles — not after, the way it used to be.
    expect(cloudDraftIngestSeq()).toBe(1);

    // A directory sweep whose snapshot predates this ingest (fenceSeq 0)
    // must not drop the pre-existing replica row for this draft id, even
    // though the row is not in its listed set: the just-reserved sequence
    // fences it.
    sweepAbsentCloudDraftMirrors("host-ingesting", new Map(), 0);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
      id,
    );

    await ingest;
  });

  it("fences a host session's own live echo the same as a cloud-head ingest: kept at an older snapshot, dropped once its session is gone and the fence catches up", async () => {
    const id = "sweep-host-session-echo";
    const ownLandingDocument: DraftDocument = {
      draftId: id,
      kind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      revision: 1,
      lastTouchedAt: 2,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-b",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-b" },
      publication: {
        status: "current",
        lastPublishedAt: 1,
        publishedRevision: 1,
        halted: null,
      },
      portable: {
        content: typed("host-b's own body"),
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };

    // Mount host-b's own mirror session: its bootstrap `drafts.list` returns
    // this row as its own, adopted document - the "host session's live echo"
    // path through `applyHostDocument`, not `ingestCloudDraftSummary`.
    acquireDraftMirrorSession({
      hostId: "host-b",
      client: {
        request: (method: string) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: [ownLandingDocument],
              tombstones: [],
              snapshotSeq: 0,
              scopeId: null,
            });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });

    await vi.waitFor(() => {
      expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
        id,
      );
    });

    // The apply reserved the fence synchronously as part of the bootstrap,
    // exactly like an `ingestCloudDraftSummary` apply does.
    expect(cloudDraftIngestSeq()).toBeGreaterThan(0);

    // An older directory snapshot (fence 0) predates this apply's reserved
    // sequence, so it must not drop the row it just installed.
    sweepAbsentCloudDraftMirrors("host-a", new Map(), 0);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toContain(
      id,
    );

    // Contrast: once host-b's session is gone and the sweep's fence has
    // caught up to the reserved sequence, the row is an own row adopted on
    // host-b with no mirror session there and IS published - it is dropped.
    releaseDraftMirrorSession("host-b");
    sweepAbsentCloudDraftMirrors("host-a", new Map(), cloudDraftIngestSeq());
    expect(
      useLandingDraftStore.getState().drafts.map((d) => d.id),
    ).not.toContain(id);
  });
});

function readDraft() {
  const draft = useComposerDraftStore.getState().drafts[CHAT_ID];
  if (draft === undefined) throw new Error("missing composer draft");
  return draft;
}

function readDraftId(): string {
  const draftId = readDraft().draftId;
  if (draftId === null) throw new Error("missing composer draft id");
  return draftId;
}
