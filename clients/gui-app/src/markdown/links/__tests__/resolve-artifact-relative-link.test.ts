import { describe, expect, it } from "vitest";
import { resolveArtifactRelativeLinkPath } from "@/markdown/links/resolve-artifact-relative-link";

const EPIC_ID = "epic-1";
const SELF_CHAIN = ["ticket-breakdown", "01-something"];

describe("resolveArtifactRelativeLinkPath", () => {
  it("resolves a bare index.md href to this artifact's own directory", () => {
    expect(
      resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, "index.md"),
    ).toBe("epics/epic-1/artifacts/ticket-breakdown/01-something/index.md");
  });

  it("resolves a bare sibling-shaped href (no trailing slash) as a folder", () => {
    expect(
      resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, "01-sub-ticket"),
    ).toBe(
      "epics/epic-1/artifacts/ticket-breakdown/01-something/01-sub-ticket/index.md",
    );
  });

  it("resolves a ./dir/ href (trailing slash) into a child folder", () => {
    expect(
      resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, "./01-sub-ticket/"),
    ).toBe(
      "epics/epic-1/artifacts/ticket-breakdown/01-something/01-sub-ticket/index.md",
    );
  });

  it("resolves an explicit ./dir/index.md href", () => {
    expect(
      resolveArtifactRelativeLinkPath(
        EPIC_ID,
        SELF_CHAIN,
        "./01-sub-ticket/index.md",
      ),
    ).toBe(
      "epics/epic-1/artifacts/ticket-breakdown/01-something/01-sub-ticket/index.md",
    );
  });

  it("resolves a ../sibling/index.md href against the parent folder", () => {
    expect(
      resolveArtifactRelativeLinkPath(
        EPIC_ID,
        SELF_CHAIN,
        "../decision-log/index.md",
      ),
    ).toBe("epics/epic-1/artifacts/ticket-breakdown/decision-log/index.md");
  });

  it("resolves multiple ../ segments walking up several levels", () => {
    expect(
      resolveArtifactRelativeLinkPath(
        EPIC_ID,
        ["a", "b", "c"],
        "../../../sibling-of-a/index.md",
      ),
    ).toBe("epics/epic-1/artifacts/sibling-of-a/index.md");
  });

  it("returns null when the href walks above the epic's artifacts root", () => {
    expect(
      resolveArtifactRelativeLinkPath(EPIC_ID, ["only-one"], "../../escaped"),
    ).toBeNull();
  });

  it("returns null (not a parent/artifacts-root fallback guess) when the author writes one '../' too many", () => {
    // Mirrors the corpus report's Gap 2: selfChain is 2 deep, so exactly 2
    // '../' reach the artifacts root - a 3rd walks the resolver off the top
    // of selfChain. There is deliberately no fallback base to retry against;
    // a wrong guess would silently open a DIFFERENT real artifact rather
    // than surfacing the authoring mistake.
    expect(
      resolveArtifactRelativeLinkPath(
        EPIC_ID,
        ["remote-host-support", "implementation-fixes-plan"],
        "../../../debates/remote-host-fixset-soundness/final-synthesis/index.md",
      ),
    ).toBeNull();
  });

  it("returns null for an empty href", () => {
    expect(resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, "")).toBeNull();
    expect(
      resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, "   "),
    ).toBeNull();
  });

  it("keeps an edge space that came out of a decoded %20 in a folder name", () => {
    // `classifyHref` trims the raw href and decodes it, so a space still sitting
    // at the edge here was authored as `%20` - part of the name, not padding.
    expect(resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, " draft")).toBe(
      "epics/epic-1/artifacts/ticket-breakdown/01-something/ draft/index.md",
    );
  });

  it("resolves a bare '.' to this artifact's own directory, like bare index.md", () => {
    expect(resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, ".")).toBe(
      "epics/epic-1/artifacts/ticket-breakdown/01-something/index.md",
    );
  });

  it("treats backslash separators the same as forward slashes", () => {
    expect(
      resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, "..\\decision-log"),
    ).toBe("epics/epic-1/artifacts/ticket-breakdown/decision-log/index.md");
  });

  // `classifyHref` owns the single decode on the way here, so a percent escape
  // that survives it is a LITERAL part of the folder name and must stay one.
  // Decoding again would both miss the real folder and let an authored
  // `%252E%252E` become a `..` that walks out of the linked folder.
  it("keeps a literal percent escape in a folder name as authored", () => {
    expect(
      resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, "my%20folder"),
    ).toBe(
      "epics/epic-1/artifacts/ticket-breakdown/01-something/my%20folder/index.md",
    );
  });

  it("does not resurrect a '..' traversal from an encoded segment", () => {
    expect(
      resolveArtifactRelativeLinkPath(
        EPIC_ID,
        SELF_CHAIN,
        "%2E%2E/decision-log/index.md",
      ),
    ).toBe(
      "epics/epic-1/artifacts/ticket-breakdown/01-something/%2E%2E/decision-log/index.md",
    );
  });

  it("passes a malformed percent-escape through unchanged instead of throwing", () => {
    expect(() =>
      resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, "bad%escape"),
    ).not.toThrow();
    expect(
      resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, "bad%escape"),
    ).toBe(
      "epics/epic-1/artifacts/ticket-breakdown/01-something/bad%escape/index.md",
    );
  });
});
