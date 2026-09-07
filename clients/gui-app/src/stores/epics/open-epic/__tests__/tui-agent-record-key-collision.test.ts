import { describe, expect, it } from "vitest";
import type {
  TuiAgentRecordSummaryV11,
  TuiAgentRecordSummaryV12,
} from "@traycer/protocol/host/epic/tui-agent-records";
import { createTuiAgentRecordTable } from "../runtime/tui-agent-record-table";

const EPIC_ID = "epic-collision";
const SHARED_ID = "tui-shared";
const FIRST_OWNER = "user-first";
const SECOND_OWNER = "user-second";

/** Mirrors `tui-agent-records-merge.test.ts`'s `row()` fixture. */
function row(
  overrides: Partial<TuiAgentRecordSummaryV11>,
): Extract<TuiAgentRecordSummaryV12, { origin: "registry" | "doc" }> {
  const base: TuiAgentRecordSummaryV11 = {
    tuiAgentId: SHARED_ID,
    ownerUserId: FIRST_OWNER,
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

describe("terminal-agent rows are keyed by owner, not by id alone", () => {
  it("a signed-in account's own agent survives a retained stranger at a HIGHER revision", () => {
    // The viewer is mutable because the collision only exists ACROSS an account switch: within one
    // answer the host's ids really are unambiguous, which is why keying by id alone held for as long
    let viewer: string | null = FIRST_OWNER;
    const table = createTuiAgentRecordTable({
      getCurrentUserId: () => viewer,
      onBeforePublish: () => undefined,
    });

    // The first account's agent, well into its revision stream.
    table.applyRecords(
      [row({ ownerUserId: FIRST_OWNER, revision: 9, title: "First account" })],
      null,
    );
    expect(table.current().byId[SHARED_ID]?.title).toBe("First account");

    // The account switches. The first owner's row is retained - that is the
    // table's design, and what makes a switch back lossless.
    viewer = SECOND_OWNER;

    // The second account has an agent the host minted with the same id, early
    // in ITS OWN revision stream. Nothing relates the two numbers.
    table.applyRecords(
      [
        row({
          ownerUserId: SECOND_OWNER,
          revision: 2,
          title: "Second account",
        }),
      ],
      null,
    );

    // THE REDDENING ASSERTION.
    expect(table.current().allIds).toEqual([SHARED_ID]);
    // The title identifies WHICH row won, so this cannot pass on the retained
    // stranger merely still being present.
    expect(table.current().byId[SHARED_ID]?.title).toBe("Second account");
  });

  it("still rejects a genuinely stale row from the SAME owner", () => {
    // The control.
    let viewer: string | null = FIRST_OWNER;
    const table = createTuiAgentRecordTable({
      getCurrentUserId: () => viewer,
      onBeforePublish: () => undefined,
    });
    viewer = FIRST_OWNER;

    table.applyRecords(
      [row({ ownerUserId: FIRST_OWNER, revision: 9, title: "Current" })],
      null,
    );
    table.applyRecords(
      [row({ ownerUserId: FIRST_OWNER, revision: 2, title: "Stale" })],
      null,
    );

    expect(table.current().byId[SHARED_ID]?.title).toBe("Current");
  });

  it("removes both owners' rows for one bare id, which is all a tuiRemove carries", () => {
    // The other half of the keying change: rows are owner-scoped, removals are NOT, because a
    // `tuiRemove` frame carries `(epicId, tuiAgentId)` and no owner at all.
    let viewer: string | null = null;
    const table = createTuiAgentRecordTable({
      getCurrentUserId: () => viewer,
      onBeforePublish: () => undefined,
    });

    table.applyRecords(
      [
        row({ ownerUserId: FIRST_OWNER, revision: 9 }),
        row({ ownerUserId: SECOND_OWNER, revision: 2 }),
      ],
      null,
    );

    viewer = SECOND_OWNER;
    table.applyDelta({
      kind: "tuiRemove",
      epicId: EPIC_ID,
      tuiAgentId: SHARED_ID,
      reason: "deleted",
    });
    expect(table.current().allIds).toEqual([]);

    viewer = FIRST_OWNER;
    expect(
      table.republishForCurrentUser()?.tuiAgentRecords.allIds ?? [],
    ).toEqual([]);
  });
});
