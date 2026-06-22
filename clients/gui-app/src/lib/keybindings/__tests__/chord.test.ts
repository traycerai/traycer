import { describe, expect, it } from "vitest";
import {
  chordFromEvent,
  chordMatchesEvent,
  formatChordForDisplay,
  parseChordString,
} from "@/lib/keybindings/chord";

function keydown(
  init: Partial<KeyboardEventInit> & { code: string },
): KeyboardEvent {
  return new KeyboardEvent("keydown", { ...init, code: init.code });
}

describe("chordFromEvent", () => {
  it("encodes Cmd+1 / Ctrl+1 as 'mod+1'", () => {
    expect(chordFromEvent(keydown({ code: "Digit1", metaKey: true }))).toBe(
      "mod+1",
    );
    expect(chordFromEvent(keydown({ code: "Digit1", ctrlKey: true }))).toBe(
      "mod+1",
    );
  });

  it("encodes Cmd+Shift+H as 'mod+shift+h'", () => {
    expect(
      chordFromEvent(keydown({ code: "KeyH", metaKey: true, shiftKey: true })),
    ).toBe("mod+shift+h");
  });

  it("encodes Cmd+Alt+ArrowLeft as 'mod+alt+arrowleft'", () => {
    expect(
      chordFromEvent(
        keydown({ code: "ArrowLeft", metaKey: true, altKey: true }),
      ),
    ).toBe("mod+alt+arrowleft");
  });

  it("encodes Cmd+, as 'mod+,'", () => {
    expect(chordFromEvent(keydown({ code: "Comma", metaKey: true }))).toBe(
      "mod+,",
    );
  });

  it("returns null for bare modifier keydowns", () => {
    expect(chordFromEvent(keydown({ code: "MetaLeft" }))).toBeNull();
    expect(chordFromEvent(keydown({ code: "ControlRight" }))).toBeNull();
  });
});

describe("chordMatchesEvent", () => {
  it("matches the stored chord string against an event", () => {
    expect(
      chordMatchesEvent("mod+2", keydown({ code: "Digit2", metaKey: true })),
    ).toBe(true);
    expect(
      chordMatchesEvent("mod+2", keydown({ code: "Digit3", metaKey: true })),
    ).toBe(false);
  });
});

describe("parseChordString", () => {
  it("round-trips mod+shift+h", () => {
    const parts = parseChordString("mod+shift+h");
    expect(parts).toEqual({
      mod: true,
      ctrl: false,
      shift: true,
      alt: false,
      key: "h",
    });
  });

  it("parses the Control-specific token", () => {
    expect(parseChordString("ctrl+shift+m")).toEqual({
      mod: false,
      ctrl: true,
      shift: true,
      alt: false,
      key: "m",
    });
  });

  it("parses bare key", () => {
    expect(parseChordString("a")).toEqual({
      mod: false,
      ctrl: false,
      shift: false,
      alt: false,
      key: "a",
    });
  });

  it("rejects malformed input", () => {
    expect(parseChordString("")).toBeNull();
    expect(parseChordString("foo+bar+baz")).toBeNull();
  });
});

describe("formatChordForDisplay", () => {
  it("returns a readable label for mod+shift+h", () => {
    const out = formatChordForDisplay("mod+shift+h");
    expect(out).toMatch(/H$/);
    expect(out.length).toBeGreaterThan(1);
  });

  it("pretty-prints arrows", () => {
    expect(formatChordForDisplay("mod+alt+arrowleft")).toMatch(/←$/);
  });
});
