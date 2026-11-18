import { describe, expect, it } from "vitest";
import { getSvgIntrinsicSize } from "@/editor-core/nodes/mermaid/mermaid-service";

describe("getSvgIntrinsicSize", () => {
  it("reads dimensions from viewBox", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"></svg>';
    expect(getSvgIntrinsicSize(svg)).toEqual({ width: 640, height: 480 });
  });

  it("lets explicit width/height override viewBox", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="800" height="600"></svg>';
    expect(getSvgIntrinsicSize(svg)).toEqual({ width: 800, height: 600 });
  });

  it("parses px-suffixed width/height attributes", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="320px" height="240px"></svg>';
    expect(getSvgIntrinsicSize(svg)).toEqual({ width: 320, height: 240 });
  });

  it("falls back to 1024x768 when neither viewBox nor width/height are present", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    expect(getSvgIntrinsicSize(svg)).toEqual({ width: 1024, height: 768 });
  });

  it("ignores non-finite width/height values", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" width="invalid" height="NaN"></svg>';
    expect(getSvgIntrinsicSize(svg)).toEqual({ width: 500, height: 500 });
  });

  it('ignores percentage width/height (mermaid emits width="100%")', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 276 398" width="100%" style="max-width: 276px"></svg>';
    expect(getSvgIntrinsicSize(svg)).toEqual({ width: 276, height: 398 });
  });
});
