import { expect, test, type Page } from "@playwright/test";

/**
 * Boxes, the page-side reads every layout editor check is made of, and the
 * two ways a check reports: a log of violations for a loop that should name
 * every failing member at once, and measurement notes for the report.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A laid-out box with its centre, as `rectOf` reads it off the page. */
export interface Box extends Rect {
  readonly cx: number;
  readonly cy: number;
}

/** `[x, y, WxH]`, one decimal, the way every message in this suite prints a box. */
export function boxText(box: Rect): string {
  return `[${box.x.toFixed(1)}, ${box.y.toFixed(1)}, ${box.width.toFixed(1)}x${box.height.toFixed(1)}]`;
}

export function sameBoxWithin(
  left: Rect,
  right: Rect,
  tolerance: number,
): boolean {
  return (
    Math.abs(left.x - right.x) <= tolerance &&
    Math.abs(left.y - right.y) <= tolerance &&
    Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance
  );
}

export function near(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

const RECT_OF = (selector: string): string => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (node === null) return null;
  const rect = node.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    cx: rect.x + rect.width / 2,
    cy: rect.y + rect.height / 2,
  };
})()`;

/** The first match's box, or `null` when nothing matches. */
export function rectOf(page: Page, selector: string): Promise<Box | null> {
  return page.evaluate<Box | null>(RECT_OF(selector));
}

/** The first match's box; a missing node is a failure that names the selector. */
export async function requireRect(page: Page, selector: string): Promise<Box> {
  const box = await rectOf(page, selector);
  if (box === null) throw new Error(`nothing matches ${selector}`);
  return box;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export function viewportOf(page: Page): Promise<Viewport> {
  return page.evaluate<Viewport>(
    "({ width: window.innerWidth, height: window.innerHeight })",
  );
}

/** Whether a box lies wholly inside the window. */
export function insideViewport(box: Rect, viewport: Viewport): boolean {
  return (
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= viewport.width &&
    box.y + box.height <= viewport.height
  );
}

/**
 * The lines a loop collects so ONE failure names every member that broke,
 * not the first: a sweep over twenty regions is one test, and a fix needs the
 * whole list. Asserted once, at the end, with the title as the message.
 */
export interface ViolationLog {
  readonly add: (line: string) => void;
  /** Adds `line` when `holds` is false. */
  readonly check: (holds: boolean, line: string) => void;
  readonly count: () => number;
  readonly assertNone: (title: string) => void;
}

export function violationLog(): ViolationLog {
  const lines: string[] = [];
  return {
    add: (line) => {
      lines.push(line);
    },
    check: (holds, line) => {
      if (!holds) lines.push(line);
    },
    count: () => lines.length,
    assertNone: (title) => {
      expect(
        lines,
        `${title} (${String(lines.length)}):\n${lines.map((line) => `  - ${line}`).join("\n")}`,
      ).toEqual([]);
    },
  };
}

/**
 * A measurement the report keeps: what the driver printed as a note, kept as
 * an annotation on the running test instead of as console output.
 */
export function note(text: string): void {
  test.info().annotations.push({ type: "measurement", description: text });
}
