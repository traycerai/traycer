/**
 * A retained-buffer merge that the target REFUSES must not destroy the source.
 *
 * `applyRootUpdate` answers whether the update LANDED, and it answers `false`
 * rather than throwing precisely so a caller can act on it - "a merge that
 * cannot land is a fact the caller must act on: it decides whether the source's
 * edits have been transferred". The retention merge ignored that answer. It
 * awaited the apply, converted a rejection to `false` too, and then disposed the
 * source in EVERY case - so under a worker fault or a teardown race the source,
 * which is the only copy of its unsynced edits, was destroyed silently while the
 * target's `queueSize` had already been credited as if the transfer had
 * happened. The user's work was gone and the count said it was there.
 *
 * ## Why the target is disposed to drive this
 *
 * Not a stub, and not a mocked port: `applyRootUpdate` answers `false` on a
 * disposed runtime (`if (disposed) return Promise.resolve(false)`), which IS
 * the teardown race the finding names. Driving it through the real port means
 * the pin fails if the refusal ever stops being reported the same way, rather
 * than agreeing with a fake that would keep answering `false` forever.
 *
 * ## Why both a count and the sizes
 *
 * The public row for an epic merges every retention into one, so "merged into
 * the existing buffer" and "kept as a second buffer" are indistinguishable
 * through it - and so are "reverted the credit" and "left it double-counted",
 * because the totals agree. Both test seams are read here for that reason: the
 * count proves the source survived, and the per-buffer sizes prove the credit
 * for a transfer that did not happen was taken back.
 */
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
  // Dirtiness DERIVED from the named queue size, not set beside it. Only a
  // dirty handle is retained on re-point, so the two carriers this rig uses to
  // move the mounted slot along must be clean or they become retentions of
  // their own - which is how the first draft of this test built three buffers
  // and read the count as a refused merge. A freshly built handle also arrives
  // dirty from seeding its own doc, so this normalises rather than assumes.
  handle.store.setState({
    isDirty: queueSize > 0,
    unsyncedQueueSize: queueSize,
  });
  return handle;
}

/**
 * Retire the mounted handle into a retained buffer, through the product path.
 *
 * `replaceMounted` with `editsTransferredToReplacement: false` is the re-point
 * that leaves the outgoing handle as the only copy of its edits, which is
 * exactly the condition the retention exists for.
 */
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

    // BUFFER TWO - the source, which must survive the refusal. It replaces the
    // handle the first re-point installed, under the SAME identity, which is
    // what routes it into the merge rather than into a second slot.
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

    // The merge is deliberately asynchronous - the retention verdict its caller
    // serves is synchronous, and only the tail decides what becomes of the
    // source. Drained through the harness's own pipe rather than a bare
    // `await`, because the apply crosses the worker bridge.
    await final.flush();
    await final.flush();
    await final.flush();

    // The source was KEPT, not disposed. Under the unfixed tree this is 1: the
    // refusal was swallowed and the only copy of five queued edits destroyed.
    expect(registry.retainedCountForTests(EPIC_ID)).toBe(2);
    expect(await isAlive(source)).toBe(true);

    // And the credit for a transfer that did not happen was taken back. The
    // TOTAL is 8 either way, which is why this reads the buffers rather than
    // the row: a revert that was forgotten shows `[8, 5]` and tells the user
    // about thirteen unsynced edits that do not exist.
    expect([...registry.retainedQueueSizesForTests(EPIC_ID)]).toEqual([3, 5]);
  });
});
