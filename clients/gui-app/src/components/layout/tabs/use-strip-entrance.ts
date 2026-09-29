import { animate, useReducedMotion } from "motion/react";
import { useLayoutEffect, type RefObject } from "react";
import {
  peekStripEntrance,
  settleStripEntrance,
} from "@/stores/tabs/strip-motion";

/** The strip's own `ease-spring`, so a slot opens like everything else on it. */
const SLOT_EASE = [0.32, 0.72, 0, 1] as const;
const SLOT_OPEN_S = 0.32;
const LABEL_EASE = [0.2, 0, 0, 1] as const;
const LABEL_RISE_S = 0.24;
/** The label starts once the slot has room for it. */
const LABEL_LAG_S = 0.08;
const LABEL_RISE_PX = 6;

/**
 * Inline properties the opening holds, all released when it ends so the item
 * returns to the strip's own flex sizing. Margins and padding matter only for
 * a group chip, whose box would otherwise open from its padding, not from 0.
 */
const HELD_PROPERTIES = [
  "flex",
  "min-width",
  "width",
  "overflow",
  "opacity",
  "margin-left",
  "margin-right",
  "padding-left",
  "padding-right",
] as const;
const RISE_PROPERTIES = ["opacity", "transform", "transition"] as const;

/**
 * Opens a strip item's slot from zero width when the coordinator marked it as
 * opened or reopened, so its neighbours part to make room instead of jumping.
 *
 * `markKeys` is space-separated: every ref the item shows (a split has two),
 * or a group chip's key. A `"tab"` also lifts its label in once there is room;
 * a `"chip"` is too small for that and fades in with its box.
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
    if (reduceMotion) {
      settleStripEntrance(keys);
      return;
    }
    return openSlot(node, kind, entrance.delayMs / 1000, () => {
      settleStripEntrance(keys);
    });
  }, [nodeRef, markKeys, kind, reduceMotion]);
}

/**
 * Runs in the mount's layout effect, so the item is measured at its natural
 * width and held shut before it is ever painted. Returns the cleanup, which
 * also serves StrictMode's second run: it releases every held property, and
 * the rerun measures and opens again from a clean slate.
 */
function openSlot(
  node: HTMLElement,
  kind: "tab" | "chip",
  delaySeconds: number,
  onOpened: () => void,
): () => void {
  const computed = getComputedStyle(node);
  const target = {
    width: node.getBoundingClientRect().width,
    marginLeft: Number.parseFloat(computed.marginLeft),
    marginRight: Number.parseFloat(computed.marginRight),
    paddingLeft: Number.parseFloat(computed.paddingLeft),
    paddingRight: Number.parseFloat(computed.paddingRight),
  };
  const label =
    kind === "tab" && node.firstElementChild instanceof HTMLElement
      ? node.firstElementChild
      : null;

  node.style.flex = "none";
  node.style.minWidth = "0px";
  node.style.width = "0px";
  node.style.overflow = "hidden";
  node.style.marginLeft = "0px";
  node.style.marginRight = "0px";
  node.style.paddingLeft = "0px";
  node.style.paddingRight = "0px";
  if (kind === "chip") node.style.opacity = "0";
  if (label !== null) {
    // The tab root transitions `transform` for its own states; left on, it
    // would trail every frame of the lift by its 300ms.
    label.style.transition = "none";
    label.style.opacity = "0";
    label.style.transform = `translateY(${LABEL_RISE_PX}px)`;
  }

  const slot = animate(
    node,
    {
      width: [0, target.width],
      marginLeft: [0, target.marginLeft],
      marginRight: [0, target.marginRight],
      paddingLeft: [0, target.paddingLeft],
      paddingRight: [0, target.paddingRight],
      ...(kind === "chip" ? { opacity: [0, 1] } : {}),
    },
    { duration: SLOT_OPEN_S, ease: SLOT_EASE, delay: delaySeconds },
  );
  const rise =
    label === null
      ? null
      : animate(
          label,
          { opacity: [0, 1], y: [LABEL_RISE_PX, 0] },
          {
            duration: LABEL_RISE_S,
            ease: LABEL_EASE,
            delay: delaySeconds + LABEL_LAG_S,
          },
        );

  let cancelled = false;
  const release = () => {
    for (const property of HELD_PROPERTIES) node.style.removeProperty(property);
    if (label !== null) {
      for (const property of RISE_PROPERTIES)
        label.style.removeProperty(property);
    }
  };
  void Promise.all([slot.finished, rise?.finished]).then(
    () => {
      // A cleanup already released and possibly re-held these properties for
      // a newer run; this settled run must not touch them.
      if (cancelled) return;
      release();
      onOpened();
    },
    () => undefined,
  );
  return () => {
    cancelled = true;
    slot.stop();
    rise?.stop();
    release();
  };
}
