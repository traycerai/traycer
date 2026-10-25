import { describe, expect, it } from "vitest";
import { withIndefiniteArticle } from "../indefinite-article";

describe("withIndefiniteArticle", () => {
  it.each([
    ["editor", "an editor"],
    ["admin", "an admin"],
    ["Acme sandbox", "an Acme sandbox"],
    ["viewer", "a viewer"],
    ["Beta sandbox", "a Beta sandbox"],
  ])(
    "writes %s as %s, whatever the case of its first letter",
    (noun, phrase) => {
      expect(withIndefiniteArticle(noun)).toBe(phrase);
    },
  );
});
