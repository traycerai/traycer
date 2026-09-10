import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_SPLASH_MS } from "@/hooks/auth/use-auth-splash-cover";
import { AuthLandingPage } from "@/components/auth/auth-landing-page";

/**
 * These drive the real `AuthLandingPage`, and they run COMPILED - both
 * `auth-brand-splash` and `auth-landing-page` are listed in
 * `REACT_COMPILER_REGRESSION_FILES` (vitest.config.ts). That is what makes them
 * meaningful: the compiler can cache a value derived from other state past the
 * timer meant to retire it, so a surface that retires itself on a timeout has
 * to be tested as the compiler emits it, through the component that owns the
 * state. Uncompiled, or against the presentation component alone, these would
 * pass on code that cannot ship.
 */
// The only child of the page that needs the host runtime. Stubbed so these can
// drive the REAL `AuthLandingPage` - the component that owns the splash boolean
// and applies `inert` - without standing up a provider tree that has nothing to
// do with what is under test. The button's own behaviour is covered elsewhere.
vi.mock("@/components/layout/header/sign-in-button", () => ({
  SignInButton: () => <button type="button">Sign in</button>,
}));

function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query === "(prefers-reduced-motion: reduce)",
    media: query,
  }));
}

function contentSection(): Element | null {
  return document.querySelector("section");
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the sign-in splash", () => {
  it("covers at first paint and is gone after the span", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);

    render(<AuthLandingPage refusal={null} />);
    expect(screen.queryByTestId("auth-brand-splash")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(AUTH_SPLASH_MS);
    });

    // One timeout, one boolean: no second tick is needed to retire it.
    expect(screen.queryByTestId("auth-brand-splash")).toBeNull();
    expect(AUTH_SPLASH_MS).toBe(2240);
  });

  it("is still covering a frame before the span ends", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);

    render(<AuthLandingPage refusal={null} />);
    act(() => {
      vi.advanceTimersByTime(AUTH_SPLASH_MS - 1);
    });
    expect(screen.queryByTestId("auth-brand-splash")).not.toBeNull();
  });

  it("leaves no still frame: the fade begins as the last piece lands", () => {
    // The span is the assembly (2000ms) plus the fade (240ms) and nothing
    // else. A hold would show up here as slack between the two, which is the
    // pause a viewer reads as the app having stopped.
    expect(2000 + 240).toBe(AUTH_SPLASH_MS);
  });

  it("holds the covered controls out of the focus order", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);

    render(<AuthLandingPage refusal={null} />);

    // `pointer-events: none` on the layer above says nothing about the focus
    // order, so without `inert` a keyboard or a switch could reach "Sign in"
    // beneath a screen that shows no sign of it.
    expect(contentSection()?.hasAttribute("inert")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(AUTH_SPLASH_MS);
    });

    expect(screen.queryByTestId("auth-brand-splash")).toBeNull();
    expect(contentSection()?.hasAttribute("inert")).toBe(false);
  });

  it("never covers a refused shell, which is there to be read", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);

    render(<AuthLandingPage refusal="unverified-relay-only" />);

    expect(screen.queryByTestId("auth-brand-splash")).toBeNull();
    expect(contentSection()?.hasAttribute("inert")).toBe(false);
    expect(screen.queryByTestId("auth-landing-refusal")).not.toBeNull();
  });

  it("never appears under reduced motion", () => {
    vi.useFakeTimers();
    stubReducedMotion(true);

    render(<AuthLandingPage refusal={null} />);

    expect(screen.queryByTestId("auth-brand-splash")).toBeNull();
    expect(contentSection()?.hasAttribute("inert")).toBe(false);
  });

  it("is not a second full-bleed surface", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);

    render(<AuthLandingPage refusal={null} />);
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
