import { describe, expect, it } from "vitest";
import {
  movesSummary,
  type MoveRow,
  type MovesSectionRow,
} from "@/components/settings/move-sheet-model";

function moving(kind: string, key: string): MovesSectionRow {
  const row: MoveRow = { kind, key, os: null, label: key, detail: null };
  return { row, choiceKey: JSON.stringify([kind, key]) };
}

describe("movesSummary", () => {
  it("counts rows by kind and names a one-of-a-kind row by its page", () => {
    expect(
      movesSummary([
        moving("variable", "A"),
        moving("secret", "OPENAI_API_KEY"),
        moving("secret", "ANTHROPIC_API_KEY"),
        moving("fallback_policy", "x"),
      ]),
    ).toBe("1 variable · 2 API keys · Model routing");
  });

  it.each(["something_new", "constructor"])(
    "counts rows of kind %s as items",
    (kind) => {
      expect(movesSummary([moving(kind, "a"), moving(kind, "b")])).toBe(
        "2 items",
      );
    },
  );
});
