import type { Page } from "@playwright/test";

// What the side strip's section-move specs read off the page: the animations a
// row's move started, frozen so a geometry read lands on an animation's first
// frame.

/** An animation a row's move started: on its frame (the slide) or on its row (the glow). */
export interface StartedAnimation {
  readonly on: "frame" | "row";
  readonly properties: ReadonlyArray<string>;
}

/**
 * Holds the page's animations on their first frame, so geometry can be read
 * there however long the test takes to ask. A slowed rate is not enough: an
 * ease-out slide covers its first few pixels in the first percent of its
 * time, which a loaded CI runner spends before the read lands.
 * `finishAnimations` still plays them out.
 */
export async function freezeAnimations(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Animation.enable");
  await session.send("Animation.setPlaybackRate", { playbackRate: 0 });
}

export const startedAnimations = (
  page: Page,
): Promise<Array<StartedAnimation>> =>
  page.evaluate(() =>
    document.getAnimations().flatMap((animation): Array<StartedAnimation> => {
      const { effect } = animation;
      // Only what a script started: the stylesheet's own transitions are not
      // the move's.
      if (
        animation instanceof CSSTransition ||
        animation instanceof CSSAnimation ||
        !(effect instanceof KeyframeEffect)
      ) {
        return [];
      }
      const { target } = effect;
      let on: StartedAnimation["on"] | null = null;
      if (target?.hasAttribute("data-strip-item-id")) on = "frame";
      else if (target?.hasAttribute("data-side-tab")) on = "row";
      if (on === null) return [];
      return [
        {
          on,
          // The styles animated, not each keyframe's own timing fields.
          properties: Array.from(
            new Set(
              effect
                .getKeyframes()
                .flatMap((frame) => Object.keys(frame))
                .filter(
                  (name) =>
                    ![
                      "offset",
                      "computedOffset",
                      "easing",
                      "composite",
                    ].includes(name),
                ),
            ),
          ),
        },
      ];
    }),
  );

/** Plays out every animation that ends; a rail tile's breathing pip never does. */
export const finishAnimations = (page: Page): Promise<void> =>
  page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getComputedTiming().endTime !== Infinity) {
        animation.finish();
      }
    }
  });
