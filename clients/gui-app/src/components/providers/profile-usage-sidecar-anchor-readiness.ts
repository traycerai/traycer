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
 * Radix menu/popover content plays a brief zoom+slide entrance animation on
 * open (see `dropdown-menu.tsx` / `popover.tsx`: `data-open:zoom-in-95`,
 * `slide-in-from-*`). `getBoundingClientRect()` on a row inside that content,
 * read synchronously right after mount, captures the transform mid-animation
 * rather than the settled resting position - a bounding box that's still
 * being scaled/translated. Wait for any in-flight, finite-duration animation
 * on the anchor or one of its ancestors to finish before a measurement is
 * trusted. Infinite animations are excluded so a stray unrelated looping
 * animation elsewhere on the page can never block this indefinitely.
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
