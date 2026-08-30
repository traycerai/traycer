import { describe, expect, it } from "vitest";
import {
  distinctExternalEpicIds,
  finalSweepButtonLabel,
  isBulkScopeRow,
  mergeSessionOutcomes,
  reconcileSessionOutcomes,
  selectAllCountCopy,
  selectionIsSafeOnly,
} from "@/lib/epics/sweep-consequences";
import type { EpicSweepWorktreeRow } from "@/hooks/epic/use-epic-sweep-worktree-candidates-query";

function row(
  over: Partial<EpicSweepWorktreeRow> & Pick<EpicSweepWorktreeRow, "note">,
): EpicSweepWorktreeRow {
  return {
    entry: {
      worktreePath: "/wt/a",
      branch: "feat",
      repoLabel: "acme/app",
      repoIdentifier: null,
      inUse: over.note === "in-use",
      uncommittedCount: 0,
      gitRemovable: true,
      scripts: null,
      owners: [],
      lastActivityAt: null,
      branchStatus: null,
      createdAt: null,
      prState: "merged",
      prNumber: null,
      prUrl: null,
      mergedHeadShaMatches: true,
      submodules: [],
      atBaseCommit: false,
      resolvedAt: 1,
    },
    tier: over.note === "in-use" ? "in-use" : "merged",
    defaultChecked: over.note === null,
    disabled: false,
    holders: [],
    holdersStatus: "none",
    holdersRevision: undefined,
    ...over,
  };
}

describe("sweep consequence copy", () => {
  it("treats only proven exclusive idle rows as the one-click path", () => {
    expect(selectionIsSafeOnly([row({ note: null })])).toBe(true);
    expect(selectionIsSafeOnly([row({ note: "in-use" })])).toBe(false);
    expect(selectionIsSafeOnly([row({ note: "not-landed" })])).toBe(false);
    expect(selectionIsSafeOnly([row({ note: "shared" })])).toBe(false);
  });

  it("names the dominant extra consequence on the final button", () => {
    expect(finalSweepButtonLabel([row({ note: "in-use" })])).toBe(
      "Stop work & sweep",
    );
    expect(finalSweepButtonLabel([row({ note: "not-landed" })])).toBe(
      "Sweep anyway",
    );
    expect(finalSweepButtonLabel([row({ note: "shared" })])).toBe(
      "Break bindings & sweep",
    );
    expect(
      finalSweepButtonLabel([
        row({ note: "in-use" }),
        row({ note: "not-landed" }),
      ]),
    ).toBe("Confirm sweep");
  });

  it("renders the select-all count without an in-use qualifier", () => {
    expect(selectAllCountCopy({ selected: 5, total: 7 })).toBe(
      "5 of 7 selected",
    );
    expect(isBulkScopeRow(row({ note: "in-use" }))).toBe(true);
    expect(isBulkScopeRow(row({ note: "in-use", disabled: true }))).toBe(false);
    expect(isBulkScopeRow(row({ note: "not-landed" }))).toBe(true);
    expect(isBulkScopeRow(row({ note: null }))).toBe(true);
  });

  it("counts distinct external Tasks, not bindings", () => {
    const sharedA = row({
      note: "shared",
      entry: {
        ...row({ note: "shared" }).entry,
        worktreePath: "/wt/a",
        owners: [
          {
            epicId: "epic-1",
            ownerKind: "chat",
            ownerId: "c1",
            updatedAt: 1,
          },
          {
            epicId: "epic-ext",
            ownerKind: "chat",
            ownerId: "c2",
            updatedAt: 1,
          },
        ],
      },
    });
    const sharedB = row({
      note: "shared",
      entry: {
        ...row({ note: "shared" }).entry,
        worktreePath: "/wt/b",
        owners: [
          {
            epicId: "epic-1",
            ownerKind: "chat",
            ownerId: "c1",
            updatedAt: 1,
          },
          {
            epicId: "epic-ext",
            ownerKind: "chat",
            ownerId: "c3",
            updatedAt: 1,
          },
        ],
      },
    });
    expect(
      distinctExternalEpicIds([sharedA, sharedB], new Set(["epic-1"])),
    ).toEqual(["epic-ext"]);
  });

  it("merges new uncertain/failed outcomes without dropping prior deferred paths", () => {
    const current = new Map([
      ["/wt/maybe", { kind: "uncertain" as const, identity: "feat-maybe" }],
    ]);
    const merged = mergeSessionOutcomes(
      current,
      {
        removed: [],
        uncertain: [],
        failed: ["/wt/fail"],
      },
      new Map([["/wt/fail", "feat-fail"]]),
    );
    expect(merged.get("/wt/maybe")?.kind).toBe("uncertain");
    expect(merged.get("/wt/fail")).toEqual({
      kind: "failed",
      identity: "feat-fail",
    });
  });

  it("re-enables still-listed uncertain paths after a proof refresh", () => {
    const current = new Map([
      ["/wt/maybe", { kind: "uncertain" as const, identity: "feat-maybe" }],
      ["/wt/fail", { kind: "failed" as const, identity: "feat-fail" }],
    ]);
    const reconciled = reconcileSessionOutcomes(current, [
      row({
        note: "in-use",
        entry: { ...row({ note: "in-use" }).entry, worktreePath: "/wt/maybe" },
      }),
      row({
        note: "in-use",
        entry: { ...row({ note: "in-use" }).entry, worktreePath: "/wt/fail" },
      }),
    ]);
    expect(reconciled.has("/wt/maybe")).toBe(false);
    expect(reconciled.get("/wt/fail")?.kind).toBe("failed");
  });
});
