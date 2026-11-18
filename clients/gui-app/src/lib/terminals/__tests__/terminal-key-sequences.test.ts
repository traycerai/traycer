import { describe, expect, it } from "vitest";
import {
  applyModifiersToTypedCharacter,
  encodeTerminalKeyBarKey,
  NO_TERMINAL_KEY_BAR_MODIFIERS,
  type TerminalKeyBarModifiers,
} from "@/lib/terminals/terminal-key-sequences";

function mods(
  overrides: Partial<TerminalKeyBarModifiers>,
): TerminalKeyBarModifiers {
  return { ...NO_TERMINAL_KEY_BAR_MODIFIERS, ...overrides };
}

describe("encodeTerminalKeyBarKey", () => {
  it("encodes plain keys", () => {
    const none = NO_TERMINAL_KEY_BAR_MODIFIERS;
    expect(encodeTerminalKeyBarKey("escape", none, "normal")).toBe("\x1b");
    expect(encodeTerminalKeyBarKey("tab", none, "normal")).toBe("\t");
    expect(encodeTerminalKeyBarKey("enter", none, "normal")).toBe("\r");
    expect(encodeTerminalKeyBarKey("space", none, "normal")).toBe(" ");
    expect(encodeTerminalKeyBarKey("backspace", none, "normal")).toBe("\x7f");
  });

  it("switches arrow dialect on the cursor-key mode (DECCKM)", () => {
    const none = NO_TERMINAL_KEY_BAR_MODIFIERS;
    expect(encodeTerminalKeyBarKey("arrow-up", none, "normal")).toBe("\x1b[A");
    expect(encodeTerminalKeyBarKey("arrow-down", none, "normal")).toBe(
      "\x1b[B",
    );
    expect(encodeTerminalKeyBarKey("arrow-right", none, "normal")).toBe(
      "\x1b[C",
    );
    expect(encodeTerminalKeyBarKey("arrow-left", none, "normal")).toBe(
      "\x1b[D",
    );
    expect(encodeTerminalKeyBarKey("arrow-up", none, "application")).toBe(
      "\x1bOA",
    );
    expect(encodeTerminalKeyBarKey("arrow-left", none, "application")).toBe(
      "\x1bOD",
    );
  });

  it("uses the CSI 1;<mod> form for modified arrows in both modes", () => {
    expect(
      encodeTerminalKeyBarKey("arrow-up", mods({ ctrl: true }), "normal"),
    ).toBe("\x1b[1;5A");
    expect(
      encodeTerminalKeyBarKey("arrow-up", mods({ ctrl: true }), "application"),
    ).toBe("\x1b[1;5A");
    expect(
      encodeTerminalKeyBarKey("arrow-right", mods({ shift: true }), "normal"),
    ).toBe("\x1b[1;2C");
    expect(
      encodeTerminalKeyBarKey("arrow-up", mods({ alt: true }), "normal"),
    ).toBe("\x1b[1;3A");
    expect(
      encodeTerminalKeyBarKey(
        "arrow-down",
        mods({ ctrl: true, shift: true }),
        "normal",
      ),
    ).toBe("\x1b[1;6B");
  });

  it("encodes plain Alt+left/right as the readline word-jump (desktop parity)", () => {
    expect(
      encodeTerminalKeyBarKey("arrow-left", mods({ alt: true }), "normal"),
    ).toBe("\x1bb");
    expect(
      encodeTerminalKeyBarKey(
        "arrow-right",
        mods({ alt: true }),
        "application",
      ),
    ).toBe("\x1bf");
    expect(
      encodeTerminalKeyBarKey(
        "arrow-left",
        mods({ alt: true, ctrl: true }),
        "normal",
      ),
    ).toBe("\x1b[1;7D");
  });

  it("encodes Shift+Tab as back-tab", () => {
    expect(
      encodeTerminalKeyBarKey("tab", mods({ shift: true }), "normal"),
    ).toBe("\x1b[Z");
  });

  it("encodes Shift+Enter as the TUI newline sequence", () => {
    expect(
      encodeTerminalKeyBarKey("enter", mods({ shift: true }), "normal"),
    ).toBe("\x1b\r");
  });

  it("encodes modified space and backspace", () => {
    expect(
      encodeTerminalKeyBarKey("space", mods({ ctrl: true }), "normal"),
    ).toBe("\x00");
    expect(
      encodeTerminalKeyBarKey("backspace", mods({ alt: true }), "normal"),
    ).toBe("\x1b\x7f");
    expect(
      encodeTerminalKeyBarKey("backspace", mods({ ctrl: true }), "normal"),
    ).toBe("\x08");
  });

  it("ignores modifiers on Escape", () => {
    expect(
      encodeTerminalKeyBarKey(
        "escape",
        mods({ ctrl: true, shift: true }),
        "normal",
      ),
    ).toBe("\x1b");
  });
});

describe("applyModifiersToTypedCharacter", () => {
  it("maps latched Ctrl + letter to the control byte", () => {
    expect(applyModifiersToTypedCharacter("c", mods({ ctrl: true }))).toBe(
      "\x03",
    );
    expect(applyModifiersToTypedCharacter("C", mods({ ctrl: true }))).toBe(
      "\x03",
    );
    expect(applyModifiersToTypedCharacter("a", mods({ ctrl: true }))).toBe(
      "\x01",
    );
    expect(applyModifiersToTypedCharacter("[", mods({ ctrl: true }))).toBe(
      "\x1b",
    );
    expect(applyModifiersToTypedCharacter(" ", mods({ ctrl: true }))).toBe(
      "\x00",
    );
    expect(applyModifiersToTypedCharacter("?", mods({ ctrl: true }))).toBe(
      "\x7f",
    );
  });

  it("returns null for characters with no control form", () => {
    expect(
      applyModifiersToTypedCharacter("1", mods({ ctrl: true })),
    ).toBeNull();
    expect(
      applyModifiersToTypedCharacter(",", mods({ ctrl: true })),
    ).toBeNull();
  });

  it("prefixes ESC for latched Alt", () => {
    expect(applyModifiersToTypedCharacter("b", mods({ alt: true }))).toBe(
      "\x1bb",
    );
    expect(
      applyModifiersToTypedCharacter("c", mods({ ctrl: true, alt: true })),
    ).toBe("\x1b\x03");
  });

  it("leaves text unchanged under a shift-only latch", () => {
    expect(applyModifiersToTypedCharacter("c", mods({ shift: true }))).toBe(
      "c",
    );
  });
});
