/**
 * F2 and F4 - the TRANSFER (`transferFor`) must outlive any one caller's
 * bounded wait, and the caller's bound must cover the whole transfer,
 * verification and write-back included.
 *
 * F2: a caller timeout used to end the whole flight - `inFlightByHash` was
 * deleted, an eager worker took another pool slot while the original
 * download was still on the wire, and a late successful reply was never
 * decoded or stored. `transferFor` now owns a flight that lives until the
 * work settles; `awaitTransferBounded` is only the caller's bounded VIEW of
 * it.
 *
 * F4: the old timer was cleared once `request()` answered, so digest
 * verification and the IndexedDB write-back ran outside any deadline - a
 * stalled write-back held a caller open forever. The caller's bound now
 * covers the whole transfer.
 *
 * `putImageBytesAtHash` is mocked module-wide so the F4 cases can stall it,
 * but delegates to the REAL implementation by default (captured from
 * `importOriginal`) so the F2 cases still exercise genuine digest
 * verification and an actual IndexedDB write - only the two F4 cases swap in
 * a controlled implementation, and restore it afterward.
 *
 * Fake timers are scoped to `["setTimeout", "clearTimeout"]` only - a bare
 * `vi.useFakeTimers()` also fakes `setImmediate`/`queueMicrotask` and stalls
 * the fake IndexedDB the store writes through, which reads as a hang, not a
 * failure. Timers are never advanced before the work they bound has actually
 * been entered (a recorded call).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";

import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { getImageBytes } from "@/lib/composer/landing-image-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordCloudDraftImageSources,
  readCloudDraftImageBytes,
  recoverCloudDraftImages,
  resetCloudDraftImageRecoveryForTests,
} from "@/lib/drafts/cloud-draft-image-recovery";
import type { DraftBlobClient } from "@/lib/drafts/draft-blob-transport";
import type { ImageBytes } from "@/lib/attachments/image-bytes";

type PutImageBytesAtHash = (
  hash: string,
  bytes: ImageBytes,
) => Promise<boolean>;

const putState = vi.hoisted(() => ({
  impl: null as PutImageBytesAtHash | null,
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  // Default to the REAL implementation so every test not deliberately
  // overriding it still gets genuine digest verification and a real write.
  putState.impl = actual.putImageBytesAtHash;
  return {
    ...actual,
    putImageBytesAtHash: (hash: string, bytes: ImageBytes) => {
      const impl = putState.impl;
      if (impl === null) throw new Error("putImageBytesAtHash impl unset");
      return impl(hash, bytes);
    },
  };
});

/** The caller's own wait, mirrored from `cloud-draft-image-recovery.ts`. */
const CALLER_READ_TIMEOUT_MS = 10_000;

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

async function sha256HexOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  return btoa(String.fromCharCode(...bytes));
}

// Never shared with any other suite's byte content - the landing-image-store
// session cache survives `installFreshIndexedDb()`, so a repeated byte
// pattern could silently hit a stale entry.
let uniqueByteSeed = 200_000;

function uniqueBytes(length: number): Uint8Array<ArrayBuffer> {
  uniqueByteSeed += 1;
  const seed = uniqueByteSeed;
  return new Uint8Array(
    Array.from({ length }, (_unused, index) => (seed * 13 + index * 5) % 256),
  );
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Drains pending work under fake timers: the fake IndexedDB the store reads
 * and writes through settles its requests on a zero-delay timer, not a bare
 * microtask, so a plain microtask flush never lets `hasLocalImageBytes` or a
 * write-back actually complete while `["setTimeout", "clearTimeout"]` are
 * faked. `advanceTimersByTimeAsync` flushes microtasks between each 0ms
 * tick, which is what lets IndexedDB's own chain of callbacks run.
 */
async function flushFakeTimers(times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Same drain, for the stretches where real timers are in effect. */
async function flushRealTimers(times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
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
  vi.useRealTimers();
  resetCloudDraftImageRecoveryForTests();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("cloud-draft-image-recovery - transfer lifetime (F2)", () => {
  it("bounds concurrent transfers to 4 and never frees a slot at the caller's 10s mark - all 8 land once released", async () => {
    const fixtures = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const bytes = uniqueBytes(4);
        const hash = await sha256HexOf(bytes);
        return { bytes, hash };
      }),
    );
    const gates = new Map<string, Deferred<void>>();
    for (const { hash } of fixtures) gates.set(hash, deferred<void>());

    let inFlight = 0;
    let maxInFlight = 0;
    const requestedHashes: string[] = [];
    const { client } = recordingClient((_method, params) => {
      const { ref } = params as { ref: { sha256: string } };
      requestedHashes.push(ref.sha256);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const gate = gates.get(ref.sha256);
      const fixture = fixtures.find((f) => f.hash === ref.sha256);
      if (gate === undefined || fixture === undefined) {
        throw new Error("unexpected hash");
      }
      return gate.promise.then(() => {
        inFlight -= 1;
        return {
          outcome: {
            status: "ok" as const,
            bytesBase64: toBase64(fixture.bytes),
            byteLength: fixture.bytes.byteLength,
          },
        };
      });
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const resultPromise = recoverCloudDraftImages({
      identity: IDENTITY,
      hostId: "host-a",
      client,
      hashes: fixtures.map((f) => f.hash),
    });

    // Let the four eager workers each reach their own RPC call.
    await flushFakeTimers(5);
    expect(requestedHashes).toHaveLength(4);
    expect(maxInFlight).toBe(4);

    // Cross the caller's own 10s bound. Under the old design this was also
    // the bound on the TRANSFER, so the flight would have been abandoned
    // here and a fifth/sixth request dispatched while the first four were
    // still (deliberately) held open. Under the fix, nothing changes: the
    // eager pass never asked for a bounded view in the first place.
    await vi.advanceTimersByTimeAsync(CALLER_READ_TIMEOUT_MS + 1);
    expect(requestedHashes).toHaveLength(4);
    expect(maxInFlight).toBe(4);

    // Release the first batch and let the pool advance to the rest.
    vi.useRealTimers();
    for (const { hash } of fixtures.slice(0, 4)) {
      gates.get(hash)?.resolve();
    }
    await flushRealTimers(5);
    for (const { hash } of fixtures.slice(4)) {
      gates.get(hash)?.resolve();
    }

    await resultPromise;

    expect(requestedHashes.sort()).toEqual(fixtures.map((f) => f.hash).sort());
    for (const { hash, bytes } of fixtures) {
      expect(await getImageBytes(hash)).toEqual(bytes);
    }
  });

  it("a lazy reply that lands AFTER the caller's 10s deadline still verifies and stores - the caller only gets null", async () => {
    const bytes = uniqueBytes(6);
    const hash = await sha256HexOf(bytes);
    const gate = deferred<void>();
    const { client, calls } = recordingClient((_method, _params) =>
      gate.promise.then(() => ({
        outcome: {
          status: "ok" as const,
          bytesBase64: toBase64(bytes),
          byteLength: bytes.byteLength,
        },
      })),
    );

    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-a",
      client,
      hashes: [hash],
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const callerPromise = readCloudDraftImageBytes(hash);

    // Let the request actually dispatch before the deadline can mean anything.
    await flushFakeTimers(5);
    expect(calls).toHaveLength(1);

    // Cross the caller's bound while the reply is still withheld. Under the
    // pre-fix design this deleted `inFlightByHash` outright, so the reply
    // arriving afterward would have nowhere to verify or store into.
    await vi.advanceTimersByTimeAsync(CALLER_READ_TIMEOUT_MS + 1);
    await expect(callerPromise).resolves.toBeNull();

    // The late reply now lands. The transfer is still alive underneath -
    // only the caller gave up - so it decodes, verifies and stores.
    vi.useRealTimers();
    gate.resolve();
    await flushRealTimers(10);

    expect(await getImageBytes(hash)).toEqual(bytes);
  });
});

describe("cloud-draft-image-recovery - stalled write-back (F4)", () => {
  afterEach(async () => {
    // Restore the real implementation the mock factory captured, so a later
    // F2 test (or a re-run of this suite) is never left pointed at a
    // never-settling stub from a prior case.
    const actual = await vi.importActual<
      typeof import("@/lib/composer/landing-image-store")
    >("@/lib/composer/landing-image-store");
    putState.impl = actual.putImageBytesAtHash;
  });

  it("a write-back that never settles yields null to the caller within the 10s bound", async () => {
    putState.impl = () => new Promise<boolean>(() => {});
    const bytes = uniqueBytes(3);
    const hash = await sha256HexOf(bytes);
    const { client, calls } = recordingClient((_method, _params) =>
      Promise.resolve({
        outcome: {
          status: "ok" as const,
          bytesBase64: toBase64(bytes),
          byteLength: bytes.byteLength,
        },
      }),
    );

    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-a",
      client,
      hashes: [hash],
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const callerPromise = readCloudDraftImageBytes(hash);

    // Let the request settle and the (never-settling) write-back start.
    await flushFakeTimers(5);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(CALLER_READ_TIMEOUT_MS + 1);
    await expect(callerPromise).resolves.toBeNull();
  });

  it("positive control: a write-back that resolves true still returns the bytes to the caller", async () => {
    putState.impl = () => Promise.resolve(true);
    const bytes = uniqueBytes(3);
    const hash = await sha256HexOf(bytes);
    const { client } = recordingClient((_method, _params) =>
      Promise.resolve({
        outcome: {
          status: "ok" as const,
          bytesBase64: toBase64(bytes),
          byteLength: bytes.byteLength,
        },
      }),
    );

    recordCloudDraftImageSources({
      identity: IDENTITY,
      hostId: "host-a",
      client,
      hashes: [hash],
    });

    const result = await readCloudDraftImageBytes(hash);
    expect(result).toEqual(bytes);
  });
});
