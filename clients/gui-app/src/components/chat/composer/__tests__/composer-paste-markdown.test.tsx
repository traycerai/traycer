import { describe, expect, it } from "vitest";

import { sanitizeMarkdownHtml } from "@/lib/composer/markdown-paste";

describe("composer markdown paste sanitizer", () => {
  it("demotes h1-h6 headings to <strong> wrapped paragraphs", () => {
    const body = sanitizeMarkdownHtml("<h1>Hello</h1><h3>Sub</h3><p>tail</p>");
    expect(body).not.toBeNull();
    if (body === null) return;
    expect(body.querySelectorAll("h1, h2, h3, h4, h5, h6").length).toBe(0);
    const strongs = body.querySelectorAll("strong");
    expect(strongs.length).toBe(2);
    expect(strongs[0].textContent).toBe("Hello");
    expect(strongs[1].textContent).toBe("Sub");
    expect(body.textContent).toContain("tail");
  });

  it("unwraps blockquote elements", () => {
    const body = sanitizeMarkdownHtml(
      "<blockquote><p>quoted</p></blockquote><p>plain</p>",
    );
    expect(body).not.toBeNull();
    if (body === null) return;
    expect(body.querySelectorAll("blockquote").length).toBe(0);
    expect(body.textContent).toContain("quoted");
    expect(body.textContent).toContain("plain");
  });

  it("preserves bullet list and code block structures", () => {
    const body = sanitizeMarkdownHtml(
      "<ul><li>a</li><li>b</li></ul><pre><code>foo()</code></pre>",
    );
    expect(body).not.toBeNull();
    if (body === null) return;
    expect(body.querySelectorAll("ul > li").length).toBe(2);
    expect(body.querySelector("pre code")?.textContent).toBe("foo()");
  });

  it("preserves inline marks", () => {
    const body = sanitizeMarkdownHtml(
      "<p><strong>bold</strong> <em>italic</em> <code>inline</code></p>",
    );
    expect(body).not.toBeNull();
    if (body === null) return;
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(body.querySelector("em")?.textContent).toBe("italic");
    expect(body.querySelector("code")?.textContent).toBe("inline");
  });
});
