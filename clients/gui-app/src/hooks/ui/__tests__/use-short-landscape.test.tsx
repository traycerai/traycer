import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import { useShortLandscape } from "@/hooks/ui/use-short-landscape";

const SHORT_LANDSCAPE = "(max-height: 560px) and (orientation: landscape)";

const realMatchMedia = window.matchMedia.bind(window);

function answer(input: {
  readonly shortLandscape: boolean;
  readonly narrow: boolean;
}): void {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string): MediaQueryList =>
      Object.defineProperty(realMatchMedia(query), "matches", {
        configurable: true,
        value: query === SHORT_LANDSCAPE ? input.shortLandscape : input.narrow,
      }),
  );
}

function Probe() {
  return <span data-testid="short">{String(useShortLandscape())}</span>;
}

function shown(): string | null {
  return screen.getByTestId("short").textContent;
}

afterEach(() => {
  cleanup();
  setPhoneLayoutOnly(false);
  vi.restoreAllMocks();
});

describe("useShortLandscape", () => {
  it("is true in the installed app when the window is short and landscape", () => {
    setPhoneLayoutOnly(true);
    answer({ shortLandscape: true, narrow: false });
    render(<Probe />);

    expect(shown()).toBe("true");
  });

  it("is false in the installed app when the window is not short", () => {
    setPhoneLayoutOnly(true);
    answer({ shortLandscape: false, narrow: false });
    render(<Probe />);

    expect(shown()).toBe("false");
  });

  it("is false in a short desktop window", () => {
    answer({ shortLandscape: true, narrow: false });
    render(<Probe />);

    expect(shown()).toBe("false");
  });

  it("is true in a narrow browser window that is also short and landscape", () => {
    answer({ shortLandscape: true, narrow: true });
    render(<Probe />);

    expect(shown()).toBe("true");
  });
});
