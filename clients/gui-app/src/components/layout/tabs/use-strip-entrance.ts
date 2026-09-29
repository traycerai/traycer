import { useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  peekStripEntrance,
  settleStripEntrance,
} from "@/stores/tabs/strip-motion";

/** The strip's own `ease-spring`, so a slot opens like everything else on it. */
const SLOT_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const SLOT_OPEN_MS = 320;
const LABEL_EASE = "cubic-bezier(0.2, 0, 0, 1)";
const LABEL_RISE_MS = 240;
/** The label starts once the slot has room for it. */
const LABEL_LAG_MS = 80;
const LABEL_RISE_PX = 6;

interface EntranceRequest {
  readonly node: HTMLElement;
  readonly kind: "tab" | "chip";
  readonly delayMs: number;
  readonly keys: ReadonlyArray<string>;
  stop: (() => void) | null;
}

interface SlotSize {
  readonly width: number;
  readonly marginLeft: number;
  readonly marginRight: number;
  readonly paddingLeft: number;
  readonly paddingRight: number;
}

/** Members that mounted in the current commit owing an entrance. */
const pending = new Set<EntranceRequest>();

/**
 * Registers a strip member that the coordinator marked as opened or reopened;
 * `useOpenStripEntrances` opens it. `markKeys` is space-separated: every ref
 * the item shows (a split has two), or a group chip's key. A `"tab"` also
 * lifts its label in once there is room; a `"chip"` is too small for that and
 * fades in with its box.
 */
export function useStripEntrance(
  nodeRef: RefObject<HTMLElement | null>,
  markKeys: string,
  kind: "tab" | "chip",
): void {
  const reduceMotion = useReducedMotion() === true;
  useLayoutEffect(() => {
    const keys = markKeys.split(" ");
    const entrance = peekStripEntrance(keys);
    const node = nodeRef.current;
    if (entrance === null || node === null) return;
    // Without Web Animations (jsdom) the slot simply appears.
    if (reduceMotion || typeof node.animate !== "function") {
      settleStripEntrance(keys);
      return;
    }
    const request: EntranceRequest = {
      node,
      kind,
      delayMs: entrance.delayMs,
      keys,
      stop: null,
    };
    pending.add(request);
    return () => {
      pending.delete(request);
      request.stop?.();
    };
  }, [nodeRef, markKeys, kind, reduceMotion]);
}

/**
 * Opens every member that registered in this commit, so neighbours part to
 * make room instead of jumping.
 *
 * The strip calls it from its own layout effect, which runs after all of its
 * members' effects: every entering member is measured at its natural width
 * before any of them is held shut. Measuring each as it mounted would let a
 * later one measure against earlier ones already at zero and aim too wide.
 *
 * Nothing a strip shows on its first paint animates: a strip that has not
 * painted is hydrating or opening in a new window, not answering a gesture.
 * `onFrame` runs on every frame a slot is opening.
 */
export function useOpenStripEntrances(onFrame: () => void): void {
  const paintedRef = useRef(false);
  useEffect(() => {
    paintedRef.current = true;
  }, []);
  useLayoutEffect(() => {
    if (pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    if (!paintedRef.current) {
      for (const request of batch) settleStripEntrance(request.keys);
      return;
    }
    const sizes = batch.map((request) => measureSlot(request.node));
    const running = batch.map((request, index) =>
      openSlot(request, sizes[index]),
    );
    // One frame loop for the whole batch: the openings move the selection
    // after the strip's activation reveal already ran.
    let frame = requestAnimationFrame(function follow() {
      onFrame();
      frame = requestAnimationFrame(follow);
    });
    void Promise.allSettled(running.map((slot) => slot.finished)).then(() => {
      cancelAnimationFrame(frame);
      onFrame();
    });
  });
}

function measureSlot(node: HTMLElement): SlotSize {
  const computed = getComputedStyle(node);
  return {
    width: node.getBoundingClientRect().width,
    marginLeft: Number.parseFloat(computed.marginLeft),
    marginRight: Number.parseFloat(computed.marginRight),
    paddingLeft: Number.parseFloat(computed.paddingLeft),
    paddingRight: Number.parseFloat(computed.paddingRight),
  };
}

/**
 * Holds the slot shut through its stagger delay (`fill: "backwards"`), then
 * opens it. Nothing is written inline: when the animation ends its effect
 * simply stops, and the member is back on the strip's own flex sizing, which
 * is the size it was measured at.
 */
function openSlot(request: EntranceRequest, size: SlotSize): Animation {
  const { node, kind, delayMs } = request;
  const held = {
    flexGrow: "0",
    flexShrink: "0",
    flexBasis: "auto",
    minWidth: "0px",
    overflow: "hidden",
  };
  const slot = node.animate(
    [
      {
        ...held,
        width: "0px",
        marginLeft: "0px",
        marginRight: "0px",
        paddingLeft: "0px",
        paddingRight: "0px",
        ...(kind === "chip" ? { opacity: "0" } : {}),
      },
      {
        ...held,
        width: `${size.width}px`,
        marginLeft: `${size.marginLeft}px`,
        marginRight: `${size.marginRight}px`,
        paddingLeft: `${size.paddingLeft}px`,
        paddingRight: `${size.paddingRight}px`,
        ...(kind === "chip" ? { opacity: "1" } : {}),
      },
    ],
    {
      duration: SLOT_OPEN_MS,
      easing: SLOT_EASE,
      delay: delayMs,
      fill: "backwards",
    },
  );
  const label =
    kind === "tab" && node.firstElementChild instanceof HTMLElement
      ? node.firstElementChild.animate(
          [
            { opacity: "0", transform: `translateY(${LABEL_RISE_PX}px)` },
            { opacity: "1", transform: "none" },
          ],
          {
            duration: LABEL_RISE_MS,
            easing: LABEL_EASE,
            delay: delayMs + LABEL_LAG_MS,
            fill: "backwards",
          },
        )
      : null;
  let cancelled = false;
  void slot.finished.then(
    () => {
      if (!cancelled) settleStripEntrance(request.keys);
    },
    () => undefined,
  );
  request.stop = () => {
    cancelled = true;
    slot.cancel();
    label?.cancel();
  };
  return slot;
}
