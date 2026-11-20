import type { Page } from "@playwright/test";
import { z } from "zod";

const BoxSchema = z.object({
  left: z.number(),
  right: z.number(),
  top: z.number(),
  bottom: z.number(),
  width: z.number(),
});
const EntrySchema = z.object({
  /** One box per frame the surface had a running animation. */
  inFlight: z.array(BoxSchema),
  /** The box once every animation on the surface had finished. */
  settled: BoxSchema,
});
export type SurfaceEntry = z.infer<typeof EntrySchema>;

/**
 * Follows a surface's entry and returns where it came to rest. A frame loop
 * takes the surface's box each frame it has an animation that has not
 * finished (`getAnimations({ subtree: true })` covers a CSS animation and a
 * transition alike), and ends once the surface exists and none is left. With a
 * `trigger` the loop starts at its click and the surface must have animated: a
 * surface that never animates fails by name instead of passing on its resting
 * box. With `trigger: null` the surface is already opening, and a surface that
 * never settles fails by name.
 */
export async function followSurface(
  page: Page,
  options: {
    readonly surface: string;
    readonly trigger: string | null;
  },
): Promise<SurfaceEntry> {
  return EntrySchema.parse(
    await page.evaluate(
      async (selectors: {
        readonly surface: string;
        readonly trigger: string | null;
      }) => {
        const trigger =
          selectors.trigger === null
            ? null
            : document.querySelector(selectors.trigger);
        if (selectors.trigger !== null && !(trigger instanceof HTMLElement)) {
          throw new Error("no trigger");
        }
        interface Box {
          left: number;
          right: number;
          top: number;
          bottom: number;
          width: number;
        }
        const boxOf = (node: Element): Box => {
          const box = node.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            width: box.width,
          };
        };
        return new Promise((resolve, reject) => {
          const inFlight: Box[] = [];
          let seenAnimation = false;
          const deadline = performance.now() + 5_000;
          const tick = (): void => {
            const node = document.querySelector(selectors.surface);
            const unfinished =
              node === null
                ? []
                : node
                    .getAnimations({ subtree: true })
                    .filter(
                      (animation) =>
                        animation.playState === "running" || animation.pending,
                    );
            if (node !== null && unfinished.length > 0) {
              seenAnimation = true;
              inFlight.push(boxOf(node));
            }
            if (
              node !== null &&
              unfinished.length === 0 &&
              (seenAnimation || selectors.trigger === null)
            ) {
              resolve({ inFlight, settled: boxOf(node) });
              return;
            }
            if (performance.now() > deadline) {
              reject(
                new Error(
                  seenAnimation || selectors.trigger === null
                    ? "the surface's animation never finished"
                    : "no animation ran on the surface: nothing to follow",
                ),
              );
              return;
            }
            requestAnimationFrame(tick);
          };
          if (trigger instanceof HTMLElement) trigger.click();
          requestAnimationFrame(tick);
        });
      },
      options,
    ),
  );
}
