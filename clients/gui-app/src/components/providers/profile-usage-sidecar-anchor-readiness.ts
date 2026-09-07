const POPPER_WRAPPER_SELECTOR = "[data-radix-popper-content-wrapper]";
const UNPOSITIONED_POPPER_TRANSFORM =
  /^translate\(\s*0(?:px)?\s*,\s*-200%\s*\)$/i;

function popperWrappersForAnchor(
  anchor: HTMLElement,
): ReadonlyArray<HTMLElement> {
  const wrappers: HTMLElement[] = [];
  let ancestor = anchor.parentElement;
  while (ancestor !== null) {
    if (ancestor.matches(POPPER_WRAPPER_SELECTOR)) wrappers.push(ancestor);
    ancestor = ancestor.parentElement;
  }
  return wrappers;
}

function isPopperWrapperPlaced(wrapper: HTMLElement): boolean {
  const transform = wrapper.style.transform;
  return (
    transform.length > 0 &&
    !UNPOSITIONED_POPPER_TRANSFORM.test(transform.trim())
  );
}

/** Because poppers can be nested, every wrapper in the anchor's ancestor chain must leave the sentinel before
 * the anchor's rect is trustworthy. */
export function waitForAnchorPlacement(
  anchor: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  const wrappers = popperWrappersForAnchor(anchor);
  const unplacedWrappers = wrappers.filter(
    (wrapper) => !isPopperWrapperPlaced(wrapper),
  );
  if (unplacedWrappers.length === 0 || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      observer.disconnect();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const observer = new MutationObserver(() => {
      if (wrappers.every(isPopperWrapperPlaced)) finish();
    });
    unplacedWrappers.forEach((wrapper) =>
      observer.observe(wrapper, {
        attributes: true,
        attributeFilter: ["style"],
      }),
    );
    signal.addEventListener("abort", finish);
  });
}

/** `Document.getAnimations` is typed as always-present in lib.dom.d.ts, but environments that don't implement
 * the Web Animations API (older webviews, jsdom in tests) leave it `undefined` at runtime. */
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

/** Infinite animations are excluded so a stray unrelated looping animation elsewhere on the page can never
 * block this indefinitely. */
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

/** Full anchor-readiness sequence: wait for Radix's Popper to land its first real placement (not the off-screen
 * measuring position), then wait for any entrance animation that placement unblocked to settle. */
export async function waitForAnchorReady(
  anchor: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  await waitForAnchorPlacement(anchor, signal);
  if (signal.aborted) return;
  await waitForAnchorEntranceAnimations(anchor);
}
