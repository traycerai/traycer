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
import type { TuiAgentRecordSummary } from "@traycer/protocol/host/epic/tui-agent-records";
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

function row(
  overrides: Partial<TuiAgentRecordSummary>,
): TuiAgentRecordSummary {
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
    ...overrides,
  };
}

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
    handle.store.getState().applyTuiAgentRecords([row({ tuiAgentId: "old" })]);

    handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: row({ tuiAgentId: "pushed" }),
    });
    // The stale answer: issued before `pushed` existed, so it names only `old`.
    handle.store.getState().applyTuiAgentRecords([row({ tuiAgentId: "old" })]);

    expect(ids(handle)).toEqual(["old", "pushed"]);
  });

  it("collects a genuinely deleted agent on the answer after the next", () => {
    // The other half of the same rule: holding an omitted row forever would
    // turn a missed `tuiRemove` (a delta lost to a disconnect) into a row that
    // outlives the session. The grace is exactly one answer - the following
    // read is necessarily issued after the fence moved, so an omission there is
    // evidence.
    signedInAs(USER);
    const handle = newSession();
    handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: row({ tuiAgentId: "doomed" }),
    });

    handle.store.getState().applyTuiAgentRecords([]);
    expect(ids(handle)).toEqual(["doomed"]);

    handle.store.getState().applyTuiAgentRecords([]);
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
      .applyTuiAgentRecords([row({ tuiAgentId: "tui-1", title: "Before" })]);

    handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiUpsert",
      epicId: "epic-test",
      record: row({ tuiAgentId: "tui-1", title: "After", revision: 2 }),
    });
    handle.store
      .getState()
      .applyTuiAgentRecords([
        row({ tuiAgentId: "tui-1", title: "Before", revision: 1 }),
      ]);

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
      .applyTuiAgentRecords([row({ tuiAgentId: "tui-1", title: "Before" })]);
    handle.store
      .getState()
      .applyTuiAgentRecords([
        row({ tuiAgentId: "tui-1", title: "After", revision: 2 }),
      ]);

    expect(handle.store.getState().tuiAgentRecords.byId["tui-1"].title).toBe(
      "After",
    );
  });

  it("keeps a retraction absorbing across the merge", () => {
    // `tuiRemove` is the explicit deletion signal and outranks every later
    // answer for the session - the merge must not become a way back in.
    signedInAs(USER);
    const handle = newSession();
    handle.store.getState().applyTuiAgentRecords([row({ tuiAgentId: "tui-1" })]);
    handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiRemove",
      epicId: "epic-test",
      tuiAgentId: "tui-1",
      reason: "deleted",
    });

    handle.store
      .getState()
      .applyTuiAgentRecords([row({ tuiAgentId: "tui-1", revision: 9 })]);

    expect(ids(handle)).toEqual([]);
  });
});
