import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostRequestDispatchOptions,
  HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { putImage } from "@/lib/composer/composer-image-store";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { appLogger } from "@/lib/logger";
import { DRAFT_BLOB_PUT_RESPONSE_TIMEOUT_MS } from "@/lib/drafts/draft-blob-transport-budget";
import {
  forgetBlobUnsupportedHost,
  putDraftBlobs,
  readDraftBlobsForRecovery,
  readDraftBlobsIntoLocalStore,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";

const HOST = "host-blobs";

type RecordedMember = "request" | "requestWithOptions";

type RecordedCall = {
  readonly member: RecordedMember;
  readonly method: string;
  readonly params: unknown;
  readonly options: HostRequestDispatchOptions | undefined;
};

/**
 * A `DraftBlobClient` over both `request` and `requestWithOptions`, recording
 * every call it receives.
 *
 * The put path dispatches through `requestWithOptions` (digest key + the
 * extended budget); the read path still uses `request`. Each recorded call
 * therefore carries `member`, `method`, `params`, and the dispatch `options`
 * (`undefined` on the plain `request` path) so a case can assert which member
 * was used. A rejection ALONE still proves nothing here, because both loops
 * in `draft-blob-transport.ts` catch a non-capability error and return the
 * accumulated result. An empty result is therefore the same observation
 * whether the intended member answered `ok: false` or the other member threw.
 * That is what `calls` is for: every case below pins the member, the method,
 * the params, the options and the invocation count, so a dispatch that moved
 * to the other member fails on the log rather than on an empty result.
 */
function recordingClient(
  respond: (method: string, params: unknown) => Promise<unknown>,
): { client: DraftBlobClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const request = ((method, params) => {
    calls.push({
      member: "request",
      method,
      params,
      options: undefined,
    });
    return respond(method, params);
  }) as HostRequester<HostRpcRegistry>["request"];
  const requestWithOptions = ((method, params, options) => {
    calls.push({
      member: "requestWithOptions",
      method,
      params,
      options,
    });
    return respond(method, params);
  }) as HostRequester<HostRpcRegistry>["requestWithOptions"];
  return {
    client: {
      request,
      requestWithOptions,
    },
    calls,
  };
}

function pngBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
}

function putBlobDispatchOptions(sha256: string): HostRequestDispatchOptions {
  return {
    idempotencyKey: sha256,
    responseTimeoutMs: DRAFT_BLOB_PUT_RESPONSE_TIMEOUT_MS,
    requiredHostMethodVersion: null,
    signal: undefined,
  };
}

/**
 * A `putBlob`-only recording client whose response never settles until
 * `release` is called - a FIFO queue, not a single slot, so a case that
 * expects more than one call in flight (a same-host/same-digest pair the
 * join should have collapsed to one, or two different-host calls that must
 * NOT be collapsed) can drive each one independently instead of parking a
 * second caller forever behind a single resolver.
 */
function gatedPutBlobClient(): {
  readonly client: DraftBlobClient;
  readonly calls: RecordedCall[];
  readonly release: (ok: boolean) => void;
  readonly pendingCount: () => number;
} {
  const pending: Array<(response: { ok: boolean }) => void> = [];
  const { client, calls } = recordingClient((method) => {
    if (method !== "drafts.putBlob") {
      return Promise.resolve({ ok: true as const });
    }
    return new Promise((resolve) => {
      pending.push(resolve);
    });
  });
  return {
    client,
    calls,
    release: (ok) => {
      const resolve = pending.shift();
      if (resolve === undefined) {
        throw new Error("no drafts.putBlob call in flight to release");
      }
      resolve({ ok });
    },
    pendingCount: () => pending.length,
  };
}

beforeEach(() => {
  installFreshIndexedDb();
});

afterEach(() => {
  resetDraftBlobTransportForTests();
  vi.restoreAllMocks();
});

describe("draft blob transport", () => {
  it("treats a withheld blob store as an old host, not a failure", async () => {
    const hash = await putImage(pngBytes());
    const { client, calls } = recordingClient(() =>
      Promise.reject(
        new HostRpcError({
          code: "E_HOST_UNSUPPORTED",
          message: "old",
          requestId: "r",
          method: "drafts.putBlob",
          fatalDetails: null,
        }),
      ),
    );
    const first = await putDraftBlobs(HOST, client, [hash]);
    expect(first).toEqual([]);
    expect(calls).toHaveLength(1);
    const second = await putDraftBlobs(HOST, client, [hash]);
    expect(second).toEqual([]);
    expect(calls).toHaveLength(1);

    forgetBlobUnsupportedHost(HOST);
    const third = await putDraftBlobs(HOST, client, [hash]);
    expect(third).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("an ok putBlob confirms the hash - the positive control for the skip below", async () => {
    const hash = await putImage(pngBytes());
    const { client, calls } = recordingClient(() =>
      Promise.resolve({ ok: true as const }),
    );

    const confirmed = await putDraftBlobs(HOST, client, [hash]);

    expect(confirmed).toEqual([hash]);
    expect(calls).toEqual([
      {
        member: "requestWithOptions",
        method: "drafts.putBlob",
        params: { sha256: hash, bytesBase64: bytesToBase64(pngBytes()) },
        options: putBlobDispatchOptions(hash),
      },
    ]);
  });

  it("digest-mismatch skips the hash and does not confirm it", async () => {
    const hash = await putImage(pngBytes());
    const { client, calls } = recordingClient(() =>
      Promise.resolve({
        ok: false as const,
        reason: "digest-mismatch" as const,
      }),
    );

    const confirmed = await putDraftBlobs(HOST, client, [hash]);

    expect(confirmed).toEqual([]);
    // Same one call, same bytes, as the control above - only the host's answer
    // differs. Without this the case would pass on a put that never happened.
    expect(calls).toEqual([
      {
        member: "requestWithOptions",
        method: "drafts.putBlob",
        params: { sha256: hash, bytesBase64: bytesToBase64(pngBytes()) },
        options: putBlobDispatchOptions(hash),
      },
    ]);
  });

  it("an ok readBlob yields the decoded bytes - the positive control for the miss below", async () => {
    // `readDraftBlobsForRecovery`, not `…IntoLocalStore`, because the latter
    // installs through `putImageBytesAtHash`, which re-hashes the bytes and
    // refuses a mismatch - so a positive case there needs the real digest of
    // the served bytes, and learning it via `putImage` would seed the local
    // store and short-circuit the RPC this case exists to observe. The two
    // share `readDraftBlobs` entirely; what is left uncovered here is the
    // store gate, which is `composer-image-store`'s own invariant.
    const sha256 = "ab".repeat(32);
    const { client, calls } = recordingClient(() =>
      Promise.resolve({
        ok: true as const,
        bytesBase64: bytesToBase64(pngBytes()),
      }),
    );

    const images = await readDraftBlobsForRecovery(HOST, client, [sha256]);

    expect(calls).toEqual([
      {
        member: "request",
        method: "drafts.readBlob",
        params: { sha256 },
        options: undefined,
      },
    ]);
    expect(images.size).toBe(1);
    expect(Array.from(images.get(sha256)?.bytes ?? [])).toEqual(
      Array.from(pngBytes()),
    );
  });

  it("readBlob missing collapses to no local bytes", async () => {
    const sha256 = "ab".repeat(32);
    const { client, calls } = recordingClient(() =>
      Promise.resolve({ ok: false as const, reason: "missing" as const }),
    );

    const images = await readDraftBlobsIntoLocalStore(HOST, client, [sha256]);

    expect(images.size).toBe(0);
    expect(calls).toEqual([
      {
        member: "request",
        method: "drafts.readBlob",
        params: { sha256 },
        options: undefined,
      },
    ]);
  });

  it("a second put of the same hash replays under the digest key with no warning", async () => {
    const hash = await putImage(pngBytes());
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    const { client, calls } = recordingClient(() =>
      Promise.resolve({ ok: true as const }),
    );

    const first = await putDraftBlobs(HOST, client, [hash]);
    const second = await putDraftBlobs(HOST, client, [hash]);

    expect(first).toEqual([hash]);
    expect(second).toEqual([hash]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.options?.idempotencyKey).toBe(hash);
    expect(calls[1]?.options?.idempotencyKey).toBe(hash);
    expect(calls[0]?.params).toEqual(calls[1]?.params);
    expect(calls[0]?.params).toEqual({
      sha256: hash,
      bytesBase64: bytesToBase64(pngBytes()),
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("putBlob never falls back to the unbudgeted request member", async () => {
    const hash = await putImage(pngBytes());
    const { client, calls } = recordingClient(() =>
      Promise.resolve({ ok: true as const }),
    );

    await putDraftBlobs(HOST, client, [hash]);

    expect(calls.length).toBeGreaterThan(0);
    expect(
      calls.every(
        (call) =>
          call.method !== "drafts.putBlob" ||
          call.member === "requestWithOptions",
      ),
    ).toBe(true);
  });

  describe("putsInFlight - single-flight join for a concurrent same-host upload", () => {
    it("two concurrent puts for the same hash on the same host share one body and both resolve confirmed", async () => {
      const hash = await putImage(pngBytes());
      const gated = gatedPutBlobClient();

      const firstCall = putDraftBlobs(HOST, gated.client, [hash]);
      const secondCall = putDraftBlobs(HOST, gated.client, [hash]);
      await vi.waitFor(() => expect(gated.pendingCount()).toBeGreaterThan(0));

      // Both callers are waiting on the same in-flight body before either
      // sees an answer - the join, not a coincidence of two separate calls
      // landing on the same reply.
      expect(gated.pendingCount()).toBe(1);
      gated.release(true);
      const [first, second] = await Promise.all([firstCall, secondCall]);

      expect(first).toEqual([hash]);
      expect(second).toEqual([hash]);
      expect(
        gated.calls.filter((call) => call.method === "drafts.putBlob"),
      ).toHaveLength(1);
    });

    it("negative control: the same hash on DIFFERENT hosts is two bodies - the join is host-keyed", async () => {
      const hash = await putImage(pngBytes());
      const OTHER_HOST = "host-blobs-other";
      const gated = gatedPutBlobClient();

      const firstCall = putDraftBlobs(HOST, gated.client, [hash]);
      const secondCall = putDraftBlobs(OTHER_HOST, gated.client, [hash]);
      await vi.waitFor(() => expect(gated.pendingCount()).toBeGreaterThan(1));

      expect(gated.pendingCount()).toBe(2);
      gated.release(true);
      gated.release(true);
      const [first, second] = await Promise.all([firstCall, secondCall]);

      expect(first).toEqual([hash]);
      expect(second).toEqual([hash]);
      expect(
        gated.calls.filter((call) => call.method === "drafts.putBlob"),
      ).toHaveLength(2);
    });

    // Negative control (b) - a second put issued strictly AFTER the first
    // settles is a real second body - is already covered above by "a second
    // put of the same hash replays under the digest key with no warning",
    // which awaits the first `putDraftBlobs` before starting the second and
    // asserts `calls` grew to 2. Single-flight narrows concurrency; it never
    // answers from history.
  });
});
