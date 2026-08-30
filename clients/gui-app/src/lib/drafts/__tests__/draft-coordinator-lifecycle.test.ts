import { afterEach, describe, expect, it } from "vitest";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import {
  acquireDraftMirrorSession,
  bindComposerDraftHost,
  bindInterviewDraftHost,
  collectDraftMirrorDirtyWrites,
  resetDraftMirrorCoordinatorForTests,
  submitComposerDraft,
  unbindInterviewDraftHost,
} from "@/lib/drafts/draft-mirror-coordinator";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useInterviewDraftStore } from "@/stores/composer/interview-draft-store";

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
  /** Resolves the NEXT `drafts.delete`; `null` answers immediately. */
  holdDelete: (() => void) | null;
}

function mountSession(log: HostLog): void {
  let listed: DraftDocument[] = [];
  acquireDraftMirrorSession({
    hostId: HOST_ID,
    client: {
      request: (method: string, params: unknown) => {
        if (method === "drafts.list") {
          return Promise.resolve({
            drafts: listed,
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
          listed = [document];
          return Promise.resolve({ draft: document });
        }
        if (method === "drafts.delete") {
          const draftId = (params as { draftId: string }).draftId;
          log.deletes.push(draftId);
          listed = listed.filter((row) => row.draftId !== draftId);
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
  useComposerDraftStore.setState({ drafts: {} });
  useInterviewDraftStore.setState({ draftsByChat: {} });
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
    const log: HostLog = { upserts: [], deletes: [], holdDelete: null };
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
});
