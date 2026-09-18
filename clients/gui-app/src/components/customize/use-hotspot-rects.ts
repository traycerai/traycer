import { useLayoutEffect, useState } from "react";
import type {
  HotspotInstance,
  InstanceKey,
} from "@/stores/customize/customize-store";

export interface HotspotRects {
  readonly source: ReadonlyMap<InstanceKey, HotspotInstance>;
  readonly rects: ReadonlyMap<InstanceKey, DOMRect>;
  readonly unreachable: ReadonlySet<InstanceKey>;
  readonly version: number;
}
export function useHotspotRects(
  instances: ReadonlyMap<InstanceKey, HotspotInstance>,
): HotspotRects {
  const [measured, setMeasured] = useState<HotspotRects>({
    source: instances,
    rects: new Map(),
    unreachable: new Set(),
    version: 0,
  });
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rects = new Map<InstanceKey, DOMRect>();
      const unreachable = new Set<InstanceKey>();
      for (const [key, instance] of instances) {
        const rect = instance.node.getBoundingClientRect();
        if (
          !instance.node.isConnected ||
          !instance.node.getClientRects().length ||
          rect.width <= 0 ||
          rect.height <= 0 ||
          instance.node.closest('[hidden], [aria-hidden="true"]')
        )
          unreachable.add(key);
        else rects.set(key, rect);
      }
      setMeasured((previous) => ({
        source: instances,
        rects,
        unreachable,
        version: previous.version + 1,
      }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(document.documentElement);
    for (const { node } of instances.values()) resize.observe(node);
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["inert", "hidden", "aria-hidden", "data-state"],
    });
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [instances]);
  return measured;
}
