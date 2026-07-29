import { describe, expect, it } from "vitest";
import { missingEpicIds } from "@/lib/epics/epic-tab-existence";

describe("missingEpicIds", () => {
  it("reports only the open ids the host did not confirm", () => {
    expect(
      missingEpicIds(
        ["epic-a", "epic-b", "epic-deleted"],
        new Set(["epic-a", "epic-b"]),
      ),
    ).toEqual(["epic-deleted"]);
  });

  it("reports every open id when nothing was confirmed", () => {
    // The reconciler must never reach this with an unresolved lookup - an
    // empty confirmed set means every tab is stale. `EpicTabExistenceProbe`
    // passes `null` (conclude nothing) instead; see
    // epic-tab-existence-reconciler.test.tsx.
    expect(missingEpicIds(["epic-a", "epic-b"], new Set())).toEqual([
      "epic-a",
      "epic-b",
    ]);
  });

  it("preserves open-tab order and ignores confirmed ids with no open tab", () => {
    expect(
      missingEpicIds(
        ["epic-c", "epic-a", "epic-b"],
        new Set(["epic-a", "epic-unopened"]),
      ),
    ).toEqual(["epic-c", "epic-b"]);
  });
});
