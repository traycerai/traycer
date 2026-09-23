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

  it("places an input's caption and a textarea's placeholder at their position in document order", () => {
    const html = [
      "<h2>Sign in</h2>",
      '<input placeholder="Email">',
      "<button>Go</button>",
      '<textarea placeholder="Notes"></textarea>',
      '<input type="submit" value="Save">',
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("Sign in Email Go Notes Save");
  });

  it("prefers a non-blank value over the placeholder, and falls back to the placeholder when the value is blank", () => {
    const html = [
      '<input value="Ada" placeholder="Name">',
      '<input value="   " placeholder="Notes">',
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("Ada Notes");
  });

  it("counts a submit, button or reset input's value as its caption", () => {
    const html = [
      '<input type="submit" value="Save">',
      '<input type="button" value="Cancel">',
      '<input type="reset" value="Clear">',
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("Save Cancel Clear");
  });

  it("ignores a checkbox or radio input's value", () => {
    const html = [
      '<input type="checkbox" value="yes">',
      '<input type="radio" value="on">',
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("");
  });

  it("excludes hidden and password input values", () => {
    const html = [
      '<input type="hidden" value="token123">',
      '<input type="password" value="secret">',
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("");
  });

  it("contributes nothing for an input with neither a placeholder nor a value", () => {
    expect(wireframeVisibleText("<input>")).toBe("");
  });

  it("ignores a textarea's placeholder once it has content", () => {
    const html = '<textarea placeholder="Notes">Existing text</textarea>';

    expect(wireframeVisibleText(html)).toBe("Existing text");
  });

  it("removes elements hidden by an inline display:none or visibility:hidden style, leaving visible siblings", () => {
    const html = [
      "<p>Before</p>",
      '<p style="display:none">Secret</p>',
      '<span style="visibility:hidden">Ghost</span>',
      "<p>After</p>",
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("Before After");
  });
});
