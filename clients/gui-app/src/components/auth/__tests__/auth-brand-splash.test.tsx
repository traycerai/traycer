import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_SPLASH_DEFAULT_VARIANT,
  AUTH_SPLASH_MS,
  AuthBrandSplash,
} from "@/components/auth/auth-brand-splash";

/**
 * These run COMPILED - `auth-brand-splash` is listed in
 * `REACT_COMPILER_REGRESSION_FILES` (vitest.config.ts), and that is what makes
 * them meaningful. The compiler can cache a value derived from other state past
 * the timer meant to retire it, so a surface that retires itself on a timeout
 * has to be tested as the compiler emits it. Uncompiled, these tests would pass
 * against code that cannot ship.
 *
 * The assertion that matters is therefore not "the boolean flips" but "the
 * splash is GONE after the span, under compilation".
 */
function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query === "(prefers-reduced-motion: reduce)",
    media: query,
  }));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("<AuthBrandSplash />", () => {
  it("covers at first paint and is gone after the ceiling", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);

    render(<AuthBrandSplash variant={AUTH_SPLASH_DEFAULT_VARIANT} />);
    expect(screen.queryByTestId("auth-brand-splash")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(AUTH_SPLASH_MS);
    });

    // One timeout, one boolean: no second tick is needed to retire it, which is
    // exactly the property the previous phase machine lacked.
    expect(screen.queryByTestId("auth-brand-splash")).toBeNull();
    expect(AUTH_SPLASH_MS).toBe(3500);
  });

  it("is still covering just before the ceiling", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);

    render(<AuthBrandSplash variant={AUTH_SPLASH_DEFAULT_VARIANT} />);
    act(() => {
      vi.advanceTimersByTime(AUTH_SPLASH_MS - 1);
    });
    expect(screen.queryByTestId("auth-brand-splash")).not.toBeNull();
  });

  it("never appears under reduced motion", () => {
    vi.useFakeTimers();
    stubReducedMotion(true);

    render(<AuthBrandSplash variant={AUTH_SPLASH_DEFAULT_VARIANT} />);
    expect(screen.queryByTestId("auth-brand-splash")).toBeNull();
  });

  it("is not a second full-bleed surface", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);

    render(<AuthBrandSplash variant={AUTH_SPLASH_DEFAULT_VARIANT} />);
    const splash = screen.getByTestId("auth-brand-splash");

    // `fixed inset-0` is reserved for `StandaloneShell`, and a contract test
    // asserts the full-bleed marker appears exactly once. This layer sits
    // INSIDE that shell and insets itself like any other content layer there.
    expect(splash.className).toContain("absolute");
    expect(splash.className).not.toContain("fixed");
    expect(splash.getAttribute("data-full-bleed-surface")).toBeNull();
    expect(splash.className).toContain("pt-safe-top");
    expect(splash.className).toContain("pl-safe-left");
    expect(splash.className).toContain("pr-safe-right");
  });
});
