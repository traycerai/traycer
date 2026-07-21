import { describe, expect, it } from "vitest";
import { toAccelerator } from "../chord-core";

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
