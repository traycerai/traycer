import { describe, it, expect } from "vitest";
import type {
  CommitAheadFile,
  SubmoduleChangeset,
  SubmoduleRelation,
} from "@traycer/protocol/host";
import { resolveAheadDiffGate } from "../submodule-ahead-diff-gate";

const REPO_ROOT = "/repo/traycer";
const PIN = "1111111111";
const HEAD = "2222222222";

function aheadFile(path: string): CommitAheadFile {
  return {
    path,
    previousPath: null,
    status: "modified",
    isBinary: false,
    insertions: 3,
    deletions: 1,
  };
}

function changeset(
  relation: SubmoduleRelation,
  repoRoot: string,
): SubmoduleChangeset {
  return {
    repoRoot,
    parentPath: "traycer",
    branch: "main",
    repoState: { kind: "clean" },
    relation,
    files: [],
  };
}

const aheadRelation: SubmoduleRelation = {
  state: "ahead",
  recordedPinSha: PIN,
  submoduleHeadSha: HEAD,
  commitsAhead: { count: 1, files: [aheadFile("committed.ts")] },
};

describe("resolveAheadDiffGate", () => {
  it("is pending until fresh metadata lands (issues nothing yet)", () => {
    expect(resolveAheadDiffGate(null, REPO_ROOT, "committed.ts")).toEqual({
      status: "pending",
    });
  });

  it("derives compareFromSha from the fresh ahead relation, not persisted state", () => {
    const gate = resolveAheadDiffGate(
      { submodules: [changeset(aheadRelation, REPO_ROOT)] },
      REPO_ROOT,
      "committed.ts",
    );
    expect(gate.status).toBe("ready");
    if (gate.status !== "ready") throw new Error("expected ready");
    // The pin used for the diff comes straight from *current* metadata.
    expect(gate.compareFromSha).toBe(PIN);
    expect(gate.submoduleHeadSha).toBe(HEAD);
    expect(gate.file.path).toBe("committed.ts");
  });

  // --- The stale-UI diff-gating tests: an ahead-of-pin diff must be
  // unreachable once fresh metadata no longer shows the submodule as `ahead`. ---

  it("closes the gate after an old-host degrade drops submodules[]", () => {
    // A v1.0 host upgrades to `submodules: []`; a persisted ahead tile must NOT
    // fall through to a stripped, wrong stage-based diff.
    expect(
      resolveAheadDiffGate({ submodules: [] }, REPO_ROOT, "committed.ts"),
    ).toEqual({ status: "unavailable" });
  });

  it("closes the gate when the submodule is no longer ahead (pin moved / caught up)", () => {
    const equalRelation: SubmoduleRelation = {
      state: "equal",
      recordedPinSha: HEAD,
      submoduleHeadSha: HEAD,
    };
    expect(
      resolveAheadDiffGate(
        { submodules: [changeset(equalRelation, REPO_ROOT)] },
        REPO_ROOT,
        "committed.ts",
      ),
    ).toEqual({ status: "unavailable" });
  });

  it("closes the gate when the file is no longer among the commits ahead", () => {
    expect(
      resolveAheadDiffGate(
        { submodules: [changeset(aheadRelation, REPO_ROOT)] },
        REPO_ROOT,
        "gone.ts",
      ),
    ).toEqual({ status: "unavailable" });
  });

  it("closes the gate when no submodule matches the tile's repoRoot", () => {
    expect(
      resolveAheadDiffGate(
        { submodules: [changeset(aheadRelation, "/repo/other")] },
        REPO_ROOT,
        "committed.ts",
      ),
    ).toEqual({ status: "unavailable" });
  });
});
