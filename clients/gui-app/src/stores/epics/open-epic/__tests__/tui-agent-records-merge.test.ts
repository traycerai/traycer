/**
 * How the terminal-agent record table combines its TWO producers - the
 * `epic.listTuiAgents` poll (`applyTuiAgentRecords`) and the
 * `host.chatRecords.subscribe@1.1` push (`applyTuiAgentRecordDelta`).
 *
 * The pair is not ordered by anything the wire carries. A list read issued
 * before an agent was committed cannot contain it, and the `tuiUpsert` that
 * announces that agent can land while the read is still in flight - so the
 * older answer arrives LAST and, as a clear-and-replace, would delete the row
 * the push had just surfaced. That is the exact shape of the field report this
 * channel exists to fix (an A2A-created child that never appears), which is why
 * the merge rules are pinned here rather than left to the reducer's shape.
 *
 * Two rules, both asserted below with their ablation named:
 *   - a SERVED row is revision-guarded, like a delta, so an older answer cannot
 *     regress a newer push;
 *   - an OMITTED row is retracted only once an answer issued after it was
 *     ingested has had its chance, so a genuine deletion is still collected.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { TuiAgentRecordSummaryV11 } from "@traycer/protocol/host/epic/tui-agent-records";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { useAuthStore } from "@/stores/auth/auth-store";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

const USER = "user-a";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-test",
      title: "Epic test",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

/**
 * A registry row. Every scenario in this file is about the MERGE (revision
 * guards, omission fencing) rather than about doc residency, so the default
 * is `false` - an ordinary registry row.
 *
 * Typed as the WIRE `@1.1` row so it satisfies `applyTuiAgentRecords`'s
 * `TuiAgentRecordSummaryV11[]` directly. It is also assignable to a delta's
 * `record: TuiAgentRecordSummary` field (the delta plane's wire type, which
 * carries no `docResident` of its own - see `applyTuiAgentRecordDelta`'s
 * stamp): `TuiAgentRecordSummaryV11` is a strict superset, and this is a
 * function return value rather than an object literal, so no excess-property
 * check applies.
 */
function row(
  overrides: Partial<TuiAgentRecordSummaryV11>,
): TuiAgentRecordSummaryV11 {
  return {
    tuiAgentId: "tui-1",
    ownerUserId: USER,
    hostId: "host-A",
    harnessId: "claude",
    harnessSessionId: null,
    parentId: null,
    title: "An agent",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    workspaceFolders: [],
    workspaceMode: null,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    revision: 1,
    docResident: false,
    ...overrides,
  };
}

/**
 * Every handle a test opens. A store subscribes to the auth store at
 * construction and unsubscribes only in `dispose()`, so an undisposed handle
 * would keep re-publishing and re-projecting on every later test's sign-out.
 */
const openHandles: OpenedStoreForTest[] = [];

function newSession(): OpenedStoreForTest {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: "epic-test",
    userId: null,
    // The factories go to the COMPOSITION now, not the store:
    // `createOpenEpicStore` stopped constructing a runtime, so a
    // suite that used to hand it a `streamClientFactory` has nothing
    // to hand it. `handle.doc` still resolves because this harness
    // builds the runtime in THIS thread.
    factories: {
      streamClientFactory: factory,
      laneSelection: null,
    },
    // Explicit: `null` means this suite never writes, so a write in
    // one that said so fails rather than resolving quietly.
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  openHandles.push(handle);
  return handle;
}

/**
 * A session whose ROOT SNAPSHOT already carries doc content, for the tests that
 * need `docTuiAgents` to be non-empty before any record answers.
 *
 * Separate from {@link newSession} rather than a parameter on it: every other
 * test in this file asserts about the record TABLE and wants an empty doc, and
 * threading a seeder through them all would put a doc-projection concern into
 * eleven tests that have none.
 */
function newSessionSeeded(seedDoc: (doc: Y.Doc) => void): OpenedStoreForTest {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: "epic-test",
    userId: null,
    factories: {
      streamClientFactory: factory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  const seed = new Y.Doc();
  seedDoc(seed);
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(seed));
  openHandles.push(handle);
  return handle;
}

/**
 * One doc-resident terminal agent, with every field
 * `projectTerminalAgent` requires.
 *
 * `harnessId: "codex"` because the projection DROPS a row whose harness this
 * build cannot dispatch (`narrowTuiHarnessId`) - a fixture naming `cursor` or
 * an unknown vendor would produce an empty slice and the alias pins would then
 * be asserting `EMPTY === EMPTY`, which holds for the wrong reason.
 */
function seedDocTerminalAgent(doc: Y.Doc, id: string, title: string): void {
  const agent = new Y.Map<unknown>();
  agent.set("id", id);
  agent.set("harnessId", "codex");
  agent.set("title", title);
  agent.set("parentId", null);
  agent.set("createdAt", 1);
  agent.set("updatedAt", 1);
  agent.set("hostId", "host-1");
  agent.set("workspaceFolders", ["/repo"]);
  agent.set("model", null);
  agent.set("reasoningEffort", null);
  agent.set("agentMode", "regular");
  agent.set("harnessSessionId", null);
  agent.set("terminalShellCommand", null);
  agent.set("terminalShellArgs", null);
  const agents = new Y.Map<unknown>();
  agents.set(id, agent);
  doc.getMap("epic").set("tuiAgents", agents);
}

function ids(handle: OpenedStoreForTest): readonly string[] {
  return handle.store.getState().tuiAgentRecords.allIds.slice().sort();
}

function signedInAs(userId: string): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId, userName: userId, email: `${userId}@example.com` },
      { userId, username: userId },
      [],
    );
}

// The auth store is module-global; do not leak this identity into the next test.
afterEach(() => {
  // Before the sign-out: a live handle's auth subscription would otherwise
  // re-publish and re-project a store the test is done with.
  for (const handle of openHandles.splice(0)) handle.dispose();
  useAuthStore.getState().setSignedOut();
});

describe("applyTuiAgentRecords merges rather than replaces", () => {
  it("keeps a pushed agent that an in-flight list answer could not carry", () => {
    // The A2A case end to end: the host commits `pushed`, the delta announces
    // it, and the list read that was ALREADY in flight answers without it.
    //
    // Ablation: restore the `clear()`-then-refill body and `pushed` is gone
    // from the table the instant the stale answer lands.
    signedInAs(USER);
    const handle = newSession();
    const state = handle.store.getState();
    state.applyTuiAgentRecords([row({ tuiAgentId: "old" })], null);

    // The read is dispatched HERE - the hook captures the counter before the
    // RPC - and the push lands while it is in flight.
    const issuedAt = state.peekTuiAgentIngestSeq();
    state.applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: row({ tuiAgentId: "pushed" }),
    });
    // The stale answer: issued before `pushed` existed, so it names only `old`.
    state.applyTuiAgentRecords([row({ tuiAgentId: "old" })], issuedAt);

    expect(ids(handle)).toEqual(["old", "pushed"]);
  });

  it("collects a deleted agent on the first answer issued after it landed", () => {
    // The other half of the same rule: holding an omitted row forever would
    // turn a missed `tuiRemove` (a delta lost to a disconnect) into a row that
    // outlives the session. An answer issued AFTER the push is evidence - the
    // host had the row when it answered - so the omission retracts it at once,
    // not one read later.
    //
    // Ablation: fence on the previous answer's watermark instead of the
    // request-time counter and `doomed` survives this answer, staying
    // actionable until the 20s poll after a mutation's own refetch.
    signedInAs(USER);
    const handle = newSession();
    const state = handle.store.getState();
    state.applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: row({ tuiAgentId: "doomed" }),
    });

    // Stream drops; the agent is deleted on the host; a mutation-triggered
    // refetch is dispatched now and answers without it.
    state.applyTuiAgentRecords([], state.peekTuiAgentIngestSeq());
    expect(ids(handle)).toEqual([]);
  });

  it("falls back to a one-answer grace when no fence was captured", () => {
    // `null` is the dispatch-with-no-session case: the answer cannot say
    // whether it was issued before or after the push, so the previous
    // answer's watermark stands in and the row survives exactly one answer.
    signedInAs(USER);
    const handle = newSession();
    const state = handle.store.getState();
    state.applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: row({ tuiAgentId: "doomed" }),
    });

    state.applyTuiAgentRecords([], null);
    expect(ids(handle)).toEqual(["doomed"]);

    state.applyTuiAgentRecords([], null);
    expect(ids(handle)).toEqual([]);
  });

  it("does not let an older served row regress a newer pushed revision", () => {
    // Revision is per-record monotonic and is the only ordering fact on a row,
    // so the poll owes it the same test the push already applies.
    //
    // Ablation: drop the revision guard in the served loop and the title reverts
    // to "Before" - a rename the user has already seen land, undone by a poll.
    signedInAs(USER);
    const handle = newSession();
    handle.store
      .getState()
      .applyTuiAgentRecords(
        [row({ tuiAgentId: "tui-1", title: "Before" })],
        null,
      );

    handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: row({ tuiAgentId: "tui-1", title: "After", revision: 2 }),
    });
    handle.store
      .getState()
      .applyTuiAgentRecords(
        [row({ tuiAgentId: "tui-1", title: "Before", revision: 1 })],
        null,
      );

    expect(handle.store.getState().tuiAgentRecords.byId["tui-1"].title).toBe(
      "After",
    );
  });

  it("still lets a served row advance the table when its revision is newer", () => {
    // The positive control for the guard above: same shape, newer revision, so
    // the poll must win. Without this a guard inverted to `>=` would pass the
    // test above and silently freeze the table against its own poll.
    signedInAs(USER);
    const handle = newSession();
    handle.store
      .getState()
      .applyTuiAgentRecords(
        [row({ tuiAgentId: "tui-1", title: "Before" })],
        null,
      );
    handle.store
      .getState()
      .applyTuiAgentRecords(
        [row({ tuiAgentId: "tui-1", title: "After", revision: 2 })],
        null,
      );

    expect(handle.store.getState().tuiAgentRecords.byId["tui-1"].title).toBe(
      "After",
    );
  });

  it("refreshes a doc-resident row on a later answer at the same revision: 0", () => {
    // H1: `tuiAgentRecordSummaryOfDocEntry` hardcodes every doc-resident row to
    // `revision: 0` on EVERY answer, because a doc entry has no registry seq
    // to report. The ordinary revision guard ("apply only when strictly
    // greater") would then reject every refresh of a doc-resident row against
    // itself - `0 <= 0` - freezing it at whatever the session's first answer
    // said, for the life of the session (H1 in the cold review). The two
    // titles below are the only way to observe the freeze: an unfixed guard
    // keeps "First poll" forever.
    //
    // Ablation: drop the `bothDocResident` waiver back to a bare
    // `row.revision <= held.revision` and this fails - the second answer's
    // title never lands.
    signedInAs(USER);
    const handle = newSession();
    const state = handle.store.getState();

    state.applyTuiAgentRecords(
      [
        row({
          tuiAgentId: "tui-1",
          docResident: true,
          revision: 0,
          title: "First poll",
        }),
      ],
      null,
    );
    expect(handle.store.getState().tuiAgentRecords.byId["tui-1"].title).toBe(
      "First poll",
    );

    state.applyTuiAgentRecords(
      [
        row({
          tuiAgentId: "tui-1",
          docResident: true,
          revision: 0,
          title: "Second poll",
        }),
      ],
      null,
    );
    expect(handle.store.getState().tuiAgentRecords.byId["tui-1"].title).toBe(
      "Second poll",
    );
  });

  it("still blocks a doc-resident row at revision 0 from clobbering a held registry row", () => {
    // The H1 waiver is narrow: it applies ONLY when both the held row and the
    // incoming row are doc-resident. A held REGISTRY row (revision >= 1) must
    // still win against a doc row at revision 0 - the ordinary guard, not the
    // waiver, governs this pair.
    signedInAs(USER);
    const handle = newSession();
    const state = handle.store.getState();

    state.applyTuiAgentRecords(
      [
        row({
          tuiAgentId: "tui-1",
          docResident: false,
          revision: 3,
          title: "Registry row",
        }),
      ],
      null,
    );

    state.applyTuiAgentRecords(
      [
        row({
          tuiAgentId: "tui-1",
          docResident: true,
          revision: 0,
          title: "Stale doc copy",
        }),
      ],
      null,
    );

    const held = handle.store.getState().tuiAgentRecords.byId["tui-1"];
    expect(held.title).toBe("Registry row");
    expect(held.docResident).toBe(false);
  });

  it("still lets adoption replace a held doc-resident row at revision 0 with a real registry row", () => {
    // The other direction the waiver must not break: the adoption path
    // (`converges a frozen doc-resident row...` below) is a registry row
    // (revision >= 1) replacing a held DOC row at 0 - that must keep working,
    // since it is not a doc-over-doc comparison and the ordinary guard
    // (`0 <= n` is false) already lets it through.
    signedInAs(USER);
    const handle = newSession();
    const state = handle.store.getState();

    state.applyTuiAgentRecords(
      [
        row({
          tuiAgentId: "tui-1",
          docResident: true,
          revision: 0,
          title: "Frozen (doc-resident)",
        }),
      ],
      null,
    );

    state.applyTuiAgentRecords(
      [
        row({
          tuiAgentId: "tui-1",
          docResident: false,
          revision: 1,
          title: "Adopted (registry)",
        }),
      ],
      null,
    );

    const held = handle.store.getState().tuiAgentRecords.byId["tui-1"];
    expect(held.title).toBe("Adopted (registry)");
    expect(held.docResident).toBe(false);
  });

  it("keeps a retraction absorbing across the merge", () => {
    // `tuiRemove` is the explicit deletion signal and outranks every later
    // answer for the session - the merge must not become a way back in.
    signedInAs(USER);
    const handle = newSession();
    handle.store
      .getState()
      .applyTuiAgentRecords([row({ tuiAgentId: "tui-1" })], null);
    handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiRemove",
      epicId: "epic-test",
      tuiAgentId: "tui-1",
      reason: "deleted",
    });

    handle.store
      .getState()
      .applyTuiAgentRecords([row({ tuiAgentId: "tui-1", revision: 9 })], null);

    expect(ids(handle)).toEqual([]);
  });
});

describe("applyTuiAgentRecordDelta always reports registry provenance", () => {
  it("stamps docResident: false on every delta-applied row", () => {
    // The delta plane is REGISTRY-ONLY by construction - a `tuiUpsert` frame
    // (`TuiAgentRecordDelta` in `chat-records-stream-client.ts`) carries a
    // `TuiAgentRecordSummary`, which has no `docResident` of its own. So
    // `false` here is a fact about the SOURCE the store stamps unconditionally,
    // not a filled-in default.
    signedInAs(USER);
    const handle = newSession();
    handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      // Deliberately `true` on the way in: the fixture's default is `false`,
      // so an implementation that PASSED the field THROUGH instead of
      // stamping the delta plane's own `false` would also pass a
      // default-valued row. It must not survive this one.
      record: row({ tuiAgentId: "tui-1", docResident: true }),
    });

    expect(
      handle.store.getState().tuiAgentRecords.byId["tui-1"].docResident,
    ).toBe(false);
  });

  it("converges a frozen doc-resident row through the same revision guard the poll's merge uses", () => {
    // `epic.listTuiAgents@1.1` can serve a doc-resident remainder at
    // `revision: 0` (the lowest value the wire admits - see
    // `tuiAgentRecordSummaryOfDocEntry`): the frozen copy of an agent whose
    // BINDING host has not upgraded. The delta plane cannot address that row
    // directly - it is registry-only - but it does not need to: the moment
    // the binding host upgrades and the eviction sweep imports the entry, the
    // FIRST real registry delta for that id carries a revision >= 1, which -
    // through the exact staleness test exercised above ("does not let an
    // older served row regress a newer pushed revision") - strictly exceeds
    // the frozen `0` and replaces it, flipping `docResident` to `false` in
    // the same move.
    //
    // Ablation: if the doc-resident poll row were held at any revision other
    // than the lowest the wire admits, a binding host that upgrades and
    // imports at a low real revision could lose to the frozen copy and the
    // agent would stay stuck at `docResident: true`. Pinning the doc-resident
    // row to `revision: 0` is what guarantees the FIRST real registry write
    // always wins.
    signedInAs(USER);
    const handle = newSession();
    const state = handle.store.getState();

    // The @1.1 poll serving the doc-resident remainder.
    state.applyTuiAgentRecords(
      [
        row({
          tuiAgentId: "tui-1",
          docResident: true,
          revision: 0,
          title: "Frozen (doc-resident)",
        }),
      ],
      null,
    );
    const frozen = handle.store.getState().tuiAgentRecords.byId["tui-1"];
    expect(frozen.docResident).toBe(true);
    expect(frozen.title).toBe("Frozen (doc-resident)");

    // The binding host upgrades; the sweep imports the row; the push
    // announces it as an ordinary registry upsert.
    state.applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: row({
        tuiAgentId: "tui-1",
        revision: 1,
        title: "Adopted (registry)",
      }),
    });

    // Not just a flag flip in isolation: the ENTIRE frozen row was replaced by
    // the real one (`title` proves it, `docResident` proves what it now is).
    const after = handle.store.getState().tuiAgentRecords.byId["tui-1"];
    expect(after.docResident).toBe(false);
    expect(after.title).toBe("Adopted (registry)");
  });
});

/**
 * The `tuiAgents` / `docTuiAgents` alias - the TWIN of the one
 * `chat-records-union.test.ts` pins, and the member of that pair that had no
 * pin at all until this suite grew one.
 *
 * There are exactly two producer aliases of this shape in the projection:
 * `unionChats` returns `docChats` itself when no record has answered, and
 * `unionTerminalAgents` returns `docAgents` on the same condition
 * (`projection-helpers.ts`). `chats === docChats` was pinned; `tuiAgents ===
 * docTuiAgents` was not, and it was severed identically and silently by the
 * store's per-key `replaceEqualDeep` pass - each key reconciled against its
 * own previous value, so two deep-equal results and no `===`.
 *
 * Pinned here rather than left to the chats twin's coverage because "the other
 * one is tested" is exactly the reasoning under which this one went unnoticed.
 */
describe("the doc slice is handed through by reference in doc-only mode", () => {
  it("aliases `tuiAgents` to `docTuiAgents` while no record has answered", () => {
    signedInAs(USER);
    const handle = newSessionSeeded((doc) => {
      seedDocTerminalAgent(doc, "doc-only", "Doc-only agent");
    });

    const state = handle.store.getState();
    expect(state.tuiAgents.allIds).toEqual(["doc-only"]);
    // The alias itself. A consumer reads `===` here as "no record layer".
    expect(state.tuiAgents).toBe(state.docTuiAgents);
  });

  it("un-aliases the moment a record answers, even when the content is unchanged", () => {
    // The other half, and the one that says the alias is a FACT about the
    // record layer rather than about content: the record below projects to a
    // row equal field-for-field to what the doc already held, and the slices
    // must still come apart.
    //
    // NOTE ON ITS HISTORY, so the vacuous era is on record: the sibling
    // assertion in `chat-records-union.test.ts` (`expect(chats).not.toBe(
    // docChats)`) passed for the whole period the alias was severed, because
    // nothing was ever aliased and a negative identity assertion cannot fail
    // in that world. It became a REAL pin only once aliasing was restored, and
    // so did this one. A `not.toBe` is only load-bearing beside a `toBe` that
    // holds.
    signedInAs(USER);
    const handle = newSessionSeeded((doc) => {
      seedDocTerminalAgent(doc, "both", "Same content");
    });
    const store = handle.store;
    expect(store.getState().tuiAgents).toBe(store.getState().docTuiAgents);

    store
      .getState()
      .applyTuiAgentRecords(
        [row({ tuiAgentId: "both", title: "Same content", revision: 1 })],
        null,
      );

    expect(store.getState().tuiAgents).not.toBe(
      store.getState().docTuiAgents,
    );
    expect(store.getState().tuiAgents.byId.both.title).toBe("Same content");
  });
});
