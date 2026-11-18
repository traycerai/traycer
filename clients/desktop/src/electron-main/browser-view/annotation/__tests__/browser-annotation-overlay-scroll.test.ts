import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ANNOTATION_OVERLAY_GUEST_SOURCE } from "../browser-annotation-overlay-guest.generated";

function pointer(
  window: JSDOM["window"],
  type: string,
  x: number,
  y: number,
): void {
  window.dispatchEvent(
    new window.MouseEvent(type, {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: x,
      clientY: y,
    }),
  );
}

async function nextPaint(window: JSDOM["window"]): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

describe("annotation overlay scrolling", () => {
  it("keeps element, region, draw, labels, and composer anchored to page content", async () => {
    const dom = new JSDOM(
      "<!doctype html><html><body><div id='target'>target</div></body></html>",
      {
        pretendToBeVisual: true,
        runScripts: "outside-only",
      },
    );
    const { window } = dom;
    const { document } = window;
    let scrollY = 0;
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      get: () => scrollY,
    });
    Object.defineProperty(window, "scrollX", {
      configurable: true,
      get: () => 0,
    });
    Object.defineProperty(window, "innerWidth", { value: 1_200 });
    Object.defineProperty(window, "innerHeight", { value: 900 });
    Object.defineProperty(window, "CSS", {
      configurable: true,
      value: { escape: (value: string) => value },
    });
    const nativeAttachShadow = window.Element.prototype.attachShadow;
    window.Element.prototype.attachShadow = function attachOpenShadow(init) {
      return nativeAttachShadow.call(this, { ...init, mode: "open" });
    };

    const target = document.querySelector("#target");
    if (!(target instanceof window.HTMLElement)) {
      throw new Error("missing target");
    }
    target.getBoundingClientRect = () =>
      window.DOMRect.fromRect({
        x: 20,
        y: 200 - scrollY,
        width: 120,
        height: 40,
      });
    document.elementsFromPoint = (x) => (x < 200 ? [target] : []);

    window.eval(ANNOTATION_OVERLAY_GUEST_SOURCE);
    const host = document.querySelector('[data-traycer-annotation="host"]');
    if (!(host instanceof window.HTMLElement) || host.shadowRoot === null) {
      throw new Error("annotation overlay did not boot");
    }
    const shadow = host.shadowRoot;

    pointer(window, "pointerdown", 40, 220);
    shadow.querySelector<HTMLButtonElement>('[data-mode="region"]')?.click();
    pointer(window, "pointerdown", 300, 200);
    pointer(window, "pointerup", 380, 260);
    shadow.querySelector<HTMLButtonElement>('[data-mode="draw"]')?.click();
    pointer(window, "pointerdown", 500, 200);
    pointer(window, "pointermove", 550, 250);
    pointer(window, "pointerup", 550, 250);

    const elementOutline = shadow.querySelector<HTMLElement>(
      ".outline:not(.region)",
    );
    const regionOutline = shadow.querySelector<HTMLElement>(".outline.region");
    const labels = shadow.querySelectorAll<HTMLElement>(".badge");
    const elementLabel = labels[0];
    const regionLabel = labels[1];
    const draw = shadow.querySelector<SVGPathElement>(".ink .pen");
    const editor = shadow.querySelector<HTMLElement>(".editor");
    if (
      elementOutline === null ||
      regionOutline === null ||
      elementLabel === undefined ||
      regionLabel === undefined ||
      draw === null ||
      editor === null
    ) {
      throw new Error("expected all annotation surfaces");
    }

    const before = {
      element: elementOutline.style.top,
      region: regionOutline.style.top,
      elementLabel: elementLabel.style.top,
      regionLabel: regionLabel.style.top,
      draw: draw.getAttribute("d"),
      editor: editor.style.top,
    };
    const wheel = new window.WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);

    scrollY = 100;
    window.dispatchEvent(new window.Event("scroll"));
    await nextPaint(window);

    expect(elementOutline.style.top).toBe("100px");
    expect(regionOutline.style.top).toBe("100px");
    expect(elementLabel.style.top).not.toBe(before.elementLabel);
    expect(regionLabel.style.top).not.toBe(before.regionLabel);
    expect(draw.getAttribute("d")).not.toBe(before.draw);
    expect(editor.style.top).not.toBe(before.editor);
    expect(before.element).toBe("200px");
    expect(before.region).toBe("200px");

    scrollY = 0;
    window.dispatchEvent(new window.Event("scroll"));
    await nextPaint(window);

    expect(elementOutline.style.top).toBe(before.element);
    expect(regionOutline.style.top).toBe(before.region);
    expect(elementLabel.style.top).toBe(before.elementLabel);
    expect(regionLabel.style.top).toBe(before.regionLabel);
    expect(draw.getAttribute("d")).toBe(before.draw);
    expect(editor.style.top).toBe(before.editor);

    dom.window.close();
  });
});
