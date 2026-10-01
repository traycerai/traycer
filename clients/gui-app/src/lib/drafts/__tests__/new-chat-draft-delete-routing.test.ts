import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import {
  acquireDraftMirrorSession,
  bindNewChatDraftHost,
  releaseDraftMirrorSession,
  resetDraftMirrorCoordinatorForTests,
  unbindNewChatDraftHost,
} from "@/lib/drafts/draft-mirror-coordinator";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";

const HOST_ID = "host-new-chat";
const EPIC_ID = "epic-new-chat";

function typed(text: string) {
  return {
    type: "doc" as const,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

interface HostLog {
  readonly deletes: string[];
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
  useNewConversationModalStore.getState().resetForTests();
});

// Scope: the BOUND case only - a modal for this epic is mounted, so
// `bindNewChatDraftHost` has put the epic in the coordinator's
// `newChatHostByEpicId` map and the routed delete has a host to resolve. The
// unmounted-modal route (where that binding is gone, and the drafts list is
// deleting a row whose modal was never opened this session) is NOT closed by
// the notify-before-remove reorder: it is `deleteNewChatDraftRow`'s explicit
// client routing in T04. The second case below pins that limit.
describe("new-chat clearDraft routes its host delete with the epic host bound (critique C2)", () => {
  it("sends drafts.delete for the patch's draft id, and the host stops listing the row", async () => {
    const log: HostLog = { deletes: [], rows: [] };
    const session = mountSession(log);
    bindNewChatDraftHost(EPIC_ID, HOST_ID);

    useNewConversationModalStore.getState().setContent(EPIC_ID, typed("later"));
    const draftId =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
        ?.draftId ?? null;
    expect(draftId).not.toBeNull();
    if (draftId === null) throw new Error("expected a draft id");
    await session.flush([draftId]);
    expect(log.rows.map((row) => row.draftId)).toEqual([draftId]);

    useNewConversationModalStore.getState().clearDraft(EPIC_ID);

    // The whole point of notifying BEFORE the entry is removed: the
    // coordinator resolves this draft's host through `findNewChatByDraftId`,
    // which reads the very entry `clearDraft` is deleting. Removing first
    // left the host with nothing to delete and it went on listing the row.
    await vi.waitFor(() => {
      expect(log.deletes).toEqual([draftId]);
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID],
    ).toBeUndefined();

    // A later session's bootstrap replay - the channel a surviving host row
    // would come back through - no longer carries it.
    releaseDraftMirrorSession(HOST_ID);
    mountSession(log);
    await vi.waitFor(() => {
      expect(log.rows).toEqual([]);
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID],
    ).toBeUndefined();
  });

  it("CURRENT LIMIT: with the modal unmounted, the entry goes but no drafts.delete is sent - T04's explicit routing is what closes this", async () => {
    const log: HostLog = { deletes: [], rows: [] };
    const session = mountSession(log);
    bindNewChatDraftHost(EPIC_ID, HOST_ID);

    useNewConversationModalStore.getState().setContent(EPIC_ID, typed("later"));
    const draftId =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
        ?.draftId ?? null;
    if (draftId === null) throw new Error("expected a draft id");
    await session.flush([draftId]);
    expect(log.rows.map((row) => row.draftId)).toEqual([draftId]);

    // The modal closes. The session for the host is still up (another tab in
    // the same epic), but the epic's entry in `newChatHostByEpicId` is gone,
    // so `hostIdForDraft` has nothing to resolve the routed delete against.
    unbindNewChatDraftHost(EPIC_ID, HOST_ID);

    useNewConversationModalStore.getState().clearDraft(EPIC_ID);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(log.deletes).toEqual([]);
    // The local row is gone either way - it is the HOST row that survives,
    // which is why `deleteNewChatDraftRow` (T04) sends the delete on the
    // owner host's client itself rather than relying on this notice.
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID],
    ).toBeUndefined();
    expect(log.rows.map((row) => row.draftId)).toEqual([draftId]);
  });

  it("removes the entry with no host request when the epic has no draft id yet", async () => {
    const log: HostLog = { deletes: [], rows: [] };
    mountSession(log);
    bindNewChatDraftHost(EPIC_ID, HOST_ID);

    useNewConversationModalStore.getState().clearDraft(EPIC_ID);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(log.deletes).toEqual([]);
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID],
    ).toBeUndefined();
  });
});
