import { use, useEffect, useState, type ReactNode } from "react";
import { useTabBodySelected } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { FirstTaskPaintGate, GateContext } from "./mobile-drawer-history-state";

/** A new signed-in shell gets its own first-paint latch. */
export function MobileDrawerHistoryGateProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const [gate] = useState(() => new FirstTaskPaintGate());
  return (
    <GateContext.Provider value={gate}>{props.children}</GateContext.Provider>
  );
}

/** The caller has committed its visible task body; publish after its paint. */
export function MobileDrawerTaskPaintReporter(props: {
  readonly ready: boolean;
}): null {
  const gate = use(GateContext);
  useEffect(() => {
    if (!props.ready || gate === null || gate.snapshot()) return;
    if (typeof window.requestAnimationFrame === "function") {
      let secondFrame: number | null = null;
      const firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => gate.markPainted());
      });
      return () => {
        window.cancelAnimationFrame(firstFrame);
        if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
      };
    }
    const timer = window.setTimeout(() => gate.markPainted(), 0);
    return () => window.clearTimeout(timer);
  }, [gate, props.ready]);
  return null;
}

/** Report only a selected tile whose payload has committed in a visible pane. */
export function MobileDrawerVisibleTilePaintReporter(props: {
  readonly ready: boolean;
}): ReactNode {
  const selected = useTabBodySelected();
  const paneVisible = usePaneVisible();
  const ready = props.ready && selected && paneVisible;
  return <MobileDrawerTaskPaintReporter ready={ready} />;
}
