import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { putImage } from "@/lib/composer/landing-image-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import {
  forgetBlobUnsupportedHost,
  putDraftBlobs,
  readDraftBlobsIntoLocalStore,
  resetDraftBlobTransportForTests,
} from "@/lib/drafts/draft-blob-transport";

const HOST = "host-blobs";

function pngBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
}

beforeEach(() => {
  installFreshIndexedDb();
});

afterEach(() => {
  resetDraftBlobTransportForTests();
});

describe("draft blob transport", () => {
  it("treats a withheld blob store as an old host, not a failure", async () => {
    const hash = await putImage(pngBytes());
    let calls = 0;
    const client = {
      request: ((_method, _params) => {
        calls += 1;
        return Promise.reject(
          new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            message: "old",
            requestId: "r",
            method: "drafts.putBlob",
            fatalDetails: null,
          }),
        );
      }) as HostRequester<HostRpcRegistry>["request"],
    };
    const first = await putDraftBlobs(HOST, client, [hash]);
    expect(first).toEqual([]);
    expect(calls).toBe(1);
    const second = await putDraftBlobs(HOST, client, [hash]);
    expect(second).toEqual([]);
    expect(calls).toBe(1);

    forgetBlobUnsupportedHost(HOST);
    const third = await putDraftBlobs(HOST, client, [hash]);
    expect(third).toEqual([]);
    expect(calls).toBe(2);
  });

  it("digest-mismatch skips the hash and does not confirm it", async () => {
    const hash = await putImage(pngBytes());
    const client = {
      request: ((_method, _params) =>
        Promise.resolve({
          ok: false as const,
          reason: "digest-mismatch" as const,
        })) as HostRequester<HostRpcRegistry>["request"],
    };
    const confirmed = await putDraftBlobs(HOST, client, [hash]);
    expect(confirmed).toEqual([]);
  });

  it("readBlob missing collapses to no local bytes", async () => {
    const client = {
      request: ((_method, _params) =>
        Promise.resolve({
          ok: false as const,
          reason: "missing" as const,
        })) as HostRequester<HostRpcRegistry>["request"],
    };
    const images = await readDraftBlobsIntoLocalStore(HOST, client, [
      "ab".repeat(32),
    ]);
    expect(images.size).toBe(0);
  });
});
