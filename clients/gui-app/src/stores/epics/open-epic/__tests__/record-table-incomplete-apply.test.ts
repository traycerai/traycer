/**
 * `snapshotIncompleteSeq` - the signal a revision-gated list poll declines its
 * answer's stamp on, and the reason `applyTouches` must not promote a row's
 * `revision`.
 *
 * ## What these exist to prevent
 *
 * Rule 1 (`record-table.ts`) means an answer's rows are sometimes NOT what the
 * table ends up holding: a row ingested after the request was issued survives
 * that answer, whether the answer omits it or carries a copy of it. Before the
 * list read was gated that cost one poll interval - the next unconditional
 * answer re-served the row and it landed one tick late. A gated poll can answer
 * `unchanged` instead, so the client may only claim to hold what an answer
 * described when it actually took every row that answer carried. This counter is
 * the inverse of that claim.
 *
 * Driven against `createChatRecordTable` / `createTuiAgentRecordTable` directly
 * - no store, no React - because the fence, the guard and the counter all live
 * in the table layer. The wire half (that the poll really does return to
 * `knownRevision: null`) is pinned in
 * `hooks/chats/__tests__/record-list-revision-gating.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { ChatRecordSummaryStreamV13 } from "@traycer/protocol/host/epic/chat-records";
import type {
  AgentSessionState,
  AgentSessionLastExit,
} from "@traycer/protocol/host/agent-session-state";
import type {
  TuiAgentRecordSummaryV11,
  TuiAgentRecordSummaryV12,
  TuiAgentRecordSummaryV13,
} from "@traycer/protocol/host/epic/tui-agent-records";
import { createChatRecordTable } from "../runtime/chat-record-table";
import { createTuiAgentRecordTable } from "../runtime/tui-agent-record-table";

const EPIC_ID = "epic-incomplete";
const OWNER_A = "user-a";

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

/** The STREAM row a `host.chatRecords.subscribe` upsert carries: no home. */
function chatStreamRow(
  overrides: Partial<ChatRecordSummaryStreamV13>,
): ChatRecordSummaryStreamV13 {
  const { docResident: _ignored, ...base } = chatRow({});
  return { ...base, ...overrides };
}

function freshChatTable() {
  return createChatRecordTable({
    getCurrentUserId: () => OWNER_A,
    onBeforePublish: () => undefined,
    now: () => 0,
  });
}

type TuiRowOverrides = Partial<
  TuiAgentRecordSummaryV11 & {
    readonly sessionState: AgentSessionState | null;
    readonly lastExit: AgentSessionLastExit | null;
  }
>;

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
  const wire = {
    ...base,
    sessionState: overrides.sessionState ?? null,
    lastExit: overrides.lastExit ?? null,
  };
  return base.docResident
    ? { ...wire, origin: "doc" as const }
    : { ...wire, origin: "registry" as const };
}

/** The `@1.2` STREAM row a `tuiUpsert` carries: no session facet. */
function tuiStreamRow(overrides: TuiRowOverrides): TuiAgentRecordSummaryV12 {
  const { sessionState: _state, lastExit: _exit, ...row } = tuiRow(overrides);
  return row;
}

function freshTuiTable() {
  return createTuiAgentRecordTable({
    getCurrentUserId: () => OWNER_A,
    onBeforePublish: () => undefined,
  });
}

describe("a carried row the fence skipped marks the apply incomplete (I1)", () => {
  it("declines the stamp for the create-a-chat race, and the NEXT snapshot states the home", () => {
    const table = freshChatTable();
    // 1. The list request leaves. Nothing is held yet, so the fence is 0.
    const issuedAtSeq = table.ingestSeq();
    expect(table.snapshotIncompleteSeq()).toBe(0);

    // 2. The owning host pushes its `upsert` the moment it commits, and it
    //    lands while the request is in flight. The stream row cannot state the
    //    home, and nothing is held to carry one forward, so the row is seeded
    //    `docResident: null`.
    table.applyDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: chatStreamRow({ chatId: "c1", revision: 5 }),
    });
    expect(table.current().byId.c1.docResident).toBeNull();

    // 3. The answer arrives carrying the SAME revision with the home stated -
    //    a fresher read of the same registry row, not a staler one. The fence
    //    skips it anyway (rule 1's carried half, ahead of the waiver at
    //    `chatRowSupersedesOnSnapshot`'s first clause that exists to let this
    //    answer fill the home).
    table.applyRecords(
      [chatRow({ chatId: "c1", revision: 5, docResident: true })],
      issuedAtSeq,
    );
    expect(table.current().byId.c1.docResident).toBeNull();

    // THE CLAIM: the table says so, so the poll can decline this answer's
    // stamp. Without it every later poll answers `unchanged`, the home stays
    // unknown, and `routeChatWrite` reports the chat as unadopted - rename,
    // archive and reparent closed for the life of the session.
    expect(table.snapshotIncompleteSeq()).toBe(1);

    // 4. Which is what makes the next poll a full snapshot. Its fence is
    //    current, so the row lands and the home is stated at last.
    table.applyRecords(
      [chatRow({ chatId: "c1", revision: 5, docResident: true })],
      table.ingestSeq(),
    );
    expect(table.current().byId.c1.docResident).toBe(true);
    // Self-healing ONCE: a complete apply leaves the counter alone, so the
    // stamp this answer carries is held and the gating engages again.
    expect(table.snapshotIncompleteSeq()).toBe(1);
  });
});

describe("the terminal twin: a racing tuiUpsert marks the apply incomplete (I2)", () => {
  it("declines the stamp, so the snapshot that states the session facet is not suppressed", () => {
    const table = freshTuiTable();
    const issuedAtSeq = table.ingestSeq();

    // A `tuiUpsert` for an agent this table has never held. The `@1.3` stream
    // row cannot state the facet and there is no held row to carry one from, so
    // the facet is `null` - which per `tui-agent-records.ts` means "this host
    // cannot know", i.e. a reaped agent reads as ABSENT rather than as
    // asleep-and-resumable.
    table.applyDelta({
      kind: "tuiUpsert",
      epicId: EPIC_ID,
      record: tuiStreamRow({ tuiAgentId: "a1", revision: 5 }),
      // NOT STATED - a pre-`@1.4` frame, which is what makes this the racing
      // case. A `@1.4` frame states the facet and there is nothing to repair.
      sessionFacet: null,
    });

    // The answer that would have stated the facet, at the same revision.
    table.applyRecords(
      [tuiRow({ tuiAgentId: "a1", revision: 5, sessionState: "sleeping" })],
      issuedAtSeq,
    );

    // `TerminalAgentsSlice` now carries the facet, so the symptom itself is
    // assertable and not merely the causal step: the fence skipped the answer,
    // so the agent still reads `null` - "this host cannot know", i.e. ABSENT
    // rather than asleep-and-resumable.
    expect(table.snapshotIncompleteSeq()).toBe(1);
    expect(table.current().allIds).toContain("a1");
    expect(table.current().byId.a1.sessionState).toBeNull();

    // The repair the declined stamp buys, and the LIMIT on it.
    //
    // Re-serving the same revision does NOT land the facet:
    // `tuiAgentRowSupersedes` is `candidate.revision > held.revision` for two
    // local rows and this plane has no unknown-facet waiver - unlike the chat
    // twin, whose `chatRowSupersedesOnSnapshot` waives the test outright while
    // the held home is `null`, for this exact shape of race.
    table.applyRecords(
      [tuiRow({ tuiAgentId: "a1", revision: 5, sessionState: "sleeping" })],
      table.ingestSeq(),
    );
    expect(table.current().byId.a1.sessionState).toBeNull();

    // It lands once the row's revision actually moves, which is what any
    // subsequent write to the agent produces.
    table.applyRecords(
      [tuiRow({ tuiAgentId: "a1", revision: 6, sessionState: "sleeping" })],
      table.ingestSeq(),
    );
    expect(table.current().byId.a1.sessionState).toBe("sleeping");
  });
});

describe("an omitted row the fence held back counts too (I3)", () => {
  it("marks the apply incomplete when a racing delta's row is absent from the answer", () => {
    const table = freshChatTable();
    table.applyRecords([chatRow({ chatId: "c1", revision: 1 })], null);
    const issuedAtSeq = table.ingestSeq();

    // A chat created after the request left. The answer cannot carry it.
    table.applyDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: chatStreamRow({ chatId: "c2", revision: 9 }),
    });
    table.applyRecords([chatRow({ chatId: "c1", revision: 1 })], issuedAtSeq);

    // The row survives (rule 1's omission half) - and so the rows this client
    // holds are not the rows the answer described, which is the whole of what
    // the stamp would be claiming.
    expect(table.current().allIds).toContain("c2");
    expect(table.snapshotIncompleteSeq()).toBe(1);
  });
});

describe("only the FENCE marks an apply incomplete (I4)", () => {
  it("leaves the counter alone for a complete apply", () => {
    const table = freshChatTable();
    table.applyRecords([chatRow({ chatId: "c1", revision: 1 })], null);
    table.applyRecords([chatRow({ chatId: "c1", revision: 2 })], null);
    table.applyRecords([], null);
    expect(table.snapshotIncompleteSeq()).toBe(0);
  });

  it("leaves the counter alone for a row rule 2 rejected as stale", () => {
    const table = freshChatTable();
    table.applyRecords([chatRow({ chatId: "c1", revision: 5 })], null);

    // A staler copy, with a CURRENT fence - so the fence admits it and the
    // revision guard is what turns it away. The held row is already at least as
    // new as the answer's, so nothing is owed and no snapshot would fill a gap.
    table.applyRecords(
      [chatRow({ chatId: "c1", revision: 4, title: "Stale" })],
      table.ingestSeq(),
    );

    expect(table.current().byId.c1.title).toBe("A chat");
    expect(table.snapshotIncompleteSeq()).toBe(0);
  });

  it("leaves the counter alone for a row rule 3 retracted", () => {
    const table = freshChatTable();
    table.applyRecords([chatRow({ chatId: "c1", revision: 1 })], null);
    table.applyDelta({
      kind: "remove",
      epicId: EPIC_ID,
      chatId: "c1",
      reason: "deleted",
    });

    // An answer issued before the retraction, still carrying the row. Removal is
    // terminal and absorbing BY CONTRACT for the life of the session, so a
    // declined stamp here would put the session back on unconditional snapshots
    // forever rather than repairing anything.
    table.applyRecords([chatRow({ chatId: "c1", revision: 1 })], null);

    expect(table.current().allIds).not.toContain("c1");
    expect(table.snapshotIncompleteSeq()).toBe(0);
  });
});

describe("applyTouches does not promote a fence-skipped row's revision (F1a)", () => {
  it("lets a genuine snapshot at the patch's revision land the content", () => {
    const table = freshChatTable();
    // The home is STATED here, and that matters: with `docResident: null` the
    // chat plane's first waiver admits any answer and the revision guard never
    // decides, so this case would pass for the wrong reason. Both sides `false`
    // for the same reason - `true`/`true` is the doc-over-doc waiver.
    table.applyRecords(
      [
        chatRow({
          chatId: "c1",
          revision: 10,
          title: "Ten",
          docResident: false,
        }),
      ],
      null,
    );
    const issuedAtSeq = table.ingestSeq();

    // The fence-skip that splits content from revision: a delta advances the
    // held row to revision 11, and the answer already in flight - carrying 12 -
    // is skipped, so the content this table holds is revision 11's while the
    // host has moved past it.
    table.applyDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: chatStreamRow({ chatId: "c1", revision: 11, title: "Eleven" }),
    });
    table.applyRecords(
      [
        chatRow({
          chatId: "c1",
          revision: 12,
          title: "Twelve",
          docResident: false,
        }),
      ],
      issuedAtSeq,
    );
    expect(table.current().byId.c1.title).toBe("Eleven");

    // A quiet write - only `updatedAt` moved - reported as a recency patch at
    // the host's current revision. It lands: the recency really is newer.
    expect(
      table.applyTouches([
        { id: "c1", ownerUserId: OWNER_A, updatedAt: 999, revision: 13 },
      ]),
    ).not.toBeNull();
    expect(table.current().byId.c1.updatedAt).toBe(999);

    // THE CLAIM: the patch did not stamp `revision: 13` onto revision-11
    // content, so the genuine revision-13 row is still news and rule 2 admits
    // it. Stamping it would make `13 > 13` false - and that rejection outlives
    // every repair channel the design has, stamp resets included.
    table.applyRecords(
      [
        chatRow({
          chatId: "c1",
          revision: 13,
          title: "Thirteen",
          docResident: false,
        }),
      ],
      table.ingestSeq(),
    );
    expect(table.current().byId.c1.title).toBe("Thirteen");
  });

  it("still drops a replayed patch, and one a later snapshot has passed", () => {
    const table = freshChatTable();
    table.applyRecords(
      [chatRow({ chatId: "c1", revision: 5, updatedAt: 10 })],
      null,
    );

    const patch = {
      id: "c1",
      ownerUserId: OWNER_A,
      updatedAt: 50,
      revision: 6,
    };
    expect(table.applyTouches([patch])).not.toBeNull();
    // Redelivered verbatim: the patch revision is remembered beside the row, so
    // dropping it does not depend on the row having absorbed it.
    expect(table.applyTouches([patch])).toBeNull();
    expect(table.current().byId.c1.updatedAt).toBe(50);

    // A snapshot jumps the CONTENT past the patch. A patch from in between is
    // then stale in the only sense that matters - the row already carries newer
    // recency - so the gate reads the higher of the two books.
    table.applyRecords(
      [chatRow({ chatId: "c1", revision: 20, updatedAt: 200 })],
      table.ingestSeq(),
    );
    expect(
      table.applyTouches([
        { id: "c1", ownerUserId: OWNER_A, updatedAt: 60, revision: 15 },
      ]),
    ).toBeNull();
    expect(table.current().byId.c1.updatedAt).toBe(200);
  });
});
