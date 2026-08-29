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
import type {
  TuiAgentRecordSummaryV11,
  TuiAgentRecordSummaryV12,
} from "@traycer/protocol/host/epic/tui-agent-records";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";

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
 * A local row (registry- or doc-resident). Every scenario in this file is
 * about the MERGE (revision guards, omission fencing) rather than about doc
 * residency, so the default is `false` - an ordinary registry row.
 *
 * Built as the `@1.1` shape (both local arms are field-for-field identical
 * bar `origin`) and then given the `origin` its own `docResident` implies,
 * exactly as `epicListTuiAgentsUpgradeV11ToV12` derives it - so this factory
 * can never produce the one combination the wire itself cannot
 * (`docResident: true` paired with `origin: "registry"`, or the reverse).
 * Only the two local arms: this file never exercises a `cloud` row.
 */
function row(
  overrides: Partial<TuiAgentRecordSummaryV11>,
): Extract<TuiAgentRecordSummaryV12, { origin: "registry" | "doc" }> {
  const base: TuiAgentRecordSummaryV11 = {
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
  return base.docResident
    ? { ...base, origin: "doc" as const }
    : { ...base, origin: "registry" as const };
}

/**
 * Every handle a test opens. A store subscribes to the auth store at
 * construction and unsubscribes only in `dispose()`, so an undisposed handle
 * would keep re-publishing and re-projecting on every later test's sign-out.
 */
const openHandles: OpenEpicStoreHandle[] = [];

function newSession(): OpenEpicStoreHandle {
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
  const handle = createOpenEpicStore({
    epicId: "epic-test",
    streamClientFactory: factory,
    userId: null,
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  openHandles.push(handle);
  return handle;
}

function ids(handle: OpenEpicStoreHandle): readonly string[] {
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

describe("applyTuiAgentRecordDelta takes the row's own provenance", () => {
  it("preserves what the frame stated, rather than re-deriving it", () => {
    // THIS USED TO STAMP `docResident: false` unconditionally, and that was
    // right while the frame could not answer: at `@1.1` a `tuiUpsert` carried
    // the `@1.0` row, which has no `docResident` at all, and the delta plane
    // was registry-only - so `false` was a fact about the SOURCE.
    //
    // `@1.2` gave the row an `origin` and a second producer. Re-deriving now
    // would overwrite a stated answer with a guess, and there is no guess that
    // is right for both arms.
    signedInAs(USER);
    const handle = newSession();
    handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: row({ tuiAgentId: "tui-1" }),
    });

    const applied = handle.store.getState().tuiAgentRecords.byId["tui-1"];
    expect(applied.origin).toBe("registry");
    expect(applied.docResident).toBe(false);
  });

  it("LISTS a replica whose cloud row never named a harness", () => {
    // The protocol arm makes `harnessId` nullable on purpose - a cloud row
    // written before `runSettingsSummary` carried the harness has none - and
    // says such a row renders without a harness mark. Dropping it here made
    // the agent vanish from the roster on every other machine, which is the
    // one outcome the contract rules out: the host stores and serves it
    // correctly, and only the projection was losing it.
    signedInAs(USER);
    const handle = newSession();
    handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: {
        origin: "cloud",
        tuiAgentId: "tui-legacy",
        ownerUserId: USER,
        hostId: "host-elsewhere",
        harnessId: null,
        parentId: null,
        title: "A legacy remote agent",
        isTitleEditedByUser: false,
        createdAt: 1,
        updatedAt: 2,
        archived: false,
        revision: 1,
      },
    });

    const applied = handle.store.getState().tuiAgentRecords.byId["tui-legacy"];
    expect(applied).toBeDefined();
    expect(applied.harnessId).toBeNull();
  });

  it("still DROPS a replica naming a harness this build cannot dispatch", () => {
    // A different case, and it keeps its old answer: the row named something
    // (a newer host's vendor), so a tile for it would promise a session this
    // build cannot open. Absent beats a row that errors on click.
    signedInAs(USER);
    const handle = newSession();
    handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: {
        origin: "cloud",
        tuiAgentId: "tui-future",
        ownerUserId: USER,
        hostId: "host-elsewhere",
        harnessId: "some-future-vendor",
        parentId: null,
        title: "An agent this build cannot run",
        isTitleEditedByUser: false,
        createdAt: 1,
        updatedAt: 2,
        archived: false,
        revision: 1,
      },
    });

    expect(
      handle.store.getState().tuiAgentRecords.byId["tui-future"],
    ).toBeUndefined();
  });

  it("applies a CROSS-HOST replica, which has no docResident to stamp", () => {
    // The second producer: the serving host's record inbox, replicating an
    // agent bound to another of the user's machines. The narrow arm carries no
    // `docResident` key, so the old unconditional stamp had nothing to write
    // it onto - and the projection derives `false` from the arm rather than
    // from a field that is not there.
    signedInAs(USER);
    const handle = newSession();
    handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: {
        origin: "cloud",
        tuiAgentId: "tui-remote",
        ownerUserId: USER,
        hostId: "host-elsewhere",
        harnessId: "claude",
        parentId: null,
        title: "An agent on my other machine",
        isTitleEditedByUser: false,
        createdAt: 1,
        updatedAt: 2,
        archived: false,
        revision: 1,
      },
    });

    const applied = handle.store.getState().tuiAgentRecords.byId["tui-remote"];
    expect(applied.origin).toBe("cloud");
    // NOT doc-resident: a replica is not the doc map's frozen copy, and it IS
    // addressable through the registry affordances - on its own host, which is
    // where every mutation aimed at it has to go anyway.
    expect(applied.docResident).toBe(false);
    // The placeholders the narrow arm cannot fill. `origin` is what keeps a
    // consumer from reading them as facts about the remote machine - above all
    // `harnessSessionId`, whose absence is why a replica can never be cloned.
    expect(applied.harnessSessionId).toBeNull();
    expect(applied.workspaceFolders).toEqual([]);
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

/** The narrow cross-host arm, as a delta or a snapshot row. */
function cloudRow(
  overrides: Partial<Extract<TuiAgentRecordSummaryV12, { origin: "cloud" }>>,
): TuiAgentRecordSummaryV12 {
  return {
    origin: "cloud",
    tuiAgentId: "tui-1",
    ownerUserId: USER,
    hostId: "host-elsewhere",
    harnessId: "claude",
    parentId: null,
    title: "An agent on my other machine",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    revision: 1,
    ...overrides,
  };
}

describe("terminal-agent merge puts AUTHORITY before revision", () => {
  it("TRIPWIRE: a registry snapshot row replaces a held cloud row at a LOWER revision", () => {
    // THE STRANDING THIS PREVENTS. The host may legitimately answer with the
    // authoritative local row at or below a stale replica's revision - it
    // drops a replica sitting under a live local row SILENTLY, then serves the
    // local row from its next list. A revision-first rule rejects that as "not
    // newer" and keeps the cloud copy, which is unlaunchable and unforkable -
    // and because the id WAS in the snapshot, the omission fence cannot remove
    // it either. Nothing dislodges it until some later local mutation happens
    // to bump the revision.
    signedInAs(USER);
    const handle = newSession();
    handle.store
      .getState()
      .applyTuiAgentRecords([cloudRow({ revision: 999 })], null);
    handle.store
      .getState()
      .applyTuiAgentRecords([row({ tuiAgentId: "tui-1", revision: 1 })], null);

    expect(handle.store.getState().tuiAgentRecords.byId["tui-1"].origin).toBe(
      "registry",
    );
  });

  it("TRIPWIRE: a registry DELTA replaces a held cloud row at a lower revision", () => {
    // The push half of the same rule. Poll and push share one predicate so
    // they cannot disagree about which of two rows wins.
    signedInAs(USER);
    const handle = newSession();
    handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: cloudRow({ revision: 999 }),
    });
    handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: row({ tuiAgentId: "tui-1", revision: 1 }),
    });

    expect(handle.store.getState().tuiAgentRecords.byId["tui-1"].origin).toBe(
      "registry",
    );
  });

  it("never lets a cloud row displace a local one, however new it is", () => {
    // The other direction, and the one that keeps a live local agent usable: a
    // replica arriving at a far higher revision must not turn an authoritative
    // row into an unlaunchable copy.
    signedInAs(USER);
    const handle = newSession();
    handle.store
      .getState()
      .applyTuiAgentRecords([row({ tuiAgentId: "tui-1", revision: 1 })], null);
    handle.store
      .getState()
      .applyTuiAgentRecords([cloudRow({ revision: 999 })], null);

    expect(handle.store.getState().tuiAgentRecords.byId["tui-1"].origin).toBe(
      "registry",
    );
  });

  it("still orders by revision BETWEEN two rows of the same authority", () => {
    // Authority is a tie-breaker between planes, not a licence to ignore
    // ordering. Two replicas still compare by revision, so a replayed or
    // reordered delta stays a no-op.
    signedInAs(USER);
    const handle = newSession();
    handle.store
      .getState()
      .applyTuiAgentRecords([cloudRow({ revision: 5, title: "newer" })], null);
    handle.store
      .getState()
      .applyTuiAgentRecords([cloudRow({ revision: 4, title: "older" })], null);

    expect(handle.store.getState().tuiAgentRecords.byId["tui-1"].title).toBe(
      "newer",
    );
  });
});
