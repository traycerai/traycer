import { vi } from "vitest";

/**
 * Tailwind `sm` is `(width < 40rem)`. At a 16px root that bound is 640px,
 * so 640–767 stay on the inline editor. The app-wide phone shell uses `md`.
 */
const REM_PX = 16;
const WIDTH_RANGE = /^\(\s*width\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)(px|rem)\s*\)$/;

let viewportWidth = 639;
let installed = false;
let savedInnerWidth = 0;
let nativeMatchMedia: typeof window.matchMedia = window.matchMedia;

/** Answer width queries from `width`; every other query keeps the test shim. */
export function installPhoneViewport(width: number): void {
  if (!installed) {
    savedInnerWidth = window.innerWidth;
    nativeMatchMedia = window.matchMedia.bind(window);
    vi.stubGlobal("matchMedia", (query: string): MediaQueryList => {
      const list = nativeMatchMedia(query);
      if (matchesWidth(query) === null) return list;
      // Live getter: the hook calls `matchMedia` again on each snapshot, and
      // a resize between those calls has to see the new width.
      return Object.defineProperty(list, "matches", {
        configurable: true,
        get: () => matchesWidth(query) === true,
      });
    });
    installed = true;
  }
  viewportWidth = width;
  window.innerWidth = width;
}

/**
 * The small-viewport hook re-reads `matchMedia` from its window `resize`
 * listener. The shared test shim's media listeners do not fire.
 */
export function resizePhoneViewport(width: number): void {
  installPhoneViewport(width);
  window.dispatchEvent(new Event("resize"));
}

export function restorePhoneViewport(): void {
  if (!installed) return;
  window.innerWidth = savedInnerWidth;
  vi.unstubAllGlobals();
  installed = false;
}

function matchesWidth(query: string): boolean | null {
  const range = WIDTH_RANGE.exec(query);
  if (range === null) return null;
  const bound = Number(range[2]) * (range[3] === "rem" ? REM_PX : 1);
  if (range[1] === "<") return viewportWidth < bound;
  if (range[1] === "<=") return viewportWidth <= bound;
  if (range[1] === ">") return viewportWidth > bound;
  return viewportWidth >= bound;
}
