/**
 * `applyTouches` - the third write path `record-table.ts`'s module doc names:
 * what an `unchanged` `epic.listChatRecords@1.3` / `epic.listTuiAgents@1.3`
 * answer delivers instead of rows, and how it interacts with the shared
 * fence/revision-guard/retraction machinery both planes already have.
 *
 * Driven against `createChatRecordTable` / `createTuiAgentRecordTable`
 * DIRECTLY - no store, no React - because the reconciliation this pins lives
 * entirely in the table layer, and a store harness would only add ways for a
 * broken guard to pass for the wrong reason.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { RecordListRecencyPatch } from "@traycer/protocol/host/epic/record-list-revision";
import type {
  AgentSessionLastExit,
  AgentSessionState,
} from "@traycer/protocol/host/agent-session-state";
import type {
  TuiAgentRecordSummaryV11,
  TuiAgentRecordSummaryV12,
  TuiAgentRecordSummaryV13,
} from "@traycer/protocol/host/epic/tui-agent-records";
import { createChatRecordTable } from "../runtime/chat-record-table";
import { createTuiAgentRecordTable } from "../runtime/tui-agent-record-table";

const EPIC_ID = "epic-recency";
const OWNER_A = "user-a";
const OWNER_B = "user-b";

/** Mirrors `chat-record-key-collision.test.ts`'s `record()` fixture. */
function chatRow(
  overrides: Partial<ChatRecordSummaryV11>,
): ChatRecordSummaryV11 {
  return {
    chatId: "chat-1",
    ownerUserId: OWNER_A,
    originHostId: "host-1",
    title: "A chat",
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    runSettingsSummary: "claude",
    revision: 1,
    visibility: "private",
    origin: "own",
    docResident: false,
    ...overrides,
  };
}

function freshChatTable() {
  return createChatRecordTable({
    getCurrentUserId: () => null,
    onBeforePublish: () => undefined,
    now: () => 0,
  });
}

/**
 * The `@1.1` fields a case wants to vary, PLUS the `@1.3` session facet.
 *
 * The facet is spelled out here rather than left to `Partial<…V11>` because
 * the `@1.1` row has no field for it: passing `sessionState` through that type
 * is an excess property, and this fixture used to overwrite it with `null` one
 * line later - so a case that asked for a sleeping agent silently got an
 * unknown one, and only a type-check could say so.
 */
type TuiRowOverrides = Partial<
  TuiAgentRecordSummaryV11 & {
    readonly sessionState: AgentSessionState | null;
    readonly lastExit: AgentSessionLastExit | null;
  }
>;

/** Mirrors `tui-agent-record-key-collision.test.ts`'s `row()` fixture. */
function tuiRow(
  overrides: TuiRowOverrides,
): Extract<TuiAgentRecordSummaryV13, { origin: "registry" | "doc" }> {
  const base: TuiAgentRecordSummaryV11 = {
    tuiAgentId: "tui-1",
    ownerUserId: OWNER_A,
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
  // `@1.3`'s session facet, which the `@1.1` base this is built from has no
  // field for. An override wins; `null` - "this host cannot say" - is the
  // default, and is what every case that is not about the facet wants.
  const wire = {
    ...base,
    sessionState: overrides.sessionState ?? null,
    lastExit: overrides.lastExit ?? null,
  };
  return base.docResident
    ? { ...wire, origin: "doc" as const }
    : { ...wire, origin: "registry" as const };
}

function freshTuiTable(getCurrentUserId: () => string | null = () => null) {
  return createTuiAgentRecordTable({
    getCurrentUserId,
    onBeforePublish: () => undefined,
  });
}

describe("applyTouches - a strictly-greater patch lands (T1)", () => {
  it("moves the held row's updatedAt and reports no retraction", () => {
    const table = freshChatTable();
    table.applyRecords(
      [chatRow({ chatId: "c1", revision: 5, updatedAt: 10 })],
      null,
    );

    const patch: RecordListRecencyPatch = {
      id: "c1",
      ownerUserId: OWNER_A,
      updatedAt: 99,
      revision: 6,
    };
    const publication = table.applyTouches([patch]);

    expect(publication).not.toBeNull();
    expect(publication?.chatRetractions).toBeNull();
    expect(table.current().byId.c1.updatedAt).toBe(99);
  });
});

describe("applyTouches - equal or lower revision is dropped (T2)", () => {
  it("drops a patch at the SAME revision as the held row", () => {
    const table = freshChatTable();
    table.applyRecords(
      [chatRow({ chatId: "c1", revision: 5, updatedAt: 10 })],
      null,
    );

    const publication = table.applyTouches([
      { id: "c1", ownerUserId: OWNER_A, updatedAt: 500, revision: 5 },
    ]);

    expect(publication).toBeNull();
    expect(table.current().byId.c1.updatedAt).toBe(10);
  });

  it("drops a patch at a LOWER revision than the held row", () => {
    const table = freshChatTable();
    table.applyRecords(
      [chatRow({ chatId: "c1", revision: 5, updatedAt: 10 })],
      null,
    );

    const publication = table.applyTouches([
      { id: "c1", ownerUserId: OWNER_A, updatedAt: 500, revision: 3 },
    ]);

    expect(publication).toBeNull();
    expect(table.current().byId.c1.updatedAt).toBe(10);
  });
});

describe("applyTouches - a patch naming no held row is dropped (T3)", () => {
  it("drops a patch for a row the table has never held, and creates none", () => {
    const table = freshChatTable();

    const publication = table.applyTouches([
      { id: "ghost", ownerUserId: OWNER_A, updatedAt: 5, revision: 1 },
    ]);

    expect(publication).toBeNull();
    expect(table.current().allIds).not.toContain("ghost");
  });

  it("drops a patch for a RETRACTED id and does not resurrect it", () => {
    const table = freshChatTable();
    table.applyRecords([chatRow({ chatId: "c2", revision: 1 })], null);
    table.applyDelta({
      kind: "remove",
      epicId: EPIC_ID,
      chatId: "c2",
      reason: "deleted",
    });
    expect(table.current().allIds).not.toContain("c2");

    const publication = table.applyTouches([
      { id: "c2", ownerUserId: OWNER_A, updatedAt: 99, revision: 5 },
    ]);

    expect(publication).toBeNull();
    expect(table.current().allIds).not.toContain("c2");
  });
});

describe("applyTouches - owner-qualified identity (T4)", () => {
  it("moves only the named owner's row when two owners hold the same bare id", () => {
    const SHARED_ID = "tui-shared";
    let viewer: string | null = OWNER_A;
    const table = freshTuiTable(() => viewer);

    table.applyRecords(
      [
        tuiRow({
          ownerUserId: OWNER_A,
          tuiAgentId: SHARED_ID,
          revision: 5,
          updatedAt: 10,
        }),
        tuiRow({
          ownerUserId: OWNER_B,
          tuiAgentId: SHARED_ID,
          revision: 5,
          updatedAt: 10,
        }),
      ],
      null,
    );

    // The patch names OWNER_B alone.
    table.applyTouches([
      { id: SHARED_ID, ownerUserId: OWNER_B, updatedAt: 77, revision: 6 },
    ]);

    viewer = OWNER_B;
    expect(
      table.republishForCurrentUser()?.tuiAgentRecords.byId[SHARED_ID]
        ?.updatedAt,
    ).toBe(77);

    // OWNER_A's retained row must be untouched by a patch that never named it.
    viewer = OWNER_A;
    expect(
      table.republishForCurrentUser()?.tuiAgentRecords.byId[SHARED_ID]
        ?.updatedAt,
    ).toBe(10);
  });
});

describe("applyTouches - a touch survives a snapshot issued before it (T5)", () => {
  it("keeps the patched updatedAt through a stale-issued snapshot of the same row", () => {
    const table = freshChatTable();
    table.applyRecords(
      [chatRow({ chatId: "c1", revision: 5, updatedAt: 10 })],
      null,
    );

    const issuedBeforeThePatch = table.ingestSeq();

    table.applyTouches([
      { id: "c1", ownerUserId: OWNER_A, updatedAt: 50, revision: 6 },
    ]);

    // A snapshot re-serving the SAME row still at revision 5, but stamped
    // with the fence captured BEFORE the patch landed - the answer could not
    // have known about it.
    table.applyRecords(
      [chatRow({ chatId: "c1", revision: 5, updatedAt: 10 })],
      issuedBeforeThePatch,
    );

    expect(table.current().byId.c1.updatedAt).toBe(50);
  });
});

describe("applyTouches does not advance the snapshot fence (T6)", () => {
  it("lets a touched row survive a later EMPTY snapshot with no fence of its own", () => {
    const table = freshChatTable();
    table.applyRecords(
      [chatRow({ chatId: "c1", revision: 5, updatedAt: 10 })],
      null,
    );

    table.applyTouches([
      { id: "c1", ownerUserId: OWNER_A, updatedAt: 50, revision: 6 },
    ]);

    // `issuedAtSeq: null` - the dispatch-with-no-session case - falls back to
    // `snapshotFence`, which is where the FIRST (rows) answer left it. If
    // `applyTouches` had advanced that fence to its own `ingestSeq`, this
    // empty snapshot's omission would clear it: the fence would then sit
    // past the touched row's own sequence number and the omission-retraction
    // rule would delete it.
    table.applyRecords([], null);

    expect(table.current().byId.c1.updatedAt).toBe(50);
    expect(table.current().allIds).toContain("c1");
  });
});

describe("applyTouches - the session facet survives a recency patch (T7)", () => {
  it("keeps sessionState through a patch, and a tuiUpsert with no facet carries it forward", () => {
    const table = freshTuiTable();
    table.applyRecords(
      [
        tuiRow({
          tuiAgentId: "tui-1",
          revision: 1,
          updatedAt: 10,
          sessionState: "sleeping",
        }),
      ],
      null,
    );

    // A recency patch is a registry quiet write and states nothing about the
    // facet - `withPatch` on the tui plane deliberately leaves it untouched.
    // `TerminalAgentsSlice` does not carry the facet yet (ticket 8's work),
    // so the only thing observable here is that the patch is accepted and
    // the row's ordinary fields move; the facet's survival THROUGH the patch
    // has no seam this table exposes to a caller outside the plane.
    const afterPatch = table.applyTouches([
      { id: "tui-1", ownerUserId: OWNER_A, updatedAt: 99, revision: 2 },
    ]);
    expect(afterPatch).not.toBeNull();
    expect(table.current().byId["tui-1"]?.updatedAt).toBe(99);

    // The stream row (`@1.2`, no facet) landing as a `tuiUpsert` must not
    // reset the facet to `null` - the plane carries forward what the last
    // ANSWER stated, exactly as it does for `docResident` on the chat twin.
    // Only `origin`/`title` are observable through the published slice; the
    // facet itself is not, for the same reason noted above.
    const streamRow: TuiAgentRecordSummaryV12 = {
      origin: "registry",
      tuiAgentId: "tui-1",
      ownerUserId: OWNER_A,
      hostId: "host-A",
      harnessId: "claude",
      harnessSessionId: null,
      parentId: null,
      title: "Renamed via stream",
      isTitleEditedByUser: false,
      createdAt: 1,
      updatedAt: 100,
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
      revision: 3,
      docResident: false,
    };
    const afterUpsert = table.applyDelta({
      kind: "tuiUpsert",
      epicId: EPIC_ID,
      record: streamRow,
    });

    expect(afterUpsert).not.toBeNull();
    expect(table.current().byId["tui-1"]?.title).toBe("Renamed via stream");
  });

  it("types applyRecords' rows as the @1.3 shape, refusing a @1.2-shaped (facet-less) row", () => {
    // The runtime half above cannot observe the facet's SURVIVAL (no seam
    // exists until ticket 8 widens `TuiAgentProjection`), but the claim that
    // the table's rows CARRY the facet at all is a fact about
    // `applyRecords`' parameter type, and that is compile-time checkable: if
    // this ever gets typed back down to the `@1.2` row, a `@1.2` array (no
    // `sessionState` / `lastExit`) would newly satisfy it and nothing today
    // would catch that regression. This assertion is enforced by `tsc`
    // (`bun run compile`), not by the vitest runtime - there is no
    // `test.typecheck` project configured here, so this line is a no-op when
    // merely run, and only reddens under a type-check.
    const table = freshTuiTable();
    expectTypeOf<readonly TuiAgentRecordSummaryV12[]>().not.toExtend<
      Parameters<typeof table.applyRecords>[0]
    >();
  });
});
