import { describe, it, expect } from "vitest";
import { prQueryKeys } from "@/lib/query-keys/pr-query-keys";

const BASE = {
  hostId: "host-1",
  epicId: "epic-1",
  linkGroupKey: "/Users/dev/worktrees/widgets",
  owner: "acme",
  repo: "widgets",
  baseRefName: "main",
  headRefName: "feature/x",
  headRefOid: "a".repeat(40),
  ignoreWhitespace: false,
};

describe("prQueryKeys.localDiff", () => {
  it("separates two epics that share the same PR identity on one host", () => {
    // `pr.getLocalDiff` is authorized against `epicId` and only honours a
    // worktree binding belonging to that epic, so the SAME PR under a
    // different epic can legitimately answer `unavailable`. If the key
    // omitted `epicId` the two would share one cache slot and one epic's
    // answer would be served for the other.
    const first = prQueryKeys.localDiff(BASE);
    const second = prQueryKeys.localDiff({ ...BASE, epicId: "epic-2" });

    expect(first).not.toEqual(second);
    expect(first).toContain("epic-1");
    expect(second).toContain("epic-2");
  });

  it("is stable for identical arguments", () => {
    expect(prQueryKeys.localDiff(BASE)).toEqual(prQueryKeys.localDiff(BASE));
  });

  it("still separates the inputs that already varied the answer", () => {
    const first = prQueryKeys.localDiff(BASE);
    for (const patch of [
      { linkGroupKey: "/Users/dev/other" },
      { headRefOid: "b".repeat(40) },
      { ignoreWhitespace: true },
      { baseRefName: "release" },
    ]) {
      expect(prQueryKeys.localDiff({ ...BASE, ...patch })).not.toEqual(first);
    }
  });
});
