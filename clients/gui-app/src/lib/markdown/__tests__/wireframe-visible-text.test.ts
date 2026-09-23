import { describe, expect, it } from "vitest";
import { wireframeVisibleText } from "../wireframe-visible-text";

describe("wireframeVisibleText", () => {
  it("joins visible words from nested elements with single spaces and collapses whitespace", () => {
    const html = [
      "<div>",
      '  <header class="card">',
      "    <h1>  Sign   in  </h1>",
      "  </header>",
      "  <p>Welcome\nback,\tfriend</p>",
      "</div>",
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("Sign in Welcome back, friend");
  });

  it("drops content of script, style, noscript, template, title and [hidden]", () => {
    const html = [
      "<html>",
      "<head><title>Page title</title></head>",
      "<body>",
      '  <button class="primary">Save</button>',
      '  <script>track("Save")</script>',
      "  <style>.primary { color: red; }</style>",
      "  <noscript>Enable JavaScript</noscript>",
      "  <template><span>Template content</span></template>",
      "  <div hidden>Hidden content</div>",
      "</body>",
      "</html>",
    ].join("\n");

    const text = wireframeVisibleText(html);

    expect(text).toBe("Save");
    expect(text).not.toContain("Page title");
    expect(text).not.toContain("track");
    expect(text).not.toContain("Enable JavaScript");
    expect(text).not.toContain("Template content");
    expect(text).not.toContain("Hidden content");
  });

  it("never surfaces a tag name or an attribute value", () => {
    const html = '<div class="card" data-testid="root"><span>Save</span></div>';

    const text = wireframeVisibleText(html);

    expect(text).toBe("Save");
    expect(text).not.toContain("card");
    expect(text).not.toContain("div");
    expect(text).not.toContain("span");
    expect(text).not.toContain("root");
  });

  it("returns an empty string for empty input", () => {
    expect(wireframeVisibleText("")).toBe("");
  });
});
