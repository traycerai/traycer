import { describe, expect, it } from "vitest";
import {
  isArtifactFolderHref,
  resolveArtifactRelativeLinkPath,
} from "@/markdown/links/resolve-artifact-relative-link";

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

  it("decodes a URL-encoded '..' segment before walking it", () => {
    expect(
      resolveArtifactRelativeLinkPath(
        EPIC_ID,
        SELF_CHAIN,
        "%2E%2E/decision-log/index.md",
      ),
    ).toBe("epics/epic-1/artifacts/ticket-breakdown/decision-log/index.md");
  });

  it("decodes a URL-encoded space in a folder name", () => {
    expect(
      resolveArtifactRelativeLinkPath(EPIC_ID, SELF_CHAIN, "my%20folder"),
    ).toBe(
      "epics/epic-1/artifacts/ticket-breakdown/01-something/my folder/index.md",
    );
  });

  it("falls back to the raw string on a malformed percent-escape instead of throwing", () => {
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

describe("isArtifactFolderHref", () => {
  it("treats a bare extension-less name as folder-shaped", () => {
    expect(isArtifactFolderHref("01-sub-ticket")).toBe(true);
  });

  it("treats a trailing-separator href as folder-shaped", () => {
    expect(isArtifactFolderHref("./01-sub-ticket/")).toBe(true);
  });

  it("treats an explicit index.md href as folder-shaped", () => {
    expect(isArtifactFolderHref("./01-sub-ticket/index.md")).toBe(true);
  });

  it("treats bare '.' and '..' as folder-shaped", () => {
    expect(isArtifactFolderHref(".")).toBe(true);
    expect(isArtifactFolderHref("..")).toBe(true);
  });

  it("treats a relative href with a non-index.md file extension as NOT folder-shaped", () => {
    expect(isArtifactFolderHref("diagram.png")).toBe(false);
    expect(isArtifactFolderHref("../src/main.ts")).toBe(false);
  });

  it("treats a dotfile-style name (leading dot, no extension) as folder-shaped", () => {
    expect(isArtifactFolderHref(".gitignore")).toBe(true);
  });

  it("decodes before checking, so an encoded '..' is folder-shaped", () => {
    expect(isArtifactFolderHref("%2E%2E")).toBe(true);
  });

  it("returns false for an empty or blank href", () => {
    expect(isArtifactFolderHref("")).toBe(false);
    expect(isArtifactFolderHref("   ")).toBe(false);
  });
});
