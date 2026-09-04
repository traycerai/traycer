/**
 * A retained-buffer merge that is still in flight when the registry is torn
 * down must not resurrect its source.
 *
 * `mergeRetainedThenDispose` awaits `encodeRootState` and then
 * `applyRootUpdate`. Across those awaits the source handle is in NEITHER
 * collection: it has left `sessions`, and it is not in `retained` because the
 * point of the merge is that its edits went into the target. So when
 * `disposeAll()` runs - sign-out, user switch, token expiry - its two loops
 * walk `sessions` and `retained` and cannot see the source at all.
 *
 * A late `applied: false` (or a rejection) then called
 * `keepSourceAsItsOwnBuffer()`, which appends that handle back into the map
 * `disposeAll` had just cleared. A previous identity's Y.Doc and its unsynced
 * row came back AFTER the security boundary, which is the one outcome
 * `disposeAll` exists to make impossible.
 *
 * ## Why the count alone is not enough
 *
 * "Not re-appended" and "disposed" are different facts, and only the second is
 * safe: a source dropped without disposal is still a live Y.Doc belonging to
 * the signed-out identity, merely one nothing tracks any more. The liveness
 * probe is the half that distinguishes them, so this pin fails a fix that
 * returns early without disposing.
 *
 * ## Why the sibling refusal test is not enough
 *
 * `retained-buffer-merge-refusal.test.ts` drives the same refusal and asserts
 * the source SURVIVES. That is the correct behaviour with no teardown in play,
 * and it passes both before and after this fence - which is exactly why it
 * could not catch this. The discriminator here is the `disposeAll()` landing
 * inside the await window; the two tests together pin that the fence fires on
 * teardown and only on teardown.
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
  // Dirtiness DERIVED from the named queue size: only a dirty handle is
  // retained on re-point, so the clean carriers that move the mounted slot
  // along do not become retentions of their own.
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

    // BUFFER ONE - the merge target. Disposed up front so the merge below
    // reaches a real `applied: false` through the real port rather than a
    // stub that would answer `false` forever.
    const target = makeHandle(3);
    const afterTarget = retain(target);
    expect(registry.retainedCountForTests(EPIC_ID)).toBe(1);
    target.dispose();
    expect(await isAlive(target)).toBe(false);

    // BUFFER TWO - the source. Same identity, so it routes into the MERGE
    // rather than into a second slot, which is what puts it in neither
    // collection for the duration of the awaits.
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

    // THE STIMULUS: sign-out lands while the merge is still awaiting. No flush
    // has run yet, so the chain is parked on `encodeRootState`/`applyRootUpdate`
    // and the source is invisible to both loops inside `disposeAll`.
    registry.disposeAll();
    expect(registry.retainedCountForTests(EPIC_ID)).toBe(0);

    // Now let the merge tail settle, the same way the sibling test does - the
    // apply crosses the worker bridge, so this is drained through the harness
    // pipe rather than a bare `await`.
    await final.flush();
    await final.flush();
    await final.flush();

    // Half 1: nothing came back. Under the unfixed tree the late refusal
    // re-appends the source and this reads 1 - a signed-out identity's
    // unsynced row, live again after the boundary.
    expect(registry.retainedCountForTests(EPIC_ID)).toBe(0);

    // Half 2: and it was DISPOSED, not merely dropped. Without this a fix that
    // returns early would pass Half 1 while leaving the previous identity's
    // Y.Doc alive and untracked, which is the same leak with no row to show it.
    expect(await isAlive(source)).toBe(false);
  });
});
