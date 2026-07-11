// Shared factory for the `@/lib/keybindings/platform` mock used by the
// keybinding tests. Centralizing it means a new platform export only needs to
// be added here, not kept in sync across every test file that mocks the module.
//
// Usage (the control must come from `vi.hoisted` so the hoisted `vi.mock`
// factory can read it):
//
//   const platformMock = vi.hoisted(() => ({ mac: false }));
//   vi.mock("@/lib/keybindings/platform", () => createPlatformMock(platformMock));
//
// Flip `platformMock.mac` per-test to switch platform.

export interface PlatformMockControl {
  mac: boolean;
}

export function createPlatformMock(control: PlatformMockControl) {
  return {
    isMac: () => control.mac,
    modLabel: () => (control.mac ? "⌘" : "Ctrl"),
    ctrlLabel: () => (control.mac ? "⌃" : "Ctrl"),
    altLabel: () => (control.mac ? "⌥" : "Alt"),
    shiftLabel: () => (control.mac ? "⇧" : "Shift"),
    leaderGlyph: (modifier: "mod" | "alt") => {
      if (modifier === "alt") return "⌥";
      return control.mac ? "⌘" : "⌃";
    },
  };
}
