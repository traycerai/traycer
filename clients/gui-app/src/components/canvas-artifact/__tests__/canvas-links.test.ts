import { describe, expect, it } from "vitest";
import { resolveCanvasBoardLink } from "../canvas-links";

const BOARDS = [
  "index.html",
  "about.html",
  "docs/intro.html",
  "docs/guide/setup.html",
  "docs/my page.html",
  "docs/50%.html",
];

describe("resolveCanvasBoardLink", () => {
  describe("resolves relative to the linking board", () => {
    it.each([
      ["docs/intro.html", "guide/setup.html", "docs/guide/setup.html"],
      ["docs/intro.html", "./guide/setup.html", "docs/guide/setup.html"],
      ["docs/intro.html", "../about.html", "about.html"],
      ["docs/guide/setup.html", "../../index.html", "index.html"],
      ["docs/guide/setup.html", "../intro.html", "docs/intro.html"],
      ["index.html", "docs/intro.html", "docs/intro.html"],
      ["index.html", "about.html", "about.html"],
      ["docs/intro.html", "intro.html", "docs/intro.html"],
      ["docs/intro.html", "guide//setup.html", "docs/guide/setup.html"],
    ])("from %s, %s goes to %s", (from, href, expected) => {
      expect(resolveCanvasBoardLink(from, href, BOARDS)).toBe(expected);
    });
  });

  describe("drops the query and the fragment", () => {
    it.each([
      "about.html?tab=2",
      "about.html#team",
      "about.html?tab=2#team",
      "about.html#team?tab=2",
    ])("%s", (href) => {
      expect(resolveCanvasBoardLink("index.html", href, BOARDS)).toBe(
        "about.html",
      );
    });

    it.each(["#team", "?tab=2", "", "#"])(
      "has no board to go to for %j alone",
      (href) => {
        expect(resolveCanvasBoardLink("index.html", href, BOARDS)).toBeNull();
      },
    );
  });

  it("decodes percent-escapes in a path segment", () => {
    expect(
      resolveCanvasBoardLink("docs/intro.html", "my%20page.html", BOARDS),
    ).toBe("docs/my page.html");
    expect(
      resolveCanvasBoardLink("docs/intro.html", "50%25.html", BOARDS),
    ).toBe("docs/50%.html");
  });

  describe("never leaves the canvas's own root", () => {
    it.each([
      ["index.html", "../about.html"],
      ["docs/intro.html", "../../about.html"],
      ["docs/intro.html", "../../../etc/passwd"],
      ["index.html", ".."],
      ["docs/intro.html", "guide/../../../about.html"],
    ])("from %s, %s", (from, href) => {
      expect(resolveCanvasBoardLink(from, href, BOARDS)).toBeNull();
    });

    it("refuses an escaped separator smuggled into a segment", () => {
      expect(
        resolveCanvasBoardLink("docs/intro.html", "..%2Fabout.html", BOARDS),
      ).toBeNull();
      expect(
        resolveCanvasBoardLink("docs/intro.html", "guide%2Fsetup.html", BOARDS),
      ).toBeNull();
      expect(
        resolveCanvasBoardLink("docs/intro.html", "guide%5Csetup.html", BOARDS),
      ).toBeNull();
    });

    it("refuses a null byte", () => {
      expect(
        resolveCanvasBoardLink("index.html", "about.html%00", BOARDS),
      ).toBeNull();
    });

    it("refuses a malformed escape", () => {
      expect(
        resolveCanvasBoardLink("index.html", "%E0%A4%A.html", BOARDS),
      ).toBeNull();
    });
  });

  describe("ignores links that are not to a board of this canvas", () => {
    it.each([
      "https://example.com/about.html",
      "http://example.com/about.html",
      "HTTPS://example.com/about.html",
      "mailto:someone@example.com",
      "javascript:alert(1)",
      "data:text/html,<p>hi</p>",
      "traycer-artifact:about.html",
      "//example.com/about.html",
      "/about.html",
      "docs\\intro.html",
      "..\\about.html",
    ])("%s", (href) => {
      expect(resolveCanvasBoardLink("index.html", href, BOARDS)).toBeNull();
    });

    it("needs the target to be one of the given board paths", () => {
      expect(
        resolveCanvasBoardLink("index.html", "missing.html", BOARDS),
      ).toBeNull();
      expect(resolveCanvasBoardLink("index.html", "about.html", [])).toBeNull();
    });

    it("compares paths exactly", () => {
      expect(
        resolveCanvasBoardLink("index.html", "About.html", BOARDS),
      ).toBeNull();
      expect(resolveCanvasBoardLink("index.html", "docs", BOARDS)).toBeNull();
      expect(resolveCanvasBoardLink("index.html", "docs/", BOARDS)).toBeNull();
    });
  });
});
