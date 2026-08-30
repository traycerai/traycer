import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { del as idbDel, get as idbGet, set as idbSet } from "idb-keyval";

import { attachBrowserAnnotation } from "@/lib/browser-view/annotation/browser-annotation-attach";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { createStubBrowserAnnotationPayloadFor } from "@/lib/browser-view/annotation/__tests__/browser-annotation-fixtures";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";
import { markLandingDraftsReady } from "@/lib/composer/landing-image-gc";
import {
  hasLandingImageBytes,
  imageHashKeys,
  putImage,
} from "@/lib/composer/landing-image-store";
import {
  drainImages,
  installIdbWorking,
} from "@/lib/browser-view/annotation/__tests__/browser-annotation-idb-fixtures";
import {
  useComposerDraftStore,
  type DraftState,
} from "../composer-draft-store";

const STORAGE_KEY = "traycer-gui-app:composer-drafts";

const idbData = vi.hoisted(() => new Map<string, unknown>());

vi.mock("idb-keyval", async () => {
  // Dynamic import: the factory is hoisted above the static imports, so the
  // fixture binding is not initialized yet when this runs.
  const { createIdbKeyvalMock } =
    await import("@/lib/browser-view/annotation/__tests__/browser-annotation-idb-mock");
  return createIdbKeyvalMock(idbData);
});

const EMPTY_DOC: DraftState["content"] = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

let urlCounter = 0;
const createObjectURL = vi.fn(
  (_obj: Blob | MediaSource) => `blob:mock/${++urlCounter}`,
);
const revokeObjectURL = vi.fn((_url: string) => undefined);

async function attachNamed(
  chatId: string,
  input: {
    readonly annotationId: string;
    readonly tabId: string;
    readonly sessionId: string;
    readonly comment: string;
  },
): Promise<{
  readonly hash: string;
  readonly annotationId: string;
}> {
  const stub = createStubBrowserAnnotationPayloadFor(input);
  const result = await attachBrowserAnnotation({
    chatId,
    payload: stub.payload,
    png: stub.png,
  });
  expect(result.status).toBe("attached");
  const record = draftOf(chatId).browserAnnotations.find(
    (entry) => entry.annotationId === input.annotationId,
  );
  if (record === undefined) {
    throw new Error(`expected attached record ${input.annotationId}`);
  }
  return {
    hash: record.imageHash,
    annotationId: record.annotationId,
  };
}

function draftOf(taskId: string): DraftState {
  const draft = useComposerDraftStore.getState().drafts[taskId];
  expect(draft).toBeDefined();
  if (draft === undefined) {
    throw new Error(`missing draft ${taskId}`);
  }
  return draft;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistedAnnotationOf(
  stored: string | null,
  taskId: string,
): { readonly annotationId: string; readonly imageHash: string } {
  if (stored === null) {
    throw new Error("missing composer-draft persist payload");
  }
  const parsed: unknown = JSON.parse(stored);
  if (!isRecord(parsed) || !isRecord(parsed.state)) {
    throw new Error("persist payload is not a draft map");
  }
  if (!isRecord(parsed.state.drafts)) {
    throw new Error("persist payload has no drafts");
  }
  const draft = parsed.state.drafts[taskId];
  if (!isRecord(draft) || !Array.isArray(draft.browserAnnotations)) {
    throw new Error(`persist draft ${taskId} has no browserAnnotations`);
  }
  const first: unknown = draft.browserAnnotations[0];
  if (!isRecord(first)) {
    throw new Error(`persist draft ${taskId} annotation is not a record`);
  }
  if (
    typeof first.annotationId !== "string" ||
    typeof first.imageHash !== "string"
  ) {
    throw new Error(`persist draft ${taskId} annotation is missing ids`);
  }
  return { annotationId: first.annotationId, imageHash: first.imageHash };
}

beforeEach(async () => {
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  installIdbWorking(idbData, idbGet, idbSet, idbDel);
  await drainImages();
  vi.clearAllMocks();
  installIdbWorking(idbData, idbGet, idbSet, idbDel);
  window.localStorage.clear();
  useComposerDraftStore.setState({ drafts: {} });
  markLandingDraftsReady();
});

afterEach(async () => {
  await drainImages();
  window.localStorage.clear();
  useComposerDraftStore.setState({ drafts: {} });
});

describe("composer draft store browserAnnotations", () => {
  it("Add: appends the record after bytes are already in the image store", async () => {
    const stub = createStubBrowserAnnotationPayloadFor({
      annotationId: "ann-add",
      tabId: "tab-add",
      sessionId: "session-add",
      comment: "Make the heading larger",
    });
    const hash = await putImage(stub.png);
    expect(hasLandingImageBytes(hash)).toBe(true);

    const record = {
      kind: "browser-annotation" as const,
      annotationId: stub.payload.annotationId,
      tabId: stub.payload.tabId,
      sessionId: stub.payload.sessionId,
      origin: stub.payload.origin,
      pageUrl: stub.payload.pageUrl,
      pageTitle: stub.payload.pageTitle,
      capturedAt: stub.payload.capturedAt,
      comment: stub.payload.comment,
      counts: stub.payload.counts,
      elements: stub.payload.elements,
      imageFileName: `browser-annotation-${stub.payload.annotationId}.png`,
      imageHash: hash,
      droppedElementCount: 0,
    };
    useComposerDraftStore.getState().addBrowserAnnotation("chat-add", record);

    const draft = draftOf("chat-add");
    expect(draft.browserAnnotations).toEqual([record]);
    expect(await imageHashKeys()).toContain(hash);
    expect(landingLiveImageRootHashes().has(hash)).toBe(true);
  });

  it("Add: same annotationId is a no-op (no second copy, no epoch bump)", async () => {
    const first = await attachNamed("chat-dedupe", {
      annotationId: "ann-dup",
      tabId: "tab-dup",
      sessionId: "session-dup",
      comment: "first",
    });
    const before = draftOf("chat-dedupe");

    const stub = createStubBrowserAnnotationPayloadFor({
      annotationId: "ann-dup",
      tabId: "tab-other",
      sessionId: "session-other",
      comment: "second copy must not land",
    });
    const result = await attachBrowserAnnotation({
      chatId: "chat-dedupe",
      payload: stub.payload,
      png: stub.png,
    });
    expect(result.status).toBe("attached");

    const after = draftOf("chat-dedupe");
    expect(after.browserAnnotations).toHaveLength(1);
    expect(after.browserAnnotations[0]?.annotationId).toBe(first.annotationId);
    expect(after.browserAnnotations[0]?.comment).toBe("first");
    expect(after.resetEpoch).toBe(before.resetEpoch);
  });

  it("X: removeAttachedBrowserAnnotation removes the record and stored image together", async () => {
    const attached = await attachNamed("chat-remove", {
      annotationId: "ann-remove",
      tabId: "tab-remove",
      sessionId: "session-remove",
      comment: "drop me",
    });
    expect(hasLandingImageBytes(attached.hash)).toBe(true);

    useComposerDraftStore
      .getState()
      .removeBrowserAnnotation("chat-remove", attached.annotationId);
    scheduleLandingImageReconcile();

    expect(draftOf("chat-remove").browserAnnotations).toEqual([]);
    await vi.waitFor(async () => {
      expect(hasLandingImageBytes(attached.hash)).toBe(false);
      expect(await imageHashKeys()).not.toContain(attached.hash);
    });
    expect(landingLiveImageRootHashes().has(attached.hash)).toBe(false);
  });

  it("X: a shared image hash stays when another record still references it", async () => {
    const firstStub = createStubBrowserAnnotationPayloadFor({
      annotationId: "ann-share-a",
      tabId: "tab-a",
      sessionId: "session-share",
      comment: "first card",
    });
    const secondStub = createStubBrowserAnnotationPayloadFor({
      annotationId: "ann-share-b",
      tabId: "tab-b",
      sessionId: "session-share",
      comment: "second card",
    });
    const first = await attachBrowserAnnotation({
      chatId: "chat-share",
      payload: firstStub.payload,
      png: firstStub.png,
    });
    const second = await attachBrowserAnnotation({
      chatId: "chat-share",
      payload: secondStub.payload,
      png: firstStub.png,
    });
    expect(first.status).toBe("attached");
    expect(second.status).toBe("attached");
    const shared = draftOf("chat-share").browserAnnotations;
    expect(shared).toHaveLength(2);
    expect(shared[0]?.imageHash).toBe(shared[1]?.imageHash);
    const sharedHash = shared[0].imageHash;

    useComposerDraftStore
      .getState()
      .removeBrowserAnnotation("chat-share", "ann-share-a");
    scheduleLandingImageReconcile();

    expect(
      draftOf("chat-share").browserAnnotations.map((r) => r.annotationId),
    ).toEqual(["ann-share-b"]);
    await Promise.resolve();
    expect(hasLandingImageBytes(sharedHash)).toBe(true);
    expect(await imageHashKeys()).toContain(sharedHash);

    useComposerDraftStore
      .getState()
      .removeBrowserAnnotation("chat-share", "ann-share-b");
    scheduleLandingImageReconcile();
    await vi.waitFor(async () => {
      expect(hasLandingImageBytes(sharedHash)).toBe(false);
      expect(await imageHashKeys()).not.toContain(sharedHash);
    });
  });

  it("Rehydrate: persist.rehydrate includes records and image hashes", async () => {
    const stub = createStubBrowserAnnotationPayloadFor({
      annotationId: "ann-persist",
      tabId: "tab-persist",
      sessionId: "session-persist",
      comment: "survives relaunch",
    });
    const hash = await putImage(stub.png);
    const persistedRecord = {
      kind: "browser-annotation" as const,
      annotationId: stub.payload.annotationId,
      tabId: stub.payload.tabId,
      sessionId: stub.payload.sessionId,
      origin: stub.payload.origin,
      pageUrl: stub.payload.pageUrl,
      pageTitle: stub.payload.pageTitle,
      capturedAt: stub.payload.capturedAt,
      comment: stub.payload.comment,
      counts: stub.payload.counts,
      elements: stub.payload.elements,
      imageFileName: `browser-annotation-${stub.payload.annotationId}.png`,
      imageHash: hash,
      droppedElementCount: 0,
    };
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          drafts: {
            "chat-persist": {
              content: EMPTY_DOC,
              selection: null,
              browserAnnotations: [persistedRecord],
              resetEpoch: 0,
              revision: 2,
            },
          },
        },
      }),
    );

    await useComposerDraftStore.persist.rehydrate();

    const draft = draftOf("chat-persist");
    expect(draft.browserAnnotations).toEqual([persistedRecord]);
    expect(draft.browserAnnotations[0]?.imageHash).toBe(hash);
    expect(landingLiveImageRootHashes().has(hash)).toBe(true);
    expect(draft.resetEpoch).toBe(1);
    expect(draft.revision).toBe(2);
  });

  it("Rehydrate: a live add is written into persist so a later rehydrate keeps it", async () => {
    const attached = await attachNamed("chat-roundtrip", {
      annotationId: "ann-roundtrip",
      tabId: "tab-roundtrip",
      sessionId: "session-roundtrip",
      comment: "persisted add",
    });
    const stored = window.localStorage.getItem(STORAGE_KEY);
    expect(stored).not.toBeNull();
    const persisted = persistedAnnotationOf(stored, "chat-roundtrip");
    expect(persisted).toEqual({
      annotationId: attached.annotationId,
      imageHash: attached.hash,
    });

    // setState persists; write the captured payload back so rehydrate sees it.
    useComposerDraftStore.setState({ drafts: {} });
    window.localStorage.setItem(STORAGE_KEY, stored ?? "");
    await useComposerDraftStore.persist.rehydrate();

    const restored = draftOf("chat-roundtrip").browserAnnotations;
    expect(restored).toHaveLength(1);
    expect(restored[0]?.annotationId).toBe(attached.annotationId);
    expect(restored[0]?.imageHash).toBe(attached.hash);
  });

  it("Rehydrate: legacy drafts without browserAnnotations become []", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          drafts: {
            "chat-legacy": {
              content: EMPTY_DOC,
              selection: null,
              resetEpoch: 0,
              revision: 4,
            },
          },
        },
      }),
    );

    await useComposerDraftStore.persist.rehydrate();

    const draft = draftOf("chat-legacy");
    expect(draft.browserAnnotations).toEqual([]);
    expect(draft.revision).toBe(4);
  });

  it("Sidecar mutations never bump resetEpoch (the editor-document reset signal)", async () => {
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-epoch", EMPTY_DOC, { from: 1, to: 1 });
    const before = draftOf("chat-epoch");

    await attachNamed("chat-epoch", {
      annotationId: "ann-epoch",
      tabId: "tab-epoch",
      sessionId: "session-epoch",
      comment: "no document change",
    });
    expect(draftOf("chat-epoch").browserAnnotations).toHaveLength(1);
    expect(draftOf("chat-epoch").resetEpoch).toBe(before.resetEpoch);

    useComposerDraftStore
      .getState()
      .removeBrowserAnnotation("chat-epoch", "ann-epoch");
    expect(draftOf("chat-epoch").browserAnnotations).toEqual([]);
    expect(draftOf("chat-epoch").resetEpoch).toBe(before.resetEpoch);
    expect(draftOf("chat-epoch").content).toEqual(before.content);
  });

  it("Sidecar mutations DO bump revision (the prompt-stash clear-if-unchanged token)", async () => {
    // A stash captures {content, revision}, saves to IndexedDB, then clears
    // the draft only if the revision still matches - and `clearDraft` wipes
    // the sidecar the stash never captured. Without a bump here, an
    // annotation attached during that save is destroyed with nothing holding
    // it.
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-cas", EMPTY_DOC, { from: 1, to: 1 });
    const captured = draftOf("chat-cas").revision;

    await attachNamed("chat-cas", {
      annotationId: "ann-cas",
      tabId: "tab-cas",
      sessionId: "session-cas",
      comment: "attached while the stash was saving",
    });
    expect(draftOf("chat-cas").revision).toBe(captured + 1);

    useComposerDraftStore
      .getState()
      .removeBrowserAnnotation("chat-cas", "ann-cas");
    expect(draftOf("chat-cas").revision).toBe(captured + 2);
  });

  it("Accepted send: clearDraft clears browserAnnotations", async () => {
    const attached = await attachNamed("chat-send", {
      annotationId: "ann-send",
      tabId: "tab-send",
      sessionId: "session-send",
      comment: "goes out with the message",
    });
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-send", EMPTY_DOC, { from: 1, to: 1 });
    const before = draftOf("chat-send");
    expect(before.browserAnnotations).toHaveLength(1);

    useComposerDraftStore.getState().clearDraft("chat-send");

    const after = draftOf("chat-send");
    expect(after.browserAnnotations).toEqual([]);
    expect(after.content).toEqual(EMPTY_DOC);
    expect(after.resetEpoch).toBe(before.resetEpoch + 1);
    expect(after.revision).toBe(before.revision + 1);
    expect(hasLandingImageBytes(attached.hash)).toBe(true);
  });

  it("Rejected send: restoreBrowserAnnotations puts records back without duplication", async () => {
    const attached = await attachNamed("chat-reject", {
      annotationId: "ann-reject",
      tabId: "tab-reject",
      sessionId: "session-reject",
      comment: "retry me",
    });
    const snapshot = draftOf("chat-reject").browserAnnotations;
    useComposerDraftStore.getState().clearDraft("chat-reject");
    expect(draftOf("chat-reject").browserAnnotations).toEqual([]);

    useComposerDraftStore
      .getState()
      .restoreBrowserAnnotations("chat-reject", snapshot);
    expect(draftOf("chat-reject").browserAnnotations).toEqual(snapshot);

    useComposerDraftStore
      .getState()
      .restoreBrowserAnnotations("chat-reject", snapshot);
    expect(draftOf("chat-reject").browserAnnotations).toHaveLength(1);
    expect(draftOf("chat-reject").browserAnnotations[0]?.annotationId).toBe(
      attached.annotationId,
    );
  });

  it("Rejected send: restoreAttachedBrowserAnnotations is a no-op when the id is already present", async () => {
    const attached = await attachNamed("chat-restore-api", {
      annotationId: "ann-restore-api",
      tabId: "tab-restore-api",
      sessionId: "session-restore-api",
      comment: "already here",
    });
    const existing = draftOf("chat-restore-api").browserAnnotations;
    const epoch = draftOf("chat-restore-api").resetEpoch;

    useComposerDraftStore
      .getState()
      .restoreBrowserAnnotations("chat-restore-api", existing);

    const after = draftOf("chat-restore-api");
    expect(after.browserAnnotations).toHaveLength(1);
    expect(after.browserAnnotations[0]?.annotationId).toBe(
      attached.annotationId,
    );
    expect(after.resetEpoch).toBe(epoch);
  });

  it("reject-after-optimistic-accept keeps crop bytes so the restored draft is re-sendable", async () => {
    const attached = await attachNamed("chat-m2", {
      annotationId: "ann-m2",
      tabId: "tab-m2",
      sessionId: "session-m2",
      comment: "must survive reject",
    });
    const records = draftOf("chat-m2").browserAnnotations;
    const handle = createChatSessionStore({
      hostId: "host-m2",
      epicId: "epic-m2",
      chatId: "chat-m2",
      userId: null,
      onAuthError: null,
      onProviderAuthError: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: () => ({
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      }),
    });
    handle.store.setState({
      pendingActions: {
        "action-m2": {
          clientActionId: "action-m2",
          action: "send",
          interviewBlockId: null,
          interviewDeliveryRetry: null,
          messageId: "msg-m2",
          restore: { content: EMPTY_DOC, browserAnnotations: records },
          sender: null,
          settings: null,
          restoreWorktreeIntent: null,
          accountContext: null,
          deliveryPolicy: null,
          createdAt: 1,
          connectionEpoch: 0,
        },
      },
    });

    useComposerDraftStore.getState().clearDraft("chat-m2");
    await vi.waitFor(() => {
      expect(draftOf("chat-m2").browserAnnotations).toEqual([]);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 700);
    });
    expect(hasLandingImageBytes(attached.hash)).toBe(true);

    handle.store.setState({ pendingActions: {} });
    scheduleLandingImageReconcile();
    await vi.waitFor(() => {
      expect(hasLandingImageBytes(attached.hash)).toBe(false);
    });
    handle.dispose();
  });
});
