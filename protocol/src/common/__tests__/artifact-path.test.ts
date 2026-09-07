import { describe, expect, it } from "vitest";

import {
  artifactLayoutFromChain,
  deriveArtifactPathLayoutRootAgnostic,
  EPIC_ARTIFACT_COMMENTS_DIRNAME,
  EPIC_ARTIFACT_IMAGES_DIRNAME,
  isEpicArtifactCommentsDirName,
} from "../artifact-path";

/**
 * The single home for the `epics/<epicId>/artifacts/<chain>/index.md` root-agnostic scanner (TKT-03).
 * Previously copy-pasted in the host (the external Traycer Host) and the gui-app's `artifact-link-path.ts`; both now consume this, so resolution semantics MUST stay identical across the host RPC resolver and the client.
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
    // Artifact folders on disk are named by the STABLE id; renaming the displayed slug never touches the folder, so the scanner returns the stable id verbatim as the folderName.
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

  it("returns null for `.comments` in the last position", () => {
    expect(artifactLayoutFromChain(["auth", ".comments"])).toBeNull();
  });

  it("returns null for `.comments` in a middle/parent position", () => {
    expect(artifactLayoutFromChain([".comments", "auth"])).toBeNull();
  });

  /**
   * The reservation has to hold on the FILESYSTEM, not in the string.
   * Widening to case variants strands nothing, because `slugify` cannot mint a leading dot in any casing.
   */
  it.each([".COMMENTS", ".Comments", ".cOmMeNtS"])(
    "returns null for the case variant %s, which names the same directory on a case-insensitive volume",
    (variant) => {
      expect(artifactLayoutFromChain(["auth", variant])).toBeNull();
      expect(artifactLayoutFromChain([variant, "auth"])).toBeNull();
    },
  );

  /** The widening is case ONLY. */
  it.each([".comments-old", ".comments2", "comments", ".comment"])(
    "still resolves the near-miss %s, which is a distinct directory everywhere",
    (name) => {
      expect(artifactLayoutFromChain(["auth", name])).toEqual({
        folderName: name,
        parentSegments: ["auth"],
      });
    },
  );

  /**
   * The reservation is exactly one name wide, and these two cases are why.
   * `images` is the mirror image: a name the gate must NOT take, because `slugify("Images")` mints it, so reserving it would break a legitimately named artifact.
   */
  it("still resolves an unrelated dot-prefixed folder (a pre-existing `.draft` artifact keeps working)", () => {
    expect(artifactLayoutFromChain([".draft"])).toEqual({
      folderName: ".draft",
      parentSegments: [],
    });
    expect(artifactLayoutFromChain(["auth", ".hidden"])).toEqual({
      folderName: ".hidden",
      parentSegments: ["auth"],
    });
  });

  it("still resolves `images`, which is a mintable slug and so must not be reserved", () => {
    expect(artifactLayoutFromChain(["auth", "images"])).toEqual({
      folderName: "images",
      parentSegments: ["auth"],
    });
  });

  it("still resolves a normal chain", () => {
    expect(artifactLayoutFromChain(["auth", "sub-spec"])).toEqual({
      folderName: "sub-spec",
      parentSegments: ["auth"],
    });
  });
});

describe("deriveArtifactPathLayoutRootAgnostic - the reserved `.comments` segment is rejected", () => {
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

  it("still resolves a pre-existing dot-prefixed artifact through the GUI link pre-check path", () => {
    expect(
      deriveArtifactPathLayoutRootAgnostic(
        `/x/epics/${EPIC}/artifacts/.draft/index.md`,
        null,
      ),
    ).toEqual({ epicId: EPIC, folderName: ".draft", parentSegments: [] });
  });
});

/**
 * The predicate is exported so the host's file-sync answers "is this our projection directory?" with the very same code that refuses it as an artifact chain.
 */
describe("isEpicArtifactCommentsDirName - shared with the host's sweep exemption", () => {
  it.each([".comments", ".COMMENTS", ".Comments", ".cOmMeNtS"])(
    "matches %s, every casing a case-insensitive volume collapses",
    (name) => {
      expect(isEpicArtifactCommentsDirName(name)).toBe(true);
    },
  );

  /**
   * Win32 drops trailing dots and spaces from a path component, so `CreateFile(".comments.")` opens `.comments`.
   */
  it.each([
    ".comments.",
    ".comments ",
    ".comments...",
    ".COMMENTS. .",
    ".comments  ",
  ])(
    "matches %s, which Win32 canonicalizes onto the projection directory",
    (name) => {
      expect(isEpicArtifactCommentsDirName(name)).toBe(true);
    },
  );

  /** Unicode case FOLDING, which is not lowercasing. */
  it.each([".commentſ", ".COMMENTſ", ".ComMentſ.", ".commentſ "])(
    "matches %s, which Unicode case folding collapses onto the reserved name",
    (name) => {
      expect(isEpicArtifactCommentsDirName(name)).toBe(true);
    },
  );

  it.each([
    "comments",
    ".comment",
    ".comments2",
    ".comments-old",
    "",
    "images",
    ".comment.s",
    " .comments",
    ".commentß",
  ])(
    "does not match the near-miss %s, a distinct directory on every platform",
    (name) => {
      expect(isEpicArtifactCommentsDirName(name)).toBe(false);
    },
  );

  it("agrees with the chain reservation, which is the point of sharing it", () => {
    for (const name of [".comments", ".COMMENTS", ".Comments"]) {
      expect(isEpicArtifactCommentsDirName(name)).toBe(true);
      expect(artifactLayoutFromChain(["auth", name])).toBeNull();
    }
    for (const name of [".draft", "images", ".comment"]) {
      expect(isEpicArtifactCommentsDirName(name)).toBe(false);
      expect(artifactLayoutFromChain(["auth", name])).not.toBeNull();
    }
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
