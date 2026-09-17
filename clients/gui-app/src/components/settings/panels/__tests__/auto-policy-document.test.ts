import { describe, expect, it } from "vitest";
import { autoPolicyChangedSinceLoad } from "@/components/settings/panels/auto-policy-document";

describe("autoPolicyChangedSinceLoad", () => {
  it("timestamp -> null: stays false - `currentUpdatedAt: null` means 'cannot tell', not 'unset', and warning there would train the user to dismiss the warning that matters", () => {
    expect(autoPolicyChangedSinceLoad("A", null)).toBe(false);
  });

  it("null -> timestamp: true - the editor opened on no policy and another device has since CREATED one, so saving now would destroy a record this window never saw", () => {
    expect(autoPolicyChangedSinceLoad(null, "B")).toBe(true);
  });

  it("null -> null: false - nothing appeared", () => {
    expect(autoPolicyChangedSinceLoad(null, null)).toBe(false);
  });

  it("timestamp -> different timestamp: true - the ordinary stale-edit case", () => {
    expect(autoPolicyChangedSinceLoad("A", "B")).toBe(true);
  });

  it("timestamp -> same timestamp: false - nothing moved under the editor", () => {
    expect(autoPolicyChangedSinceLoad("A", "A")).toBe(false);
  });
});
