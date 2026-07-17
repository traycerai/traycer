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

  it("returns null for an empty href", () => {
    expect(resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, "")).toBeNull();
    expect(
      resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, "   "),
    ).toBeNull();
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
});
