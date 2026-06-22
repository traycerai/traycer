import { describe, expect, it } from "vitest";
import { translateLineEditChord } from "@/lib/terminal-line-edit";

function event(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("translateLineEditChord", () => {
  it("maps Cmd+Arrow to line start/end", () => {
    const opts = { isMac: true };
    expect(
      translateLineEditChord(event({ key: "ArrowLeft", metaKey: true }), opts),
    ).toBe("\x01");
    expect(
      translateLineEditChord(event({ key: "ArrowRight", metaKey: true }), opts),
    ).toBe("\x05");
  });

  it("maps Cmd+Backspace to kill-to-line-start", () => {
    expect(
      translateLineEditChord(event({ key: "Backspace", metaKey: true }), {
        isMac: true,
      }),
    ).toBe("\x15\x1b[D");
  });

  it("maps Cmd+Enter to the TUI newline sequence", () => {
    expect(
      translateLineEditChord(event({ key: "Enter", metaKey: true }), {
        isMac: true,
      }),
    ).toBe("\x1b\r");
  });

  it("maps Option+Arrow to word-jump", () => {
    const opts = { isMac: true };
    expect(
      translateLineEditChord(event({ key: "ArrowLeft", altKey: true }), opts),
    ).toBe("\x1bb");
    expect(
      translateLineEditChord(event({ key: "ArrowRight", altKey: true }), opts),
    ).toBe("\x1bf");
  });

  it("ignores chords with extra modifiers (e.g. Cmd+Option+Arrow is tile focus)", () => {
    expect(
      translateLineEditChord(
        event({ key: "ArrowLeft", metaKey: true, altKey: true }),
        {
          isMac: true,
        },
      ),
    ).toBeNull();
    expect(
      translateLineEditChord(
        event({ key: "Enter", metaKey: true, shiftKey: true }),
        {
          isMac: true,
        },
      ),
    ).toBeNull();
  });

  it("does not translate on non-Mac platforms", () => {
    expect(
      translateLineEditChord(event({ key: "ArrowLeft", metaKey: true }), {
        isMac: false,
      }),
    ).toBeNull();
  });
});
