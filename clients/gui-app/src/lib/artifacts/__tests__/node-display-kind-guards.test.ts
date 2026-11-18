/**
 * The one boundary every Markdown-only surface defers to: the comments
 * sidebar/rail, bulk export, the create menus, the image-attach picker and
 * the chat card all gate on `isMarkdownArtifactKind`/`isEpicArtifactKind`
 * rather than re-deriving which kinds have a Markdown body. Pinning the
 * boundary here once is preferred over re-asserting the same conditional at
 * every call site.
 */
import { describe, expect, it } from "vitest";
import {
  isEpicArtifactKind,
  isMarkdownArtifactKind,
} from "@/lib/artifacts/node-display";

describe("isMarkdownArtifactKind", () => {
  it.each(["spec", "ticket", "story", "review"] as const)(
    "is true for %s",
    (kind) => {
      expect(isMarkdownArtifactKind(kind)).toBe(true);
    },
  );

  it.each(["html", "canvas", "file"] as const)(
    "is false for the object kind %s",
    (kind) => {
      expect(isMarkdownArtifactKind(kind)).toBe(false);
    },
  );

  it.each(["chat", "terminal-agent", "", "bogus"])(
    "is false for a non-artifact or unknown value %s",
    (value) => {
      expect(isMarkdownArtifactKind(value)).toBe(false);
    },
  );

  it("is false for null and undefined", () => {
    expect(isMarkdownArtifactKind(null)).toBe(false);
    expect(isMarkdownArtifactKind(undefined)).toBe(false);
  });
});

describe("isEpicArtifactKind", () => {
  it.each([
    "spec",
    "ticket",
    "story",
    "review",
    "html",
    "canvas",
    "file",
  ] as const)("is true for %s", (kind) => {
    expect(isEpicArtifactKind(kind)).toBe(true);
  });

  it.each(["chat", "terminal-agent", "", "bogus"])(
    "is false for a non-artifact or unknown value %s",
    (value) => {
      expect(isEpicArtifactKind(value)).toBe(false);
    },
  );

  it("is false for null and undefined", () => {
    expect(isEpicArtifactKind(null)).toBe(false);
    expect(isEpicArtifactKind(undefined)).toBe(false);
  });
});
