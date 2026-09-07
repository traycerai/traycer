// Shared @/lib/keybindings/platform mock. Hoist the control so vi.mock can
// read it: vi.hoisted(() => ({ mac: false })).

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
