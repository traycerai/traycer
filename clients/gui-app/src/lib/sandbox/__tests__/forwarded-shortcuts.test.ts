import { describe, expect, it } from "vitest";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import {
  isForwardedShortcut,
  sandboxForwardedShortcuts,
} from "@/lib/sandbox/forwarded-shortcuts";
import type { ForwardedShortcut } from "@/lib/sandbox/forwarded-shortcuts";

const press = (code: string, mac: boolean): ForwardedShortcut => ({
  code,
  ctrl: !mac,
  meta: mac,
  alt: false,
  shift: false,
});

describe("sandboxForwardedShortcuts", () => {
  it.each([true, false])(
    "forwards Close tab so a focused page's mod+w closes its tile, not the task tab (mac=%s)",
    (mac) => {
      const forwarded = sandboxForwardedShortcuts(getDefaultBindings(), mac);
      expect(isForwardedShortcut(forwarded, press("KeyW", mac))).toBe(true);
      // The other browser-scoped rows stay the page's.
      expect(isForwardedShortcut(forwarded, press("KeyT", mac))).toBe(false);
      expect(isForwardedShortcut(forwarded, press("KeyL", mac))).toBe(false);
    },
  );

  it("follows the reader's live Close tab binding", () => {
    const bindings = { ...getDefaultBindings(), "tab.close": "mod+shift+x" };
    const forwarded = sandboxForwardedShortcuts(bindings, true);
    expect(isForwardedShortcut(forwarded, press("KeyW", true))).toBe(false);
    expect(
      isForwardedShortcut(forwarded, { ...press("KeyX", true), shift: true }),
    ).toBe(true);
  });
});
