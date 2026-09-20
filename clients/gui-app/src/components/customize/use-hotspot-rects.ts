import { useLayoutEffect, useState } from "react";
import type {
  HotspotInstance,
  InstanceKey,
} from "@/stores/customize/customize-store";

export interface DropSlotRect {
  readonly id: string;
  readonly group: string;
  readonly tileId: string | null;
  readonly rect: DOMRect;
}
export interface HotspotRects {
  readonly slots: ReadonlyArray<DropSlotRect>;
  readonly source: ReadonlyMap<InstanceKey, HotspotInstance>;
  readonly rects: ReadonlyMap<InstanceKey, DOMRect>;
  readonly hitRects: ReadonlyMap<InstanceKey, DOMRect>;
  readonly unreachable: ReadonlySet<InstanceKey>;
  readonly version: number;
}
// Cache cumulative clipping within a measurement pass: shared ancestors are
// read once even when a scroller contains many hotspots.
function ancestorClip(
  node: HTMLElement | null,
  viewport: DOMRect,
  cache: Map<HTMLElement, DOMRect>,
): DOMRect {
  if (!node) return viewport;
  const cached = cache.get(node);
  if (cached) return cached;
  const inherited = ancestorClip(node.parentElement, viewport, cache);
  const style = getComputedStyle(node);
  const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
  const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
  let left = inherited.left,
    right = inherited.right;
  let top = inherited.top,
    bottom = inherited.bottom;
  if (clipsX || clipsY) {
    const bounds = node.getBoundingClientRect();
    if (clipsX) {
      left = Math.max(left, bounds.left + node.clientLeft);
      right = Math.min(right, bounds.left + node.clientLeft + node.clientWidth);
    }
    if (clipsY) {
      top = Math.max(top, bounds.top + node.clientTop);
      bottom = Math.min(
        bottom,
        bounds.top + node.clientTop + node.clientHeight,
      );
    }
  }
  const clip = new DOMRect(
    left,
    top,
    Math.max(0, right - left),
    Math.max(0, bottom - top),
  );
  cache.set(node, clip);
  return clip;
}
function intersect(rect: DOMRect, clip: DOMRect): DOMRect {
  const left = Math.max(rect.left, clip.left);
  const top = Math.max(rect.top, clip.top);
  return new DOMRect(
    left,
    top,
    Math.max(0, Math.min(rect.right, clip.right) - left),
    Math.max(0, Math.min(rect.bottom, clip.bottom) - top),
  );
}
// The final hit floor belongs here, while the source clip is still known.
function hitRect(rect: DOMRect, clip: DOMRect): DOMRect {
  const width = Math.max(24, rect.width);
  const height = Math.max(24, rect.height);
  return new DOMRect(
    Math.max(
      clip.left,
      Math.min(rect.left + (rect.width - width) / 2, clip.right - width),
    ),
    Math.max(
      clip.top,
      Math.min(rect.top + (rect.height - height) / 2, clip.bottom - height),
    ),
    width,
    height,
  );
}
function fitsHit(rect: DOMRect, clip: DOMRect): boolean {
  return (
    Math.min(rect.width, rect.height) > 0 &&
    Math.min(clip.width, clip.height) >= 24
  );
}
interface Candidate {
  readonly key: InstanceKey;
  readonly node: HTMLElement;
  readonly rect: DOMRect;
  readonly hit: DOMRect;
  readonly visibleFraction: number;
}
function compareCandidates(a: Candidate, b: Candidate): number {
  const clipping = b.visibleFraction - a.visibleFraction;
  if (clipping) return clipping;
  const position = a.node.compareDocumentPosition(b.node);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return a.key.localeCompare(b.key);
}
function overlaps(a: DOMRect, b: DOMRect): boolean {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}
function publishCandidates(
  candidates: Candidate[],
  rects: Map<InstanceKey, DOMRect>,
  hitRects: Map<InstanceKey, DOMRect>,
  unreachable: Set<InstanceKey>,
): void {
  // Prefer intact sources, then document order, regardless of registration order.
  // ponytail: pairwise checks suit the small hotspot set; spatial indexing if it grows.
  for (const candidate of candidates.sort(compareCandidates)) {
    if ([...hitRects.values()].some((hit) => overlaps(hit, candidate.hit))) {
      unreachable.add(candidate.key);
      continue;
    }
    rects.set(candidate.key, candidate.rect);
    hitRects.set(candidate.key, candidate.hit);
  }
}
export function useHotspotRects(
  instances: ReadonlyMap<InstanceKey, HotspotInstance>,
): HotspotRects {
  const [measured, setMeasured] = useState<HotspotRects>({
    source: instances,
    slots: [],
    rects: new Map(),
    hitRects: new Map(),
    unreachable: new Set(),
    version: 0,
  });
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rects = new Map<InstanceKey, DOMRect>();
      const unreachable = new Set<InstanceKey>();
      const hitRects = new Map<InstanceKey, DOMRect>();
      const clips = new Map<HTMLElement, DOMRect>();
      const candidates: Candidate[] = [];
      const viewport = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      for (const [key, instance] of instances) {
        const node = instance.node;
        if (
          !node.isConnected ||
          node.closest('[hidden], [aria-hidden="true"]') ||
          !node.getClientRects().length
        ) {
          unreachable.add(key);
          continue;
        }
        const source = node.getBoundingClientRect();
        if (Math.min(source.width, source.height) <= 0) {
          unreachable.add(key);
          continue;
        }
        const clip = ancestorClip(node.parentElement, viewport, clips);
        const rect = intersect(source, clip);
        if (!fitsHit(rect, clip)) unreachable.add(key);
        else {
          candidates.push({
            key,
            node,
            rect,
            hit: hitRect(rect, clip),
            visibleFraction:
              (rect.width * rect.height) / (source.width * source.height),
          });
        }
      }
      publishCandidates(candidates, rects, hitRects, unreachable);
      const slots: DropSlotRect[] = [];
      for (const node of document.querySelectorAll<HTMLElement>(
        "[data-customize-drop-slot]",
      )) {
        const id = node.dataset.customizeDropSlot;
        const group = node.dataset.customizeDropGroup;
        const rect = node.getBoundingClientRect();
        if (
          !id ||
          !group ||
          !node.getClientRects().length ||
          rect.width <= 0 ||
          rect.height <= 0 ||
          node.closest('[hidden], [aria-hidden="true"]')
        )
          continue;
        resize.observe(node);
        slots.push({
          id,
          group,
          tileId: node.dataset.customizeDropTile ?? null,
          rect,
        });
      }
      setMeasured((previous) => ({
        source: instances,
        slots,
        rects,
        hitRects,
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
