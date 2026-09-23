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

  it("prefers a value over the placeholder, and falls back to the placeholder only when the value is exactly empty", () => {
    const html = [
      '<input value="Ada" placeholder="Name">',
      '<input value="" placeholder="Notes">',
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("Ada Notes");
  });

  it("hides the placeholder behind a whitespace-only value, as the browser does", () => {
    const html = [
      '<input value="   " placeholder="Notes">',
      '<textarea placeholder="Comments">   </textarea>',
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("");
  });

  it("counts a submit, button or reset input's value as its caption", () => {
    const html = [
      '<input type="submit" value="Save">',
      '<input type="button" value="Cancel">',
      '<input type="reset" value="Clear">',
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("Save Cancel Clear");
  });

  it("uses the browser's default caption for a submit or reset input without a value, and nothing for an empty one", () => {
    const html = [
      '<input type="submit">',
      '<input type="reset">',
      '<input type="button">',
      '<input type="submit" value="">',
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("Submit Reset");
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

  it("draws a password field's placeholder while it is empty, and nothing once it has a value", () => {
    const emptyHtml = '<input type="password" placeholder="Password">';
    const filledHtml =
      '<input type="password" value="hunter2" placeholder="Password">';

    expect(wireframeVisibleText(emptyHtml)).toBe("Password");
    expect(wireframeVisibleText(filledHtml)).toBe("");
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

  it("contributes only a closed dropdown's chosen option, at its place in the document", () => {
    const html = [
      "<label>Plan</label>",
      "<select>",
      "  <option>Free</option>",
      "  <option selected>Team</option>",
      "  <option>Enterprise</option>",
      "</select>",
      "<button>Save</button>",
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("Plan Team Save");
  });

  it("draws an option's label attribute over its text, in a dropdown and a list box alike", () => {
    const html = [
      '<select><option label="Team" selected>team-plan</option></select>',
      '<select multiple><option label="Red">red-500</option></select>',
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("Team Red");
  });

  it("contributes a closed dropdown's first option when none is selected", () => {
    const html = [
      "<select>",
      "  <option>Monthly</option>",
      "  <option>Yearly</option>",
      "</select>",
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("Monthly");
  });

  it("draws a hidden selected option as the closed dropdown's caption", () => {
    const html = [
      "<select>",
      "  <option hidden disabled selected>Choose a plan</option>",
      "  <option>Free</option>",
      "</select>",
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("Choose a plan");
  });

  it("falls back to the first option that is not disabled when nothing is selected", () => {
    const html = [
      "<select>",
      "  <option disabled>Pick one</option>",
      "  <option>Free</option>",
      "</select>",
    ].join("\n");

    expect(wireframeVisibleText(html)).toBe("Free");
  });

  it("leaves a list box alone, counting every option's text instead of only one", () => {
    const multipleHtml = [
      "<select multiple>",
      "  <option>Red</option>",
      "  <option>Blue</option>",
      "</select>",
    ].join("\n");
    const sizedHtml = [
      '<select size="3">',
      "  <option>One</option>",
      "  <option>Two</option>",
      "</select>",
    ].join("\n");

    expect(wireframeVisibleText(multipleHtml)).toBe("Red Blue");
    expect(wireframeVisibleText(sizedHtml)).toBe("One Two");
  });

  it("draws only the summary of a closed details element, and everything of an open one", () => {
    const closedHtml =
      "<details><summary>Advanced</summary><p>Retry count</p></details>";
    const openHtml =
      "<details open><summary>Advanced</summary><p>Retry count</p></details>";
    const noSummaryHtml = "<details><p>Retry count</p></details>";

    expect(wireframeVisibleText(closedHtml)).toBe("Advanced");
    expect(wireframeVisibleText(openHtml)).toBe("Advanced Retry count");
    expect(wireframeVisibleText(noSummaryHtml)).toBe("Details");
  });
});
