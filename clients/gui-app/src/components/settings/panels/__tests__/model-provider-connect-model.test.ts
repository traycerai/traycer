import { describe, expect, it } from "vitest";
import { extractConfirmationCode } from "@/components/settings/panels/model-provider-connect-model";

/**
 * Upstream lifts the code with `instructions.split(":").pop().trim()`. We
 * deliberately do not copy that rule unguarded - see the URL case below, which
 * is the one that made it worth diverging.
 */
describe("extractConfirmationCode", () => {
  it("lifts a code that follows a colon", () => {
    expect(
      extractConfirmationCode("Enter this code in your browser: ABCD-1234"),
    ).toBe("ABCD-1234");
  });

  it("takes a bare code as-is", () => {
    expect(extractConfirmationCode("WXYZ-7890")).toBe("WXYZ-7890");
  });

  it("DEGRADES rather than reporting a URL tail as a code", () => {
    // The whole reason for diverging from upstream: splitting on `:` here
    // yields "//example.test/device and enter ABCD-1234", which their rule
    // would present in a monospace field as though it were the code.
    expect(
      extractConfirmationCode(
        "Visit https://example.test/device and enter ABCD-1234",
      ),
    ).toBeNull();
  });

  it("degrades when the tail is a sentence rather than a code", () => {
    expect(
      extractConfirmationCode("Do this: open the page and approve the request"),
    ).toBeNull();
  });

  it("degrades on a tail that is too short to be a code", () => {
    expect(extractConfirmationCode("Code: ab")).toBeNull();
  });

  it("answers null for absent or empty instructions", () => {
    expect(extractConfirmationCode(null)).toBeNull();
    expect(extractConfirmationCode("   ")).toBeNull();
  });
});
