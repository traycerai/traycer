import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthLandingPage } from "@/components/auth/auth-landing-page";
import { BRAND_DARK_TOKENS_CLASS } from "@/components/auth/brand-surface";

// Stubbed for the same reason as in `auth-brand-splash.test.tsx`: the real
// control needs the host runtime, and what is asserted here is only WHERE the
// sign-in controls mount relative to the page's palette scope.
vi.mock("@/components/layout/header/sign-in-button", () => ({
  SignInButton: () => <button type="button">Sign in</button>,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * jsdom cannot see a colour, so this is not the proof that the page is legible
 * under every theme - `scripts/sign-in-theme-contrast-browser.mjs` is. It
 * guards the mechanism that proof depends on: the page root carries the dark
 * palette scope, and the sign-in controls render inside it.
 */
describe("the sign-in page's palette scope", () => {
  it.each([null, "unverified-relay-only"] as const)(
    "wraps the sign-in controls in the dark palette (refusal: %s)",
    (refusal) => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
      }));
      render(<AuthLandingPage refusal={refusal} />);

      const page = screen.getByTestId("auth-landing-page");
      expect(page.classList.contains(BRAND_DARK_TOKENS_CLASS)).toBe(true);
      expect(
        page.contains(screen.getByRole("button", { name: "Sign in" })),
      ).toBe(true);
    },
  );
});
