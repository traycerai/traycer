import { useEffect, type ReactNode } from "react";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { cn } from "@/lib/utils";
import {
  clearPaneFlash,
  usePaneEmphasisStore,
} from "@/stores/epics/canvas/pane-emphasis-store";

/** Neutral on purpose: location and focus never borrow a status or user hue. */
const OUTLINE_CLASS =
  "pointer-events-none absolute inset-0 z-30 border-2 border-dashed border-foreground/40";
const FLASH_CLASS =
  "pointer-events-none absolute inset-0 z-30 ring-2 ring-inset ring-foreground/40";

/** The ring fades in and out once over this long; see `.pane-focus-flash`. */
const FLASH_MS = 400;
/** With no fades the ring just shows, then goes away. */
const FLASH_STATIC_MS = 600;

/**
 * What the Activity strip draws on a pane (see `pane-emphasis-store`): a dashed
 * outline while the pointer is over an agent row whose chat is this pane's
 * visible tile, and a one-shot ring when a click moves focus to it. Both
 * ignore the pointer, so the pane stays fully usable underneath.
 */
export function PaneEmphasis(props: {
  readonly activeInstanceId: string | null;
}): ReactNode {
  const { activeInstanceId } = props;
  const outlined = usePaneEmphasisStore(
    (state) =>
      activeInstanceId !== null &&
      state.outlinedInstanceId === activeInstanceId,
  );
  const flashNonce = usePaneEmphasisStore((state) =>
    activeInstanceId !== null && state.flash?.instanceId === activeInstanceId
      ? state.flash.nonce
      : null,
  );
  return (
    <>
      {outlined ? (
        <div aria-hidden data-testid="pane-outline" className={OUTLINE_CLASS} />
      ) : null}
      {flashNonce === null ? null : (
        <PaneFlash key={flashNonce} nonce={flashNonce} />
      )}
    </>
  );
}

function PaneFlash(props: { readonly nonce: number }): ReactNode {
  const { nonce } = props;
  const motionEnabled = useMotionEnabled();
  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        clearPaneFlash(nonce);
      },
      motionEnabled ? FLASH_MS : FLASH_STATIC_MS,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [motionEnabled, nonce]);
  return (
    <div
      aria-hidden
      data-testid="pane-flash"
      className={cn(FLASH_CLASS, motionEnabled && "pane-focus-flash")}
    />
  );
}
