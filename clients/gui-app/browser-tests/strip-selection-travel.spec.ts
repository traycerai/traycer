import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// Switching between two tabs of a coloured group in the top strip, in real
// Chrome, every frame. The selection slides from the tab you left to the tab
// you chose: the destination hides its own box and one traveller box stands
// in for it, carrying the sheet join (`strip-selection-travel.ts`). Only a
// layout engine paints that slide, and only a frame-by-frame read sees what
// one frame of it draws.
//
// Wide enough that the group's tabs and its chip sit unscrolled: a slide only
// runs between tabs wholly in view.
test.use({ viewport: { width: 1700, height: 860 } });

const PINK = "rgb(255, 139, 203)";

interface Frame {
  readonly selected: boolean;
  /** The outlines drawn for the selection: the traveller and any tab box. */
  readonly outlines: ReadonlyArray<string>;
  readonly bridge: string | null;
  readonly destinationJoined: boolean;
  readonly travelling: boolean;
  /** The group's x at its line's row that neither a line nor the join covers. */
  readonly gaps: ReadonlyArray<number>;
  /** Lines off the join's row, by their bottom. */
  readonly offRow: ReadonlyArray<number>;
}

async function openGroup(page: Page): Promise<void> {
  await page.goto(
    `${fixture("layout-editor-canvas")}?tabs=top&header=app&surface=epic`,
  );
  await page.waitForFunction("window.__layoutCanvasProbe?.ready === true");
  await page.evaluate(`(async () => {
    const { useTabsStore } = await import("/src/stores/tabs/store.ts");
    const store = useTabsStore.getState();
    const ref = (id) => ({ kind: "epic", id: "fixture-" + id });
    const groupId = store.createGroup(ref("epsilon"));
    if (groupId === null) throw new Error("tab group was not created");
    store.setTabGroup(ref("zeta"), groupId);
    store.updateGroup(groupId, { name: "test", color: "#ff8bcb", collapsed: false });
    window.__layoutCanvasProbe.activateEpicTab("fixture-zeta");
  })()`);
  await page.waitForSelector(
    '[data-sheet-join-bridge="top"][data-join-active]',
  );
  await nextFrames(page, 30);
}

/** Switches to Epsilon and reads every frame until the selection has landed. */
async function switchAndSample(page: Page): Promise<Frame[]> {
  return page.evaluate(
    () =>
      new Promise<Frame[]>((resolve, reject) => {
        const frames: Frame[] = [];
        const strip = document.querySelector(
          '[data-testid="header-tab-strip-scroll"]',
        );
        if (strip === null) throw new Error("no top strip");
        const itemOf = (id: string): Element => {
          const item = document
            .querySelector(`[data-testid="tab-epic-fixture-${id}"]`)
            ?.closest("[data-strip-item-id]");
          if (item === null || item === undefined) {
            throw new Error(`no ${id} tab`);
          }
          return item;
        };
        const traveller = (): HTMLElement | null => {
          const node = strip.querySelector<HTMLElement>(
            '[data-testid="tab-selection-traveller"]',
          );
          return node === null || node.hidden ? null : node;
        };
        const outlines = (): string[] => {
          const drawn = [
            ...strip.querySelectorAll('[data-testid="tab-chrome-box"]'),
          ]
            .map((box) => getComputedStyle(box))
            .filter(
              (style) => style.visibility !== "hidden" && style.opacity !== "0",
            )
            .map((style) => style.borderTopColor);
          const stand = traveller();
          return stand === null
            ? drawn
            : [getComputedStyle(stand).borderTopColor, ...drawn];
        };
        const bridgeNode = (): Element | null =>
          document.querySelector(
            '[data-sheet-join-bridge="top"][data-join-active]',
          );
        // The group runs from Epsilon's left edge to Zeta's right edge; its
        // line is drawn per tab, and the join opens it under the selection as
        // far as its feet reach.
        const lineRead = (): Pick<Frame, "gaps" | "offRow"> => {
          const bridge = bridgeNode();
          const span = bridge?.getBoundingClientRect() ?? null;
          const radius =
            bridge === null
              ? 0
              : parseFloat(getComputedStyle(bridge, "::after").width);
          const lines = [
            ...strip.querySelectorAll('[data-testid="tab-color-edge-line"]'),
          ].map((line) => line.getBoundingClientRect());
          const covers = (x: number): boolean =>
            lines.some((line) => line.left <= x && x <= line.right) ||
            (span !== null &&
              span.left - radius <= x &&
              x <= span.right + radius);
          const left = itemOf("epsilon").getBoundingClientRect().left;
          const right = itemOf("zeta").getBoundingClientRect().right;
          const gaps: number[] = [];
          for (let x = Math.ceil(left) + 1; x < right - 1; x += 1) {
            if (!covers(x)) gaps.push(x);
          }
          const offRow =
            span === null
              ? []
              : lines
                  .filter((line) => Math.abs(line.bottom - span.bottom) > 0.05)
                  .map((line) => line.bottom);
          return { gaps, offRow };
        };
        const read = (): Frame => {
          const destination = itemOf("epsilon");
          const bridge = bridgeNode();
          return {
            selected:
              destination
                .querySelector('[role="tab"]')
                ?.getAttribute("aria-selected") === "true",
            outlines: outlines(),
            bridge:
              bridge === null ? null : getComputedStyle(bridge).borderLeftColor,
            destinationJoined:
              destination.querySelector("[data-sheet-joined]") !== null,
            travelling: traveller() !== null,
            ...lineRead(),
          };
        };
        const probe: unknown = Reflect.get(window, "__layoutCanvasProbe");
        const activate: unknown =
          typeof probe === "object" && probe !== null
            ? Reflect.get(probe, "activateEpicTab")
            : undefined;
        if (typeof activate !== "function") {
          throw new Error("the canvas probe has no activateEpicTab");
        }
        Reflect.apply(activate, probe, ["fixture-epsilon"]);
        let travelled = false;
        const started = performance.now();
        const tick = (): void => {
          const frame = read();
          frames.push(frame);
          travelled ||= frame.travelling;
          if (travelled && !frame.travelling) {
            resolve(frames);
            return;
          }
          if (performance.now() - started > 3000) {
            reject(new Error("the selection never landed"));
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

test("switching inside a pink group, the selection is one pink outline on every frame and lands joined on the tab chosen", async ({
  page,
}) => {
  await openGroup(page);
  const frames = await switchAndSample(page);

  // It slid: a switch that jumped would prove nothing about the slide.
  expect(frames.filter((frame) => frame.travelling).length).toBeGreaterThan(3);
  frames.forEach((frame, index) => {
    expect(frame.selected, `frame ${index}: Epsilon selected`).toBe(true);
    expect(frame.outlines, `frame ${index}: one pink outline`).toEqual([PINK]);
    expect(frame.bridge, `frame ${index}: the bridge`).toBe(PINK);
  });
  const last = frames.at(-1);
  expect(last?.travelling).toBe(false);
  expect(last?.destinationJoined, "landed joined on Epsilon").toBe(true);
});

test("switching inside a coloured group, its line runs unbroken under both tabs on every frame, on the join's row", async ({
  page,
}) => {
  await openGroup(page);
  const frames = await switchAndSample(page);

  expect(frames.filter((frame) => frame.travelling).length).toBeGreaterThan(3);
  frames.forEach((frame, index) => {
    expect(frame.gaps, `frame ${index}: x the group's line misses`).toEqual([]);
    expect(frame.offRow, `frame ${index}: lines off the feet's row`).toEqual(
      [],
    );
  });
});
