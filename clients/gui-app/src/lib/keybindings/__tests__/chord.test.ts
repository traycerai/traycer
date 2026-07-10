import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformMock } from "@/__tests__/create-platform-mock";

const platformMock = vi.hoisted(() => ({ mac: false }));

vi.mock("@/lib/keybindings/platform", () => createPlatformMock(platformMock));

import {
  chordFromEvent,
  chordFromEventCtrlAware,
  chordMatchesEvent,
  formatChordForDisplay,
  modifierMaskFromEvent,
  modifierMaskMatches,
  parseChordString,
  parseModifierChord,
} from "@/lib/keybindings/chord";

function keydown(
  init: Partial<KeyboardEventInit> & { code: string },
): KeyboardEvent {
  return new KeyboardEvent("keydown", { ...init, code: init.code });
}

beforeEach(() => {
  platformMock.mac = false;
});

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

describe("macOS platform-primary modifier matching", () => {
  beforeEach(() => {
    platformMock.mac = true;
  });

  it("keeps Command chords matching mod bindings", () => {
    expect(
      chordMatchesEvent("mod+k", keydown({ code: "KeyK", metaKey: true })),
    ).toBe(true);
    expect(
      chordMatchesEvent("mod+w", keydown({ code: "KeyW", metaKey: true })),
    ).toBe(true);
    expect(
      chordMatchesEvent("mod+d", keydown({ code: "KeyD", metaKey: true })),
    ).toBe(true);
    expect(
      modifierMaskMatches(
        "mod",
        modifierMaskFromEvent(keydown({ code: "Digit1", metaKey: true })),
      ),
    ).toBe(true);
  });

  it("does not let bare Control chords match mod bindings or digit masks", () => {
    expect(
      chordMatchesEvent("mod+k", keydown({ code: "KeyK", ctrlKey: true })),
    ).toBe(false);
    expect(
      chordMatchesEvent("mod+w", keydown({ code: "KeyW", ctrlKey: true })),
    ).toBe(false);
    expect(
      chordMatchesEvent("mod+d", keydown({ code: "KeyD", ctrlKey: true })),
    ).toBe(false);
    expect(
      modifierMaskMatches(
        "mod",
        modifierMaskFromEvent(keydown({ code: "Digit1", ctrlKey: true })),
      ),
    ).toBe(false);
  });

  it("keeps Control-specific chords matchable", () => {
    const event = keydown({
      code: "KeyM",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(chordFromEventCtrlAware(event)).toBe("ctrl+shift+m");
    expect(chordMatchesEvent("ctrl+shift+m", event)).toBe(true);
    expect(chordMatchesEvent("shift+m", event)).toBe(false);
  });
});

describe("non-mac platform-primary modifier matching", () => {
  it("continues to treat Control as mod", () => {
    expect(
      chordMatchesEvent("mod+k", keydown({ code: "KeyK", ctrlKey: true })),
    ).toBe(true);
    expect(
      modifierMaskMatches(
        "mod",
        modifierMaskFromEvent(keydown({ code: "Digit1", ctrlKey: true })),
      ),
    ).toBe(true);
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

describe("modifier-only chord matching (digit actions)", () => {
  // T4 (profile shortcuts): confirms the debate's verified finding -
  // `matchDigitAction`'s generic mask matching already handles a mod+shift
  // chord like any other combination, so `model.profile.byDigit` needed no
  // dispatch-layer changes, only a new bound action.
  it("parses 'mod+shift' as a mod+shift-only modifier mask", () => {
    expect(parseModifierChord("mod+shift")).toEqual({
      mod: true,
      shift: true,
      alt: false,
    });
  });

  it("matches a mod+shift chord against a ⌘⇧-held event, not a bare ⌘ or ⌘⌥ event", () => {
    const modShiftMask = modifierMaskFromEvent(
      keydown({ code: "Digit2", metaKey: true, shiftKey: true }),
    );
    const modOnlyMask = modifierMaskFromEvent(
      keydown({ code: "Digit2", metaKey: true }),
    );
    const modAltMask = modifierMaskFromEvent(
      keydown({ code: "Digit2", metaKey: true, altKey: true }),
    );

    expect(modifierMaskMatches("mod+shift", modShiftMask)).toBe(true);
    expect(modifierMaskMatches("mod+shift", modOnlyMask)).toBe(false);
    expect(modifierMaskMatches("mod+shift", modAltMask)).toBe(false);
    // And the reverse - a plain "mod" binding must not match a ⌘⇧ event,
    // otherwise the profile digit would collide with the provider digit.
    expect(modifierMaskMatches("mod", modShiftMask)).toBe(false);
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
