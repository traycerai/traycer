import { describe, it, expect } from "vitest";
import { prQueryKeys } from "@/lib/query-keys/pr-query-keys";

const BASE = {
  hostId: "host-1",
  epicId: "epic-1",
  linkGroupKey: "/Users/dev/worktrees/widgets",
  owner: "acme",
  repo: "widgets",
  repoRole: "superproject",
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
      // `repoRole` selects WHICH checkout under the link group answers -
      // superproject root vs an owned submodule - so the two roles are two
      // different answers, never one shared slot.
      { repoRole: "submodule" },
    ]) {
      expect(prQueryKeys.localDiff({ ...BASE, ...patch })).not.toEqual(first);
    }
  });
});

const FILE_BASE = {
  hostId: BASE.hostId,
  epicId: BASE.epicId,
  linkGroupKey: BASE.linkGroupKey,
  owner: BASE.owner,
  repo: BASE.repo,
  repoRole: BASE.repoRole,
  mergeBaseOid: "c".repeat(40),
  headOid: "a".repeat(40),
  path: "src/a.ts",
  previousPath: null as string | null,
  ignoreWhitespace: false,
  byteBudget: 262144 as number | null,
};

describe("prQueryKeys.localDiffSummary", () => {
  it("is stable for identical arguments", () => {
    expect(prQueryKeys.localDiffSummary(BASE)).toEqual(
      prQueryKeys.localDiffSummary(BASE),
    );
  });

  it("varies the key when any identity or range argument changes", () => {
    const first = prQueryKeys.localDiffSummary(BASE);
    for (const patch of [
      { hostId: "host-2" },
      { epicId: "epic-2" },
      { linkGroupKey: "/Users/dev/other" },
      { owner: "other" },
      { repo: "other-repo" },
      { repoRole: "submodule" },
      { baseRefName: "release" },
      { headRefName: "feature/y" },
      { headRefOid: "b".repeat(40) },
      { ignoreWhitespace: true },
    ]) {
      expect(prQueryKeys.localDiffSummary({ ...BASE, ...patch })).not.toEqual(
        first,
      );
    }
  });

  it("never shares a slot with the monolith key for the same arguments", () => {
    // The summary and monolith responses have different shapes; a copy-pasted
    // key segment would serve one to consumers of the other from the cache.
    expect(prQueryKeys.localDiffSummary(BASE)).not.toEqual(
      prQueryKeys.localDiff(BASE),
    );
  });
});

describe("prQueryKeys.localFileDiff", () => {
  it("is stable for identical arguments", () => {
    expect(prQueryKeys.localFileDiff(FILE_BASE)).toEqual(
      prQueryKeys.localFileDiff(FILE_BASE),
    );
  });

  it("varies the key when any identity, range, path, or budget argument changes", () => {
    const first = prQueryKeys.localFileDiff(FILE_BASE);
    for (const patch of [
      { hostId: "host-2" },
      { epicId: "epic-2" },
      { linkGroupKey: "/Users/dev/other" },
      { owner: "other" },
      { repo: "other-repo" },
      { repoRole: "submodule" },
      { mergeBaseOid: "d".repeat(40) },
      { headOid: "e".repeat(40) },
      { path: "src/b.ts" },
      { previousPath: "src/old.ts" },
      { ignoreWhitespace: true },
      { byteBudget: null },
    ]) {
      expect(prQueryKeys.localFileDiff({ ...FILE_BASE, ...patch })).not.toEqual(
        first,
      );
    }
  });

  it("composes on localFileDiffScope so the prefix relation is structural", () => {
    const scope = prQueryKeys.localFileDiffScope(FILE_BASE);
    const full = prQueryKeys.localFileDiff(FILE_BASE);
    expect(full.slice(0, scope.length)).toEqual([...scope]);
  });
});
