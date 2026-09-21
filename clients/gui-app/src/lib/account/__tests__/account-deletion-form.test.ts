/**
 * The deletion form's URL is the whole mechanism behind Settings › Delete
 * account: the app has no deletion RPC, so a wrong `entry.*` id or a mangled
 * address is the difference between a request support can act on and one they
 * cannot. Neither failure is visible in a render test - both produce a
 * perfectly valid URL - so the builder is pinned here, parsed rather than
 * string-compared, since the order `URLSearchParams` serializes in is not part
 * of the contract.
 */
import { describe, expect, it } from "vitest";

import { buildAccountDeletionFormUrl } from "@/lib/account/account-deletion-form";

const FORM_PATH =
  "/forms/d/e/1FAIpQLScT3D5fygNGY-sg3ZJh682itv_YBXGUSsacBG3_RXocL5wG4g/viewform";

/** The parsed query, so assertions read answers rather than percent-encoding. */
function paramsFor(email: string | null): URLSearchParams {
  return new URL(buildAccountDeletionFormUrl(email)).searchParams;
}

describe("buildAccountDeletionFormUrl", () => {
  it("targets the deletion form itself", () => {
    const url = new URL(buildAccountDeletionFormUrl("ada@example.com"));
    expect(url.origin).toBe("https://docs.google.com");
    expect(url.pathname).toBe(FORM_PATH);
  });

  it("answers both address questions and leaves the sign-in method to the user", () => {
    const params = paramsFor("ada@example.com");
    // The two address questions are distinct on the form (account vs contact,
    // one per sign-in branch) and both carry the signed-in address, so
    // whichever branch the user picks is already filled.
    expect(params.get("entry.833738174")).toBe("ada@example.com");
    expect(params.get("entry.671973110")).toBe("ada@example.com");
    // The sign-in method is the user's to answer: only they know whether they
    // sign in with Email, GitHub or Apple, and a wrong prefill routes to the
    // wrong branch.
    expect(params.has("entry.1825201942")).toBe(false);
  });

  it("prefills nothing when the address has not resolved", () => {
    const params = paramsFor(null);
    // The form still opens, which is the point - it is the only deletion route.
    expect(params.has("entry.833738174")).toBe(false);
    expect(params.has("entry.671973110")).toBe(false);
  });

  it("treats a blank address as unresolved", () => {
    expect(paramsFor("   ").has("entry.833738174")).toBe(false);
    expect(paramsFor("").has("entry.833738174")).toBe(false);
  });

  it("trims surrounding whitespace off an address it does send", () => {
    expect(paramsFor("  ada@example.com  ").get("entry.833738174")).toBe(
      "ada@example.com",
    );
  });

  // The reason this builder uses `URLSearchParams` rather than concatenation.
  // Every character below is legal in the local part of an address, and each
  // one truncates or rewrites a concatenated query: `&` starts a new
  // parameter, `#` starts a fragment, and `+` decodes as a space - so the
  // form would open pre-filled with an address that is not the user's.
  it.each([
    "a+b@example.com",
    "a&b@example.com",
    "a#b@example.com",
    "a=b@example.com",
    "a b@example.com",
  ])("round-trips %s without corrupting it", (email) => {
    const params = paramsFor(email);
    expect(params.get("entry.833738174")).toBe(email);
    // The second address answer must survive beside it - an unescaped `&` or
    // `#` would have swallowed or orphaned whatever followed.
    expect(params.get("entry.671973110")).toBe(email);
  });

  it("escapes a raw address out of the serialized query", () => {
    // Belt and braces on the above: assert the dangerous characters never
    // appear literally in the query string, which is what a concatenated
    // build would have produced.
    const url = buildAccountDeletionFormUrl("a&b#c@example.com");
    expect(url).not.toContain("a&b#c@example.com");
    expect(url).toContain("a%26b%23c%40example.com");
  });
});
