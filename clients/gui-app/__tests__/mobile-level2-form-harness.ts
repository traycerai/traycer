import { act } from "@testing-library/react";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";

/**
 * Drives the REAL level-2 form hooks: they measure `#root`'s box and read the
 * screen's orientation, so a test sets those two and lets the resolver answer.
 * `750` answers `{ column: 256 }`, `594` `"menu"`, and portrait `"bar"`. `867` is
 * the narrowest of the rail's two panes with a second tile open: it answers
 * `"menu"` with two tiles, where 750 has room for one.
 */
export const SHELL_WIDTH_COLUMN_256 = 750;
export const SHELL_WIDTH_MENU = 594;
export const SHELL_WIDTH_TWO_TILES = 867;

/** Narrower than the phone-portrait limit, which the hook reads off `matchMedia`. */
const PORTRAIT_INNER_WIDTH = 400;
const LANDSCAPE_INNER_WIDTH = 1000;

export interface ShellFormHarness {
  /** Resizes the shell; `portrait` is the phone held upright. */
  readonly set: (shape: {
    readonly width: number;
    readonly portrait: boolean;
  }) => void;
  readonly dispose: () => void;
}

/** Mounts `#root` at `width` in the installed app, landscape. Call `dispose` in cleanup. */
export function installShellForm(width: number): ShellFormHarness {
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  const originalInnerWidth = window.innerWidth;
  const state = { width, portrait: false };
  root.getBoundingClientRect = () =>
    ({ width: state.width, height: 800 }) as DOMRect;
  Object.defineProperty(window.screen, "orientation", {
    configurable: true,
    value: {
      get type() {
        return state.portrait ? "portrait-primary" : "landscape-primary";
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  window.innerWidth = LANDSCAPE_INNER_WIDTH;
  setPhoneLayoutOnly(true);
  return {
    set: (shape) => {
      state.width = shape.width;
      state.portrait = shape.portrait;
      window.innerWidth = shape.portrait
        ? PORTRAIT_INNER_WIDTH
        : LANDSCAPE_INNER_WIDTH;
      // Both stores re-read on a window resize, which the shell also fires.
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
    },
    dispose: () => {
      root.remove();
      Reflect.deleteProperty(window.screen, "orientation");
      window.innerWidth = originalInnerWidth;
      setPhoneLayoutOnly(false);
    },
  };
}
