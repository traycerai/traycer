import { describe, expect, it } from "vitest";
import { resolveArtifactPlaceholderText } from "../build-artifact-extensions";

const TITLE = "Untitled";
const BODY = "Describe what you want to build…";

function resolve(params: {
  nodeTypeName: string;
  headingLevel: number | null;
  pos: number;
}): string {
  return resolveArtifactPlaceholderText({
    ...params,
    titlePlaceholderText: TITLE,
    placeholderText: BODY,
  });
}

describe("resolveArtifactPlaceholderText", () => {
  it("returns the title hint for an empty leading level-1 heading", () => {
    expect(resolve({ nodeTypeName: "heading", headingLevel: 1, pos: 0 })).toBe(
      TITLE,
    );
  });

  it("returns the body hint for a leading paragraph (whole-empty doc)", () => {
    expect(
      resolve({ nodeTypeName: "paragraph", headingLevel: null, pos: 0 }),
    ).toBe(BODY);
  });

  it("returns the body hint for a level-1 heading that is not the first node", () => {
    expect(resolve({ nodeTypeName: "heading", headingLevel: 1, pos: 12 })).toBe(
      BODY,
    );
  });

  it("returns the body hint for a leading heading deeper than level 1", () => {
    expect(resolve({ nodeTypeName: "heading", headingLevel: 2, pos: 0 })).toBe(
      BODY,
    );
  });
});
