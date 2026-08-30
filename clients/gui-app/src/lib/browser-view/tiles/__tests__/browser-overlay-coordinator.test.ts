import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { collectBrowserOverlaySurfaces } from "@/lib/browser-view/tiles/browser-overlay-coordinator";

afterEach(() => {
  document.body.replaceChildren();
});

function appendFadingOverlay(): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-browser-overlay", "dialog");
  element.setAttribute("data-browser-overlay-id", "dialog-1");
  element.style.opacity = "0";
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  document.body.append(element);
  return element;
}

describe("collectBrowserOverlaySurfaces opacity-0 handling", () => {
  it("skips an opacity-0 element with no running animation (steady-state hidden)", () => {
    const element = appendFadingOverlay();
    Object.defineProperty(element, "getAnimations", {
      configurable: true,
      value: () => [],
    });

    expect(collectBrowserOverlaySurfaces(document.body)).toEqual([]);
  });

  it("still detects an opacity-0 element mid fade-in (a running Animation)", () => {
    const element = appendFadingOverlay();
    Object.defineProperty(element, "getAnimations", {
      configurable: true,
      value: () => [{} as Animation],
    });

    const surfaces = collectBrowserOverlaySurfaces(document.body);
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.id).toBe("dialog-1");
  });

  it("does not throw when getAnimations is entirely unavailable (jsdom-safe guard)", () => {
    const element = appendFadingOverlay();
    expect("getAnimations" in element).toBe(false);

    expect(() => collectBrowserOverlaySurfaces(document.body)).not.toThrow();
    expect(collectBrowserOverlaySurfaces(document.body)).toEqual([]);
  });

  it("detects a fully opaque overlay as before (no regression)", () => {
    const element = appendFadingOverlay();
    element.style.opacity = "1";
    Object.defineProperty(element, "getAnimations", {
      configurable: true,
      value: () => [],
    });

    const surfaces = collectBrowserOverlaySurfaces(document.body);
    expect(surfaces).toHaveLength(1);
  });
});
