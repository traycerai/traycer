/** A retained-buffer merge that the target REFUSES must not destroy the source. */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

const EPIC_ID = "epic-refused-merge";
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
  // Dirtiness DERIVED from the named queue size, not set beside it.
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

describe("a retained buffer whose merge target refuses the update", () => {
  afterEach(() => {
    __getOpenEpicRegistryForTests().disposeAll();
  });

  it("keeps the source as its own buffer and takes back the credit", async () => {
    const registry = __getOpenEpicRegistryForTests();

    // BUFFER ONE - the merge target.
    const target = makeHandle(3);
    const afterTarget = retain(target);
    expect(registry.retainedCountForTests(EPIC_ID)).toBe(1);

    // The teardown race, made deterministic. From here the target's runtime is
    // gone, so the merge below will reach a real `applied: false`.
    target.dispose();
    expect(await isAlive(target)).toBe(false);

    // BUFFER TWO - the source, which must survive the refusal.
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

    // The merge is deliberately asynchronous - the retention verdict its caller serves is synchronous,
    // and only the tail decides what becomes of the source.
    await final.flush();
    await final.flush();
    await final.flush();

    // The source was KEPT, not disposed. Under the unfixed tree this is 1: the
    // refusal was swallowed and the only copy of five queued edits destroyed.
    expect(registry.retainedCountForTests(EPIC_ID)).toBe(2);
    expect(await isAlive(source)).toBe(true);

    // And the credit for a transfer that did not happen was taken back.
    expect([...registry.retainedQueueSizesForTests(EPIC_ID)]).toEqual([3, 5]);
  });
});
