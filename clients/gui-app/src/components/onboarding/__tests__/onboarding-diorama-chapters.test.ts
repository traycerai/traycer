import { describe, expect, it } from "vitest";
import {
  DIORAMA_CHAPTERS,
  PHONE_SCENES,
  dioramaBeatAt,
  dioramaChapterStarts,
  dioramaElapsedMs,
  phoneTurnReached,
  setDioramaPaused,
  stepDioramaChapter,
  type PhoneTurnStage,
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

  it("loops the strip at both ends, at whatever length it is given", () => {
    const count = DIORAMA_CHAPTERS.length;
    expect(stepDioramaChapter(0, 1, count)).toBe(1);
    expect(stepDioramaChapter(count - 1, 1, count)).toBe(0);
    expect(stepDioramaChapter(0, -1, count)).toBe(count - 1);
    // The phone's page control runs the same wrap over its own three scenes.
    const scenes = PHONE_SCENES.length;
    expect(stepDioramaChapter(scenes - 1, 1, scenes)).toBe(0);
    expect(stepDioramaChapter(0, -1, scenes)).toBe(scenes - 1);
  });

  it("plays three phone scenes of about four seconds each", () => {
    expect(PHONE_SCENES.map((scene) => scene.id)).toEqual([
      "menu",
      "task",
      "tabs",
    ]);
    expect(PHONE_SCENES.map((scene) => scene.label)).toEqual([
      "Menu",
      "Task",
      "Tabs",
    ]);
    for (const scene of PHONE_SCENES) {
      expect(scene.durationMs).toBe(4000);
      expect(scene.caption).not.toBe("");
      expect(scene.beats.at(0)?.atMs).toBe(0);
      // Every scene opens on the task: the two that open a surface show the
      // control being pressed first, and the conversation is the room that
      // surface arrives over.
      expect(scene.beats.at(0)?.surface).toBe("task");
      let previous = -1;
      for (const beat of scene.beats) {
        expect(beat.atMs).toBeGreaterThan(previous);
        expect(beat.atMs).toBeLessThan(scene.durationMs);
        previous = beat.atMs;
      }
    }
    // Every surface the phone has is reached by the end of some scene.
    expect(PHONE_SCENES.map((scene) => scene.beats.at(-1)?.surface)).toEqual([
      "drawer",
      "task",
      "sheet",
    ]);
    expect(dioramaBeatAt(PHONE_SCENES[0], 759)).toBe(0);
    expect(dioramaBeatAt(PHONE_SCENES[0], 760)).toBe(1);
  });

  it("plays the Task scene as a turn rather than holding one frame", () => {
    const [menu, task, tabs] = PHONE_SCENES;
    // The regression this pins: Task used to be a single beat, so a third of
    // act 1 was four seconds on a frame that never changed.
    expect(task.beats.length).toBeGreaterThan(1);
    expect(task.beats.map((beat) => beat.turn)).toEqual([
      "asked",
      "answering",
      "reading",
      "answered",
    ]);
    // Never a spotlight: the scene's subject is the conversation, and there is
    // no control to point at.
    expect(task.beats.every((beat) => beat.spotlight === null)).toBe(true);
    // The other two open over a finished turn, so nothing is mid-stream behind
    // a drawer or a sheet.
    for (const scene of [menu, tabs]) {
      expect(scene.beats.every((beat) => beat.turn === "answered")).toBe(true);
      expect(scene.beats.map((beat) => beat.spotlight)).not.toContain(null);
    }
  });

  it("reads the turn as a rising stage, so a block never arrives early", () => {
    const order: readonly PhoneTurnStage[] = [
      "asked",
      "answering",
      "reading",
      "answered",
    ];
    for (const [reachedIndex, reached] of order.entries()) {
      for (const [stageIndex, stage] of order.entries()) {
        expect(phoneTurnReached(reached, stage)).toBe(
          reachedIndex >= stageIndex,
        );
      }
    }
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

  it("freezes the clock while the tab is hidden and resumes where it stopped", () => {
    const running = { startedAt: 1000, pausedAt: null };
    expect(dioramaElapsedMs(running, 2000)).toBe(1000);

    const hidden = setDioramaPaused(running, true, 2000);
    expect(dioramaElapsedMs(hidden, 9000)).toBe(1000);

    const shown = setDioramaPaused(hidden, false, 9000);
    expect(dioramaElapsedMs(shown, 9500)).toBe(1500);

    // An event for the state the clock is already in changes nothing, so a
    // repeat cannot move the freeze point or lose the paused span.
    expect(setDioramaPaused(hidden, true, 9000)).toBe(hidden);
    expect(setDioramaPaused(shown, false, 9600)).toBe(shown);
  });
});
