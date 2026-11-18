import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { DraftHeadReaderRecord } from "@traycer/protocol/persistence/draft/schemas";
import { DRAFT_HEAD_SCHEMA_VERSION } from "@traycer/protocol/persistence/draft/version";
import type { DraftDocument } from "@traycer/protocol/host";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { getImageBytes } from "@/lib/composer/landing-image-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { draftDocumentFromCloudHead } from "@/lib/drafts/cloud-draft-apply";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  acquireDraftMirrorSession,
  ingestCloudDraftSummary,
  noteCloudDraftHeadHost,
  releaseDraftMirrorSession,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import { resetStashMigrationForTests } from "@/lib/drafts/stash-migration";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { resolveDraftImageBytes } from "@/lib/drafts/resolve-draft-image-bytes";

const INGESTING_HOST = "host-a";
const OWNER_HOST = "host-b"; // never mirrored on this window
const OTHER_MOUNTED_HOST = "host-c"; // mirrored here, and lists the same row
const SECOND_OTHER_MOUNTED_HOST = "host-d"; // mirrored here, remembered after host-c
const LATE_MOUNTED_HOST = "host-e"; // mounts and is remembered mid-pass
const EMPTY_DOC = {
  type: "doc" as const,
  content: [{ type: "paragraph" }],
};

type FakeRequest = HostRequester<HostRpcRegistry>["request"];

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

function cloudPayloadImageHash(params: unknown): string | null {
  if (typeof params !== "object" || params === null || !("ref" in params)) {
    return null;
  }
  const ref = params.ref;
  if (
    typeof ref !== "object" ||
    ref === null ||
    !("sha256" in ref) ||
    typeof ref.sha256 !== "string"
  ) {
    return null;
  }
  return ref.sha256;
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
  mimeType: string,
  byteLength: number,
): DraftDocument {
  const record: DraftHeadReaderRecord = {
    dialect: "draft/v1",
    schemaVersion: DRAFT_HEAD_SCHEMA_VERSION,
    kind: "stash-entry",
    lastTouchedAt: 5,
    target: { epicId: null, chatId: null, blockId: null },
    hostLocal: { hostId: OWNER_HOST, workspace: null },
    portable: {
      content: stashContent(hashes, mimeType, byteLength),
      blobHashes: [...hashes],
      createdAt: 1,
      annotations: [],
    },
  };
  return draftDocumentFromCloudHead(cloudSummary, record);
}

/**
 * A stash document's content, with one image node per hash. The conversion
 * imports what the CONTENT names, not what `blobHashes` lists, so a hash with
 * no node in the document is never read for.
 */
function stashContent(
  hashes: readonly string[],
  mimeType: string,
  byteLength: number,
): JsonContent {
  return {
    type: "doc",
    content: [
      ...hashes.map((hash, index) => ({
        type: "imageAttachment",
        attrs: {
          id: `image-${String(index)}`,
          fileName: "shot.gif",
          mimeType,
          size: byteLength,
          hash,
        },
      })),
      { type: "paragraph", content: [{ type: "text", text: "stashed words" }] },
    ],
  };
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

/**
 * A payload distinct from the cold-boot fixtures above. The
 * landing image store's in-memory session cache outlives
 * `installFreshIndexedDb()`, so a test asserting that bytes are ABSENT has to
 * use a hash no earlier test in this file stored.
 */
function bytesRefused(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([55, 66, 77, 88, 99]);
}

/**
 * Bytes that sniff to `image/png`, which is all the stash fetch needs of them.
 * `tail` makes each test's digest its own: the session cache outlives the
 * IndexedDB reset, and the transfer is single-flight per digest.
 */
function pngBytesWithTail(tail: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    tail,
    tail + 1,
  ]);
}

function payloadReadCount(calls: readonly RecordedCall[]): number {
  return calls.filter((call) => call.method === "epic.readCloudChatPayload")
    .length;
}

/**
 * Mounts a draft-mirror session for `INGESTING_HOST` whose `request` answers
 * `drafts.list` (session bootstrap) plus whatever `handleOther` supplies, and
 * records every call.
 */
function mountIngestingHostSession(
  handleOther: (method: string, params: unknown) => unknown,
): RecordedCall[] {
  return mountHostSession(INGESTING_HOST, handleOther);
}

/** The same, for any host: a second mounted session needs its own requester. */
function mountHostSession(
  hostId: string,
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
    hostId,
    client: { request } as never,
    streamClient: fakeDraftStreamClient(),
    timing: undefined,
  });
  return calls;
}

beforeEach(() => {
  installFreshIndexedDb();
  window.localStorage.clear();
  resetStashMigrationForTests();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
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
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  // A dirty new-chat row makes every later apply keep its local content, so
  // leaving one behind silently disarms the tests that follow.
  useNewConversationModalStore.setState({ draftPatchesByEpicId: {} });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("ingestCloudDraftSummary - cloud image recovery", () => {
  it("records six cloud image sources without reading payloads until a draft needs bytes", async () => {
    const images = await Promise.all(
      Array.from({ length: 6 }, async (_unused, index) => {
        const bytes = new Uint8Array([101 + index, 201, 37, 49]);
        return { hash: await sha256HexOf(bytes), bytes };
      }),
    );
    const firstImage = images[0];
    const imagesByHash = new Map(
      images.map((image) => [image.hash, image] as const),
    );
    const calls = mountIngestingHostSession((method, params) => {
      if (method === "epic.readCloudChatPayload") {
        const hash = cloudPayloadImageHash(params);
        const image = hash === null ? undefined : imagesByHash.get(hash);
        if (image === undefined) {
          throw new Error(`unexpected cloud image hash ${String(hash)}`);
        }
        return Promise.resolve({
          outcome: {
            status: "ok" as const,
            bytesBase64: toBase64(image.bytes),
            byteLength: image.bytes.byteLength,
          },
        });
      }
      throw new Error(`unexpected ${String(method)} ${JSON.stringify(params)}`);
    });
    await Promise.resolve(); // let acquireDraftMirrorSession's `list` settle

    const cloudSummary = summary();

    await ingestCloudDraftSummary({
      hostId: INGESTING_HOST,
      // Captured where the head read was issued.
      readOwner: OWNER,
      summary: cloudSummary,
      document: newChatDocument(
        cloudSummary,
        images.map(({ hash }) => hash),
      ),
    });

    // The old eager ingest issued one payload read per image. Six hashes
    // reproduce the six reads seen during a cold boot; bootstrap now records
    // only their cloud addresses, and leaves the cleared local image bytes
    // absent.
    expect(
      calls.filter((call) => call.method === "epic.readCloudChatPayload"),
    ).toHaveLength(0);
    for (const { hash } of images) {
      expect(await getImageBytes(hash)).toBeUndefined();
    }

    // This shared demand path is used when a visible draft renders an image or
    // submit needs to inline it. The recorded address remains usable lazily.
    await expect(
      resolveDraftImageBytes(firstImage.hash, {
        hostId: null,
        client: null,
      }),
    ).resolves.toEqual(firstImage.bytes);
    const readCalls = calls.filter(
      (call) => call.method === "epic.readCloudChatPayload",
    );
    expect(readCalls).toHaveLength(1);
    expect(readCalls[0]?.params).toEqual({
      ...cloudSummary.identity,
      ref: { kind: "image-attachment", sha256: firstImage.hash },
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

  it("hands a stash document's images to the conversion, fetched BEFORE the apply", async () => {
    // Stash rows were once excluded from cloud recovery, deliberately: recovery
    // ran AFTER the apply and wrote into this window's image partition, which
    // is not where a stash row's bytes lived. They now go exactly there - the
    // conversion installs a start-page draft whose images ARE landing images -
    // so the fetch has to happen before the apply, while the map it produces is
    // still the conversion's only way to read them.
    //
    // A real GIF87a header. Two things ride on it. The blob must SNIFF to a
    // canonical type at all - the fetch refuses to mint a label it cannot
    // justify. And the type must not be the `image/png` the transport falls
    // back to, or the assertion below would hold just as well with the sniff
    // removed.
    const stashBytes = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00,
    ]);
    const stashHash = await sha256HexOf(stashBytes);

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
      document: stashDocument(
        cloudSummary,
        [stashHash],
        "image/gif",
        stashBytes.byteLength,
      ),
    });

    expect(
      calls.some((call) => call.method === "epic.readCloudChatPayload"),
    ).toBe(true);
    const drafts = useLandingDraftStore.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.closed).toBe(true);
    // The image node survived the conversion, and its bytes are RESIDENT in
    // this window's landing partition - which is only reachable if the fetched
    // map reached the import. Without it `importImagesIntoLanding` throws
    // `ImageBlobMissingError` and the original content is installed with a
    // hash nothing holds. (The landing hash equals the source hash here: both
    // are the sha256 of the same bytes, so residency is the discriminator, not
    // a rewrite.)
    expect(JSON.stringify(drafts[0]?.content)).toContain("imageAttachment");
    expect(await getImageBytes(stashHash)).toEqual(stashBytes);
  });

  it("still converts a stash document when the image fetch fails", async () => {
    // A converted draft that lands without its images still carries its text,
    // and a hash whose bytes never arrived renders as unavailable. One that
    // does not land AT ALL because a blob read threw would be a regression, so
    // the fetch is never fatal to the apply.
    const missingBytes = new Uint8Array([71, 72, 73, 74]);
    const missingHash = await sha256HexOf(missingBytes);

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
      document: stashDocument(
        cloudSummary,
        [missingHash],
        "image/png",
        missingBytes.byteLength,
      ),
    });

    const drafts = useLandingDraftStore.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(JSON.stringify(drafts[0]?.content)).toContain("stashed words");
    // The original hash, un-rewritten: nothing was imported.
    expect(JSON.stringify(drafts[0]?.content)).toContain(missingHash);
  });

  it("converts with no images when the cloud's bytes are not a decodable image", async () => {
    // The fetch refuses to mint a label it cannot justify, so a stash row whose
    // cloud bytes sniff to nothing arrives with an EMPTY map - and the
    // conversion installs the original content rather than failing outright.
    const junk = new Uint8Array([1, 2, 3, 4]);
    const junkHash = await sha256HexOf(junk);

    mountIngestingHostSession((method) => {
      if (method === "epic.readCloudChatPayload") {
        return Promise.resolve({
          outcome: {
            status: "ok" as const,
            bytesBase64: toBase64(junk),
            byteLength: junk.byteLength,
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
      document: stashDocument(
        cloudSummary,
        [junkHash],
        "image/png",
        junk.byteLength,
      ),
    });

    const drafts = useLandingDraftStore.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(JSON.stringify(drafts[0]?.content)).toContain(junkHash);
  });

  describe("a stash document whose ingesting host misses an image", () => {
    const INGESTING_MISSES: ReadonlyArray<
      readonly [string, number, () => Promise<unknown>]
    > = [
      [
        "a rejected read",
        120,
        () => Promise.reject(new Error("payload read exploded")),
      ],
      [
        "an unavailable outcome",
        130,
        () => Promise.resolve({ outcome: { status: "unavailable" as const } }),
      ],
    ];

    it.each(INGESTING_MISSES)(
      "converts with the bytes another host that listed the row still holds, asking the ingesting host first: %s",
      async (_name, tail, ingestingAnswer) => {
        // A stash entry is converted BEFORE its head settles, and the
        // conversion retires the source row, so a byte the ingesting host's
        // cloud read misses is lost for good unless the conversion asks the
        // other hosts the row was shown on. The second host's mount skipped the
        // head (`noteCloudDraftHeadHost`) while the read was in flight, which
        // remembers it on the row; recovery then records it behind the
        // ingesting host, which stays the first address tried.
        const bytes = pngBytesWithTail(tail);
        const hash = await sha256HexOf(bytes);
        const askedHosts: string[] = [];

        const ingestingCalls = mountHostSession(INGESTING_HOST, (method) => {
          if (method === "epic.readCloudChatPayload") {
            askedHosts.push(INGESTING_HOST);
            return ingestingAnswer();
          }
          throw new Error(`unexpected ${String(method)}`);
        });
        const otherCalls = mountHostSession(OTHER_MOUNTED_HOST, (method) => {
          if (method === "epic.readCloudChatPayload") {
            askedHosts.push(OTHER_MOUNTED_HOST);
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

        const cloudSummary = summary();
        noteCloudDraftHeadHost(cloudSummary, OTHER_MOUNTED_HOST);
        await ingestCloudDraftSummary({
          hostId: INGESTING_HOST,
          readOwner: OWNER,
          summary: cloudSummary,
          document: stashDocument(
            cloudSummary,
            [hash],
            "image/png",
            bytes.byteLength,
          ),
        });

        expect(askedHosts).toEqual([INGESTING_HOST, OTHER_MOUNTED_HOST]);
        expect(payloadReadCount(ingestingCalls)).toBe(1);
        expect(payloadReadCount(otherCalls)).toBe(1);
        const drafts = useLandingDraftStore.getState().drafts;
        expect(drafts).toHaveLength(1);
        expect(JSON.stringify(drafts[0]?.content)).toContain("imageAttachment");
        // Resident in the landing partition: the fallback host's bytes reached
        // the import, so the image is not a hash-only unavailable one.
        expect(await getImageBytes(hash)).toEqual(bytes);
      },
    );

    it("converts hash-only after one request when no other host is remembered on the row", async () => {
      // Control: the second host is mounted but never noted the head, so the
      // registry holds the ingesting host alone and the previous behaviour
      // stands.
      const bytes = pngBytesWithTail(140);
      const hash = await sha256HexOf(bytes);

      const ingestingCalls = mountHostSession(INGESTING_HOST, (method) => {
        if (method === "epic.readCloudChatPayload") {
          return Promise.reject(new Error("payload read exploded"));
        }
        throw new Error(`unexpected ${String(method)}`);
      });
      const otherCalls = mountHostSession(OTHER_MOUNTED_HOST, (method) => {
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

      const cloudSummary = summary();
      await ingestCloudDraftSummary({
        hostId: INGESTING_HOST,
        readOwner: OWNER,
        summary: cloudSummary,
        document: stashDocument(
          cloudSummary,
          [hash],
          "image/png",
          bytes.byteLength,
        ),
      });

      expect(payloadReadCount(ingestingCalls)).toBe(1);
      expect(payloadReadCount(otherCalls)).toBe(0);
      const drafts = useLandingDraftStore.getState().drafts;
      expect(drafts).toHaveLength(1);
      expect(JSON.stringify(drafts[0]?.content)).toContain(hash);
      expect(await getImageBytes(hash)).toBeUndefined();
    });

    interface PayloadAsk {
      readonly hostId: string;
      readonly hash: string;
    }

    /**
     * Mounts `hostId` so that it serves exactly the payloads in `holds` and
     * reports every other hash as unavailable, recording each ask.
     */
    function mountHoldingHost(
      hostId: string,
      holds: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
      asks: PayloadAsk[],
    ): RecordedCall[] {
      return mountHostSession(hostId, (method, params) => {
        if (method !== "epic.readCloudChatPayload") {
          throw new Error(`unexpected ${String(method)}`);
        }
        const hash = cloudPayloadImageHash(params);
        if (hash === null) throw new Error("payload read without a hash");
        asks.push({ hostId, hash });
        const held = holds.get(hash);
        if (held === undefined) {
          return Promise.resolve({
            outcome: { status: "unavailable" as const },
          });
        }
        return Promise.resolve({
          outcome: {
            status: "ok" as const,
            bytesBase64: toBase64(held),
            byteLength: held.byteLength,
          },
        });
      });
    }

    function hostsAsked(asks: readonly PayloadAsk[]): string[] {
      return [...new Set(asks.map((ask) => ask.hostId))];
    }

    function hashesAskedOf(
      asks: readonly PayloadAsk[],
      hostId: string,
    ): string[] {
      return asks
        .filter((ask) => ask.hostId === hostId)
        .map((ask) => ask.hash)
        .sort();
    }

    it("asks each remembered host only for the hashes still missing, until every image is recovered", async () => {
      // Two images, three hosts: the ingesting host holds neither, the first
      // remembered host holds only the first, the second holds the second. The
      // pass must not stop at one fallback host (the second image would be lost
      // when the conversion retires the row), and must not ask the second
      // fallback host for the image the first already served.
      const firstBytes = pngBytesWithTail(150);
      const secondBytes = pngBytesWithTail(152);
      const firstHash = await sha256HexOf(firstBytes);
      const secondHash = await sha256HexOf(secondBytes);
      const asks: PayloadAsk[] = [];

      mountHoldingHost(INGESTING_HOST, new Map(), asks);
      mountHoldingHost(
        OTHER_MOUNTED_HOST,
        new Map([[firstHash, firstBytes]]),
        asks,
      );
      mountHoldingHost(
        SECOND_OTHER_MOUNTED_HOST,
        new Map([[secondHash, secondBytes]]),
        asks,
      );
      await Promise.resolve();

      const cloudSummary = summary();
      noteCloudDraftHeadHost(cloudSummary, OTHER_MOUNTED_HOST);
      noteCloudDraftHeadHost(cloudSummary, SECOND_OTHER_MOUNTED_HOST);
      await ingestCloudDraftSummary({
        hostId: INGESTING_HOST,
        readOwner: OWNER,
        summary: cloudSummary,
        document: stashDocument(
          cloudSummary,
          [firstHash, secondHash],
          "image/png",
          firstBytes.byteLength,
        ),
      });

      // Hosts are asked in the order they were remembered, the reading host
      // first.
      expect(hostsAsked(asks)).toEqual([
        INGESTING_HOST,
        OTHER_MOUNTED_HOST,
        SECOND_OTHER_MOUNTED_HOST,
      ]);
      // The reading host was asked for both. (Its address stays behind the
      // newer ones on each hash's recorded list, so a later host's walk may ask
      // it again for a hash that host missed; the contract here is who was
      // asked for what, not how many times the older address was retried.)
      expect([...new Set(hashesAskedOf(asks, INGESTING_HOST))]).toEqual(
        [firstHash, secondHash].sort(),
      );
      // The first fallback host was asked for both, once each.
      expect(hashesAskedOf(asks, OTHER_MOUNTED_HOST)).toEqual(
        [firstHash, secondHash].sort(),
      );
      // Only the hash still missing after the first fallback host.
      expect(hashesAskedOf(asks, SECOND_OTHER_MOUNTED_HOST)).toEqual([
        secondHash,
      ]);
      const drafts = useLandingDraftStore.getState().drafts;
      expect(drafts).toHaveLength(1);
      expect(JSON.stringify(drafts[0]?.content)).toContain("imageAttachment");
      expect(await getImageBytes(firstHash)).toEqual(firstBytes);
      expect(await getImageBytes(secondHash)).toEqual(secondBytes);
    });

    it("never asks a later remembered host once an earlier one served everything missing", async () => {
      const bytes = pngBytesWithTail(154);
      const hash = await sha256HexOf(bytes);
      const asks: PayloadAsk[] = [];

      mountHoldingHost(INGESTING_HOST, new Map(), asks);
      mountHoldingHost(OTHER_MOUNTED_HOST, new Map([[hash, bytes]]), asks);
      const laterCalls = mountHoldingHost(
        SECOND_OTHER_MOUNTED_HOST,
        new Map([[hash, bytes]]),
        asks,
      );
      await Promise.resolve();

      const cloudSummary = summary();
      noteCloudDraftHeadHost(cloudSummary, OTHER_MOUNTED_HOST);
      noteCloudDraftHeadHost(cloudSummary, SECOND_OTHER_MOUNTED_HOST);
      await ingestCloudDraftSummary({
        hostId: INGESTING_HOST,
        readOwner: OWNER,
        summary: cloudSummary,
        document: stashDocument(
          cloudSummary,
          [hash],
          "image/png",
          bytes.byteLength,
        ),
      });

      expect(asks).toEqual([
        { hostId: INGESTING_HOST, hash },
        { hostId: OTHER_MOUNTED_HOST, hash },
      ]);
      expect(payloadReadCount(laterCalls)).toBe(0);
      expect(await getImageBytes(hash)).toEqual(bytes);
    });

    /**
     * Mounts `OTHER_MOUNTED_HOST` so its payload read stays pending until the
     * returned `open` is called, then answers it as a miss. `asks` records the
     * hash of each read it receives, so a test can tell the read is in flight.
     */
    function mountHostWithHeldRead(asks: string[]): { open: () => void } {
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      mountHostSession(OTHER_MOUNTED_HOST, (method, params) => {
        if (method !== "epic.readCloudChatPayload") {
          throw new Error(`unexpected ${String(method)}`);
        }
        const hash = cloudPayloadImageHash(params);
        if (hash === null) throw new Error("payload read without a hash");
        asks.push(hash);
        return gate.then(() => ({
          outcome: { status: "unavailable" as const },
        }));
      });
      return { open };
    }

    it("asks a fallback host through the requester it holds when its turn comes, not the one it held when the pass began", async () => {
      // host-d is released and re-acquired (a new requester) while host-c's
      // read is pending. The pass snapshotted host ids only, so host-d is
      // looked up after host-c answers and reaches the NEW requester; the old
      // one is closed and would have failed for nothing.
      const bytes = pngBytesWithTail(160);
      const hash = await sha256HexOf(bytes);
      const ingestingAsks: PayloadAsk[] = [];
      const heldReadAsks: string[] = [];
      const staleAsks: PayloadAsk[] = [];
      const freshAsks: PayloadAsk[] = [];

      mountHoldingHost(INGESTING_HOST, new Map(), ingestingAsks);
      const heldRead = mountHostWithHeldRead(heldReadAsks);
      const staleCalls = mountHoldingHost(
        SECOND_OTHER_MOUNTED_HOST,
        new Map([[hash, bytes]]),
        staleAsks,
      );
      await Promise.resolve();

      const cloudSummary = summary();
      noteCloudDraftHeadHost(cloudSummary, OTHER_MOUNTED_HOST);
      noteCloudDraftHeadHost(cloudSummary, SECOND_OTHER_MOUNTED_HOST);
      const ingest = ingestCloudDraftSummary({
        hostId: INGESTING_HOST,
        readOwner: OWNER,
        summary: cloudSummary,
        document: stashDocument(
          cloudSummary,
          [hash],
          "image/png",
          bytes.byteLength,
        ),
      });
      await vi.waitFor(() => {
        expect(heldReadAsks).toEqual([hash]);
      });

      // The pass is parked on host-c. Replace host-d's session underneath it.
      releaseDraftMirrorSession(SECOND_OTHER_MOUNTED_HOST);
      const freshCalls = mountHoldingHost(
        SECOND_OTHER_MOUNTED_HOST,
        new Map([[hash, bytes]]),
        freshAsks,
      );
      await Promise.resolve();

      heldRead.open();
      await ingest;

      expect(freshAsks).toEqual([{ hostId: SECOND_OTHER_MOUNTED_HOST, hash }]);
      expect(payloadReadCount(freshCalls)).toBe(1);
      expect(staleAsks).toEqual([]);
      expect(payloadReadCount(staleCalls)).toBe(0);
      const drafts = useLandingDraftStore.getState().drafts;
      expect(drafts).toHaveLength(1);
      expect(JSON.stringify(drafts[0]?.content)).toContain("imageAttachment");
      expect(await getImageBytes(hash)).toEqual(bytes);
    });

    it("skips a fallback host whose session was released while an earlier host was being asked, and converts hash-only", async () => {
      const bytes = pngBytesWithTail(162);
      const hash = await sha256HexOf(bytes);
      const ingestingAsks: PayloadAsk[] = [];
      const heldReadAsks: string[] = [];
      const releasedAsks: PayloadAsk[] = [];

      mountHoldingHost(INGESTING_HOST, new Map(), ingestingAsks);
      const heldRead = mountHostWithHeldRead(heldReadAsks);
      const releasedCalls = mountHoldingHost(
        SECOND_OTHER_MOUNTED_HOST,
        new Map([[hash, bytes]]),
        releasedAsks,
      );
      await Promise.resolve();

      const cloudSummary = summary();
      noteCloudDraftHeadHost(cloudSummary, OTHER_MOUNTED_HOST);
      noteCloudDraftHeadHost(cloudSummary, SECOND_OTHER_MOUNTED_HOST);
      const ingest = ingestCloudDraftSummary({
        hostId: INGESTING_HOST,
        readOwner: OWNER,
        summary: cloudSummary,
        document: stashDocument(
          cloudSummary,
          [hash],
          "image/png",
          bytes.byteLength,
        ),
      });
      await vi.waitFor(() => {
        expect(heldReadAsks).toEqual([hash]);
      });

      releaseDraftMirrorSession(SECOND_OTHER_MOUNTED_HOST);
      heldRead.open();
      await expect(ingest).resolves.toBeUndefined();

      expect(releasedAsks).toEqual([]);
      expect(payloadReadCount(releasedCalls)).toBe(0);
      const drafts = useLandingDraftStore.getState().drafts;
      expect(drafts).toHaveLength(1);
      expect(JSON.stringify(drafts[0]?.content)).toContain(hash);
      expect(await getImageBytes(hash)).toBeUndefined();
    });

    it("asks a host that mounts and is noted on the row while an earlier host's read is pending, once and after that host", async () => {
      // The pass re-reads the row's hosts before every turn, so a host whose
      // mount noted it on the row DURING the pass is asked too, behind the host
      // being waited on, and only once.
      const bytes = pngBytesWithTail(164);
      const hash = await sha256HexOf(bytes);
      const ingestingAsks: PayloadAsk[] = [];
      const heldReadAsks: string[] = [];
      const lateAsks: PayloadAsk[] = [];

      mountHoldingHost(INGESTING_HOST, new Map(), ingestingAsks);
      const heldRead = mountHostWithHeldRead(heldReadAsks);
      await Promise.resolve();

      const cloudSummary = summary();
      noteCloudDraftHeadHost(cloudSummary, OTHER_MOUNTED_HOST);
      const ingest = ingestCloudDraftSummary({
        hostId: INGESTING_HOST,
        readOwner: OWNER,
        summary: cloudSummary,
        document: stashDocument(
          cloudSummary,
          [hash],
          "image/png",
          bytes.byteLength,
        ),
      });
      await vi.waitFor(() => {
        expect(heldReadAsks).toEqual([hash]);
      });

      // The pass is parked on host-c. host-e mounts and notes the row now.
      const lateCalls = mountHoldingHost(
        LATE_MOUNTED_HOST,
        new Map([[hash, bytes]]),
        lateAsks,
      );
      await Promise.resolve();
      noteCloudDraftHeadHost(cloudSummary, LATE_MOUNTED_HOST);
      // Not asked while host-c's read is still pending: it comes after it.
      expect(lateAsks).toEqual([]);

      heldRead.open();
      await ingest;

      expect(heldReadAsks).toEqual([hash]);
      expect(lateAsks).toEqual([{ hostId: LATE_MOUNTED_HOST, hash }]);
      expect(payloadReadCount(lateCalls)).toBe(1);
      const drafts = useLandingDraftStore.getState().drafts;
      expect(drafts).toHaveLength(1);
      expect(JSON.stringify(drafts[0]?.content)).toContain("imageAttachment");
      expect(await getImageBytes(hash)).toEqual(bytes);
    });

    it("asks a host remembered on the row without a session at its first turn once its session mounts during the pass", async () => {
      // host-d is remembered BEFORE host-c but has no session when the pass
      // reaches it, so host-c is asked first. A host skipped for want of a
      // session is not counted as asked: when host-d mounts while host-c's read
      // is pending, it gets its turn after host-c, once.
      const bytes = pngBytesWithTail(166);
      const hash = await sha256HexOf(bytes);
      const ingestingAsks: PayloadAsk[] = [];
      const heldReadAsks: string[] = [];
      const laterAsks: PayloadAsk[] = [];

      mountHoldingHost(INGESTING_HOST, new Map(), ingestingAsks);
      const heldRead = mountHostWithHeldRead(heldReadAsks);
      await Promise.resolve();

      const cloudSummary = summary();
      noteCloudDraftHeadHost(cloudSummary, SECOND_OTHER_MOUNTED_HOST);
      noteCloudDraftHeadHost(cloudSummary, OTHER_MOUNTED_HOST);
      const ingest = ingestCloudDraftSummary({
        hostId: INGESTING_HOST,
        readOwner: OWNER,
        summary: cloudSummary,
        document: stashDocument(
          cloudSummary,
          [hash],
          "image/png",
          bytes.byteLength,
        ),
      });
      await vi.waitFor(() => {
        expect(heldReadAsks).toEqual([hash]);
      });

      const laterCalls = mountHoldingHost(
        SECOND_OTHER_MOUNTED_HOST,
        new Map([[hash, bytes]]),
        laterAsks,
      );
      await Promise.resolve();
      expect(laterAsks).toEqual([]);

      heldRead.open();
      await ingest;

      expect(heldReadAsks).toEqual([hash]);
      expect(laterAsks).toEqual([{ hostId: SECOND_OTHER_MOUNTED_HOST, hash }]);
      expect(payloadReadCount(laterCalls)).toBe(1);
      const drafts = useLandingDraftStore.getState().drafts;
      expect(drafts).toHaveLength(1);
      expect(JSON.stringify(drafts[0]?.content)).toContain("imageAttachment");
      expect(await getImageBytes(hash)).toEqual(bytes);
    });
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
    const resolveOnDemand = () =>
      resolveDraftImageBytes(hash, { hostId: null, client: null });
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
    expect(payloadReads(refusingCalls)).toBe(0);
    await expect(resolveOnDemand()).resolves.toBeNull();
    expect(payloadReads(refusingCalls)).toBe(1);
    expect(await getImageBytes(hash)).toBeUndefined();

    // A second ingest plus another on-demand resolve against the SAME session
    // spends no extra request: an old host answers this for every image, so
    // the unsupported result is remembered once.
    await ingestOnce();
    await expect(resolveOnDemand()).resolves.toBeNull();
    expect(payloadReads(refusingCalls)).toBe(1);

    // A new mirror session is a new host connection, so the memo is dropped
    // and a host that upgraded while this renderer stayed up is asked again -
    // the wiring in `acquireDraftMirrorSession`. The ingest remains read-free;
    // the next on-demand resolve reaches the new session.
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
    expect(payloadReads(upgradedCalls)).toBe(0);
    await expect(resolveOnDemand()).resolves.toEqual(bytes);
    expect(payloadReads(upgradedCalls)).toBe(1);
    // New-chat draft bytes are returned to the waiting resolver and are not
    // admitted to the landing image partition as a persistent root.
    expect(await getImageBytes(hash)).toBeUndefined();
  });
});
