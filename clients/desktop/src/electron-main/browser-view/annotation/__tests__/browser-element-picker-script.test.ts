import { describe, expect, it } from "vitest";
import {
  ELEMENT_PICKER_LIMITS,
  sanitizeElementCapture,
} from "../browser-element-picker-script";

describe("sanitizeElementCapture", () => {
  it("bounds untrusted picked element data", () => {
    const hugeHtml = "<div>".repeat(4000);
    const attributes = Array.from({ length: 100 }, (_unused, index) => ({
      name: `data-${index}`,
      value: "v".repeat(1000),
    }));
    const styles = Array.from({ length: 200 }, () => ({
      property: "display",
      value: "z".repeat(1000),
    }));
    const element = sanitizeElementCapture({
      selector: "s".repeat(5000),
      tagName: "BUTTON",
      elementId: "submit",
      classNames: [1, "keep", null, "keep2"],
      attributes,
      outerHtml: hugeHtml,
      outerHtmlTruncated: true,
      textPreview: "hello",
      ariaRole: "button",
      accessibleName: "Submit",
      boundingBox: {
        x: 1.2,
        y: 2,
        width: 3,
        height: 4,
        top: 2,
        right: 4,
        bottom: 6,
        left: 1.2,
        extra: "ignored",
      },
      computedStyles: styles,
      extraField: "dropped",
    });
    if (element === null) throw new Error("expected capture");
    expect(element.selector.length).toBe(ELEMENT_PICKER_LIMITS.selector);
    expect(element.tagName).toBe("button");
    expect(element.outerHtml.length).toBe(ELEMENT_PICKER_LIMITS.outerHtml);
    expect(element.attributes.length).toBe(
      ELEMENT_PICKER_LIMITS.attributeCount,
    );
    expect(element.attributes[0].value.length).toBe(
      ELEMENT_PICKER_LIMITS.attributeValue,
    );
    expect(element.classNames).toEqual(["keep", "keep2"]);
    expect(element.computedStyles.length).toBe(
      ELEMENT_PICKER_LIMITS.styleCount,
    );
    expect(element.computedStyles[0].value.length).toBe(
      ELEMENT_PICKER_LIMITS.styleValue,
    );
    expect(element.boundingBox.x).toBe(1.2);
    expect(Object.keys(element.boundingBox)).not.toContain("extra");
    expect(Object.keys(element)).not.toContain("extraField");
  });

  it("drops computed styles outside the curated whitelist", () => {
    const element = sanitizeElementCapture({
      selector: "div",
      tagName: "div",
      outerHtml: "<div></div>",
      boundingBox: {},
      attributes: [],
      classNames: [],
      computedStyles: [
        { property: "display", value: "grid" },
        { property: "content", value: "url(https://evil.example)" },
        { property: "--injected", value: "1" },
        { property: "color", value: "red" },
      ],
    });
    if (element === null) throw new Error("expected capture");
    expect(element.computedStyles).toEqual([
      { property: "display", value: "grid" },
      { property: "color", value: "red" },
    ]);
  });

  it("clamps oversized bounding box magnitudes", () => {
    const element = sanitizeElementCapture({
      selector: "div",
      tagName: "div",
      outerHtml: "<div></div>",
      boundingBox: {
        x: 1e308,
        y: -1e308,
        width: -50,
        height: 5e12,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      },
      attributes: [],
      classNames: [],
      computedStyles: [],
    });
    if (element === null) throw new Error("expected capture");
    const box = element.boundingBox;
    expect(box.x).toBe(1_000_000);
    expect(box.y).toBe(-1_000_000);
    expect(box.width).toBe(0);
    expect(box.height).toBe(1_000_000);
  });

  it("coerces non-finite bounding box numbers to zero", () => {
    const element = sanitizeElementCapture({
      selector: "button",
      tagName: "button",
      outerHtml: "<button></button>",
      boundingBox: { x: Number.NaN, width: "10", height: 5 },
      computedStyles: [],
      attributes: [],
      classNames: [],
    });
    if (element === null) throw new Error("expected capture");
    expect(element.boundingBox.x).toBe(0);
    expect(element.boundingBox.width).toBe(0);
    expect(element.boundingBox.height).toBe(5);
  });

  it("rejects non-objects", () => {
    expect(sanitizeElementCapture(null)).toBeNull();
  });
});
