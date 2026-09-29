import { describe, expect, it } from "vitest";
import { providerLoginRetryLabel } from "@/lib/providers/provider-login-retry-label";

describe("providerLoginRetryLabel", () => {
  it("keeps the surface's own label when the provider did not refuse the sign-in", () => {
    expect(providerLoginRetryLabel(null, "Retry")).toBe("Retry");
    expect(providerLoginRetryLabel(null, "Try again")).toBe("Try again");
  });

  it("reads as choosing another account once the provider refused this one, with or without a link", () => {
    expect(
      providerLoginRetryLabel(
        {
          reason: "Not eligible.",
          actionUrl: "https://accounts.google.com/signin/continue",
        },
        "Retry",
      ),
    ).toBe("Try another account");
    expect(
      providerLoginRetryLabel(
        { reason: "Not eligible.", actionUrl: null },
        "Try again",
      ),
    ).toBe("Try another account");
  });
});
