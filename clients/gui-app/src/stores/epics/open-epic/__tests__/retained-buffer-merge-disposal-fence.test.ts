/**
 * A retained-buffer merge that is still in flight when the registry is torn down must not
 * resurrect its source.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

const EPIC_ID = "epic-disposed-mid-merge";
/** Same host and same owner identity: what makes two retentions ONE room. */
const IDENTITY = { hostStamp: "host-a", ownerIdentityKey: "key-a" } as const;

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function makeHandle(queueSize: number): OpenedStoreForTest {
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  // Dirtiness DERIVED from the named queue size: only a dirty handle is retained on re-point, so the
  // clean carriers that move the mounted slot along do not become retentions of their own.
  handle.store.setState({
    isDirty: queueSize > 0,
    unsyncedQueueSize: queueSize,
  });
  return handle;
}

/** Retire the mounted handle into a retained buffer, through the product path. */
function retain(outgoing: OpenedStoreForTest): OpenedStoreForTest {
  const registry = __getOpenEpicRegistryForTests();
  registry.acquireMounted(EPIC_ID, () => outgoing);
  const incoming = makeHandle(0);
  registry.replaceMounted(EPIC_ID, outgoing, incoming, {
    ...IDENTITY,
    editsTransferredToReplacement: false,
  });
  return incoming;
}

/**
 * Whether this handle's replica is still alive, asked through the same port
 * the merge uses. A disposed runtime answers `false` to every apply.
 */
async function isAlive(handle: OpenedStoreForTest): Promise<boolean> {
  const probe = new Y.Doc();
  probe.getMap("epic").set("liveness-probe", "1");
  return handle.applyRootUpdate(Y.encodeStateAsUpdate(probe), false);
}

describe("a retained-buffer merge still in flight when the registry is torn down", () => {
  afterEach(() => {
    __getOpenEpicRegistryForTests().disposeAll();
  });

  it("disposes the source instead of re-retaining it past disposeAll", async () => {
    const registry = __getOpenEpicRegistryForTests();

    // BUFFER ONE - the merge target. Disposed up front so the merge below reaches a real `applied:
    // false` through the real port rather than a stub that would answer `false` forever.
    const target = makeHandle(3);
    const afterTarget = retain(target);
    expect(registry.retainedCountForTests(EPIC_ID)).toBe(1);
    target.dispose();
    expect(await isAlive(target)).toBe(false);

    // BUFFER TWO - the source. Same identity, so it routes into the MERGE rather than into a second
    // slot, which is what puts it in neither collection for the duration of the awaits.
    const source = makeHandle(5);
    registry.acquireMounted(EPIC_ID, () => source);
    registry.replaceMounted(EPIC_ID, afterTarget, source, {
      ...IDENTITY,
      editsTransferredToReplacement: false,
    });
    const final = makeHandle(0);
    registry.replaceMounted(EPIC_ID, source, final, {
      ...IDENTITY,
      editsTransferredToReplacement: false,
    });

    // THE STIMULUS: sign-out lands while the merge is still awaiting.
    registry.disposeAll();
    expect(registry.retainedCountForTests(EPIC_ID)).toBe(0);

    // Now let the merge tail settle, the same way the sibling test does - the apply crosses the worker
    // bridge, so this is drained through the harness pipe rather than a bare `await`.
    await final.flush();
    await final.flush();
    await final.flush();

    // Half 1: nothing came back. Under the unfixed tree the late refusal re-appends the source and
    // this reads 1 - a signed-out identity's unsynced row, live again after the boundary.
    expect(registry.retainedCountForTests(EPIC_ID)).toBe(0);

    // Half 2: and it was DISPOSED, not merely dropped.
    expect(await isAlive(source)).toBe(false);
  });
});
