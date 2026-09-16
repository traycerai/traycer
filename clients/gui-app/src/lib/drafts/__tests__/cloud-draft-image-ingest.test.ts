import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { DraftHeadReaderRecord } from "@traycer/protocol/persistence/draft/schemas";
import { DRAFT_HEAD_SCHEMA_VERSION } from "@traycer/protocol/persistence/draft/version";
import type { DraftDocument } from "@traycer/protocol/host";

import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { getImageBytes } from "@/lib/composer/landing-image-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { draftDocumentFromCloudHead } from "@/lib/drafts/cloud-draft-apply";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  acquireDraftMirrorSession,
  ingestCloudDraftSummary,
  releaseDraftMirrorSession,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";

const INGESTING_HOST = "host-a";
const OWNER_HOST = "host-b"; // never mirrored on this window
const EMPTY_DOC = {
  type: "doc" as const,
  content: [{ type: "paragraph" }],
};

type FakeRequest = HostRequester<HostRpcRegistry>["request"];

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

/**
 * The account every fixture identity below belongs to. The signed-in fixture
 * and the recorded sources have to name the SAME owner: a cloud source carries
 * the identity it was minted under and is not spendable under another.
 */
const OWNER = "user-1";

function summary(): CloudChatSummary {
  return {
    identity: {
      taskId: "scp_1",
      chatId: "draft-1",
      ownerUserId: OWNER,
    },
    ownerHostId: OWNER_HOST,
    createdAt: 1,
    visibility: "private",
    title: null,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: "ab".repeat(32),
    publishedAt: 9,
    throughRecordSeq: 1,
    isOwnedByViewer: true,
  };
}

/** A `new-chat` document naming `hashes`, projected the way the cloud feed does. */
function newChatDocument(
  cloudSummary: CloudChatSummary,
  hashes: readonly string[],
): DraftDocument {
  const record: DraftHeadReaderRecord = {
    dialect: "draft/v1",
    schemaVersion: DRAFT_HEAD_SCHEMA_VERSION,
    kind: "draft",
    surfaceKind: "new-chat",
    lastTouchedAt: 5,
    target: { epicId: "epic-1", chatId: null, blockId: null },
    hostLocal: { hostId: OWNER_HOST, workspace: null },
    portable: {
      content: EMPTY_DOC,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [...hashes],
      closed: false,
    },
  };
  return draftDocumentFromCloudHead(cloudSummary, record);
}

/** A `stash-entry` document naming `hashes` - the excluded kind (decision K). */
function stashDocument(
  cloudSummary: CloudChatSummary,
  hashes: readonly string[],
): DraftDocument {
  const record: DraftHeadReaderRecord = {
    dialect: "draft/v1",
    schemaVersion: DRAFT_HEAD_SCHEMA_VERSION,
    kind: "stash-entry",
    lastTouchedAt: 5,
    target: { epicId: null, chatId: null, blockId: null },
    hostLocal: { hostId: OWNER_HOST, workspace: null },
    portable: {
      content: EMPTY_DOC,
      blobHashes: [...hashes],
      createdAt: 1,
      annotations: [],
    },
  };
  return draftDocumentFromCloudHead(cloudSummary, record);
}

async function sha256HexOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  return btoa(String.fromCharCode(...bytes));
}

function bytesA(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([11, 22, 33, 44]);
}

/**
 * A DIFFERENT payload, so its digest cannot collide with `bytesA`'s. The
 * landing image store's in-memory session cache outlives
 * `installFreshIndexedDb()`, so a test asserting that bytes are ABSENT has to
 * use a hash no earlier test in this file stored.
 */
function bytesRefused(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([55, 66, 77, 88, 99]);
}

/**
 * Mounts a draft-mirror session for `INGESTING_HOST` whose `request` answers
 * `drafts.list` (session bootstrap) plus whatever `handleOther` supplies, and
 * records every call.
 */
function mountIngestingHostSession(
  handleOther: (method: string, params: unknown) => unknown,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const request: FakeRequest = ((method, params) => {
    calls.push({ method, params });
    if (method === "drafts.list") {
      return Promise.resolve({
        drafts: [],
        tombstones: [],
        snapshotSeq: 0,
        scopeId: null,
      });
    }
    return handleOther(method, params);
  }) as FakeRequest;
  acquireDraftMirrorSession({
    hostId: INGESTING_HOST,
    client: { request } as never,
    streamClient: fakeDraftStreamClient(),
    timing: undefined,
  });
  return calls;
}

beforeEach(() => {
  installFreshIndexedDb();
  useAuthStore.setState({
    status: "signed-in",
    // The store guarantees non-null `contextMetadata` in every signed-in
    // state, and the owner id in it is what scopes a cloud source: a record
    // minted under one account is not spendable under another. A bare
    // `{ status: "signed-in" }` is a state production cannot produce, and it
    // made every source here look like another account's.
    contextMetadata: { userId: OWNER, username: OWNER },
  });
});

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
  usePromptStashStore.setState({ rows: [] });
  // A dirty new-chat row makes every later apply keep its local content, so
  // leaving one behind silently disarms the tests that follow.
  useNewConversationModalStore.setState({ draftPatchesByEpicId: {} });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("ingestCloudDraftSummary - cloud image recovery", () => {
  it("recovers bytes for a hash whose owner host has no mirror on this window (case A)", async () => {
    const bytes = bytesA();
    const hash = await sha256HexOf(bytes);
    const calls = mountIngestingHostSession((method, params) => {
      if (method === "epic.readCloudChatPayload") {
        return Promise.resolve({
          outcome: {
            status: "ok" as const,
            bytesBase64: toBase64(bytes),
            byteLength: bytes.byteLength,
          },
        });
      }
      throw new Error(`unexpected ${String(method)} ${JSON.stringify(params)}`);
    });
    await Promise.resolve(); // let acquireDraftMirrorSession's `list` settle

    const cloudSummary = summary();
    const document = newChatDocument(cloudSummary, [hash]);

    await ingestCloudDraftSummary({
      hostId: INGESTING_HOST,
      // Captured where the head read was issued.
      readOwner: OWNER,
      summary: cloudSummary,
      document,
    });

    expect(await getImageBytes(hash)).toEqual(bytes);

    const readCall = calls.find(
      (call) => call.method === "epic.readCloudChatPayload",
    );
    expect(readCall).toBeDefined();
    expect(readCall?.params).toEqual({
      ...cloudSummary.identity,
      ref: { kind: "image-attachment", sha256: hash },
    });
    // There is no mirror for the owner host, so `drafts.readBlob` - which
    // only ever targets `document.ownerHostId` - must never be requested.
    expect(calls.some((call) => call.method === "drafts.readBlob")).toBe(false);
  });

  it("does not recover images for a document the store refused (DRIVE RED)", async () => {
    // `applyHostDocument` abandons for several reasons that have nothing to do
    // with identity - a retired draft, a pending delete, a newer apply, an
    // older revision, and this one: a DIRTY local row, which keeps its own
    // text and takes only the identity. The document's hashes are not rooted
    // in any of those cases, yet recovery used to run anyway - and
    // `putImageBytesAtHash` seeds a session entry that is itself a GC root, so
    // the bytes stay resident with nothing left to release them.
    const bytes = bytesRefused();
    const hash = await sha256HexOf(bytes);
    const calls = mountIngestingHostSession((method, params) => {
      if (method === "epic.readCloudChatPayload") {
        return Promise.resolve({
          outcome: {
            status: "ok" as const,
            bytesBase64: toBase64(bytes),
            byteLength: bytes.byteLength,
          },
        });
      }
      throw new Error(`unexpected ${String(method)} ${JSON.stringify(params)}`);
    });
    await Promise.resolve();

    // The user is typing in this epic's new-conversation modal: generation is
    // ahead of syncedGeneration, so the incoming document takes the identity
    // and leaves the local text alone.
    useNewConversationModalStore.getState().setContent("epic-1", {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "mine" }] },
      ],
    });

    const cloudSummary = summary();
    await ingestCloudDraftSummary({
      hostId: INGESTING_HOST,
      readOwner: OWNER,
      summary: cloudSummary,
      document: newChatDocument(cloudSummary, [hash]),
    });

    // Nothing fetched, and nothing resident.
    expect(
      calls.some((call) => call.method === "epic.readCloudChatPayload"),
    ).toBe(false);
    expect(await getImageBytes(hash)).toBeUndefined();
  });

  it("hands a stash document's images to the ingest, fetched BEFORE the apply", async () => {
    // Stash rows were once excluded from cloud recovery, deliberately: recovery
    // ran AFTER the apply and wrote into this window's image partition, which is
    // not where a stash row's bytes live. `ingestRemote` carries them in the SAME
    // durable write as the row and returns early once the row exists, so "after
    // the apply" was never late for a stash entry - it was never.
    //
    // Asserted at the handover rather than through the repository: this file's
    // harness cannot drive the real prompt-stash IndexedDB (`hydrate()` answers
    // "This browser does not support IndexedDB" here), and the repository's own
    // durability is covered by `prompt-stash-store` and the real-repository
    // handoff suite. What is new HERE is that a populated map reaches the ingest
    // at all, and reaches it before the row is written.
    //
    // Bytes unique to this test. The case this replaces reused `bytesA()`, which
    // an earlier test in this file had already stored, so the hash was in the
    // partition before the ingest ran and NO fetch was issued whatever the rule
    // was - it asserted "no payload read" and would have passed just the same
    // with the exclusion removed.
    const stashBytes = new Uint8Array([61, 62, 63, 64]);
    const stashHash = await sha256HexOf(stashBytes);
    const handed: Array<ReadonlyMap<string, { readonly mimeType: string }>> =
      [];
    usePromptStashStore.setState({
      ingestRemote: (_entry, imagesByHash) => {
        handed.push(imagesByHash);
        return Promise.resolve();
      },
    });

    const calls = mountIngestingHostSession((method) => {
      if (method === "epic.readCloudChatPayload") {
        return Promise.resolve({
          outcome: {
            status: "ok" as const,
            bytesBase64: toBase64(stashBytes),
            byteLength: stashBytes.byteLength,
          },
        });
      }
      throw new Error(`unexpected ${String(method)}`);
    });
    await Promise.resolve();

    const cloudSummary = summary();
    await ingestCloudDraftSummary({
      hostId: INGESTING_HOST,
      // Captured where the head read was issued.
      readOwner: OWNER,
      summary: cloudSummary,
      document: stashDocument(cloudSummary, [stashHash]),
    });

    expect(
      calls.some((call) => call.method === "epic.readCloudChatPayload"),
    ).toBe(true);
    expect(handed).toHaveLength(1);
    expect([...(handed[0]?.keys() ?? [])]).toEqual([stashHash]);
    // Sniffed from the bytes, never from the document's own attr, so this map
    // says what `readDraftBlobs` says about the same bytes.
    expect(handed[0]?.get(stashHash)?.mimeType).toBe("image/png");
  });

  it("still applies a stash document when the image fetch fails", async () => {
    // A stash entry that lands without its images is the status quo and still
    // restores its text. One that does not land AT ALL because a blob read threw
    // would be a regression, so the fetch is never fatal to the apply.
    const missingHash = await sha256HexOf(new Uint8Array([71, 72, 73, 74]));
    const handed: Array<ReadonlyMap<string, unknown>> = [];
    usePromptStashStore.setState({
      ingestRemote: (_entry, imagesByHash) => {
        handed.push(imagesByHash);
        return Promise.resolve();
      },
    });

    mountIngestingHostSession((method) => {
      if (method === "epic.readCloudChatPayload") {
        return Promise.reject(new Error("payload read exploded"));
      }
      throw new Error(`unexpected ${String(method)}`);
    });
    await Promise.resolve();

    const cloudSummary = summary();
    await ingestCloudDraftSummary({
      hostId: INGESTING_HOST,
      // Captured where the head read was issued.
      readOwner: OWNER,
      summary: cloudSummary,
      document: stashDocument(cloudSummary, [missingHash]),
    });

    // The row was still ingested - with an empty map, which is the pre-existing
    // behaviour for a stash entry whose bytes cannot be found.
    expect(handed).toHaveLength(1);
    expect(handed[0]?.size).toBe(0);
  });

  it("memoizes a host that withholds the payload read, and re-probes it on a new mirror session", async () => {
    const bytes = new Uint8Array([91, 92, 93]);
    const hash = await sha256HexOf(bytes);
    const cloudSummary = summary();
    const ingestOnce = (): Promise<void> =>
      ingestCloudDraftSummary({
        hostId: INGESTING_HOST,
        // Captured where the head read was issued.
        readOwner: OWNER,
        summary: cloudSummary,
        document: newChatDocument(cloudSummary, [hash]),
      });
    const payloadReads = (calls: RecordedCall[]): number =>
      calls.filter((call) => call.method === "epic.readCloudChatPayload")
        .length;

    const refusingCalls = mountIngestingHostSession((method) => {
      if (method === "epic.readCloudChatPayload") {
        return Promise.reject(
          new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            message: "host predates the cloud-chat surface",
            requestId: "r1",
            method: "epic.readCloudChatPayload",
            fatalDetails: null,
          }),
        );
      }
      throw new Error(`unexpected ${String(method)}`);
    });
    await Promise.resolve();

    await ingestOnce();
    expect(payloadReads(refusingCalls)).toBe(1);
    expect(await getImageBytes(hash)).toBeUndefined();

    // A second ingest against the SAME session spends no request: an old host
    // answers this for every image, so it is remembered once.
    await ingestOnce();
    expect(payloadReads(refusingCalls)).toBe(1);

    // A new mirror session is a new host connection, so the memo is dropped
    // and a host that upgraded while this renderer stayed up is asked again -
    // the wiring in `acquireDraftMirrorSession`. Without that reset the ingest
    // below would spend zero requests and store nothing.
    releaseDraftMirrorSession(INGESTING_HOST);
    const upgradedCalls = mountIngestingHostSession((method) => {
      if (method === "epic.readCloudChatPayload") {
        return Promise.resolve({
          outcome: {
            status: "ok" as const,
            bytesBase64: toBase64(bytes),
            byteLength: bytes.byteLength,
          },
        });
      }
      throw new Error(`unexpected ${String(method)}`);
    });
    await Promise.resolve();

    await ingestOnce();
    expect(payloadReads(upgradedCalls)).toBe(1);
    expect(await getImageBytes(hash)).toEqual(bytes);
  });
});
