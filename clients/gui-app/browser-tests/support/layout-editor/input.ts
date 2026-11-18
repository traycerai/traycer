import type { Page } from "@playwright/test";

import type { Point } from "../fixtures.ts";
import { becomesTruthy, waitForStableBox, waitUntil } from "./waits.ts";
import type { Box, Rect } from "./dom.ts";
import { nextFrames } from "../fixtures.ts";

/**
 * Real input. `page.mouse` and `page.keyboard` dispatch trusted events through
 * Chrome, the same `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` the
 * driver sent by hand.
 */

/**
 * A drag's moves. `armLayoutDrag` only starts a drag once the press has
 * TRAVELLED (`dragStarted`, 6px Manhattan) and the reflow is driven by the
 * moves after that, so a single jump would arm and drop in the same event.
 */
const DRAG_STEPS = 16;

/**
 * Resolves once the PAGE has dispatched a `pointermove` to `to`, not merely
 * been sent one. CDP answers a move once the browser has taken it, while the
 * browser holds each move until the renderer acknowledges the previous one and
 * the renderer dispatches moves aligned to its next frame, so a read straight
 * after the last send could see the page one or more moves behind. Under load
 * that read the side strip at its 192px minimum instead of the rail its
 * crossing had already drawn. Polled once per frame: input is dispatched at
 * the start of a frame, before its animation-frame callbacks, so when a check
 * sees the position every handler for that move has run.
 */
export async function awaitPointerAt(page: Page, to: Point): Promise<void> {
  await waitUntil(
    page,
    `(() => {
      const last = window.__lastPointerMove;
      return Math.abs(last.x - ${String(to.x)}) <= 1 && Math.abs(last.y - ${String(to.y)}) <= 1;
    })()`,
  );
}

/** The pointer to `(x, y)`, hovering. */
export async function moveTo(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
}

/** A real click: move, press, release. */
export async function clickAt(
  page: Page,
  x: number,
  y: number,
  button: "left" | "right",
): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down({ button });
  await page.mouse.up({ button });
}

/** Moves to a point and presses the left button there. */
export async function pressAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
}

/** Moves to `to` in steps with the button down, then waits for the page to have seen the last move. */
export async function moveInSteps(page: Page, to: Point): Promise<void> {
  await page.mouse.move(to.x, to.y, { steps: DRAG_STEPS });
  await awaitPointerAt(page, to);
}

export async function releasePointer(page: Page): Promise<void> {
  await page.mouse.up();
}

/**
 * One real key press, held 60ms as a finger holds it. Radix moves roving
 * focus on a timer and checks a radio only while an arrow is still down, so a
 * zero-length press would test a keyboard no one has.
 */
export async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key, { delay: 60 });
}

/** What the canvas reads off the element in hand, mid-gesture. */
export interface MidDrag {
  readonly dragging: string | null;
  readonly transform: string | null;
  readonly draggingCenter: Point | null;
  readonly siblingRect: { readonly x: number; readonly y: number } | null;
}

const CARRYING = 'document.querySelector("[data-layout-dragging]") !== null';
const NOT_CARRYING =
  'document.querySelector("[data-layout-dragging]") === null';

function midDragProbe(siblingSelector: string | null): string {
  return `(() => {
    const dragging = document.querySelector("[data-layout-dragging]");
    const siblingSelector = ${JSON.stringify(siblingSelector)};
    const sibling = siblingSelector === null ? null : document.querySelector(siblingSelector);
    const rect = sibling === null ? null : sibling.getBoundingClientRect();
    return {
      dragging:
        dragging === null
          ? null
          : (dragging.getAttribute("data-layout-member") ??
             dragging.getAttribute("data-layout-region")),
      transform: dragging === null ? null : dragging.style.transform,
      draggingCenter: (() => {
        if (dragging === null) return null;
        const r = dragging.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })(),
      siblingRect: rect === null ? null : { x: rect.x, y: rect.y },
    };
  })()`;
}

/** A neighbour whose reflow is the proof the member is in hand. */
export interface DragSibling {
  readonly selector: string;
  /** Its box before the gesture. */
  readonly before: Rect;
}

/**
 * A press, sixteen moves, and a release, with the canvas read while the member
 * is still in hand.
 *
 * "In hand" is waited for, not slept for: the read happens once the element
 * carries `[data-layout-dragging]` and the sibling has started to step aside
 * (its spring is the reflow the claim is about), or, with no sibling, once the
 * member's own box has stopped moving (a clamped member lands on its rubber
 * band). The caller then waits for the WRITE, which the spring's settle gates:
 * `waitForDropSettled`, then the store.
 */
export async function dragPointer(
  page: Page,
  from: Box,
  to: Point,
  sibling: DragSibling | null,
): Promise<MidDrag> {
  await page.mouse.move(from.cx, from.cy);
  await page.mouse.down();
  await moveInSteps(page, to);
  if (await becomesTruthy(page, CARRYING, 4_000)) {
    if (sibling === null) {
      await waitForStableBox(page, "[data-layout-dragging]", 3);
    } else {
      await becomesTruthy(
        page,
        `(() => {
          const node = document.querySelector(${JSON.stringify(sibling.selector)});
          if (node === null) return false;
          const rect = node.getBoundingClientRect();
          return Math.abs(rect.x - ${String(sibling.before.x)}) >= 1 || Math.abs(rect.y - ${String(sibling.before.y)}) >= 1;
        })()`,
        4_000,
      );
    }
  }
  const mid = await page.evaluate<MidDrag>(
    midDragProbe(sibling === null ? null : sibling.selector),
  );
  await page.mouse.up();
  return mid;
}

/** Resolves once nothing carries `[data-layout-dragging]` any more (the release spring has landed). */
export async function waitForDropSettled(page: Page): Promise<void> {
  await becomesTruthy(page, NOT_CARRYING, 4_000);
  await nextFrames(page, 2);
}
