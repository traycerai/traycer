const POPPER_WRAPPER_SELECTOR = "[data-radix-popper-content-wrapper]";

function isRectOnscreen(rect: DOMRect): boolean {
  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

/**
 * Radix's Popper (the machinery behind DropdownMenuContent, PopoverContent,
 * etc. - see `@radix-ui/react-popper`'s `PopperContent`) renders its
 * `[data-radix-popper-content-wrapper]` at `transform: translate(0, -200%)`
 * - pushed off-screen "for measuring" - until Floating UI's first placement
 * pass completes, then snaps it to the real computed position. Content's
 * entrance animation is *also* explicitly suppressed (`animation: "none"`)
 * during this phase, so it doesn't race the pre-placement layout. Reading
 * the anchor's rect before that first placement lands captures the
 * off-screen sentinel position (hundreds of pixels off), not the real one -
 * and because the animation is suppressed, `document.getAnimations()` can
 * be genuinely empty at that moment, so waiting on animations alone cannot
 * catch this phase.
 *
 * Waits for the anchor's own bounding rect to intersect the viewport,
 * observing the closest Radix popper wrapper's `style` attribute (the
 * attribute Floating UI mutates when it lands a placement) for the
 * transition. Resolves immediately when the anchor isn't inside a Radix
 * popper wrapper (a static anchor), or is already on-screen (an
 * already-placed, already-open menu - e.g. re-anchoring on hover to a
 * different row - needs no wait at all).
 *
 * There is deliberately no fallback timeout. If placement never lands (the
 * anchor is detached, or Radix never resolves it), the correct behavior is
 * to stay hidden indefinitely, not to eventually paint at a coordinate
 * clamped from an invalid off-screen rect - that would just be this bug
 * again, delayed. `signal` is the only way out: aborting (component
 * unmount / anchor change) resolves the wait and disconnects the observer
 * without ever calling `update()`.
 */
export function waitForAnchorPlacement(
  anchor: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  const wrapper = anchor.closest(POPPER_WRAPPER_SELECTOR);
  if (
    wrapper === null ||
    isRectOnscreen(anchor.getBoundingClientRect()) ||
    signal.aborted
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      observer.disconnect();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const observer = new MutationObserver(() => {
      if (isRectOnscreen(anchor.getBoundingClientRect())) finish();
    });
    observer.observe(wrapper, {
      attributes: true,
      attributeFilter: ["style"],
    });
    signal.addEventListener("abort", finish);
  });
}

/** `Document.getAnimations` is typed as always-present in lib.dom.d.ts, but
 *  environments that don't implement the Web Animations API (older
 *  webviews, jsdom in tests) leave it `undefined` at runtime. This shape
 *  reflects that real-world optionality so the runtime check below is
 *  meaningful to the type checker instead of flagged as dead code. */
interface DocumentMaybeWithAnimations {
  readonly getAnimations: (() => ReadonlyArray<Animation>) | undefined;
}

function documentAnimations(): ReadonlyArray<Animation> {
  const doc: DocumentMaybeWithAnimations = document;
  return doc.getAnimations?.() ?? [];
}

function animationTarget(animation: Animation): Node | null {
  const effect = animation.effect;
  if (effect === null) return null;
  return "target" in effect ? (effect as KeyframeEffect).target : null;
}

function hasFiniteDuration(animation: Animation): boolean {
  const iterations = animation.effect?.getTiming().iterations;
  return iterations === undefined || Number.isFinite(iterations);
}

/**
 * Once placed (see `waitForAnchorPlacement`), Radix menu/popover content
 * plays a brief zoom+slide entrance animation (see `dropdown-menu.tsx` /
 * `popover.tsx`: `data-open:zoom-in-95`, `slide-in-from-*`). Wait for any
 * in-flight, finite-duration animation on the anchor or one of its
 * ancestors to finish before a measurement is trusted, so the sidecar
 * doesn't show mid zoom/slide either. Infinite animations are excluded so a
 * stray unrelated looping animation elsewhere on the page can never block
 * this indefinitely.
 */
export async function waitForAnchorEntranceAnimations(
  anchor: HTMLElement,
): Promise<void> {
  const relevant = documentAnimations().filter((animation) => {
    const target = animationTarget(animation);
    return (
      target !== null && target.contains(anchor) && hasFiniteDuration(animation)
    );
  });
  if (relevant.length === 0) return;
  await Promise.all(
    relevant.map((animation) => animation.finished.catch(() => undefined)),
  );
}

/**
 * Full anchor-readiness sequence: wait for Radix's Popper to land its first
 * real placement (not the off-screen measuring position), then wait for any
 * entrance animation that placement unblocked to settle. Order matters -
 * the entrance animation doesn't even start until placement lands (Radix
 * suppresses it via `animation: "none"` until then), so checking animations
 * first would miss the placement phase entirely.
 */
export async function waitForAnchorReady(
  anchor: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  await waitForAnchorPlacement(anchor, signal);
  if (signal.aborted) return;
  await waitForAnchorEntranceAnimations(anchor);
}
