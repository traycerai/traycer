import { describe, expect, it } from "vitest";
import {
  DIORAMA_CHAPTERS,
  dioramaBeatAt,
  dioramaChapterStarts,
  dioramaElapsedMs,
  setDioramaPaused,
  stepDioramaChapter,
} from "@/components/onboarding/onboarding-diorama-chapters";

describe("diorama chapters", () => {
  it("runs Tabs, Open, Panels, Browse with a readable hold in each", () => {
    expect(DIORAMA_CHAPTERS.map((chapter) => chapter.id)).toEqual([
      "tabs",
      "open",
      "panels",
      "browse",
    ]);
    // The floor is the point: a chapter shorter than this moves on before its
    // label card has been read.
    for (const chapter of DIORAMA_CHAPTERS) {
      expect(chapter.durationMs).toBeGreaterThanOrEqual(4500);
    }
    expect(DIORAMA_CHAPTERS.map((chapter) => chapter.durationMs)).toEqual([
      4500, 6000, 5500, 4500,
    ]);
    expect(dioramaChapterStarts(DIORAMA_CHAPTERS)).toEqual([
      0, 4500, 10500, 16000,
    ]);
  });

  it("loops the strip at both ends", () => {
    expect(stepDioramaChapter(0, 1)).toBe(1);
    expect(stepDioramaChapter(DIORAMA_CHAPTERS.length - 1, 1)).toBe(0);
    expect(stepDioramaChapter(0, -1)).toBe(DIORAMA_CHAPTERS.length - 1);
  });

  it("opens every chapter on its first beat and ends every beat inside it", () => {
    for (const chapter of DIORAMA_CHAPTERS) {
      expect(chapter.beats.length).toBeGreaterThan(0);
      expect(chapter.beats.at(0)?.atMs).toBe(0);
      let previous = -1;
      for (const beat of chapter.beats) {
        expect(beat.atMs).toBeGreaterThan(previous);
        // A beat that lands after the hold would never be seen.
        expect(beat.atMs).toBeLessThan(chapter.durationMs);
        previous = beat.atMs;
        // A ring on a region the same beat dimmed to .6 would read as a bug.
        expect(beat.lit).toContain(beat.ring);
      }
    }
  });

  it("drops, moves its spotlight, then opens the browser, all in Open", () => {
    const [, open] = DIORAMA_CHAPTERS;
    expect(open.beats.map((beat) => beat.atMs)).toEqual([0, 2350, 3200, 3900]);
    expect(open.beats.map((beat) => beat.stage)).toEqual([
      "single",
      "tiled",
      "tiled",
      "browsing",
    ]);
    expect(open.beats.map((beat) => beat.ring)).toEqual([
      "canvas",
      "canvas",
      "browsers",
      "browsers",
    ]);
    expect(dioramaBeatAt(open, 2349)).toBe(0);
    expect(dioramaBeatAt(open, 2350)).toBe(1);
    expect(dioramaBeatAt(open, 3200)).toBe(2);
    expect(dioramaBeatAt(open, 5999)).toBe(3);
  });

  it("carries the split forward once the drop has happened", () => {
    // The whole point of the stage living on the beat: chapters after the drop
    // must not have to restate it, and it must never run backwards inside one.
    const order = ["single", "tiled", "browsing"];
    for (const chapter of DIORAMA_CHAPTERS) {
      let reached = 0;
      for (const beat of chapter.beats) {
        const stage = order.indexOf(beat.stage);
        expect(stage).toBeGreaterThanOrEqual(reached);
        reached = stage;
      }
    }
    const opening = DIORAMA_CHAPTERS.map((chapter) => chapter.beats.at(0));
    expect(opening.map((beat) => beat?.stage)).toEqual([
      "single",
      "single",
      "browsing",
      "browsing",
    ]);
  });

  it("walks Panels through every sidebar panel and back to chats", () => {
    const [, , panels] = DIORAMA_CHAPTERS;
    expect(panels.beats.map((beat) => beat.panel)).toEqual([
      "chats",
      "terminals",
      "git",
      "pulls",
      "files",
      "chats",
    ]);
    // Browse starts where Panels left off, so the sidebar must be back on
    // chats before the chapter ends.
    expect(panels.beats.at(-1)?.panel).toBe("chats");
    expect(dioramaBeatAt(panels, 2400)).toBe(3);
    expect(dioramaBeatAt(panels, 5400)).toBe(5);
  });

  it("captions every segment with the label card's headline", () => {
    for (const chapter of DIORAMA_CHAPTERS) {
      expect(chapter.label).not.toBe("");
      expect(chapter.title).not.toBe("");
      expect(chapter.line).not.toBe("");
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
