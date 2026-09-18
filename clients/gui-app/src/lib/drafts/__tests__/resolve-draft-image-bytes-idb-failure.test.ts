/**
 * F5 (batch-1 review, P2): an IndexedDB failure escaped the draft resolver
 * BEFORE the host fallback ran. `readLocalDraftImageBytes` catches the first
 * `getImageBytes` rejection correctly, but `readDraftBlobs` (inside the host
 * leg) repeats that same local read a SECOND time, outside its own transport
 * try/catch - so a persistently failing IndexedDB let that second rejection
 * escape the whole resolver before any `drafts.readBlob` request was sent.
 * All three submit continuations `void` this promise, so the failure mode was
 * an unhandled rejection that silently abandoned the send.
 *
 * A separate file from `resolve-draft-image-bytes.test.ts` because this is
 * the one case in the suite that needs `getImageBytes` MOCKED to always
 * reject, rather than driven through the real fake-indexedDB store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  resolveDraftImageBytes,
  type DraftImageByteTarget,
} from "@/lib/drafts/resolve-draft-image-bytes";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";

const storeMocks = vi.hoisted(() => ({
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(),
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  return { ...actual, getImageBytes: storeMocks.getImageBytes };
});

const HOST = "host-idb-failure";
type FakeRequest = HostRequester<HostRpcRegistry>["request"];

beforeEach(() => {
  // The write-back leg (`putImageBytesAtHash`) is real, not mocked, and needs
  // a working IndexedDB to store into - only the READ side is forced to fail.
  installFreshIndexedDb();
  storeMocks.getImageBytes.mockReset();
  // Every call rejects - both the resolver's own leg-1 read AND the second,
  // internal read inside `readDraftBlobs`.
  storeMocks.getImageBytes.mockRejectedValue(
    new Error("IndexedDB unavailable"),
  );
  // Signed in, as production always is when a host blob read can happen: a
  // host client exists only for an established account, and the transport's
  // write-back fence now requires an auth state allowed to serve the read.
  // Leaving this out modelled a state production cannot produce.
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "owner-1", username: "owner-1" },
  });
});

afterEach(() => {
  resetDraftBlobTransportForTests();
});

/**
 * The host leg's write-back (`putImageBytesAtHash`) verifies the digest
 * before storing, so a fabricated hash would silently fail to write and this
 * test would misread that as "the host leg didn't answer".
 */
async function sha256HexOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("resolveDraftImageBytes with a persistently failing local store", () => {
  it("still returns the host's bytes, and never rejects", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const hash = await sha256HexOf(bytes);
    let readBlobCalls = 0;
    const request: FakeRequest = ((method, _params) => {
      readBlobCalls += 1;
      expect(method).toBe("drafts.readBlob");
      return Promise.resolve({
        ok: true as const,
        bytesBase64: btoa(String.fromCharCode(...bytes)),
      });
    }) as FakeRequest;
    const target: DraftImageByteTarget = {
      hostId: HOST,
      client: { request, requestWithOptions: request },
    };

    await expect(resolveDraftImageBytes(hash, target)).resolves.toEqual(bytes);
    // The host leg actually ran - the failure mode this guards against is the
    // local rejection escaping BEFORE this request was ever sent.
    expect(readBlobCalls).toBe(1);
  });

  it("answers null (not a rejection) when the host also has nothing", async () => {
    const hash = "e".repeat(64);
    const request: FakeRequest = ((_method, _params) =>
      Promise.resolve({
        ok: false as const,
        reason: "missing" as const,
      })) as FakeRequest;
    const target: DraftImageByteTarget = {
      hostId: HOST,
      client: { request, requestWithOptions: request },
    };

    await expect(resolveDraftImageBytes(hash, target)).resolves.toBeNull();
  });
});
