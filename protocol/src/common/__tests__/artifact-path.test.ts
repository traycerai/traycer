import { describe, expect, it } from "vitest";

import {
  artifactLayoutFromChain,
  deriveArtifactPathLayoutRootAgnostic,
  EPIC_ARTIFACT_COMMENTS_DIRNAME,
  EPIC_ARTIFACT_IMAGES_DIRNAME,
} from "../artifact-path";

/**
 * The single home for the `epics/<epicId>/artifacts/<chain>/index.md`
 * root-agnostic scanner (TKT-03). Previously copy-pasted in the host (the
 * external Traycer Host) and the gui-app's `artifact-link-path.ts`; both
 * now consume this, so resolution semantics MUST stay identical across the host
 * RPC resolver and the client pre-check.
 */

const EPIC = "epic-abc";

describe("deriveArtifactPathLayoutRootAgnostic - pinned epicId (host RPC)", () => {
  it("derives a top-level artifact regardless of leading root", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/home/tgill/.traycer/epics/${EPIC}/artifacts/my-spec/index.md`,
        EPIC,
      ),
    ).toEqual({ epicId: EPIC, folderName: "my-spec", parentSegments: [] });
  });

  it("derives a nested chain into folderName + parentSegments", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/any/prefix/epics/${EPIC}/artifacts/a/b/c/index.md`,
        EPIC,
      ),
    ).toEqual({ epicId: EPIC, folderName: "c", parentSegments: ["a", "b"] });
  });

  it("keys on the folder segment, not a human slug - a renamed slug with a stable id folder still resolves to that id", () => {
    // Artifact folders on disk are named by the STABLE id; renaming the
    // displayed slug never touches the folder, so the scanner returns the
    // stable id verbatim as the folderName.
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/x/epics/${EPIC}/artifacts/art_01HSTABLEID/index.md`,
        EPIC,
      ),
    ).toEqual({
      epicId: EPIC,
      folderName: "art_01HSTABLEID",
      parentSegments: [],
    });
  });

  it("splits Windows separators so a Windows path resolves on POSIX", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `C:\\Users\\them\\.traycer\\epics\\${EPIC}\\artifacts\\my-spec\\index.md`,
        EPIC,
      ),
    ).toEqual({ epicId: EPIC, folderName: "my-spec", parentSegments: [] });
  });

  it("returns null for a non-index.md basename", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/x/epics/${EPIC}/artifacts/my-spec/notes.md`,
        EPIC,
      ),
    ).toBeNull();
  });

  it("returns null when the artifacts marker is absent", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/x/epics/${EPIC}/my-spec/index.md`,
        EPIC,
      ),
    ).toBeNull();
  });

  it("returns null when no artifact folder follows artifacts/", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/x/epics/${EPIC}/artifacts/index.md`,
        EPIC,
      ),
    ).toBeNull();
  });

  it("does not match a different epic id when pinned", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/x/epics/other-epic/artifacts/my-spec/index.md`,
        EPIC,
      ),
    ).toBeNull();
  });
});

describe("deriveArtifactPathLayoutRootAgnostic - unpinned (client pre-check)", () => {
  it("lifts the epicId from a foreign-root path the local host never wrote (C1)", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/Users/them/.traycer/epics/${EPIC}/artifacts/spec/index.md`,
        null,
      ),
    ).toEqual({ epicId: EPIC, folderName: "spec", parentSegments: [] });
  });

  it("matches the first epics/<id>/artifacts marker regardless of which epic", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/data/epics/any-epic-123/artifacts/a/b/index.md`,
        null,
      ),
    ).toEqual({
      epicId: "any-epic-123",
      folderName: "b",
      parentSegments: ["a"],
    });
  });

  it("returns null when there is no artifacts marker at all", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/data/epics/any-epic/notes/index.md`,
        null,
      ),
    ).toBeNull();
  });
});

describe("deriveArtifactPathLayoutRootAgnostic - dot-segment normalization (CL-15)", () => {
  it("resolves a `.` segment sitting between epicId and artifacts", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/x/epics/${EPIC}/./artifacts/my-spec/index.md`,
        EPIC,
      ),
    ).toEqual({ epicId: EPIC, folderName: "my-spec", parentSegments: [] });
  });

  it("drops `.` segments inside the chain instead of leaking them into the layout", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/x/epics/${EPIC}/artifacts/a/./b/index.md`,
        EPIC,
      ),
    ).toEqual({ epicId: EPIC, folderName: "b", parentSegments: ["a"] });
  });

  it("collapses a `..` segment by popping the preceding folder", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/x/epics/${EPIC}/artifacts/a/b/../c/index.md`,
        EPIC,
      ),
    ).toEqual({ epicId: EPIC, folderName: "c", parentSegments: ["a"] });
  });
});

describe("artifactLayoutFromChain", () => {
  it("maps a chain into folderName + parentSegments", () => {
    expect(artifactLayoutFromChain(["a", "b", "c"])).toEqual({
      folderName: "c",
      parentSegments: ["a", "b"],
    });
  });

  it("returns null for an empty chain", () => {
    expect(artifactLayoutFromChain([])).toBeNull();
  });

  it("returns null for a dot-prefixed segment in the last position", () => {
    expect(artifactLayoutFromChain(["auth", ".comments"])).toBeNull();
  });

  it("returns null for a dot-prefixed segment in a middle/parent position", () => {
    expect(artifactLayoutFromChain([".comments", "auth"])).toBeNull();
  });

  it("returns null for a plain dotfile-ish single-segment chain", () => {
    expect(artifactLayoutFromChain([".hidden"])).toBeNull();
  });

  it("still resolves a normal chain with no dot-prefixed segment", () => {
    expect(artifactLayoutFromChain(["auth", "sub-spec"])).toEqual({
      folderName: "sub-spec",
      parentSegments: ["auth"],
    });
  });
});

describe("deriveArtifactPathLayoutRootAgnostic - dot-prefixed chain segments rejected", () => {
  it("returns null for a `.comments/index.md` nested under a real artifact folder, with a pinned expectedEpicId", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/x/epics/${EPIC}/artifacts/auth/.comments/index.md`,
        EPIC,
      ),
    ).toBeNull();
  });

  it("returns null for a `.comments/index.md` nested under a real artifact folder, with expectedEpicId null", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/x/epics/${EPIC}/artifacts/auth/.comments/index.md`,
        null,
      ),
    ).toBeNull();
  });

  it("still resolves the sibling index.md for the real artifact folder itself", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/x/epics/${EPIC}/artifacts/auth/index.md`,
        EPIC,
      ),
    ).toEqual({ epicId: EPIC, folderName: "auth", parentSegments: [] });
  });
});

describe("projection dirname constants - cross-repo contract (host + gui-app also depend on these literals)", () => {
  it("EPIC_ARTIFACT_IMAGES_DIRNAME is 'images'", () => {
    expect(EPIC_ARTIFACT_IMAGES_DIRNAME).toBe("images");
  });

  it("EPIC_ARTIFACT_COMMENTS_DIRNAME is '.comments'", () => {
    expect(EPIC_ARTIFACT_COMMENTS_DIRNAME).toBe(".comments");
  });
});
