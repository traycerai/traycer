import { INERT_ROOT_STATE_PORT } from "@/stores/epics/open-epic/test-support/root-state-port-fixture";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import {
  ArtifactBodyUnavailableError,
  holdArtifactBody,
  readEpicAttachmentBytes,
  readHeldEpicAttachmentBytes,
} from "@/lib/epic-replica-reads";

interface FakeState {
  readonly acquireArtifactBodyLease: (artifactId: string) => () => void;
  readonly getArtifactFragment: (artifactId: string) => Y.XmlFragment | null;
  readonly readAttachmentBytes: (
    hash: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array | null>;
  readonly hasAttachmentBytes: (hash: string) => boolean;
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
    acquireArtifactBodyLease: () => () => {},
    getArtifactFragment: () => null,
    readAttachmentBytes: () => Promise.resolve(null),
    hasAttachmentBytes: () => false,
    ...overrides,
  };
}

describe("holdArtifactBody", () => {
  it("takes the lease before reading the fragment", async () => {
    const order: string[] = [];
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("artifact-body");
    const release = vi.fn(() => order.push("release"));
    const state = createState({
      acquireArtifactBodyLease: () => {
        order.push("acquire");
        return release;
      },
      getArtifactFragment: () => {
        order.push("fragment");
        return fragment;
      },
    });

    const hold = await holdArtifactBody(createHandle(state), "artifact-1");

    expect(hold.fragment).toBe(fragment);
    expect(order).toEqual(["acquire", "fragment"]);
    hold.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the lease when the fragment is unavailable", async () => {
    const release = vi.fn();
    const state = createState({
      acquireArtifactBodyLease: () => release,
      getArtifactFragment: () => null,
    });

    await expect(
      holdArtifactBody(createHandle(state), "artifact-1"),
    ).rejects.toBeInstanceOf(ArtifactBodyUnavailableError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not release twice when acquiring the lease throws", async () => {
    const cause = new Error("lease unavailable");
    const release = vi.fn();
    const state = createState({
      acquireArtifactBodyLease: () => {
        throw cause;
      },
    });

    await expect(
      holdArtifactBody(createHandle(state), "artifact-1"),
    ).rejects.toBe(cause);
    expect(release).not.toHaveBeenCalled();
  });

  it("makes the returned release idempotent", async () => {
    const release = vi.fn();
    const state = createState({
      acquireArtifactBodyLease: () => release,
      getArtifactFragment: () => new Y.Doc().getXmlFragment("body"),
    });

    const hold = await holdArtifactBody(createHandle(state), "artifact-1");
    hold.release();
    hold.release();
    hold.release();

    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("attachment reads", () => {
  it("waits through readEpicAttachmentBytes without consulting presence", async () => {
    const signal = new AbortController().signal;
    const bytes = Uint8Array.from([1, 2, 3]);
    const read = vi.fn((_hash: string, receivedSignal: AbortSignal) => {
      expect(receivedSignal).toBe(signal);
      return Promise.resolve(bytes);
    });
    const has = vi.fn(() => {
      throw new Error("presence must not be consulted");
    });
    const handle = createHandle(
      createState({ readAttachmentBytes: read, hasAttachmentBytes: has }),
    );

    await expect(readEpicAttachmentBytes(handle, "hash", signal)).resolves.toBe(
      bytes,
    );
    expect(has).not.toHaveBeenCalled();
  });

  it("returns null without reading when held bytes are absent", async () => {
    const read = vi.fn(() => Promise.resolve(Uint8Array.from([1])));
    const handle = createHandle(
      createState({
        hasAttachmentBytes: () => false,
        readAttachmentBytes: read,
      }),
    );

    await expect(
      readHeldEpicAttachmentBytes(handle, "missing"),
    ).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("forwards the signal when held bytes are present", async () => {
    const signal = new AbortController().signal;
    const bytes = Uint8Array.from([4, 5]);
    const read = vi.fn((_hash: string, receivedSignal: AbortSignal) => {
      expect(receivedSignal).toBe(signal);
      return Promise.resolve(bytes);
    });
    const handle = createHandle(
      createState({
        hasAttachmentBytes: () => true,
        readAttachmentBytes: read,
      }),
    );

    await expect(readHeldEpicAttachmentBytes(handle, "hash")).resolves.toBe(
      bytes,
    );
    // ONE argument: the held read stopped taking a signal when its wait moved
    // to `awaitAttachmentBytes`, which is the leg the signal belongs to.
    expect(read).toHaveBeenCalledWith("hash");
  });
});
