import { describe, expect, it } from "vitest";
import { workingEpicIdsKey } from "@/stores/use-working-epic-ids";

describe("workingEpicIdsKey", () => {
  it("is equal only when id-set membership is equal", () => {
    expect(workingEpicIdsKey(new Set(["b", "a"]))).toBe(
      workingEpicIdsKey(new Set(["a", "b"])),
    );
    expect(workingEpicIdsKey(new Set(["a"]))).not.toBe(
      workingEpicIdsKey(new Set(["a", "b"])),
    );
  });
});
