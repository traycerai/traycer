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

function destination(path: string, search: string, hash: string) {
  return { path, search, hash };
}

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
      expect(resolveCanvasBoardLink(from, href, BOARDS)).toEqual(
        destination(expected, "", ""),
      );
    });
  });

  describe("preserves the query and the fragment on the resolved board", () => {
    it.each([
      ["about.html?tab=2", "?tab=2", ""],
      ["about.html#team", "", "#team"],
      ["about.html?tab=2#team", "?tab=2", "#team"],
    ])("%s", (href, search, hash) => {
      expect(resolveCanvasBoardLink("index.html", href, BOARDS)).toEqual(
        destination("about.html", search, hash),
      );
    });

    it("keeps a fragment that itself looks like a query untouched", () => {
      // The fragment is everything from the first `#` on; a `?` inside it is
      // not a second query string.
      expect(
        resolveCanvasBoardLink("index.html", "about.html#team?tab=2", BOARDS),
      ).toEqual(destination("about.html", "", "#team?tab=2"));
    });
  });

  describe("a suffix with no path navigates the linking board itself", () => {
    it.each([
      ["#team", "", "#team"],
      ["?tab=2", "?tab=2", ""],
      ["?tab=2#team", "?tab=2", "#team"],
    ])("%s on a board in the canvas", (href, search, hash) => {
      expect(resolveCanvasBoardLink("index.html", href, BOARDS)).toEqual(
        destination("index.html", search, hash),
      );
    });

    it("needs the linking board itself to be one of the given boards", () => {
      expect(
        resolveCanvasBoardLink("missing.html", "#team", BOARDS),
      ).toBeNull();
      expect(resolveCanvasBoardLink("index.html", "#team", [])).toBeNull();
    });

    it.each(["", "#"])("has no board to go to for %j alone", (href) => {
      // "#" alone resolves to the linking board (an empty fragment); "" is
      // not a link at all.
      if (href === "")
        expect(resolveCanvasBoardLink("index.html", href, BOARDS)).toBeNull();
      else
        expect(resolveCanvasBoardLink("index.html", href, BOARDS)).toEqual(
          destination("index.html", "", "#"),
        );
    });
  });

  it("decodes percent-escapes in a path segment", () => {
    expect(
      resolveCanvasBoardLink("docs/intro.html", "my%20page.html", BOARDS),
    ).toEqual(destination("docs/my page.html", "", ""));
    expect(
      resolveCanvasBoardLink("docs/intro.html", "50%25.html", BOARDS),
    ).toEqual(destination("docs/50%.html", "", ""));
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

    it("refuses a bare control character in the href", () => {
      expect(
        resolveCanvasBoardLink("index.html", "about.html\t", BOARDS),
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
