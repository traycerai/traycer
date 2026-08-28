import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOOT_SURFACE_ID,
  RetireBootSurface,
} from "@traycer-clients/webapp/boot-surface";

/**
 * The boot surface is markup plus a timing rule, and only one of those can be
 * read off the files. The static checks below pin the agreement between the
 * HTML that declares the surface and the module that names it; the behavioural
 * ones pin WHEN it goes away, which is the part that was wrong before and
 * which no amount of reading either file can show - removing it beside the
 * render call and removing it on commit look identical in the source.
 */
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const WEBAPP_ROOT = join(__dirname, "..");

const indexHtml = readFileSync(join(WEBAPP_ROOT, "index.html"), "utf8");
const mainTsx = readFileSync(join(WEBAPP_ROOT, "src", "main.tsx"), "utf8");

describe("boot surface markup", () => {
  it("is served in the HTML itself, before the app container", () => {
    const surface = indexHtml.indexOf(`id="${BOOT_SURFACE_ID}"`);
    const root = indexHtml.indexOf('id="root"');

    // Before, and OUTSIDE, the container React takes over: it has to be
    // painted from the first byte of HTML, with no bundle and no stylesheet.
    expect(surface).toBeGreaterThan(-1);
    expect(root).toBeGreaterThan(-1);
    expect(surface).toBeLessThan(root);
    expect(indexHtml).toContain("<style>");
  });

  it("says who is asking and what is happening", () => {
    expect(indexHtml).toContain("Traycer");
    expect(indexHtml).toContain("Signing you in");
  });

  it("holds still for a visitor who asked for no motion", () => {
    expect(indexHtml).toContain("prefers-reduced-motion");
  });

  it("is retired from inside the rendered tree", () => {
    // The removal belongs to the commit, so it belongs to a component. A call
    // beside `createRoot(...).render(...)` would run a whole scheduler tick
    // early, which is exactly the gap the surface exists to cover.
    expect(mainTsx).toContain("<RetireBootSurface />");
    expect(mainTsx).not.toMatch(/getElementById\(\s*"boot-surface"\s*\)/);
  });
});

describe("boot surface retirement", () => {
  let root: Root | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<div id="${BOOT_SURFACE_ID}">Signing you in…</div><div id="root"></div>`;
  });

  afterEach(() => {
    const current = root;
    root = null;
    if (current !== null) {
      act(() => {
        current.unmount();
      });
    }
    document.body.innerHTML = "";
  });

  function appContainer(): HTMLElement {
    const container = document.getElementById("root");
    if (container === null) {
      throw new Error("the fixture lost its root container");
    }
    return container;
  }

  it("survives the render call and goes at the commit", () => {
    const container = appContainer();
    root = createRoot(container);

    act(() => {
      root?.render(
        <>
          <RetireBootSurface />
          <main>the app</main>
        </>,
      );
      // INSIDE the act scope, after `render` was called and before React has
      // committed: this is the interval a removal beside the render call runs
      // in, and the visitor would be looking at neither surface for the whole
      // of it.
      expect(document.getElementById(BOOT_SURFACE_ID)).not.toBeNull();
      expect(container.innerHTML).toBe("");
    });

    expect(document.getElementById(BOOT_SURFACE_ID)).toBeNull();
    expect(container.textContent).toBe("the app");
  });

  it("hands over with no frame in between", () => {
    const container = appContainer();
    root = createRoot(container);
    const observed: string[] = [];

    act(() => {
      root?.render(
        <>
          <RetireBootSurface />
          <main>the app</main>
          <Probe
            onLayout={() => {
              observed.push(describeScreen(container));
            }}
          />
        </>,
      );
    });

    // Read from a LAYOUT effect of the same commit, which is the closest a
    // test gets to standing where the browser paints: layout effects run
    // before the frame, passive ones after it. So this pins both edges at
    // once - the app's DOM is already written when the surface goes (no gap),
    // and the surface is gone before the frame the app first appears in (no
    // splash covering a mounted app, which is what deferring this to a passive
    // effect would produce).
    expect(observed).toEqual(["app+none"]);
    expect(describeScreen(container)).toBe("app+none");
  });

  it("the shape that reopens the gap: removing beside the render call", () => {
    const container = appContainer();
    root = createRoot(container);
    const observed: string[] = [];

    // The discriminating control, and the defect this component was extracted
    // to remove: `render` only SCHEDULES, so a removal on the next line runs
    // while the root is still empty. Nothing errors and both things still
    // happen - which is why only a timing probe catches it.
    act(() => {
      root?.render(<main>the app</main>);
      document.getElementById(BOOT_SURFACE_ID)?.remove();
      observed.push(describeScreen(container));
    });

    expect(observed).toEqual(["empty+none"]);
  });

  it("leaves the surface up when the tree never commits", () => {
    const container = appContainer();
    root = createRoot(container);

    expect(() => {
      act(() => {
        root?.render(
          <>
            <RetireBootSurface />
            <Exploding />
          </>,
        );
      });
    }).toThrow(/first render/);

    // Nothing was committed, so nothing took the screen - and the visitor is
    // left looking at a legible surface rather than a blank document.
    expect(document.getElementById(BOOT_SURFACE_ID)).not.toBeNull();
    expect(container.innerHTML).toBe("");
  });
});

/**
 * What is on screen, as BOTH layers rather than whichever one wins.
 *
 * Collapsing them to "something is visible" is what makes a timing test stop
 * discriminating: the two failures this guards against differ only in which
 * layer is present when - a gap where neither is (`empty+none`), and a frame
 * where the surface still covers a mounted app (`app+surface`).
 */
function describeScreen(container: HTMLElement): string {
  const app = container.innerHTML.length > 0 ? "app" : "empty";
  const surface =
    document.getElementById(BOOT_SURFACE_ID) === null ? "none" : "surface";
  return `${app}+${surface}`;
}

/**
 * Ordered AFTER `RetireBootSurface` by tree position, so its layout effect
 * observes the screen as the retirement leaves it rather than before.
 */
function Probe({ onLayout }: { onLayout: () => void }): null {
  useLayoutEffect(onLayout, [onLayout]);
  return null;
}

function Exploding(): null {
  throw new Error("this component fails on its first render");
}
