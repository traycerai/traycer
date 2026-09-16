import { describe, expect, it } from "vitest";
import {
  DIORAMA_CHAPTERS,
  dioramaChapterStarts,
} from "@/components/onboarding/onboarding-diorama-chapters";

describe("diorama chapters", () => {
  it("keeps the spec's timeline: 0 / 2.4 / 6.2 / 8.8s, holding at 12.5s", () => {
    const starts = dioramaChapterStarts(DIORAMA_CHAPTERS);
    expect(starts).toEqual([0, 2400, 6200, 8800]);
    const total = DIORAMA_CHAPTERS.reduce(
      (sum, chapter) => sum + chapter.durationMs,
      0,
    );
    expect(total).toBe(12500);
  });

  it("spotlights a region it also keeps lit", () => {
    // A ring on a region the same chapter dimmed to .6 would read as a bug.
    for (const chapter of DIORAMA_CHAPTERS) {
      expect(chapter.lit).toContain(chapter.ring);
    }
  });
});
