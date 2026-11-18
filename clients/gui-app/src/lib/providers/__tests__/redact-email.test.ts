import { describe, expect, it } from "vitest";
import { redactEmail } from "../redact-email";

describe("redactEmail", () => {
  it("keeps the first local-part char and the domain's first char", () => {
    expect(redactEmail("alice@domain.com")).toBe("a•••@d…");
  });

  it("falls back to a fixed mask for a string with no @", () => {
    expect(redactEmail("not-an-email")).toBe("•••");
  });

  it("falls back to a fixed mask when @ is the first character", () => {
    expect(redactEmail("@domain.com")).toBe("•••");
  });
});
