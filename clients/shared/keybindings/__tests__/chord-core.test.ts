import { describe, expect, it } from "vitest";
import { isValidChordString, toAccelerator } from "../chord-core";

describe("toAccelerator", () => {
  it("maps a lone `mod` to the cross-platform CommandOrControl token on both platforms", () => {
    expect(toAccelerator("mod+shift+space", "mac")).toBe(
      "CommandOrControl+Shift+Space",
    );
    expect(toAccelerator("mod+shift+space", "other")).toBe(
      "CommandOrControl+Shift+Space",
    );
  });

  it("keeps Command and Control as two distinct modifiers on mac when mod and ctrl are both held", () => {
    expect(toAccelerator("mod+ctrl+k", "mac")).toBe("Command+Control+K");
  });

  it("collapses mod+ctrl into a single Control modifier elsewhere, since mod already resolves to Control there", () => {
    expect(toAccelerator("mod+ctrl+k", "other")).toBe("Control+K");
  });

  it("maps a lone `ctrl` to Control on both platforms", () => {
    expect(toAccelerator("ctrl+alt+delete", "mac")).toBe("Control+Alt+Delete");
    expect(toAccelerator("ctrl+alt+delete", "other")).toBe(
      "Control+Alt+Delete",
    );
  });

  it("uppercases single-letter keys and maps named keys to their Accelerator token", () => {
    expect(toAccelerator("mod+shift+a", "other")).toBe(
      "CommandOrControl+Shift+A",
    );
    expect(toAccelerator("mod+enter", "other")).toBe("CommandOrControl+Return");
  });

  it("uppercases function-key tokens", () => {
    expect(toAccelerator("mod+f5", "other")).toBe("CommandOrControl+F5");
  });

  it("returns the chord unchanged when it fails to parse", () => {
    expect(toAccelerator("", "mac")).toBe("");
  });
});

describe("isValidChordString", () => {
  it("rejects a trailing plus with an empty key", () => {
    expect(isValidChordString("mod+")).toBe(false);
  });

  it("rejects non-canonical modifier token order", () => {
    // Parses fine (mod=true, shift=true, key='a'), but `formatChord` always
    // reorders to mod+ctrl+shift+alt+key, so this fails the round-trip check.
    expect(isValidChordString("shift+mod+a")).toBe(false);
  });

  it("rejects an unsupported named key", () => {
    expect(isValidChordString("mod+shift+foobar")).toBe(false);
  });

  it("rejects an uppercase single-letter key", () => {
    // Round-trips fine (formatChord doesn't case-convert), but "A" fails the
    // supported-key-vocabulary check (only lowercase a-z/0-9 are supported).
    expect(isValidChordString("mod+shift+A")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidChordString("")).toBe(false);
  });

  it("accepts the default chord and other canonical chords", () => {
    expect(isValidChordString("mod+shift+space")).toBe(true);
    expect(isValidChordString("mod+alt+k")).toBe(true);
    expect(isValidChordString("ctrl+shift+m")).toBe(true);
    expect(isValidChordString("mod+f5")).toBe(true);
    expect(isValidChordString("mod+,")).toBe(true);
  });
});
