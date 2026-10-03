import { beforeAll, describe, expect, it } from "vitest";
import { renderMermaidSvg } from "../mermaid-service";

/**
 * Real Mermaid, no module mock - deliberately separate from
 * `mermaid-service.test.ts`, which mocks the `mermaid` package entirely and
 * so cannot reproduce a shape only the real renderer emits (a strict-label id
 * that also happens to be a valid three-hex-digit CSS color).
 *
 * jsdom has no layout engine: Mermaid's flowchart/dagre pass calls
 * `SVGGraphicsElement.getBBox()`, which jsdom does not implement. This stub is
 * test-fixture only, matching how the review's own probe ran real Mermaid
 * inside jsdom.
 */
beforeAll(() => {
  SVGGraphicsElement.prototype.getBBox = (): DOMRect => ({
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    top: 0,
    left: 0,
    right: 10,
    bottom: 10,
    toJSON: () => ({}),
  });
});

describe("mermaid-service (real Mermaid, no module mock)", () => {
  it("keeps a strict-label id and its own hex-string CSS color distinct after id rewriting", async () => {
    const code =
      '%%{init: {"themeVariables":{"mainBkg":"#fff"}}}%%\n' +
      "flowchart TD\n" +
      "A[\"<span id='fff'>Hello</span>\"] --> B";

    const { svg } = await renderMermaidSvg(code, new AbortController().signal);

    const wrapper = document.createElement("div");
    wrapper.innerHTML = svg;
    const labelSpan = wrapper.querySelector("span[id]");
    expect(labelSpan).not.toBeNull();
    // The strict-sanitized label id survived and was rewritten to a NEW,
    // unique id - it must not still read "fff" (the collision-prone source id).
    expect(labelSpan?.id).not.toBe("fff");

    // The CSS color that happens to share the literal text "fff" must survive
    // as a real color - treating it as an id reference would silently repaint
    // node fills with a broken value instead. CSSOM canonicalizes `#fff` to
    // `rgb(255, 255, 255)` on serialization, so assert on the CSS meaning
    // (still white), not the original hex spelling.
    expect(svg).toMatch(/fill:\s*(#fff\b|rgb\(\s*255,\s*255,\s*255\s*\))/i);
    expect(svg).not.toMatch(/fill:\s*#?tc-mermaid/i);
  });

  it("keeps quoted attribute-selector fragment predicates (href and id) matching their rewritten targets, while an unrelated quoted attribute value stays untouched", async () => {
    const code = [
      "---",
      "config:",
      "  themeCSS: |",
      '    a[href="#fff"] { color: red; }',
      '    [id="fff"] { color: green; }',
      '    [data-label="#fff"] { color: blue; }',
      "---",
      "flowchart TD",
      "A[\"<span id='fff'>Target</span><a href='#fff'>Jump</a>\"] --> B",
    ].join("\n");

    const { svg } = await renderMermaidSvg(code, new AbortController().signal);

    const wrapper = document.createElement("div");
    wrapper.innerHTML = svg;
    const anchor = wrapper.querySelector("a");
    const span = wrapper.querySelector("span[id]");
    expect(anchor).not.toBeNull();
    expect(span).not.toBeNull();
    if (anchor === null || span === null) return;
    // The href/id attributes themselves are correctly rewritten already.
    expect(anchor.getAttribute("href")).not.toBe("#fff");
    expect(span.id).not.toBe("fff");

    const styleEl = wrapper.querySelector("style");
    expect(styleEl).not.toBeNull();
    if (styleEl === null) return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(styleEl.textContent);
    // Only plain style rules carry `selectorText` - skip @keyframes/@media/etc.
    const rules = Array.from(sheet.cssRules).filter(
      (rule): rule is CSSStyleRule =>
        typeof (rule as CSSStyleRule).selectorText === "string",
    );

    const hrefRule = rules.find((rule) => rule.selectorText.includes("a[href"));
    const idAttrRule = rules.find(
      (rule) =>
        rule.selectorText.includes("[id") &&
        !rule.selectorText.includes("a[href"),
    );
    const dataLabelRule = rules.find((rule) =>
      rule.selectorText.includes("data-label"),
    );
    expect(hrefRule).toBeDefined();
    expect(idAttrRule).toBeDefined();
    expect(dataLabelRule).toBeDefined();
    if (
      hrefRule === undefined ||
      idAttrRule === undefined ||
      dataLabelRule === undefined
    ) {
      return;
    }

    // The rewritten selectors must still functionally select the rewritten
    // targets - a selector that still names the OLD fragment silently stops
    // matching once the real attribute has moved to a new id. `.soft` so all
    // three independent checks are reported in one run.
    expect.soft(wrapper.querySelector(hrefRule.selectorText)).toBe(anchor);
    expect.soft(wrapper.querySelector(idAttrRule.selectorText)).toBe(span);

    // An unrelated quoted attribute value must survive untouched - the fix
    // must not indiscriminately rewrite every quoted "#fff"-shaped string.
    expect.soft(dataLabelRule.selectorText).toContain("#fff");
  });
});
