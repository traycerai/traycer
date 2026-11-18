import { describe, expect, it } from "vitest";
import { artifactDiffRenderable } from "@/lib/chat/artifact-diff-renderable";

describe("artifactDiffRenderable", () => {
  it("renders a create / update with an after-hash", () => {
    expect(
      artifactDiffRenderable({
        operation: "create",
        beforeHash: null,
        afterHash: "h1",
      }),
    ).toBe(true);
    expect(
      artifactDiffRenderable({
        operation: "update",
        beforeHash: "h0",
        afterHash: "h1",
      }),
    ).toBe(true);
  });

  it("renders a delete from its before-hash (after-hash null is the deletion)", () => {
    expect(
      artifactDiffRenderable({
        operation: "delete",
        beforeHash: "h0",
        afterHash: null,
      }),
    ).toBe(true);
  });

  it("does NOT render a non-delete with a null after-hash (binary / failed / aborted)", () => {
    // An update whose after-capture produced no snapshot must not fall through
    // to an all-deletions diff for a file that still exists.
    expect(
      artifactDiffRenderable({
        operation: "update",
        beforeHash: "h0",
        afterHash: null,
      }),
    ).toBe(false);
    // A create that never captured an after-state has nothing to show.
    expect(
      artifactDiffRenderable({
        operation: "create",
        beforeHash: null,
        afterHash: null,
      }),
    ).toBe(false);
    // A delete with no before-hash (nothing captured) has nothing to show.
    expect(
      artifactDiffRenderable({
        operation: "delete",
        beforeHash: null,
        afterHash: null,
      }),
    ).toBe(false);
  });
});
