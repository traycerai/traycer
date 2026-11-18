/**
 * End to end: a raw `KeyboardEvent` for a non-canonically DECLARED default
 * (`tab.split.add`'s `ctrl+alt+n`, `composer.model-picker.toggle`'s
 * `alt+shift+m`) still resolves through `resolveMatchingChord` to the
 * canonical chord the store's (also canonicalized) bindings hold, and
 * `findActionForChord` finds the action from there. `app.tabs.vertical.collapse`
 * is included for the same reason, on both platforms.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformMock } from "@/__tests__/create-platform-mock";

const platformMock = vi.hoisted(() => ({ mac: false }));
vi.mock("@/lib/keybindings/platform", () => createPlatformMock(platformMock));

import { getDefaultBindings } from "@/lib/keybindings/actions";
import { resolveMatchingChord } from "@/lib/keybindings/chord";
import { findActionForChord } from "@/lib/keybindings/dispatch";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";

function keydown(
  init: Partial<KeyboardEventInit> & { code: string },
): KeyboardEvent {
  return new KeyboardEvent("keydown", { ...init, code: init.code });
}

beforeEach(() => {
  platformMock.mac = false;
  useKeybindingStore.setState({ bindings: getDefaultBindings() });
});

describe("resolveMatchingChord -> findActionForChord, off macOS", () => {
  it.each<{
    readonly label: string;
    readonly init: Partial<KeyboardEventInit> & { code: string };
    readonly chord: string;
    readonly action: string;
  }>([
    {
      label: "Ctrl+Alt+N",
      init: { code: "KeyN", ctrlKey: true, altKey: true },
      chord: "mod+alt+n",
      action: "tab.split.add",
    },
    {
      label: "Shift+Alt+M",
      init: { code: "KeyM", shiftKey: true, altKey: true },
      chord: "shift+alt+m",
      action: "composer.model-picker.toggle",
    },
    {
      label: "Shift+Alt+S",
      init: { code: "KeyS", shiftKey: true, altKey: true },
      chord: "shift+alt+s",
      action: "app.tabs.vertical.collapse",
    },
  ])("resolves $label to $action", ({ init, chord, action }) => {
    const resolved = resolveMatchingChord(keydown(init));
    expect(resolved).toBe(chord);
    expect(findActionForChord(resolved ?? "")).toBe(action);
  });
});

describe("resolveMatchingChord -> findActionForChord, on macOS", () => {
  beforeEach(() => {
    platformMock.mac = true;
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
  });

  it("resolves Ctrl+Cmd+S to app.tabs.vertical.collapse", () => {
    const chord = resolveMatchingChord(
      keydown({ code: "KeyS", ctrlKey: true, metaKey: true }),
    );
    expect(chord).toBe("mod+ctrl+s");
    expect(findActionForChord(chord ?? "")).toBe("app.tabs.vertical.collapse");
  });
});
