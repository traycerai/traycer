/**
 * `stash-entry` documents a host still lists (D20 keeps the kind on the
 * wire) convert into a closed start-page draft exactly once, reserve the
 * cloud absence-sweep fence, and retire the source row on its owner host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";

import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import {
  acquireDraftMirrorSession,
  applyIncomingDraftDocument,
  cloudDraftIngestSeq,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import { resetStashMigrationForTests } from "@/lib/drafts/stash-migration";
import { useAuthStore } from "@/stores/auth/auth-store";
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
const OWNER = "user-stash";
const IMAGE_HASH = "ab".repeat(32);

function signedInAs(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

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
      annotations: [],
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

/**
 * `stashDocument()` with one image node, so the conversion has a real
 * suspension - the blob read and the `putImage` write - for an account switch
 * to land inside.
 */
function stashDocumentWithImage(): DraftDocument {
  const base = stashDocument();
  if (base.kind !== "stash-entry") throw new Error("expected a stash entry");
  return {
    ...base,
    portable: {
      ...base.portable,
      blobHashes: [IMAGE_HASH],
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
          {
            type: "imageAttachment",
            attrs: {
              id: "node-1",
              fileName: "shot.png",
              hash: IMAGE_HASH,
              b64content: null,
              mimeType: "image/png",
              size: 32,
            },
          },
        ],
      },
    },
  };
}

beforeEach(() => {
  installFreshIndexedDb();
  window.localStorage.clear();
  resetStashMigrationForTests();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  signedInAs(OWNER);
});

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
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

  it("installs nothing, deletes nothing and writes no receipt when the account changes during the blob read (DRIVE RED)", async () => {
    // The owner check the coordinator makes BEFORE the conversion proves
    // nothing about what happens after it: the conversion awaits the image
    // import, and the landing draft store is keyed per WINDOW with no account
    // of its own. An install that lands here files the outgoing account's
    // private prompt in the incoming account's Drafts list, and roots its
    // images in that account's partition.
    //
    // Worse than a lost draft: the source row would ALSO be retired and a
    // receipt written, so the prompt would exist nowhere the right account can
    // reach it.
    const deletes: string[] = [];
    let switchOnNextRead = true;
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
          if (method === "drafts.readBlob") {
            // The switch lands INSIDE the read the conversion is waiting on -
            // once, so the positive control below runs on a clean account.
            if (switchOnNextRead) {
              switchOnNextRead = false;
              signedInAs("somebody-else");
            }
            return Promise.resolve({ found: false as const });
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

    await applyIncomingDraftDocument(stashDocumentWithImage());

    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    // The source row survives, so a later session under the right account can
    // still convert it.
    expect(deletes).toEqual([]);
    expect(window.localStorage.getItem("traycer-gui-app:stash-migration")).toBe(
      null,
    );

    // Positive control: back on the original account, the SAME row converts.
    signedInAs(OWNER);
    await applyIncomingDraftDocument(stashDocumentWithImage());

    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(deletes).toEqual(["stash-1"]);
  });
});
