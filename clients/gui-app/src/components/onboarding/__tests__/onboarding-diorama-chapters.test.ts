import { describe, expect, it } from "vitest";
import {
  DIORAMA_CHAPTERS,
  dioramaChapterStarts,
  dioramaElapsedMs,
  setDioramaPaused,
  stepDioramaChapter,
} from "@/components/onboarding/onboarding-diorama-chapters";

describe("diorama chapters", () => {
  it("gives every chapter the same 4.5s slot", () => {
    // The floor is the point: a chapter shorter than this moves on before its
    // label card has been read.
    for (const chapter of DIORAMA_CHAPTERS) {
      expect(chapter.durationMs).toBeGreaterThanOrEqual(4500);
    }
    expect(dioramaChapterStarts(DIORAMA_CHAPTERS)).toEqual([
      0, 4500, 9000, 13500,
    ]);
  });

  it("loops the strip at both ends", () => {
    expect(stepDioramaChapter(0, 1)).toBe(1);
    expect(stepDioramaChapter(DIORAMA_CHAPTERS.length - 1, 1)).toBe(0);
    expect(stepDioramaChapter(0, -1)).toBe(DIORAMA_CHAPTERS.length - 1);
  });

  it("spotlights a region it also keeps lit", () => {
    // A ring on a region the same chapter dimmed to .6 would read as a bug.
    for (const chapter of DIORAMA_CHAPTERS) {
      expect(chapter.lit).toContain(chapter.ring);
    }
  });

  it("captions every segment with the label card's headline", () => {
    for (const chapter of DIORAMA_CHAPTERS) {
      expect(chapter.label).not.toBe("");
      expect(chapter.title).not.toBe("");
    }
  });

  it("freezes the clock on pause and resumes where it stopped", () => {
    const running = { startedAt: 1000, pausedAt: null };
    expect(dioramaElapsedMs(running, 2000)).toBe(1000);

    const paused = setDioramaPaused(running, true, 2000);
    expect(dioramaElapsedMs(paused, 9000)).toBe(1000);
    // A second pause reason must not move the freeze point.
    expect(setDioramaPaused(paused, true, 9000)).toBe(paused);

    const resumed = setDioramaPaused(paused, false, 9000);
    expect(dioramaElapsedMs(resumed, 9500)).toBe(1500);
    expect(setDioramaPaused(resumed, false, 9600)).toBe(resumed);
  });
});
