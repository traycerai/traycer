import { afterEach, describe, expect, it } from "vitest";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
} from "@/stores/epics/open-epic/store";

/**
 * CHARACTERIZATION - `hasUnsyncedEdits` and `getUnsyncedEdits` must answer the
 * same question the same way, in every state.
 *
 * Written BEFORE the refactor that makes `hasUnsyncedEdits` a real projection
 * of `collectUnsyncedRows`, and passing before it, so it proves the refactor
 * preserved behaviour rather than describing whatever the new code does.
 *
 * It exists because the comment above `collectUnsyncedRows` asserts an
 * enforcement that does not exist: it claims `getUnsyncedEdits()` and
 * `hasUnsyncedEdits` are "both projections of it, and nothing else may
 * traverse `entries`", while `hasUnsyncedEdits` in fact does its own two-map
 * lookup. The two agree today by maintenance, not by construction - and the
 * same comment records what that cost last time: "the quit sheet protected
 * work that tab-close discarded without asking."
 *
 * Every arm asserts the CONCRETE expected answer as well as the agreement,
 * because agreement alone is satisfied by both sides saying "no" - which is
 * also what an empty registry says, and what a broken projection would say.
 */
const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function makeHandle(epicId: string, title: string) {
  const handle = createOpenEpicStore({
    epicId,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  handle.doc.getMap("epic").set("title", title);
  // Normalised to CLEAN on purpose. Seeding the title is a `Y.Doc` mutation,
  // so a freshly built handle arrives dirty with an unsynced update queued -
  // which silently made the "clean live session" arm below assert against a
  // dirty one. Every arm now states its own dirtiness explicitly rather than
  // inheriting a side effect of the setup.
  handle.store.setState({ isDirty: false, unsyncedQueueSize: 0 });
  return handle;
}

/**
 * The agreement assertion itself. Both readers are asked about the same epic
 * and must return the same verdict, and that verdict must be `expected` - so a
 * projection that always answered "no" fails here rather than passing on the
 * strength of both sides agreeing.
 */
function expectAgreement(epicId: string, expected: boolean): void {
  const registry = __getOpenEpicRegistryForTests();
  const viaRows = registry
    .getUnsyncedEdits()
    .some((row) => row.epicId === epicId);
  const viaPredicate = registry.hasUnsyncedEdits(epicId);
  expect({ viaRows, viaPredicate }).toEqual({
    viaRows: expected,
    viaPredicate: expected,
  });
}

describe("hasUnsyncedEdits agrees with getUnsyncedEdits", () => {
  afterEach(() => {
    __getOpenEpicRegistryForTests().disposeAll();
  });

  it("an epic with nothing open has no unsynced work", () => {
    expectAgreement("epic-absent", false);
  });

  it("a clean live session has no unsynced work", () => {
    const registry = __getOpenEpicRegistryForTests();
    registry.acquireMounted("epic-clean", () =>
      makeHandle("epic-clean", "Clean"),
    );
    expectAgreement("epic-clean", false);
  });

  it("a dirty live session has unsynced work", () => {
    const registry = __getOpenEpicRegistryForTests();
    const handle = makeHandle("epic-dirty", "Dirty");
    registry.acquireMounted("epic-dirty", () => handle);
    handle.store.setState({ isDirty: true, unsyncedQueueSize: 2 });
    expectAgreement("epic-dirty", true);
  });

  it("a CLEAN live session beside a retained buffer has unsynced work", () => {
    // The F10 state: the re-point established a fresh, clean session and the
    // outgoing dirty handle was retained. Reading the live entry alone says
    // "clean" here, which is the drift this pins.
    const registry = __getOpenEpicRegistryForTests();
    const outgoing = makeHandle("epic-retained", "Retained");
    outgoing.store.setState({ isDirty: true, unsyncedQueueSize: 3 });
    registry.acquireMounted("epic-retained", () => outgoing);
    registry.replaceMounted(
      "epic-retained",
      outgoing,
      makeHandle("epic-retained", "Retained"),
      {
        hostStamp: "host-a",
        ownerIdentityKey: "key-a",
        editsTransferredToReplacement: false,
      },
    );
    expect(registry.retainedCountForTests("epic-retained")).toBe(1);
    expectAgreement("epic-retained", true);
  });

  it("a DIRTY live session beside a retained buffer has unsynced work", () => {
    // The sixth row of `live {absent, clean, dirty} x retained {0, >0}`, and
    // the one where the two implementations reach `true` by DIFFERENT ROUTES:
    // the independent lookup short-circuits on the live entry's `isDirty` and
    // never consults the retained map, while a projection over the merged walk
    // reads both. "Both obviously say true" is precisely the reasoning that
    // lets a projection diverge here unnoticed.
    //
    // It is also the mixed case the fix's predicate must fire on - the live
    // half drains through its transport, the retained half never can, and the
    // restart destroys it regardless.
    const registry = __getOpenEpicRegistryForTests();
    const outgoing = makeHandle("epic-both", "Both");
    outgoing.store.setState({ isDirty: true, unsyncedQueueSize: 3 });
    registry.acquireMounted("epic-both", () => outgoing);
    const incoming = makeHandle("epic-both", "Both");
    registry.replaceMounted("epic-both", outgoing, incoming, {
      hostStamp: "host-a",
      ownerIdentityKey: "key-a",
      editsTransferredToReplacement: false,
    });
    incoming.store.setState({ isDirty: true, unsyncedQueueSize: 1 });

    // Premise, positively: BOTH halves are present. Either alone is a row
    // already covered above, so without this the arm could pass as a duplicate
    // of one of them.
    expect(registry.retainedCountForTests("epic-both")).toBe(1);
    expect(incoming.store.getState().isDirty).toBe(true);

    expectAgreement("epic-both", true);
  });

  it("a retained buffer whose LIVE ENTRY IS GONE still has unsynced work", () => {
    // THE ARM THE HISTORICAL DRIFT LIVED ON, and the only one where the two
    // implementations could diverge: `entries.get()` returns nothing, so the
    // answer has to come from the retained map alone. A projection that walks
    // only `entries` silently answers "no" here - and "no" from a data-loss
    // gate means the work is discarded without asking.
    //
    // Reached through a real product path, not by poking internals:
    // `release(epicId, "keep", null)` is the ownership-denial arm, which drops the
    // live entry and deliberately preserves retained buffers.
    const registry = __getOpenEpicRegistryForTests();
    const outgoing = makeHandle("epic-orphaned", "Orphaned");
    outgoing.store.setState({ isDirty: true, unsyncedQueueSize: 4 });
    registry.acquireMounted("epic-orphaned", () => outgoing);
    registry.replaceMounted(
      "epic-orphaned",
      outgoing,
      makeHandle("epic-orphaned", "Orphaned"),
      {
        hostStamp: "host-a",
        ownerIdentityKey: "key-a",
        editsTransferredToReplacement: false,
      },
    );
    registry.release("epic-orphaned", "keep", null);

    // Premise, positively: the live entry really is gone and the retention
    // really did survive. Without this the arm below could pass for the wrong
    // reason - an epic with neither would also be "gone".
    expect(registry.peek("epic-orphaned")).toBeNull();
    expect(registry.retainedCountForTests("epic-orphaned")).toBe(1);

    expectAgreement("epic-orphaned", true);
  });
});

describe("getUnsyncedEdits memo key", () => {
  afterEach(() => {
    __getOpenEpicRegistryForTests().disposeAll();
  });

  it("changes when ONLY `unsyncable` flips, so a re-point is not served a stale cached row", () => {
    // Pins the memo-key fix directly. The cache key used to be
    // `epicId:queueSize:isDirty:title`, which does not mention `unsyncable`.
    // A re-point that leaves the live session CLEAN and retains the outgoing
    // dirty handle changes nothing else about the row - same queueSize, same
    // isDirty, same title - only `unsyncable` flips true. Under the old key
    // this transition was invisible, so the stale cached row (unsyncable:
    // false) kept being served to the lifecycle push and the cross-window
    // snapshot, and an app-update install could restart Desktop past the
    // discard confirmation and destroy the retained document.
    const registry = __getOpenEpicRegistryForTests();
    const outgoing = makeHandle("epic-memo", "Memo");
    outgoing.store.setState({ isDirty: true, unsyncedQueueSize: 3 });
    registry.acquireMounted("epic-memo", () => outgoing);

    const before = registry
      .getUnsyncedEdits()
      .find((row) => row.epicId === "epic-memo");
    expect(before).toBeDefined();
    // Premise: a dirty LIVE session (nothing retained yet) is not unsyncable.
    expect(before === undefined ? null : before.unsyncable).toBe(false);
    expect(before === undefined ? -1 : before.queueSize).toBe(3);
    expect(before === undefined ? false : before.isDirty).toBe(true);

    registry.replaceMounted(
      "epic-memo",
      outgoing,
      makeHandle("epic-memo", "Memo"),
      {
        hostStamp: "host-a",
        ownerIdentityKey: "key-a",
        editsTransferredToReplacement: false,
      },
    );
    // Premise: the re-point really did retain the outgoing handle.
    expect(registry.retainedCountForTests("epic-memo")).toBe(1);

    const after = registry
      .getUnsyncedEdits()
      .find((row) => row.epicId === "epic-memo");
    expect(after).toBeDefined();
    expect(after === undefined ? false : after.unsyncable).toBe(true);
    // The OTHER key parts are unchanged - this is what makes the arm
    // discriminating: a key that omits `unsyncable` would return `before`
    // unmodified instead of recomputing on this call.
    expect(after === undefined ? -1 : after.queueSize).toBe(3);
    expect(after === undefined ? false : after.isDirty).toBe(true);
  });
});
