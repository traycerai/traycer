import { afterEach, describe, expect, it } from "vitest";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import {
  acquireDraftMirrorSession,
  consumeStashOnHost,
  deleteStashEntryOnHost,
  publishStashEntry,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import { stashDraftWrite } from "@/lib/drafts/draft-write-codec";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

const HOST_ID = "host-stash";
const EMPTY_DOC = {
  type: "doc" as const,
  content: [{ type: "paragraph" }],
};

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
  usePromptStashStore.setState({ rows: [] });
});

describe("stash host sync", () => {
  it("upserts a stash-entry once and treats a second consume delete as idempotent", async () => {
    installFreshIndexedDb();
    const upserts: DraftWrite[] = [];
    const deletes: string[] = [];
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
              scopeId: "scp_TESTDRAFTSSCOPEID000001",
            });
          }
          if (method === "drafts.upsert") {
            const write = (params as { draft: DraftWrite }).draft;
            upserts.push(write);
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
            const existed = listed.some((row) => row.draftId === draftId);
            listed = listed.filter((row) => row.draftId !== draftId);
            deletes.push(draftId);
            return Promise.resolve({ deleted: existed });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: undefined,
    });
    await Promise.resolve();
    const entry = {
      id: "stash-1",
      createdAt: 10,
      content: EMPTY_DOC,
      blobHashes: [] as string[],
      annotations: [],
    };
    await publishStashEntry(HOST_ID, entry);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.kind).toBe("stash-entry");
    expect(
      stashDraftWrite({
        draftId: entry.id,
        content: entry.content,
        blobHashes: entry.blobHashes,
        createdAt: entry.createdAt,
        annotations: entry.annotations,
      }).draftId,
    ).toBe("stash-1");

    await deleteStashEntryOnHost(HOST_ID, "stash-1");
    expect(deletes).toEqual(["stash-1"]);

    await deleteStashEntryOnHost(HOST_ID, "stash-1");
    expect(deletes).toEqual(["stash-1", "stash-1"]);
    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes,
    ).toEqual({});
  });

  it("keeps the stash host binding when delete fails so a retry still reaches the row", async () => {
    installFreshIndexedDb();
    const deletes: string[] = [];
    let failNextDelete = true;
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
          if (method === "drafts.upsert") {
            const write = (params as { draft: DraftWrite }).draft;
            return Promise.resolve({
              draft: {
                ...write,
                ownerHostId: HOST_ID,
                origin: "own" as const,
                adoption: { state: "adopted" as const, hostId: HOST_ID },
                publication: {
                  status: "unpublished" as const,
                  lastPublishedAt: null,
                  publishedRevision: null,
                  halted: null,
                },
                revision: 1,
              },
            });
          }
          if (method === "drafts.delete") {
            const draftId = (params as { draftId: string }).draftId;
            if (failNextDelete) {
              failNextDelete = false;
              return Promise.reject(new Error("transport"));
            }
            deletes.push(draftId);
            return Promise.resolve({ deleted: true });
          }
          return Promise.reject(new Error(`unexpected ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: undefined,
    });
    await Promise.resolve();
    const entry = {
      id: "stash-keep",
      createdAt: 10,
      content: EMPTY_DOC,
      blobHashes: [] as string[],
      annotations: [],
    };
    await publishStashEntry(HOST_ID, entry);
    await deleteStashEntryOnHost(null, entry.id);
    expect(deletes).toEqual([]);
    await deleteStashEntryOnHost(null, entry.id);
    expect(deletes).toEqual([entry.id]);
  });

  it("restore-consume on a second host retracts the cloud row through drafts.retract, without ever calling drafts.delete there; a lost-race retract falls back to an idempotent delete", async () => {
    installFreshIndexedDb();
    const hostA = "host-a";
    const hostB = "host-b";
    const retracts: string[] = [];
    const deletes: string[] = [];
    let listedOnB: DraftDocument[] = [];
    const entry = {
      id: "stash-cross",
      createdAt: 10,
      content: EMPTY_DOC,
      blobHashes: [] as string[],
      annotations: [],
    };
    acquireDraftMirrorSession({
      hostId: hostA,
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
          if (method === "drafts.upsert") {
            return Promise.resolve({
              draft: {
                ...(params as { draft: DraftWrite }).draft,
                ownerHostId: hostA,
                origin: "own" as const,
                adoption: { state: "adopted" as const, hostId: hostA },
                publication: {
                  status: "unpublished" as const,
                  lastPublishedAt: null,
                  publishedRevision: null,
                  halted: null,
                },
                revision: 1,
              },
            });
          }
          return Promise.reject(new Error(`unexpected A ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: undefined,
    });
    acquireDraftMirrorSession({
      hostId: hostB,
      client: {
        request: (method: string, params: unknown) => {
          if (method === "drafts.list") {
            return Promise.resolve({
              drafts: listedOnB,
              tombstones: [],
              snapshotSeq: 0,
              scopeId: "scp_TESTDRAFTSSCOPEID000002",
            });
          }
          if (method === "drafts.retract") {
            const draftId = (params as { draftId: string }).draftId;
            retracts.push(draftId);
            return Promise.resolve({ retracted: true });
          }
          if (method === "drafts.delete") {
            const draftId = (params as { draftId: string }).draftId;
            const existed = listedOnB.some((row) => row.draftId === draftId);
            listedOnB = listedOnB.filter((row) => row.draftId !== draftId);
            deletes.push(draftId);
            return Promise.resolve({ deleted: existed });
          }
          return Promise.reject(new Error(`unexpected B ${String(method)}`));
        },
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: undefined,
    });
    await Promise.resolve();
    await publishStashEntry(hostA, entry);
    // Consumed through hostB, which never published this entry: the
    // coordinator retracts the cloud row on the user's authority through
    // hostB's client, and - on a successful retract - returns without ever
    // calling `drafts.delete` there. Ownership never moves; hostA (the
    // publisher) tombstones its own row once it finds the cloud row gone.
    await consumeStashOnHost(hostB, entry.id);
    expect(retracts).toEqual([entry.id]);
    expect(deletes).toEqual([]);
    // The entry is no longer bound to a known publishing host after the
    // retract, so a second consume through hostB falls back to the
    // idempotent delete path instead of retracting again.
    await consumeStashOnHost(hostB, entry.id);
    expect(retracts).toEqual([entry.id]);
    expect(deletes).toEqual([entry.id]);
  });
});
