import { describe, expect, it } from "vitest";
import { screencastHistoryKey } from "../screencast-input-encoding";

function event(fields: {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
}): {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
} {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...fields,
  };
}

describe("screencastHistoryKey", () => {
  describe("cross-platform: non-mac viewer -> mac host", () => {
    it("translates Ctrl+Z into Cmd+Z", () => {
      expect(
        screencastHistoryKey(event({ key: "z", ctrlKey: true }), false, true),
      ).toEqual({ key: "z", modifiers: 4 });
    });

    it("translates Ctrl+Shift+Z into Cmd+Shift+Z", () => {
      expect(
        screencastHistoryKey(
          event({ key: "z", ctrlKey: true, shiftKey: true }),
          false,
          true,
        ),
      ).toEqual({ key: "Z", modifiers: 12 });
    });

    it("translates bare Ctrl+Y (redo) into Cmd+Shift+Z, mac's redo spelling", () => {
      expect(
        screencastHistoryKey(event({ key: "y", ctrlKey: true }), false, true),
      ).toEqual({ key: "Z", modifiers: 12 });
    });
  });

  describe("cross-platform: mac viewer -> non-mac host", () => {
    it("translates Cmd+Z into Ctrl+Z", () => {
      expect(
        screencastHistoryKey(event({ key: "z", metaKey: true }), true, false),
      ).toEqual({ key: "z", modifiers: 2 });
    });

    it("translates Shift+Cmd+Z into Ctrl+Shift+Z", () => {
      expect(
        screencastHistoryKey(
          event({ key: "z", metaKey: true, shiftKey: true }),
          true,
          false,
        ),
      ).toEqual({ key: "Z", modifiers: 10 });
    });
  });

  describe("mac viewer's literal Ctrl+Y/Ctrl+Z stay literal on a mac host", () => {
    // isTextHistoryShortcut only recognises Meta on a mac VIEWER, so a mac
    // viewer's own literal Ctrl+Z (terminal suspend) / Ctrl+Y (Emacs yank)
    // is never even classified as a history gesture here - it passes
    // through completely unchanged, regardless of hostIsMac, so the host's
    // own mapHistoryKeyEvent (which now also excludes Control on a mac host)
    // sees the exact same literal chord end to end.
    it("leaves a mac viewer's literal Ctrl+Z untouched", () => {
      expect(
        screencastHistoryKey(event({ key: "z", ctrlKey: true }), true, true),
      ).toEqual({ key: "z", modifiers: 2 });
    });

    it("leaves a mac viewer's literal Ctrl+Y untouched", () => {
      expect(
        screencastHistoryKey(event({ key: "y", ctrlKey: true }), true, true),
      ).toEqual({ key: "y", modifiers: 2 });
    });

    it("still translates a mac viewer's Cmd+Z even when the host is also mac (idempotent no-op shape)", () => {
      expect(
        screencastHistoryKey(event({ key: "z", metaKey: true }), true, true),
      ).toEqual({ key: "z", modifiers: 4 });
    });
  });

  describe("hostIsMac: null (host platform unknown) never translates", () => {
    it("passes a non-mac viewer's Ctrl+Y through unchanged instead of guessing Cmd+Shift+Z", () => {
      expect(
        screencastHistoryKey(event({ key: "y", ctrlKey: true }), false, null),
      ).toEqual({ key: "y", modifiers: 2 });
    });

    it("passes a mac viewer's Cmd+Z through unchanged instead of guessing Ctrl+Z", () => {
      expect(
        screencastHistoryKey(event({ key: "z", metaKey: true }), true, null),
      ).toEqual({ key: "z", modifiers: 4 });
    });
  });

  describe("non-history keys are never touched, only ordinary modifier encoding", () => {
    it("passes an unrelated Ctrl+K through as plain modifier encoding", () => {
      expect(
        screencastHistoryKey(event({ key: "k", ctrlKey: true }), false, true),
      ).toEqual({ key: "k", modifiers: 2 });
    });

    it("does not translate Alt+Cmd+Z (an extra modifier breaks the gesture)", () => {
      expect(
        screencastHistoryKey(
          event({ key: "z", metaKey: true, altKey: true }),
          true,
          false,
        ),
      ).toEqual({ key: "z", modifiers: 5 });
    });
  });
});
