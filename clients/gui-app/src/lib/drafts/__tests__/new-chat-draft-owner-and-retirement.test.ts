import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";

import { listDraftInventory } from "@/lib/drafts/draft-inventory";
import {
  acquireDraftMirrorSession,
  bindNewChatDraftHost,
  resetDraftMirrorCoordinatorForTests,
  unbindNewChatDraftHost,
} from "@/lib/drafts/draft-mirror-coordinator";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import {
  applyNewChatHostDocument,
  useNewConversationModalStore,
} from "@/stores/epics/new-conversation-modal-store";

const HOST_ID = "host-new-chat";
const EPIC_ID = "epic-new-chat";

function typed(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** A host row for `draftId` in this epic, as a live apply would deliver it. */
function hostDocument(draftId: string, content: JsonContent): DraftDocument {
  return {
    draftId,
    kind: "new-chat",
    target: { epicId: EPIC_ID, chatId: null, blockId: null },
    revision: 7,
    lastTouchedAt: 99,
    workspace: null,
    ownerHostId: HOST_ID,
    origin: "own",
    adoption: { state: "adopted", hostId: HOST_ID },
    publication: {
      status: "unpublished",
      lastPublishedAt: null,
      publishedRevision: null,
      halted: null,
    },
    supersedes: null,
    portable: {
      content,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

interface HostLog {
  rows: DraftDocument[];
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
          const document = hostDocument(write.draftId, typed("from the host"));
          log.rows = [document];
          // The session does NOT apply this response as a document - it only
          // calls `rememberSynced` - which is why the owner host has to be
          // captured while the write is being collected.
          return Promise.resolve({ draft: document });
        }
        return Promise.reject(new Error(`unexpected ${String(method)}`));
      },
    } as never,
    streamClient: fakeDraftStreamClient(),
    timing: { debounceMs: 0, maxWaitMs: 0 },
  });
}

function patchForEpic() {
  return useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
}

function currentDraftId(): string {
  const draftId = patchForEpic()?.draftId ?? null;
  if (draftId === null) throw new Error("expected a draft id");
  return draftId;
}

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
  useNewConversationModalStore.getState().resetForTests();
});

describe("new-chat owner host capture", () => {
  it("records the host a normal upsert went to, so the row outlives the binding", async () => {
    const log: HostLog = { rows: [] };
    const session = mountSession(log);
    bindNewChatDraftHost(EPIC_ID, HOST_ID);

    useNewConversationModalStore.getState().setContent(EPIC_ID, typed("later"));
    const draftId = currentDraftId();
    await session.flush([draftId]);

    expect(patchForEpic()?.ownerHostId).toBe(HOST_ID);

    // The modal closes: the epic leaves `newChatHostByEpicId`, so
    // `newChatBoundHostId` - the inventory's only other source of an owner -
    // answers null from here on.
    unbindNewChatDraftHost(EPIC_ID, HOST_ID);

    const rows = listDraftInventory({
      scope: { surface: "landing", activeDraftId: null },
      filter: "all",
      landing: [],
      composer: {},
      newChat: useNewConversationModalStore.getState().draftPatchesByEpicId,
      openChatIds: new Set(),
      liveSessionHostIds: new Set([HOST_ID]),
    });
    expect(rows.map((row) => row.id)).toEqual([draftId]);
    expect(rows[0]?.ownerHostId).toBe(HOST_ID);
  });

  it("does not dirty the patch it labels", async () => {
    const log: HostLog = { rows: [] };
    const session = mountSession(log);
    bindNewChatDraftHost(EPIC_ID, HOST_ID);

    useNewConversationModalStore.getState().setContent(EPIC_ID, typed("later"));
    await session.flush([currentDraftId()]);

    const patch = patchForEpic();
    // A dirtying write here would re-dirty the row the collector is marking
    // clean, and the flush would never settle.
    expect(patch?.generation).toBe(patch?.syncedGeneration);
  });
});

describe("new-chat retired-id fence", () => {
  it("ignores a late document for a deleted draft id", () => {
    useNewConversationModalStore.getState().setContent(EPIC_ID, typed("later"));
    const draftId = currentDraftId();

    useNewConversationModalStore.getState().clearDraft(EPIC_ID);
    // The apply that was awaiting blob reads finally lands.
    applyNewChatHostDocument(hostDocument(draftId, typed("from the host")));

    expect(patchForEpic()).toBeUndefined();
  });

  it("leaves the identity an Undo minted in place when the old id's document lands", () => {
    useNewConversationModalStore.getState().setContent(EPIC_ID, typed("later"));
    const deletedId = currentDraftId();
    useNewConversationModalStore.getState().clearDraft(EPIC_ID);

    // Undo restores the content, which mints a fresh identity - the old id is
    // being tombstoned on the host.
    useNewConversationModalStore
      .getState()
      .setContent(EPIC_ID, typed("restored"));
    const restoredId = currentDraftId();
    expect(restoredId).not.toBe(deletedId);

    applyNewChatHostDocument(hostDocument(deletedId, typed("from the host")));

    const patch = patchForEpic();
    expect(patch?.draftId).toBe(restoredId);
    expect(patch?.content).toEqual(typed("restored"));
    // Still dirty: nothing marked the restored content clean against a
    // revision that belongs to the deleted row.
    expect(patch?.generation).toBeGreaterThan(patch?.syncedGeneration ?? 0);
  });

  it("still applies a document for a live id", () => {
    useNewConversationModalStore.getState().setContent(EPIC_ID, typed("later"));
    const draftId = currentDraftId();

    applyNewChatHostDocument(hostDocument(draftId, typed("from the host")));

    // The local row is dirty, so the document supplies identity rather than
    // content - but it is applied, which is what the fence must not prevent.
    expect(patchForEpic()?.hostRevision).toBe(7);
    expect(patchForEpic()?.ownerHostId).toBe(HOST_ID);
  });
});
