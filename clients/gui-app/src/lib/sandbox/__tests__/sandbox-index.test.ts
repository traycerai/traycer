// @vitest-environment node
//
// esbuild's own build() call does an `instanceof Uint8Array` check that
// fails under jsdom's realm (jsdom's Uint8Array is not the same constructor
// as Node's), so this suite - which drives a real esbuild build through
// buildSandboxIndex() - runs in the node environment and parses the built
// HTML with jsdom directly instead of the globally-provided DOMParser.
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
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
    const doc = new JSDOM(html).window.document;

    expect(doc.querySelectorAll("[src], [href], link, base")).toHaveLength(0);
    expect(html).not.toMatch(/\bsrc\s*=|\bhref\s*=|@import|import\s*\(/i);
    // The one CSS `url(` (not the JS `new URL(`) is the Figtree face, and its
    // value is a `data:` URL referenced through whatever name esbuild gave
    // the bundled font constant - the bundler is free to rename it, so the
    // check follows the reference rather than assuming "FIGTREE_FONT_URL".
    const urls = html.match(/(?<!new )url\([^)]*\)/gi) ?? [];
    expect(urls).toHaveLength(1);
    const reference = /^url\("\$\{([A-Za-z_$][\w$]*)\}"\)$/.exec(urls[0]);
    if (reference === null) {
      throw new Error("expected a url(\"${...}\") reference in the built loader");
    }
    const fontVariable = reference[1].replace(/\$/g, "\\$");
    // esbuild's bundled output may declare the constant with const, let or var.
    expect(html).toMatch(
      new RegExp(`(?:const|let|var) ${fontVariable} = "data:font/woff2;base64,`),
    );
  });

  it("holds the whole loader as its one inline script", async () => {
    const doc = new JSDOM(await buildSandboxIndex()).window.document;

    expect(doc.scripts).toHaveLength(1);
    const code = doc.scripts[0].text.trim();
    expect(code).toContain("ui/notifications/sandbox-proxy-ready");
    // esbuild bundles the entry as an IIFE; nothing in it closed the
    // element early.
    expect(code.endsWith("})();")).toBe(true);
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
