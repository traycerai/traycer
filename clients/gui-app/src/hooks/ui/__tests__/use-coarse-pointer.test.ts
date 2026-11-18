import { afterEach, describe, expect, it, vi } from "vitest";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import { isCoarsePointer } from "@/hooks/ui/use-coarse-pointer";

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

// `isCoarsePointer` is the imperative read of the same snapshot the hook uses.
describe("coarse pointer snapshot", () => {
  it("follows the media query in a browser window", () => {
    answerEveryQuery(false);
    expect(isCoarsePointer()).toBe(false);

    answerEveryQuery(true);
    expect(isCoarsePointer()).toBe(true);
  });

  it("is coarse in the installed app even when a stylus reads as fine", () => {
    setPhoneLayoutOnly(true);
    answerEveryQuery(false);

    expect(isCoarsePointer()).toBe(true);
  });
});
