import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  buildSandboxIndex,
  escapeInlineScript,
} from "../../../../vite/sandbox-assets";

// The sandbox document must fetch nothing. WebKit does not let `*` admit iOS's
// `capacitor:` scheme from an opaque sandboxed frame, so any file the document
// referenced on its own origin would be blocked there, the loader would never
// signal ready, and every page would time out.
describe("the built sandbox document", () => {
  it("references no other file", async () => {
    const html = await buildSandboxIndex();
    const doc = new DOMParser().parseFromString(html, "text/html");

    expect(doc.querySelectorAll("[src], [href], link, base")).toHaveLength(0);
    expect(html).not.toMatch(/\bsrc\s*=|\bhref\s*=|@import|import\s*\(/i);
    // The one CSS `url(` (not the JS `new URL(`) is the Figtree face, and its
    // value is a `data:` URL.
    const urls = html.match(/(?<!new )url\([^)]*\)/gi) ?? [];
    expect(urls).toEqual(['url("${FIGTREE_FONT_URL}")']);
    expect(html).toMatch(/const FIGTREE_FONT_URL = "data:font\/woff2;base64,/);
  });

  it("holds the whole loader as its one inline script", async () => {
    const doc = new DOMParser().parseFromString(
      await buildSandboxIndex(),
      "text/html",
    );

    expect(doc.scripts).toHaveLength(1);
    const code = doc.scripts[0].text.trim();
    expect(code).toContain("ui/notifications/sandbox-proxy-ready");
    // Ends where the loader ends: nothing in it closed the element early.
    expect(code.endsWith("runLoader();")).toBe(true);
  });
});

describe("escapeInlineScript", () => {
  it("hides `</script` and `<!--` without changing what a string holds", () => {
    const source = "a</SCRIPT>b<!--c</script";
    const escaped = escapeInlineScript(JSON.stringify(source));

    expect(escaped).not.toMatch(/<\/script|<!--/i);
    expect(runInNewContext(escaped)).toBe(source);
  });
});
