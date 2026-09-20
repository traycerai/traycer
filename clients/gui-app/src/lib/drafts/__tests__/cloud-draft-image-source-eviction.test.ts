/**
 * F3 — `evictUnrootedOverflow` must never drop a hash a live landing draft
 * still names, since `sourcesByHash` is the ONLY hash-to-cloud-address
 * mapping (it holds no bytes itself). Evicting a live row's entry makes that
 * image permanently unrecoverable: the lazy leg answers `null` with no
 * request, and the unchanged head is already in the ingest's `ingested` set,
 * so nothing re-triggers recording. Positive control alongside: an UNROOTED
 * hash recorded early IS still evicted once the map overflows - otherwise
 * this suite would pass just as well against "never evict anything", a
 * different bug from the one `evictUnrootedOverflow` fixes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { getImageBytes } from "@/lib/composer/landing-image-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordCloudDraftImageSources,
  readCloudDraftImageBytes,
  resetCloudDraftImageRecoveryForTests,
} from "@/lib/drafts/cloud-draft-image-recovery";
import type { DraftBlobClient } from "@/lib/drafts/draft-blob-transport";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import {
  emptyLandingDraftWorkspaceSnapshot,
  freshLandingMirrorState,
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";

/**
 * The account every fixture identity below belongs to. The signed-in fixture
 * and the recorded sources have to name the SAME owner: a cloud source carries
 * the identity it was minted under and is not spendable under another.
 */
const OWNER = "user-1";

const IDENTITY: CloudChatIdentity = {
  taskId: "scp_1",
  chatId: "draft-1",
  ownerUserId: OWNER,
};

/** Map overflow point in `cloud-draft-image-recovery.ts`. */
/**
 * Restated, because production does not export it - and safe to restate only
 * because of the positive control below. If the real cap is RAISED, this file's
 * registrations no longer overflow, no eviction runs, the unrooted hash stays
 * addressable and the control fails. So a moved constant shows up as a red test
 * rather than as a suite that quietly stopped exercising eviction at all.
 * If that happens, re-derive the count - do not just bump this literal.
 */
const CLOUD_DRAFT_IMAGE_SOURCE_LIMIT = 512;

type FakeRequest = HostRequester<HostRpcRegistry>["request"];
type FakeHandler = (method: string, params: unknown) => unknown;

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

function recordingClient(handle: FakeHandler): {
  readonly client: DraftBlobClient;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const request = ((method: string, params: unknown) => {
    calls.push({ method, params });
    return handle(method, params);
  }) as FakeRequest;
  return { client: { request, requestWithOptions: request }, calls };
}

function okClient(
  bytesBase64: string,
  byteLength: number,
): { readonly client: DraftBlobClient; readonly calls: RecordedCall[] } {
  return recordingClient((_method, _params) =>
    Promise.resolve({
      outcome: { status: "ok" as const, bytesBase64, byteLength },
    }),
  );
}

/** A client that must never be asked anything - used for hashes expected to
 * be evicted, so a call recorded against it fails the test loudly. */
function neverCalledClient(): {
  readonly client: DraftBlobClient;
  readonly calls: RecordedCall[];
} {
  return recordingClient((_method, _params) =>
    Promise.reject(new Error("this client must never be called")),
  );
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

// Unique per test run - never shared with any other suite's byte content, so
// the landing-image-store session cache (which `installFreshIndexedDb()`
// does not clear) can never satisfy an assertion here with a stale write.
let uniqueByteSeed = 100_000;

function uniqueBytes(length: number): Uint8Array<ArrayBuffer> {
  uniqueByteSeed += 1;
  const seed = uniqueByteSeed;
  return new Uint8Array(
    Array.from({ length }, (_unused, index) => (seed * 17 + index * 3) % 256),
  );
}

/** A single-paragraph doc with one hash-only image node - the shape
 * `landingLiveImageRootHashes` recognizes as a live root via
 * `collectImageAtoms`. */
function imageDoc(hash: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: `node-${hash.slice(0, 8)}`,
              fileName: "live.png",
              hash,
              b64content: null,
              mimeType: "image/png",
              size: 4,
            },
          },
        ],
      },
    ],
  };
}

function makeDraft(input: {
  readonly id: string;
  readonly content: JsonContent;
}): LandingDraftTab {
  return {
    id: input.id,
    content: input.content,
    selection: null,
    lastTouchedAt: 1,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    ...freshLandingMirrorState(),
  };
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
  resetCloudDraftImageRecoveryForTests();
  draftRuntimeRegistry.resetForTesting();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("cloud-draft-image-recovery - source eviction", () => {
  it("keeps a rooted hash's cloud source through overflow, while an unrooted early hash is evicted (positive control)", async () => {
    const rootedBytes = uniqueBytes(5);
    const rootedHash = await sha256HexOf(rootedBytes);
    const { client: rootedClient } = okClient(
      toBase64(rootedBytes),
      rootedBytes.byteLength,
    );

    // Root the hash: a live landing draft names it, which is exactly what
    // `landingLiveImageRootHashes()` (the same set `landing-image-gc` reclaims
    // against) reads.
    useLandingDraftStore.setState({
      drafts: [makeDraft({ id: "draft-live", content: imageDoc(rootedHash) })],
      activeDraftId: "draft-live",
    });

    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-rooted",
      client: rootedClient,
      hashes: [rootedHash],
    });

    // An UNROOTED hash recorded right after the rooted one - the oldest
    // unrooted entry once overflow eviction runs.
    const earlyUnrootedHash = "e".repeat(64);
    const { client: earlyClient, calls: earlyCalls } = neverCalledClient();
    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-early-unrooted",
      client: earlyClient,
      hashes: [earlyUnrootedHash],
    });

    // 511 more unrelated, unrooted registrations - together with the one
    // above, exactly the 512 unrelated registrations that push the map from
    // 513 entries down to the 512 cap on the last call, forcing exactly one
    // eviction.
    const fillerClient = neverCalledClient().client;
    for (
      let index = 0;
      index < CLOUD_DRAFT_IMAGE_SOURCE_LIMIT - 1;
      index += 1
    ) {
      recordCloudDraftImageSources({
        identity: IDENTITY,
        hostId: "host-filler",
        client: fillerClient,
        hashes: [`filler-${index}`],
      });
    }

    // The rooted hash still resolves from the cloud after all that overflow.
    const rootedResult = await readCloudDraftImageBytes(rootedHash);
    expect(rootedResult).toEqual(rootedBytes);
    expect(await getImageBytes(rootedHash)).toEqual(rootedBytes);

    // The early UNROOTED hash was evicted: its source is gone, so the lazy
    // leg answers null issuing no request at all - proving this isn't merely
    // "eviction never runs".
    const evictedResult = await readCloudDraftImageBytes(earlyUnrootedHash);
    expect(evictedResult).toBeNull();
    expect(earlyCalls).toHaveLength(0);
  });
});
