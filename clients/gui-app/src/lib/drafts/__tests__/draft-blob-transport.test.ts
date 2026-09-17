import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import {
  putImage,
  sessionImageBytes,
} from "@/lib/composer/landing-image-store";
import { reconcile } from "@/lib/composer/landing-image-gc";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { useAuthStore } from "@/stores/auth/auth-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import {
  forgetBlobUnsupportedHost,
  forgetConfirmedDraftBlobs,
  isDraftBlobConfirmed,
  isDraftBlobUnbridgeable,
  markDraftBlobUnbridgeable,
  hostWithholdsDraftBlobs,
  putDraftBlobs,
  readDraftBlobsIntoLocalStore,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";

// F7 needs a local byte reader that REJECTS, to prove `uploadOneDraftBlob`
// never lets that escape as a detached unhandled rejection. Defaults to the
// real implementation; only the F7 test below overrides it.
const localReadMocks = vi.hoisted(() => ({
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(),
  real: null as ((hash: string) => Promise<Uint8Array | undefined>) | null,
  // Wrapped by the post-write fence test so an account switch can land INSIDE
  // the write. Without that the switch happens before the PRE-write check and
  // the test passes with the post-write fence deleted - which it did.
  putImageBytesAtHash:
    vi.fn<(hash: string, bytes: ImageBytes) => Promise<boolean>>(),
  realPut: null as
    | ((hash: string, bytes: ImageBytes) => Promise<boolean>)
    | null,
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  localReadMocks.real = actual.getImageBytes;
  localReadMocks.getImageBytes.mockImplementation(actual.getImageBytes);
  localReadMocks.realPut = actual.putImageBytesAtHash;
  localReadMocks.putImageBytesAtHash.mockImplementation(
    actual.putImageBytesAtHash,
  );
  return {
    ...actual,
    getImageBytes: localReadMocks.getImageBytes,
    putImageBytesAtHash: localReadMocks.putImageBytesAtHash,
  };
});

function signedInAs(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

async function sha256HexOfBytes(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function unsupportedError(method: string): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: "old host",
    requestId: "r",
    method,
    fatalDetails: null,
  });
}

const HOST = "host-blobs";
// These cases never reach a successful confirmation (the host throws, or
// answers digest-mismatch), so naming an owner keeps them behaving exactly as
// they did before the memo existed.
const OWNER = "user-blobs";

/** A client that counts calls and lets the test decide each response's fate. */
function countingClient(
  respond: (sha256: string) => Promise<{ readonly ok: boolean }>,
): { readonly client: DraftBlobClient; calls: () => number } {
  let calls = 0;
  const client: DraftBlobClient = {
    request: (async (_method, params) => {
      calls += 1;
      const { sha256 } = params as { readonly sha256: string };
      const result = await respond(sha256);
      return result.ok
        ? { ok: true as const }
        : { ok: false as const, reason: "digest-mismatch" as const };
    }) as HostRequester<HostRpcRegistry>["request"],
  };
  return { client, calls: () => calls };
}

function pngBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
}

beforeEach(() => {
  installFreshIndexedDb();
  localReadMocks.getImageBytes.mockReset();
  if (localReadMocks.real !== null) {
    localReadMocks.getImageBytes.mockImplementation(localReadMocks.real);
  }
  // Module-level mocks keep their call log across tests, so a count assertion
  // reads the whole file's history unless it is cleared here. `mockClear`, not
  // `mockReset`: the passthrough installed at module load has to survive.
  localReadMocks.putImageBytesAtHash.mockClear();
  if (localReadMocks.realPut !== null) {
    localReadMocks.putImageBytesAtHash.mockImplementation(
      localReadMocks.realPut,
    );
  }
});

afterEach(() => {
  resetDraftBlobTransportForTests();
});

/**
 * Rejections are asserted through Node's own `process` event, mirroring
 * `epic-title-write-settlement.test.ts`'s helper.
 */
function captureUnhandledRejections(): {
  readonly seen: unknown[];
  readonly stop: () => void;
} {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    seen,
    stop: () => {
      process.off("unhandledRejection", onUnhandled);
    },
  };
}

/** Two macrotasks: one for a stray `.then` to run, one for Node to judge it. */
async function drainRejections(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("draft blob transport", () => {
  it("treats a withheld blob store as an old host, not a failure", async () => {
    const hash = await putImage(pngBytes());
    let calls = 0;
    const client: Pick<HostRequester<HostRpcRegistry>, "request"> = {
      request: (_method, _params) => {
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
      },
    };
    const first = await putDraftBlobs(HOST, client, [hash], OWNER);
    expect(first).toEqual([]);
    expect(calls).toBe(1);
    const second = await putDraftBlobs(HOST, client, [hash], OWNER);
    expect(second).toEqual([]);
    expect(calls).toBe(1);

    forgetBlobUnsupportedHost(HOST);
    const third = await putDraftBlobs(HOST, client, [hash], OWNER);
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
    const confirmed = await putDraftBlobs(HOST, client, [hash], OWNER);
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

  it("a SIGN-IN ATTEMPT during the write is retired too, though the owner id never moves (DRIVE RED)", async () => {
    // The owner id is not sufficient on its own. `setSigningIn` moves the
    // status and leaves `contextMetadata` alone, so this window keeps
    // reporting user-a for the whole attempt and an id-only fence sees nothing
    // happen. If the attempt settles as user-b, a's bytes are already in b's
    // partition and rooted there by the session entry the write seeds.
    //
    // Switched inside `store`, like the test above and for the same reason: a
    // switch before the pre-write check would pass even with the post-write
    // fence deleted.
    const bytes = new Uint8Array([...pngBytes(), 0x7a, 0x7b, 0x7c]);
    const hash = await sha256HexOfBytes(bytes);
    signedInAs("user-a");

    const passthrough = localReadMocks.realPut;
    if (passthrough === null) throw new Error("no passthrough captured");
    localReadMocks.putImageBytesAtHash.mockImplementationOnce(
      async (writtenHash, writtenBytes) => {
        const stored = await passthrough(writtenHash, writtenBytes);
        useAuthStore.getState().setSigningIn("device");
        return stored;
      },
    );

    const client: DraftBlobClient = {
      request: ((_method, _params) =>
        Promise.resolve({
          ok: true as const,
          bytesBase64: bytesToBase64(bytes),
        })) as HostRequester<HostRpcRegistry>["request"],
    };

    const images = await readDraftBlobsIntoLocalStore(HOST, client, [hash]);

    // The owner id is still user-a - the control that makes this test about
    // the STATUS and nothing else.
    expect(useAuthStore.getState().contextMetadata?.userId).toBe("user-a");
    expect(images.size).toBe(0);
    expect(sessionImageBytes(hash)).toBeNull();
  });

  it("a switch DURING the write is retired, not kept (DRIVE RED)", async () => {
    // The switch lands inside `store`, which is the only window the POST-write
    // fence covers. An earlier version of this test switched inside
    // `client.request` - before the pre-write check - so it passed with the
    // post-write fence deleted, which is a test that cannot fail for the thing
    // it names.
    const bytes = new Uint8Array([...pngBytes(), 0x9a, 0x9b, 0x9c]);
    const hash = await sha256HexOfBytes(bytes);
    signedInAs("user-a");

    const passthrough = localReadMocks.realPut;
    if (passthrough === null) throw new Error("no passthrough captured");
    localReadMocks.putImageBytesAtHash.mockImplementationOnce(
      async (writtenHash, writtenBytes) => {
        const stored = await passthrough(writtenHash, writtenBytes);
        signedInAs("user-b");
        return stored;
      },
    );

    const client: DraftBlobClient = {
      request: ((_method, _params) =>
        Promise.resolve({
          ok: true as const,
          bytesBase64: bytesToBase64(bytes),
        })) as HostRequester<HostRpcRegistry>["request"],
    };

    const images = await readDraftBlobsIntoLocalStore(HOST, client, [hash]);

    // Not handed back, and the session root released synchronously. The
    // durable reclaim is the reconcile's, exactly as on the cloud leg.
    expect(images.size).toBe(0);
    expect(sessionImageBytes(hash)).toBeNull();
    await reconcile();
    const realRead = localReadMocks.real;
    if (realRead === null) throw new Error("no passthrough captured");
    expect(await realRead(hash)).toBeUndefined();
  });

  it("a switch BEFORE the write never writes at all (DRIVE RED)", async () => {
    // The other half: the pre-write check, which costs a wasted fetch rather
    // than a retirement. Separate test so neither fence can be deleted while
    // the other keeps the suite green.
    const bytes = new Uint8Array([...pngBytes(), 0xa1, 0xa2, 0xa3]);
    const hash = await sha256HexOfBytes(bytes);
    signedInAs("user-a");

    const client: DraftBlobClient = {
      request: ((_method, _params) => {
        signedInAs("user-b");
        return Promise.resolve({
          ok: true as const,
          bytesBase64: bytesToBase64(bytes),
        });
      }) as HostRequester<HostRpcRegistry>["request"],
    };

    const images = await readDraftBlobsIntoLocalStore(HOST, client, [hash]);

    expect(images.size).toBe(0);
    // Never written, so there is nothing to retire.
    expect(localReadMocks.putImageBytesAtHash).not.toHaveBeenCalled();
  });

  // ─── T5's once-per-host upload memo ─────────────────────────────────────

  it("two concurrent first uploads of one digest issue ONE request", async () => {
    // Pre-T5, `putDraftBlobs` had no join/start dedupe at all - every call
    // read local bytes and issued its own `drafts.putBlob`, so two concurrent
    // first writes of the same image always issued two requests. Without
    // `joinOrStartBlobUpload`'s synchronous-with-the-decision registration,
    // this fails with `calls()` at 2.
    const hash = await putImage(pngBytes());
    const { client, calls } = countingClient(() =>
      Promise.resolve({ ok: true }),
    );

    const [first, second] = await Promise.all([
      putDraftBlobs(HOST, client, [hash], OWNER),
      putDraftBlobs(HOST, client, [hash], OWNER),
    ]);

    expect(calls()).toBe(1);
    expect(first).toEqual([hash]);
    expect(second).toEqual([hash]);
  });

  it("two owners do not share one upload flight (DRIVE RED)", async () => {
    // The host's blob store is owner-PARTITIONED, so an upload made under one
    // account says nothing about another's partition. Keyed by digest alone,
    // owner B joined A's flight and was handed `true` while the confirmation
    // was recorded only for A - and that `true` is what
    // `rememberLandingBlobsOnHost` turns into permission to evict B's local
    // bytes, from a partition that may not hold them.
    const hash = await putImage(pngBytes());
    const { client, calls } = countingClient(() =>
      Promise.resolve({ ok: true }),
    );

    const [forA, forB] = await Promise.all([
      putDraftBlobs(HOST, client, [hash], OWNER),
      putDraftBlobs(HOST, client, [hash], "owner-b"),
    ]);

    // One request per OWNER, not one per digest. This is the whole assertion:
    // at 1, one of these two answers was produced under the other's identity.
    expect(calls()).toBe(2);
    expect(forA).toEqual([hash]);
    expect(forB).toEqual([hash]);
    // The memo's single-owner-per-digest shape is unchanged and deliberate (see
    // the module doc): the later confirmation replaces the earlier, and the
    // displaced owner re-uploads once. That is a wasted request, which is the
    // fail-safe direction; being told about a partition you never wrote to is
    // not.
    expect(
      isDraftBlobConfirmed(HOST, hash, OWNER) ||
        isDraftBlobConfirmed(HOST, hash, "owner-b"),
    ).toBe(true);
  });

  it("a late acknowledgement after re-bootstrap is reported unconfirmed, not just unmemoized", async () => {
    // Pre-T5, there was no epoch at all: `uploadOneDraftBlob` recorded a
    // confirmation unconditionally on a successful response, so an ack that
    // arrives after `forgetConfirmedDraftBlobs` (a reconnect re-bootstrap)
    // would still be memoized - a host that may have silently dropped its
    // blob store would be trusted anyway. Without the epoch re-check this
    // test's second `putDraftBlobs` call issues NO request (the memo would
    // already claim the digest confirmed), which is the positive control
    // below.
    const hash = await putImage(pngBytes());
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { client, calls } = countingClient(async () => {
      await gate;
      return { ok: true };
    });

    const firstCall = putDraftBlobs(HOST, client, [hash], OWNER);
    // The upload is now in flight, parked on `gate`. Simulate a genuinely new
    // bootstrap (a reconnect re-bootstrap) landing while it is outstanding.
    forgetConfirmedDraftBlobs(HOST);
    releaseFirst();
    const first = await firstCall;

    // Unconfirmed for BOTH consumers. The memo is the send gate's, and the
    // returned array is `rememberLandingBlobsOnHost`'s - which feeds
    // `landingDraftPinsLocalImageBytes`, the check that stops a landing draft
    // from pinning its local bytes. Counting a retired conversation's ack
    // there let the LRU evict the draft holding the only copy.
    expect(first).toEqual([]);
    expect(isDraftBlobConfirmed(HOST, hash, OWNER)).toBe(false);

    // Positive control: without the epoch guard the confirmation WOULD have
    // been recorded, and this second call would issue zero further requests.
    const second = await putDraftBlobs(HOST, client, [hash], OWNER);
    expect(second).toEqual([hash]);
    expect(calls()).toBe(2);
  });

  it("a REFUSAL from a retired epoch does not re-mark an upgraded host (DRIVE RED)", async () => {
    // The mirror image of the acknowledgement fence one test up. A refusal is
    // a verdict about the host BUILD, and the re-bootstrap that moved the epoch
    // is the signal that the build may have changed - so a refusal from the
    // previous connection, landing after that reset, would undo the re-probe
    // with the very answer the re-probe existed to discard.
    const hash = await putImage(pngBytes());
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client: DraftBlobClient = {
      request: async (_method, _params) => {
        await gate;
        throw unsupportedError("drafts.putBlob");
      },
    };

    const firstCall = putDraftBlobs(HOST, client, [hash], OWNER);
    // The reconnect re-bootstrap lands while the refusal is still on the wire.
    forgetConfirmedDraftBlobs(HOST);
    releaseFirst();
    expect(await firstCall).toEqual([]);

    // The host is NOT marked: this refusal describes a connection that has
    // already been replaced.
    expect(hostWithholdsDraftBlobs(HOST)).toBe(false);
  });

  it("a refusal on the CURRENT epoch still marks the host - positive control", async () => {
    const hash = await putImage(pngBytes());
    const client: DraftBlobClient = {
      request: (_method, _params) =>
        Promise.reject(unsupportedError("drafts.putBlob")),
    };

    expect(await putDraftBlobs(HOST, client, [hash], OWNER)).toEqual([]);
    expect(hostWithholdsDraftBlobs(HOST)).toBe(true);
  });

  it("a null-owner upload is acknowledged but NOT reported confirmed (DRIVE RED)", async () => {
    // `currentDraftBlobOwnerId()` can be null, and both coordinator paths pass
    // it straight through. With no identity there is nothing to memoize
    // against, so `isDraftBlobConfirmed` keeps answering false - and returning
    // `true` here would still put the digest in `confirmedHostBlobHashes`,
    // where it stops `landingDraftPinsLocalImageBytes` pinning the bytes. The
    // two consumers have to agree, and the memo is the one that can be asked.
    const hash = await putImage(pngBytes());
    const { client, calls } = countingClient(() =>
      Promise.resolve({ ok: true }),
    );

    expect(await putDraftBlobs(HOST, client, [hash], null)).toEqual([]);
    expect(calls()).toBe(1);
    expect(isDraftBlobConfirmed(HOST, hash, OWNER)).toBe(false);
  });

  it("a readBlob refusal from a retired epoch does not re-mark an upgraded host (DRIVE RED)", async () => {
    // The READ path is as able to outlive its connection as the write path,
    // and its refusal is the same kind of verdict - about the host BUILD, which
    // is exactly what a re-bootstrap says may have changed.
    const hash = "ab".repeat(32);
    let releaseRead: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const client: DraftBlobClient = {
      request: async (_method, _params) => {
        await gate;
        throw unsupportedError("drafts.readBlob");
      },
    };

    const reading = readDraftBlobsIntoLocalStore(HOST, client, [hash]);
    forgetConfirmedDraftBlobs(HOST);
    releaseRead();
    expect((await reading).size).toBe(0);

    expect(hostWithholdsDraftBlobs(HOST)).toBe(false);
  });

  it("a readBlob refusal on the CURRENT epoch still marks the host - positive control", async () => {
    const client: DraftBlobClient = {
      request: (_method, _params) =>
        Promise.reject(unsupportedError("drafts.readBlob")),
    };

    expect(
      (await readDraftBlobsIntoLocalStore(HOST, client, ["cd".repeat(32)]))
        .size,
    ).toBe(0);
    expect(hostWithholdsDraftBlobs(HOST)).toBe(true);
  });

  it("a confirmed digest is not re-sent", async () => {
    const hash = await putImage(pngBytes());
    const { client, calls } = countingClient(() =>
      Promise.resolve({ ok: true }),
    );

    const first = await putDraftBlobs(HOST, client, [hash], OWNER);
    expect(first).toEqual([hash]);
    expect(calls()).toBe(1);

    const second = await putDraftBlobs(HOST, client, [hash], OWNER);
    expect(second).toEqual([hash]);
    expect(calls()).toBe(1);
  });

  it("a different owner is not confirmed", async () => {
    // Pre-T5, there was no memo at all, so this was never at risk of a false
    // "confirmed" answer - every send re-uploaded regardless of owner, and
    // this test would still pass. What it actually pins is
    // `isDraftBlobConfirmed`'s per-owner equality check: confirming under B
    // must NOT make `putDraftBlobs` skip an upload it is asked to do under A.
    // Positive control below: a THIRD call, again under A, DOES skip -
    // proving A's own confirmation (not merely "no memo exists yet") is what
    // made the second call's upload necessary.
    const hash = await putImage(pngBytes());
    const OWNER_B = "user-blobs-b";
    const { client, calls } = countingClient(() =>
      Promise.resolve({ ok: true }),
    );

    const underA = await putDraftBlobs(HOST, client, [hash], OWNER);
    expect(underA).toEqual([hash]);
    expect(calls()).toBe(1);

    const underB = await putDraftBlobs(HOST, client, [hash], OWNER_B);
    expect(underB).toEqual([hash]);
    expect(calls()).toBe(2);

    // The store is single-slot per (host, digest): confirming B is not
    // ADDITIVE with A's earlier confirmation, it REPLACES it - a re-upload
    // under A here is the fail-safe direction (one extra upload), never a
    // lost image. Positive control that this call's own confirmation is what
    // is being read: a FOURTH call, again under A, skips it.
    const underAAgain = await putDraftBlobs(HOST, client, [hash], OWNER);
    expect(underAAgain).toEqual([hash]);
    expect(calls()).toBe(3);

    const underAOnceMore = await putDraftBlobs(HOST, client, [hash], OWNER);
    expect(underAOnceMore).toEqual([hash]);
    expect(calls()).toBe(3);
  });

  it("forgetBlobUnsupportedHost clears confirmations too, and the unbridgeable set survives forgetConfirmedDraftBlobs but not forgetBlobUnsupportedHost", async () => {
    const hash = await putImage(pngBytes());
    const { client, calls } = countingClient(() =>
      Promise.resolve({ ok: true }),
    );

    const first = await putDraftBlobs(HOST, client, [hash], OWNER);
    expect(first).toEqual([hash]);
    markDraftBlobUnbridgeable(HOST, hash);
    expect(isDraftBlobUnbridgeable(HOST, hash)).toBe(true);

    // `forgetConfirmedDraftBlobs` drops the confirmation (re-upload needed)
    // but the unbridgeable verdict is a property of the host BUILD, not the
    // conversation, and must survive it.
    forgetConfirmedDraftBlobs(HOST);
    expect(isDraftBlobConfirmed(HOST, hash, OWNER)).toBe(false);
    expect(isDraftBlobUnbridgeable(HOST, hash)).toBe(true);
    const second = await putDraftBlobs(HOST, client, [hash], OWNER);
    expect(second).toEqual([hash]);
    expect(calls()).toBe(2);

    // `forgetBlobUnsupportedHost` is the host-upgraded signal: every cached
    // verdict is suspect, including the unbridgeable set, so it clears both.
    forgetBlobUnsupportedHost(HOST);
    expect(isDraftBlobConfirmed(HOST, hash, OWNER)).toBe(false);
    expect(isDraftBlobUnbridgeable(HOST, hash)).toBe(false);
  });

  // ─── F7: no detached unhandled rejection ────────────────────────────────

  it("F7 (11): a rejecting local byte reader never escapes as a detached unhandled rejection", async () => {
    const capture = captureUnhandledRejections();
    try {
      // Positive control FIRST: prove this listener actually catches a real
      // one, so the empty-array assertion below means something.
      void Promise.reject(new Error("control"));
      await drainRejections();
      expect(capture.seen).toHaveLength(1);
      capture.seen.length = 0;

      const hash = await putImage(pngBytes());
      localReadMocks.getImageBytes.mockRejectedValue(
        new Error("IndexedDB unavailable"),
      );
      const { client, calls } = countingClient(() =>
        Promise.resolve({ ok: true }),
      );

      const result = await putDraftBlobs(HOST, client, [hash], OWNER);
      // The rejection is contained to `false`, per digest - never surfaces as
      // a thrown/rejected `putDraftBlobs`.
      expect(result).toEqual([]);
      // And the host is never even asked: the local read failed before the
      // request would have been built.
      expect(calls()).toBe(0);

      await drainRejections();
      expect(capture.seen).toEqual([]);
    } finally {
      capture.stop();
    }
  });
});
