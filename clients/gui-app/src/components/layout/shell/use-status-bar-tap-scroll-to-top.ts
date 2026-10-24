import { useEffect } from "react";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { requestScrollToTop } from "@/lib/dom/scroll-to-top-request";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Binds the shell's status-bar tap (`IRunnerHost.statusBarTap`, iOS only) to
 * what iOS users expect from it: the scroll area in front of them goes back to
 * its top.
 *
 * Nothing registers for this. "In front" is the topmost open dialog or sheet,
 * else the screen itself, and the scroll area is found under that layer the
 * way a finger would find it. Every list, document and sheet is covered
 * without knowing about this hook. The chat transcript answers the request
 * itself, since it keeps its own position while following a reply.
 *
 * Gated on the capability alone, like `useSystemBack`: every other shell
 * passes `null` and this attaches nothing.
 */
export function useStatusBarTapScrollToTop(): void {
  const runnerHost = useRunnerHostOrNull();
  const motionEnabled = useMotionEnabled();
  useEffect(() => {
    const statusBarTap = runnerHost?.statusBarTap ?? null;
    if (statusBarTap === null) return;
    const subscription = statusBarTap.onTap(() => {
      const scroller = frontmostScroller();
      if (scroller !== null) requestScrollToTop(scroller, motionEnabled);
    });
    return () => {
      subscription.dispose();
    };
  }, [motionEnabled, runnerHost]);
}

/** Probes per layer, spread evenly down its middle. */
const PROBE_STEPS = 10;

/**
 * The scroll area of whatever is in front, or `null` when nothing there
 * scrolls.
 *
 * The layer is probed top-down along its middle and the first probe that
 * lands in a scroll area decides. Top-down passes the header, which never
 * scrolls, and meets the screen's list before anything docked at its bottom:
 * the keyboard overlays the app instead of resizing it, so with a long draft
 * the chat's composer reaches far up the screen.
 *
 * Under each probe the OUTERMOST scrolling box wins. That is what makes it
 * the screen's main list: a code block or a tool's output inside a chat
 * scrolls too, but always inside the transcript, never around it.
 */
function frontmostScroller(): HTMLElement | null {
  const area = layerArea(frontmostLayer());
  const x = area.left + area.width / 2;
  for (let step = 1; step < PROBE_STEPS; step += 1) {
    const y = area.top + (area.height * step) / PROBE_STEPS;
    const scroller = outermostVerticalScroller(deepestElementAt(x, y));
    if (scroller !== null) return scroller;
  }
  return null;
}

/**
 * The topmost open modal dialog or sheet, or `null` for the bare screen. A
 * modal layer seals everything beneath it (`aria-hidden` from the dialog
 * primitives, `inert` from the nav drawer), so a sealed layer is covered and
 * the last one left in document order is the newest. A non-modal dialog, like
 * the first-task coachmark, floats over the screen without owning it.
 */
function frontmostLayer(): HTMLElement | null {
  const layers = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"]',
  );
  return (
    Array.from(layers).findLast(
      (layer) =>
        layer.getAttribute("aria-modal") !== "false" &&
        layer.closest('[aria-hidden="true"], [inert]') === null &&
        layer.getClientRects().length > 0,
    ) ?? null
  );
}

function layerArea(layer: HTMLElement | null): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} {
  if (layer === null) {
    return {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }
  return layer.getBoundingClientRect();
}

/** The element under the point, looking inside shadow roots (the file tree). */
function deepestElementAt(x: number, y: number): Element | null {
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (inner === null || inner === hit) break;
    hit = inner;
  }
  return hit;
}

function outermostVerticalScroller(
  element: Element | null,
): HTMLElement | null {
  let outermost: HTMLElement | null = null;
  for (let node = element; node !== null; node = parentAcrossShadow(node)) {
    if (node instanceof HTMLElement && scrollsVertically(node)) {
      outermost = node;
    }
  }
  return outermost;
}

function parentAcrossShadow(node: Element): Element | null {
  if (node.parentElement !== null) return node.parentElement;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function scrollsVertically(element: HTMLElement): boolean {
  const { overflowY } = getComputedStyle(element);
  return (
    (overflowY === "auto" || overflowY === "scroll") &&
    element.scrollHeight > element.clientHeight
  );
}
