/**
 * The DELTA half of "the representation is incomplete".
 *
 * `record-table-incomplete-apply.test.ts` covers the snapshot half: an answer
 * whose rows the request-time fence held back must not license its stamp. That
 * clause alone leaves the other producer of a partial row wide open, and it is
 * the more reachable of the two because it needs no race at all.
 *
 * A push delta can INTRODUCE a row this table cannot fully state - a chat
 * whose home the stream row never carries, a terminal agent whose session
 * facet the negotiated minor had no field for. Before this counter existed,
 * that apply moved nothing: the `@1.4` delta advanced the held list stamp on
 * its own, every later poll answered `unchanged`, and the row's missing field
 * was never asked for again. For a chat that is `routeChatWrite` reading
 * `docResident: null` as "unavailable" - rename, archive, reparent and delete
 * dead for the life of the session, behind copy that says the chat is not
 * adopted. For an agent it is `sessionState: null` read as "this host cannot
 * know", i.e. a reaped agent rendering as absent rather than as asleep.
 *
 * What must NOT count is a delta that merely carries a known value forward.
 * That is the steady state - every rename, every title edit - and counting it
 * would cost a snapshot per delta, which is the entire saving this epic buys.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type {
  TuiAgentRecordSummaryV11,
  TuiAgentRecordSummaryV12,
  TuiAgentRecordSummaryV13,
} from "@traycer/protocol/host/epic/tui-agent-records";
import type {
  AgentSessionLastExit,
  AgentSessionState,
} from "@traycer/protocol/host/agent-session-state";
import {
  createChatRecordTable,
  type ChatRecordTable,
} from "../runtime/chat-record-table";
import {
  createTuiAgentRecordTable,
  type TuiAgentRecordTable,
} from "../runtime/tui-agent-record-table";

const EPIC_ID = "epic-incomplete-delta";
const VIEWER_ID = "viewer-1";
const HOST_ID = "host-1";

function chatRow(
  overrides: Partial<ChatRecordSummaryV11>,
): ChatRecordSummaryV11 {
  return {
    chatId: "c1",
    ownerUserId: VIEWER_ID,
    originHostId: HOST_ID,
    title: "",
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

/** The stream's chat row: everything the list row has EXCEPT the home. */
function chatStreamRow(overrides: Partial<ChatRecordSummaryV11>) {
  const { docResident: _home, ...rest } = chatRow(overrides);
  return rest;
}

type TuiRowOverrides = Partial<
  TuiAgentRecordSummaryV11 & {
    readonly sessionState: AgentSessionState | null;
    readonly lastExit: AgentSessionLastExit | null;
    readonly origin: "registry" | "doc" | "cloud";
  }
>;

function tuiRow(overrides: TuiRowOverrides): TuiAgentRecordSummaryV13 {
  const base: TuiAgentRecordSummaryV11 = {
    tuiAgentId: "a1",
    ownerUserId: VIEWER_ID,
    hostId: HOST_ID,
    harnessId: "claude",
    harnessSessionId: null,
    parentId: null,
    title: "",
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
  const wire = {
    ...base,
    sessionState: overrides.sessionState ?? null,
    lastExit: overrides.lastExit ?? null,
  };
  if (overrides.origin === "cloud") {
    const { docResident: _home, ...cloud } = wire;
    return { ...cloud, origin: "cloud" as const };
  }
  return base.docResident
    ? { ...wire, origin: "doc" as const }
    : { ...wire, origin: "registry" as const };
}

/** The `@1.2` STREAM row a `tuiUpsert` carries: no session facet. */
function tuiStreamRow(overrides: TuiRowOverrides): TuiAgentRecordSummaryV12 {
  const row = tuiRow(overrides);
  if (row.origin === "cloud") return row;
  const { sessionState: _state, lastExit: _exit, ...rest } = row;
  return rest;
}

let chatTable: ChatRecordTable;
let tuiTable: TuiAgentRecordTable;

beforeEach(() => {
  chatTable = createChatRecordTable({
    getCurrentUserId: () => VIEWER_ID,
    onBeforePublish: () => undefined,
    now: () => 0,
  });
  tuiTable = createTuiAgentRecordTable({
    getCurrentUserId: () => VIEWER_ID,
    onBeforePublish: () => undefined,
  });
});

describe("D1 - a chat delta that introduces a row with no home", () => {
  it("counts the apply incomplete, so the stamp it advanced is dropped", () => {
    // A REMOTE CREATE between polls: no race, no lost frame, no in-flight
    // request. Another window or an A2A agent creates the chat, its `@1.4`
    // upsert arrives stamped with the very next list revision, and this
    // client holds a complete snapshot from before it.
    expect(chatTable.deltaIncompleteSeq()).toBe(0);

    chatTable.applyDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: chatStreamRow({ chatId: "c-new", revision: 9 }),
    });

    // THE CLAIM. Nothing here was held back by a fence - the row landed in
    // full - but the table still cannot say where the chat lives, and the
    // delta advanced the held stamp as though it could.
    expect(chatTable.current().byId["c-new"]?.docResident).toBeNull();
    expect(chatTable.deltaIncompleteSeq()).toBe(1);
  });

  it("does NOT count a delta for a chat whose home is already known", () => {
    // The steady state: a rename on a chat a list answer already established.
    // Counting this would drop the stamp and re-read on every keystroke.
    chatTable.applyRecords(
      [chatRow({ chatId: "c1", docResident: true })],
      null,
    );
    expect(chatTable.deltaIncompleteSeq()).toBe(0);

    chatTable.applyDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: chatStreamRow({ chatId: "c1", revision: 5, title: "renamed" }),
    });

    // The home rode forward, so nothing became less complete.
    expect(chatTable.current().byId.c1.docResident).toBe(true);
    expect(chatTable.deltaIncompleteSeq()).toBe(0);
  });

  it("does NOT count a delta the supersession rules rejected", () => {
    // A replayed or reordered frame introduced nothing at all.
    chatTable.applyRecords([chatRow({ chatId: "c1", revision: 7 })], null);
    chatTable.applyDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: chatStreamRow({ chatId: "c1", revision: 3 }),
    });
    expect(chatTable.deltaIncompleteSeq()).toBe(0);
  });

  it("counts the introduction ONCE, not once per later delta for the row", () => {
    // Otherwise a chat awaiting its first answer re-reads the whole list on
    // every delta it receives - a refetch per keystroke rather than one
    // repair.
    chatTable.applyDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: chatStreamRow({ chatId: "c-new", revision: 9 }),
    });
    chatTable.applyDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: chatStreamRow({ chatId: "c-new", revision: 10, title: "x" }),
    });
    expect(chatTable.deltaIncompleteSeq()).toBe(1);
  });
});

describe("D2 - the terminal twin, and the @1.4 distinction", () => {
  it("counts a pre-@1.4 tuiUpsert that introduces a row with no facet", () => {
    tuiTable.applyDelta({
      kind: "tuiUpsert",
      epicId: EPIC_ID,
      record: tuiStreamRow({ tuiAgentId: "a-new", revision: 9 }),
      // No field for it on this minor - NOT STATED.
      sessionFacet: null,
    });
    expect(tuiTable.current().byId["a-new"]?.sessionState).toBeNull();
    expect(tuiTable.deltaIncompleteSeq()).toBe(1);
  });

  it("does NOT count a @1.4 tuiUpsert whose stated facet is null", () => {
    // THE DISTINCTION `TuiAgentSessionFacet` EXISTS TO MAKE. A stated `null`
    // is the serving host's answer - a peer-host row, a replica, a row it
    // does not run - and re-reading the list returns the same `null`. Paying
    // a snapshot for it would mean a permanent snapshot-per-delta for every
    // cross-host agent on the canvas.
    tuiTable.applyDelta({
      kind: "tuiUpsert",
      epicId: EPIC_ID,
      record: tuiStreamRow({ tuiAgentId: "a-peer", revision: 9 }),
      sessionFacet: { sessionState: null, lastExit: null },
    });
    expect(tuiTable.current().byId["a-peer"]?.sessionState).toBeNull();
    expect(tuiTable.deltaIncompleteSeq()).toBe(0);
  });

  it("does NOT count a @1.4 tuiUpsert that states a facet", () => {
    tuiTable.applyDelta({
      kind: "tuiUpsert",
      epicId: EPIC_ID,
      record: tuiStreamRow({ tuiAgentId: "a-new", revision: 9 }),
      sessionFacet: { sessionState: "sleeping", lastExit: "reaped" },
    });
    expect(tuiTable.current().byId["a-new"]?.sessionState).toBe("sleeping");
    expect(tuiTable.deltaIncompleteSeq()).toBe(0);
  });

  it("does NOT count a pre-@1.4 delta that carries a held facet forward", () => {
    tuiTable.applyRecords(
      [tuiRow({ tuiAgentId: "a1", sessionState: "running" })],
      null,
    );
    tuiTable.applyDelta({
      kind: "tuiUpsert",
      epicId: EPIC_ID,
      record: tuiStreamRow({ tuiAgentId: "a1", revision: 5 }),
      sessionFacet: null,
    });
    expect(tuiTable.current().byId.a1.sessionState).toBe("running");
    expect(tuiTable.deltaIncompleteSeq()).toBe(0);
  });
});

describe("D3 - the equal-revision repair the forced snapshot then needs", () => {
  it("lands a facet the answer states at the SAME revision the delta seeded", () => {
    // The other half of the composition, and the reason D2's counter is not
    // enough on its own. The snapshot D2 forces re-serves the row at the
    // revision the delta already carried - the two are reads of one registry
    // row - and rule 2's `candidate.revision > held.revision` rejects it.
    // Without the facet waiver the repair is requested and then thrown away.
    tuiTable.applyDelta({
      kind: "tuiUpsert",
      epicId: EPIC_ID,
      record: tuiStreamRow({ tuiAgentId: "a1", revision: 9 }),
      sessionFacet: null,
    });
    expect(tuiTable.current().byId.a1.sessionState).toBeNull();

    tuiTable.applyRecords(
      [
        tuiRow({
          tuiAgentId: "a1",
          revision: 9,
          sessionState: "sleeping",
          lastExit: "reaped",
        }),
      ],
      tuiTable.ingestSeq(),
    );

    expect(tuiTable.current().byId.a1.sessionState).toBe("sleeping");
    expect(tuiTable.current().byId.a1.lastExit).toBe("reaped");
  });

  it("fills in lastExit alone, for an agent already known to be sleeping", () => {
    tuiTable.applyRecords(
      [tuiRow({ tuiAgentId: "a1", revision: 9, sessionState: "sleeping" })],
      null,
    );
    tuiTable.applyRecords(
      [
        tuiRow({
          tuiAgentId: "a1",
          revision: 9,
          sessionState: "sleeping",
          lastExit: "reaped",
        }),
      ],
      tuiTable.ingestSeq(),
    );
    expect(tuiTable.current().byId.a1.lastExit).toBe("reaped");
  });

  it("still refuses a LOWER-revision answer that states a facet", () => {
    // The waiver is at no-lower revision. A stale in-flight answer cannot use
    // its extra information to overwrite a newer push.
    tuiTable.applyDelta({
      kind: "tuiUpsert",
      epicId: EPIC_ID,
      record: tuiStreamRow({ tuiAgentId: "a1", revision: 9, title: "new" }),
      sessionFacet: null,
    });
    tuiTable.applyRecords(
      [
        tuiRow({
          tuiAgentId: "a1",
          revision: 8,
          title: "stale",
          sessionState: "sleeping",
        }),
      ],
      tuiTable.ingestSeq(),
    );
    expect(tuiTable.current().byId.a1.title).toBe("new");
    expect(tuiTable.current().byId.a1.sessionState).toBeNull();
  });

  it("does not let a facet-stating answer blank a facet already held", () => {
    // The no-loss half. At equal revision the two are reads of one row and
    // should agree; refusing is cheaper than reasoning about what it means
    // when they do not.
    tuiTable.applyRecords(
      [
        tuiRow({
          tuiAgentId: "a1",
          revision: 9,
          sessionState: "sleeping",
          lastExit: "reaped",
        }),
      ],
      null,
    );
    tuiTable.applyRecords(
      [tuiRow({ tuiAgentId: "a1", revision: 9, sessionState: null })],
      tuiTable.ingestSeq(),
    );
    expect(tuiTable.current().byId.a1.sessionState).toBe("sleeping");
    expect(tuiTable.current().byId.a1.lastExit).toBe("reaped");
  });

  it("leaves a CLOUD candidate refused on authority however much it states", () => {
    // The waiver sits below the authority clauses, so it cannot reopen the
    // stale-replica trap those exist to close.
    tuiTable.applyDelta({
      kind: "tuiUpsert",
      epicId: EPIC_ID,
      record: tuiStreamRow({ tuiAgentId: "a1", revision: 9 }),
      sessionFacet: null,
    });
    tuiTable.applyRecords(
      [
        tuiRow({
          tuiAgentId: "a1",
          revision: 9,
          origin: "cloud",
          sessionState: "sleeping",
        }),
      ],
      tuiTable.ingestSeq(),
    );
    expect(tuiTable.current().byId.a1.origin).toBe("registry");
    expect(tuiTable.current().byId.a1.sessionState).toBeNull();
  });
});
