import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

import { getImageBytes, putImage } from "@/lib/composer/landing-image-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  NO_DRAFT_IMAGE_BYTE_TARGET,
  resolveDraftImageBytes,
  type DraftImageByteTarget,
} from "@/lib/drafts/resolve-draft-image-bytes";

const HOST = "host-resolver";

function pngBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
}

function otherBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([1, 2, 3, 4]);
}

/**
 * `putImageBytesAtHash` (the write-back path `drafts.readBlob` uses) verifies
 * the digest before storing, so a fabricated hash silently fails to write and
 * the test would misread that as "the host leg didn't answer".
 */
async function sha256HexOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type FakeRequest = HostRequester<HostRpcRegistry>["request"];

function targetWithClient(request: FakeRequest): DraftImageByteTarget {
  return { hostId: HOST, client: { request, requestWithOptions: request } };
}

beforeEach(() => {
  installFreshIndexedDb();
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
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("resolveDraftImageBytes", () => {
  it("resolves a local hit with no host request at all", async () => {
    const bytes = pngBytes();
    const hash = await putImage(bytes);
    let calls = 0;
    const request: FakeRequest = ((_method, _params) => {
      calls += 1;
      return Promise.resolve({
        ok: false as const,
        reason: "missing" as const,
      });
    }) as FakeRequest;
    const target = targetWithClient(request);

    const resolved = await resolveDraftImageBytes(hash, target);

    expect(resolved).toEqual(bytes);
    expect(calls).toBe(0);
  });

  it("falls back to drafts.readBlob on a local miss, and writes back locally", async () => {
    const bytes = otherBytes();
    const hash = await sha256HexOf(bytes);
    let calls = 0;
    const request: FakeRequest = ((method, _params) => {
      calls += 1;
      expect(method).toBe("drafts.readBlob");
      return Promise.resolve({
        ok: true as const,
        bytesBase64: btoa(String.fromCharCode(...bytes)),
      });
    }) as FakeRequest;
    const target = targetWithClient(request);

    const resolved = await resolveDraftImageBytes(hash, target);
    expect(resolved).toEqual(bytes);
    expect(calls).toBe(1);

    // Written back into the local store: a second resolution never asks the
    // host again.
    const second = await resolveDraftImageBytes(hash, target);
    expect(second).toEqual(bytes);
    expect(calls).toBe(1);
    expect(await getImageBytes(hash)).toEqual(bytes);
  });

  it("answers null when both legs miss", async () => {
    const hash = "c".repeat(64);
    const request: FakeRequest = ((_method, _params) =>
      Promise.resolve({
        ok: false as const,
        reason: "missing" as const,
      })) as FakeRequest;
    const target = targetWithClient(request);

    const resolved = await resolveDraftImageBytes(hash, target);
    expect(resolved).toBeNull();
  });

  it("never dispatches to a host and answers null for a target missing either half", async () => {
    const hash = "d".repeat(64);
    let calls = 0;
    const request: FakeRequest = ((_method, _params) => {
      calls += 1;
      return Promise.resolve({
        ok: false as const,
        reason: "missing" as const,
      });
    }) as FakeRequest;
    const clientOnly: DraftImageByteTarget = {
      hostId: null,
      client: { request, requestWithOptions: request },
    };
    const hostOnly: DraftImageByteTarget = { hostId: HOST, client: null };

    expect(
      await resolveDraftImageBytes(hash, NO_DRAFT_IMAGE_BYTE_TARGET),
    ).toBeNull();
    expect(await resolveDraftImageBytes(hash, clientOnly)).toBeNull();
    expect(await resolveDraftImageBytes(hash, hostOnly)).toBeNull();
    expect(calls).toBe(0);
  });

  it("does not throw when the host RPC rejects", async () => {
    const hash = "e".repeat(64);
    const request: FakeRequest = (_method, _params) =>
      Promise.reject(new Error("socket died"));
    const target = targetWithClient(request);

    await expect(resolveDraftImageBytes(hash, target)).resolves.toBeNull();
  });
});
