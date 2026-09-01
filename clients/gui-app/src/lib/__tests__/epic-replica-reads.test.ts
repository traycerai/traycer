import { INERT_ROOT_STATE_PORT } from "@/stores/epics/open-epic/test-support/root-state-port-fixture";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import type {
  ArtifactBodyResidentLease,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { ArtifactBodyRetention } from "@/stores/epics/open-epic/runtime/worker/artifact-body-lease-bridge";
import {
  ArtifactBodyUnavailableError,
  holdArtifactBody,
  readEpicAttachmentBytes,
  readHeldEpicAttachmentBytes,
} from "@/lib/epic-replica-reads";

interface FakeState {
  /**
   * The read seam takes the RESIDENT member and no longer the sync one, so the
   * sync member is deliberately absent here: a fixture that still offered it
   * would let a test pin a call `holdArtifactBody` does not make.
   */
  readonly acquireResidentArtifactBodyLease: (
    artifactId: string,
    // Mirrors the store member: the fixture is cast to the real type, so a
    // narrower arity here is a mismatch the cast can no longer bridge.
    retention: ArtifactBodyRetention,
  ) => ArtifactBodyResidentLease;
  readonly getArtifactFragment: (artifactId: string) => Y.XmlFragment | null;
  /**
   * The two attachment legs, and they are DIFFERENT store members - which is
   * the whole property this fixture exists to keep observable.
   *
   * `awaitAttachmentBytes` waits, so it takes the signal that bounds the wait.
   * `readAttachmentBytes` answers from what the replica already holds, so it
   * takes the hash alone: there is no wait, and nothing to abort.
   *
   * `hasAttachmentBytes` is deliberately ABSENT. It was the held leg's
   * synchronous presence guard on main, and the relocation moved it into the
   * worker, which now answers `null` for a hash it does not hold. A fixture
   * still offering it would let a test pin a guard that no longer runs here.
   */
  readonly awaitAttachmentBytes: (
    hash: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array | null>;
  readonly readAttachmentBytes: (hash: string) => Promise<Uint8Array | null>;
}

function createHandle(state: FakeState): OpenEpicStoreHandle {
  const store = {
    getState: (): FakeState => state,
  } as OpenEpicStoreHandle["store"];
  // This is a deliberately narrow fixture: the read seam only asks the store
  // for the four members above, while the handle remains the real public type.
  return {
    epicId: "epic-1",
    userId: "user-1",
    // No `doc` / `awareness`: a production handle has neither, because the
    // replica lives on the worker thread and a `Y.Doc` cannot cross a
    // structured clone. A fake that offered them would let a test reach for a
    // capability its callers no longer have.
    store,
    // Present because the handle is the real public type; the read seam never
    // touches either, and a fixture that omitted them would not compile.
    projection: {
      accept: () => null,
      apply: () => {},
      reject: () => {},
    },
    body: { applyDocUpdate: () => {}, applyAwareness: () => {} },
    dispose: () => {},
    detachTransport: () => {},
    requestFreshSnapshot: () => {},
    isClean: () => true,
    hotArtifactRoomIdsForTests: () => [],
    ...INERT_ROOT_STATE_PORT,
  };
}

function createState(overrides: Partial<FakeState>): FakeState {
  return {
    acquireResidentArtifactBodyLease: () => ({
      release: () => {},
      resident: Promise.resolve(),
    }),
    getArtifactFragment: () => null,
    awaitAttachmentBytes: () => Promise.resolve(null),
    readAttachmentBytes: () => Promise.resolve(null),
    ...overrides,
  };
}

/** Deferred promise, so a test can settle `resident` on its own schedule. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  // Settled through a HOLDER rather than two `let … | null` locals with a
  // guard: TypeScript does not track the executor's assignments, so the guard
  // reads as a comparison between literal values and is rejected as an
  // unnecessary condition. Same shape `provisional-boot-session.test.ts`'s
  // `createDeferredResponse` uses.
  const handles: {
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
  } = { resolve: () => undefined, reject: () => undefined };
  const promise = new Promise<T>((res, rej) => {
    handles.resolve = res;
    handles.reject = rej;
  });
  return {
    promise,
    resolve: (value) => {
      handles.resolve(value);
    },
    reject: (reason) => {
      handles.reject(reason);
    },
  };
}

describe("holdArtifactBody", () => {
  it("resolves the fragment that only becomes readable after residency settles", async () => {
    const fragment = new Y.Doc().getXmlFragment("body");
    const release = vi.fn();
    const gate = deferred<void>();
    let residentSettled = false;
    const state = createState({
      acquireResidentArtifactBodyLease: () => ({
        release,
        resident: gate.promise,
      }),
      getArtifactFragment: () => (residentSettled ? fragment : null),
    });

    const holdPromise = holdArtifactBody(
      createHandle(state),
      "artifact-1",
      "linger",
    );
    // Not resident yet - the fragment must not be readable through this same
    // fixture until residency settles.
    expect(state.getArtifactFragment("artifact-1")).toBeNull();

    residentSettled = true;
    gate.resolve();

    // The whole point of the seam: the fragment is read only AFTER residency
    // settles. Reading it in the same tick as the acquire - which is what this
    // function used to do - sees `residentSettled === false` and reports a body
    // that was milliseconds away as `ArtifactBodyUnavailableError`.
    await expect(holdPromise).resolves.toMatchObject({ fragment });
  });

  it("rejects with ArtifactBodyUnavailableError and releases when the grant is unavailable", async () => {
    const release = vi.fn();
    const state = createState({
      acquireResidentArtifactBodyLease: () => ({
        release,
        resident: Promise.reject(
          new ArtifactBodyUnavailableError("artifact-1"),
        ),
      }),
    });

    await expect(
      holdArtifactBody(createHandle(state), "artifact-1", "linger"),
    ).rejects.toBeInstanceOf(ArtifactBodyUnavailableError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not release twice when acquiring the lease throws", async () => {
    const cause = new Error("lease unavailable");
    const release = vi.fn();
    const state = createState({
      acquireResidentArtifactBodyLease: () => {
        throw cause;
      },
    });

    await expect(
      holdArtifactBody(createHandle(state), "artifact-1", "linger"),
    ).rejects.toBe(cause);
    // Nothing to release: the acquire never handed a lease back, and the
    // `catch` must not invent one. Kept from before the resident lease
    // existed - only the member that throws changed.
    expect(release).not.toHaveBeenCalled();
  });

  it("makes the returned release idempotent", async () => {
    const release = vi.fn();
    const fragment = new Y.Doc().getXmlFragment("body");
    const state = createState({
      acquireResidentArtifactBodyLease: () => ({
        release,
        resident: Promise.resolve(),
      }),
      getArtifactFragment: () => fragment,
    });

    const hold = await holdArtifactBody(
      createHandle(state),
      "artifact-1",
      "linger",
    );
    hold.release();
    hold.release();
    hold.release();

    expect(release).toHaveBeenCalledTimes(1);
  });
});

/**
 * The two legs must not collapse into one another.
 *
 * `epic-replica-reads.ts` states the cost of merging them, in both directions:
 * guarding the waiting leg turns "still replicating" into "missing" for exactly
 * the images expected to be late, and dropping the guard on the held leg parks
 * the chat chain forever on a hash the epic doc never held. So every test below
 * asserts BOTH which member ran and which did not - a pin that only checked the
 * result would pass with the two wired to the same member, which is the defect.
 */
describe("attachment reads", () => {
  it("waits through awaitAttachmentBytes, and never takes the held read", async () => {
    const signal = new AbortController().signal;
    const bytes = Uint8Array.from([1, 2, 3]);
    const waited = vi.fn((_hash: string, receivedSignal: AbortSignal) => {
      expect(receivedSignal).toBe(signal);
      return Promise.resolve(bytes);
    });
    const held = vi.fn(() => Promise.resolve(null));
    const handle = createHandle(
      createState({ awaitAttachmentBytes: waited, readAttachmentBytes: held }),
    );

    await expect(readEpicAttachmentBytes(handle, "hash", signal)).resolves.toBe(
      bytes,
    );
    expect(waited).toHaveBeenCalledWith("hash", signal);
    // The held leg answers `null` for a hash still replicating, so reaching it
    // here IS the "still syncing becomes missing" regression.
    expect(held).not.toHaveBeenCalled();
  });

  it("answers null from the held read alone when the replica does not hold the bytes", async () => {
    const held = vi.fn(() => Promise.resolve(null));
    const waited = vi.fn(() => Promise.resolve(Uint8Array.from([1])));
    const handle = createHandle(
      createState({ readAttachmentBytes: held, awaitAttachmentBytes: waited }),
    );

    await expect(
      readHeldEpicAttachmentBytes(handle, "missing"),
    ).resolves.toBeNull();
    // The `null` comes from the WORKER's own presence check, which is where the
    // guard moved; main no longer asks a separate predicate first.
    expect(held).toHaveBeenCalledWith("missing");
    // Waiting here would park the chat chain on a hash the epic doc never held.
    expect(waited).not.toHaveBeenCalled();
  });

  it("passes the hash alone when held bytes are present - there is no wait to abort", async () => {
    const bytes = Uint8Array.from([4, 5]);
    const held = vi.fn(() => Promise.resolve(bytes));
    const waited = vi.fn(() => Promise.resolve(null));
    const handle = createHandle(
      createState({ readAttachmentBytes: held, awaitAttachmentBytes: waited }),
    );

    await expect(readHeldEpicAttachmentBytes(handle, "hash")).resolves.toBe(
      bytes,
    );
    // ONE argument: the held read stopped taking a signal when its wait moved
    // to `awaitAttachmentBytes`, which is the leg the signal belongs to.
    expect(held).toHaveBeenCalledWith("hash");
    expect(waited).not.toHaveBeenCalled();
  });
});
