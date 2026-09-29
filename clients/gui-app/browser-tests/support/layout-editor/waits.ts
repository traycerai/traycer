import type { Page } from "@playwright/test";

import { nextFrames } from "../fixtures.ts";

/**
 * Condition waits. The driver spent about 230 seconds in fixed `settle(ms)`
 * sleeps; every one of those is one of these instead: a wait for the thing the
 * sleep was guessing at.
 */

/**
 * How long a condition wait may take before it is the finding. The same bound
 * as the config's `expect.timeout`: a wait without one runs to the test's own
 * 180 seconds, and a claim that fails by hanging reports nothing.
 */
export const CONDITION_TIMEOUT_MS = 10_000;

/**
 * Waits, once per animation frame, for a page-side expression to be truthy, and
 * fails naming the expression when it never is.
 */
export async function waitUntil(page: Page, expression: string): Promise<void> {
  try {
    await page.waitForFunction(expression, undefined, {
      polling: "raf",
      timeout: CONDITION_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(
      `timed out after ${String(CONDITION_TIMEOUT_MS)}ms waiting for: ${expression.replace(/\s+/g, " ").slice(0, 200)}`,
      { cause: error },
    );
  }
}

/**
 * Resolves once every finite CSS transition and animation has finished and a
 * frame has been presented since. An endless one (a spinner, the waiting
 * pulse) is not something that "settles", so it does not hold this up.
 * Motion's springs run on `requestAnimationFrame`, not the Web Animations
 * API: for those, `waitForStableBox` on the moving element is the wait.
 */
export async function waitForFiniteAnimations(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.playState !== "running" ||
            animation.effect === null ||
            animation.effect.getComputedTiming().iterations === Infinity,
        ),
    undefined,
    { polling: "raf", timeout: CONDITION_TIMEOUT_MS },
  );
  await nextFrames(page, 2);
}

/** About five seconds of frames: a spring that has not landed by then is not going to. */
const STABLE_BOX_FRAME_LIMIT = 300;

/**
 * Resolves once the first match's box of EVERY selector has not moved for
 * `frames` consecutive frames: a spring that has landed, a layout that has
 * stopped reflowing. A selector matching nothing counts as "absent" and is
 * part of the reading, so this also waits out an element that is about to
 * mount or unmount.
 */
export async function waitForStableBoxes(
  page: Page,
  selectors: readonly string[],
  frames: number,
): Promise<void> {
  const settled = await page.evaluate(
    ({
      queries,
      needed,
      limit,
    }: {
      queries: readonly string[];
      needed: number;
      limit: number;
    }) =>
      new Promise<boolean>((resolve) => {
        let last = "";
        let same = 0;
        let frame = 0;
        const step = (): void => {
          const key = JSON.stringify(
            queries.map((query) => {
              const node = document.querySelector(query);
              return node === null
                ? "absent"
                : JSON.stringify(node.getBoundingClientRect());
            }),
          );
          if (key === last) same += 1;
          else {
            same = 0;
            last = key;
          }
          frame += 1;
          if (same >= needed) resolve(true);
          else if (frame >= limit) resolve(false);
          else requestAnimationFrame(step);
        };
        step();
      }),
    { queries: selectors, needed: frames, limit: STABLE_BOX_FRAME_LIMIT },
  );
  if (!settled) {
    throw new Error(
      `${selectors.join(", ")} kept moving for ${String(STABLE_BOX_FRAME_LIMIT)} frames, so its box never settled`,
    );
  }
}

/** {@link waitForStableBoxes} for one selector. */
export function waitForStableBox(
  page: Page,
  selector: string,
  frames: number,
): Promise<void> {
  return waitForStableBoxes(page, [selector], frames);
}

/**
 * Whether `expression` became truthy within `timeoutMs`. For the gesture whose
 * failure IS "the thing never appeared": the wait for the positive event has
 * to end somewhere, and its absence is the finding.
 */
export async function becomesTruthy(
  page: Page,
  expression: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await page.waitForFunction(expression, undefined, {
      timeout: timeoutMs,
      polling: "raf",
    });
    return true;
  } catch {
    return false;
  }
}
