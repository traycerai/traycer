import { afterEach, describe, expect, it, vi } from "vitest";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import { readIsNarrowWindowSnapshot } from "@/hooks/ui/use-narrow-window";

const realMatchMedia = window.matchMedia.bind(window);

function answerEveryQuery(matches: boolean): void {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string): MediaQueryList =>
      Object.defineProperty(realMatchMedia(query), "matches", {
        configurable: true,
        value: matches,
      }),
  );
}

afterEach(() => {
  setPhoneLayoutOnly(false);
  vi.restoreAllMocks();
});

describe("readIsNarrowWindowSnapshot", () => {
  it("follows the media query in a browser window", () => {
    answerEveryQuery(false);
    expect(readIsNarrowWindowSnapshot()).toBe(false);

    answerEveryQuery(true);
    expect(readIsNarrowWindowSnapshot()).toBe(true);
  });

  it("is narrow in the installed app whatever the media query says", () => {
    setPhoneLayoutOnly(true);
    answerEveryQuery(false);

    expect(readIsNarrowWindowSnapshot()).toBe(true);
  });
});
