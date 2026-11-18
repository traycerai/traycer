import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformMock } from "@/__tests__/create-platform-mock";

const platformMock = vi.hoisted(() => ({ mac: false }));

vi.mock("@/lib/keybindings/platform", () => createPlatformMock(platformMock));

import {
  listNavigationKey,
  type ListNavigationKeyEvent,
} from "../list-navigation-key";

function keyEvent(
  key: string,
  modifiers: Omit<ListNavigationKeyEvent, "key">,
): ListNavigationKeyEvent {
  return { key, ...modifiers };
}

const NO_MODIFIERS = {
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
};
const CTRL_ONLY = { ...NO_MODIFIERS, ctrlKey: true };

describe("listNavigationKey", () => {
  beforeEach(() => {
    platformMock.mac = false;
  });

  describe("on macOS", () => {
    beforeEach(() => {
      platformMock.mac = true;
    });

    it.each([
      ["n", "ArrowDown"],
      ["j", "ArrowDown"],
      ["p", "ArrowUp"],
      ["k", "ArrowUp"],
      // Caps lock reports the uppercase letter with no Shift modifier.
      ["N", "ArrowDown"],
      ["J", "ArrowDown"],
      ["P", "ArrowUp"],
      ["K", "ArrowUp"],
    ])("reads Ctrl+%s as %s", (key, expected) => {
      expect(listNavigationKey(keyEvent(key, CTRL_ONLY))).toBe(expected);
    });

    it.each([
      ["Ctrl+Shift+N", { ...CTRL_ONLY, shiftKey: true }],
      ["Ctrl+Alt+N", { ...CTRL_ONLY, altKey: true }],
      ["Ctrl+Cmd+N", { ...CTRL_ONLY, metaKey: true }],
      ["plain N without Ctrl", NO_MODIFIERS],
    ])("leaves %s unchanged", (_description, modifiers) => {
      expect(listNavigationKey(keyEvent("n", modifiers))).toBe("n");
    });

    it.each([
      ["ArrowDown", NO_MODIFIERS],
      ["ArrowDown", CTRL_ONLY],
      ["a", CTRL_ONLY],
      ["Enter", NO_MODIFIERS],
    ])("passes %s through unchanged", (key, modifiers) => {
      expect(listNavigationKey(keyEvent(key, modifiers))).toBe(key);
    });
  });

  describe("on Windows and Linux", () => {
    it.each(["n", "j", "p", "k"])("leaves Ctrl+%s unchanged", (key) => {
      expect(listNavigationKey(keyEvent(key, CTRL_ONLY))).toBe(key);
    });
  });
});
