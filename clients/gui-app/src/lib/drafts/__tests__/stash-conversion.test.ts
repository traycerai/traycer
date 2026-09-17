/**
 * `stash-entry` documents a host still lists (D20 keeps the kind on the
 * wire) convert into a closed start-page draft exactly once, reserve the
 * cloud absence-sweep fence, and retire the source row on its owner host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";

import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import {
  acquireDraftMirrorSession,
  applyIncomingDraftDocument,
  cloudDraftIngestSeq,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import { resetStashMigrationForTests } from "@/lib/drafts/stash-migration";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  }),
}));

const HOST_ID = "host-stash";

function stashDocument(): DraftDocument {
  return {
    draftId: "stash-1",
    kind: "stash-entry",
    target: { epicId: null, chatId: null, blockId: null },
    revision: 1,
    lastTouchedAt: 4242,
    workspace: null,
    supersedes: null,
    portable: {
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
        ],
      },
      blobHashes: [],
      createdAt: 4242,
    },
    ownerHostId: HOST_ID,
    origin: "own",
    adoption: { state: "adopted", hostId: HOST_ID },
    publication: {
      status: "unpublished",
      lastPublishedAt: null,
      publishedRevision: null,
      halted: null,
    },
  };
}

beforeEach(() => {
  installFreshIndexedDb();
  window.localStorage.clear();
  resetStashMigrationForTests();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
});

describe("stash-entry conversion", () => {
  it("converts once, reserves the ingest fence, and deletes the source row on the owner session", async () => {
    const deletes: string[] = [];
    acquireDraftMirrorSession({
      hostId: HOST_ID,
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
    const fenceBefore = cloudDraftIngestSeq();

    await applyIncomingDraftDocument(stashDocument());

    const drafts = useLandingDraftStore.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.closed).toBe(true);
    expect(drafts[0]?.lastTouchedAt).toBe(4242);
    expect(drafts[0]?.id).not.toBe("stash-1");
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(cloudDraftIngestSeq()).toBeGreaterThan(fenceBefore);
    expect(deletes).toEqual(["stash-1"]);

    // The same row listed again: the converted map blocks a second draft and
    // the per-session retired set blocks a second delete.
    await applyIncomingDraftDocument(stashDocument());

    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(deletes).toEqual(["stash-1"]);
  });
});
