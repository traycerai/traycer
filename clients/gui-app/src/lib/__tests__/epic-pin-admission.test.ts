import { describe, expect, it } from "vitest";
import { negotiatedSetPinnedServesLocalHome } from "@/lib/epic-pin-admission";

/**
 * Lane 9 item 5. `negotiatedSetPinnedServesLocalHome` fails closed on both
 * non-version answers, which are different facts (`false` - handshook, no
 * local arm; `null` - unknown) that warrant the same refusal.
 */
describe("negotiatedSetPinnedServesLocalHome", () => {
  it("is true at exactly the minor the local arm shipped on", () => {
    expect(negotiatedSetPinnedServesLocalHome({ major: 1, minor: 1 })).toBe(
      true,
    );
  });

  it("is false one minor below the local arm", () => {
    expect(negotiatedSetPinnedServesLocalHome({ major: 1, minor: 0 })).toBe(
      false,
    );
  });

  it("fails closed on null - no handshake yet", () => {
    expect(negotiatedSetPinnedServesLocalHome(null)).toBe(false);
  });

  it("fails closed on false - handshook, method not advertised", () => {
    expect(negotiatedSetPinnedServesLocalHome(false)).toBe(false);
  });

  it("stays true for a higher minor - the floor, not an exact match", () => {
    expect(negotiatedSetPinnedServesLocalHome({ major: 1, minor: 2 })).toBe(
      true,
    );
  });
});
