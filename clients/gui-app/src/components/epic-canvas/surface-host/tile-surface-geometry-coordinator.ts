import { useEpicDndStore } from "../dnd/dnd-store";
import type { StripAxis } from "../dnd/strip-axis";
import {
  readHeaderStripLayoutRect,
  readTranslate,
} from "@/components/layout/tabs/header-strip-geometry";

// One observer owns tile and strip geometry. Every delivery reads all boxes
// before publishing styles or scroll offsets; selection reuses those boxes.
export interface TileSurfaceRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

type TileSurfaceRectListener = (rect: TileSurfaceRect) => void;

interface SlotRegistration {
  readonly key: string;
  readonly slotElement: Element;
  readonly onRect: TileSurfaceRectListener;
  lastRect: TileSurfaceRect | null;
}

let hostRegistration: { readonly element: Element } | null = null;
const slotRegistrations = new Map<string, SlotRegistration>();
let sharedObserver: ResizeObserver | null = null;
const observedElements = new Map<Element, number>();

function ensureSharedObserver(): ResizeObserver {
  if (sharedObserver === null) {
    sharedObserver = new ResizeObserver((entries) => {
      for (const strip of stripRegistrations.values()) {
        if (entries.some((entry) => strip.targets.has(entry.target)))
          strip.dirty = true;
      }
      applyAllRegisteredRects();
    });
  }
  return sharedObserver;
}

function observeElement(element: Element): void {
  const count = observedElements.get(element) ?? 0;
  if (count === 0) ensureSharedObserver().observe(element);
  observedElements.set(element, count + 1);
}

function unobserveElement(element: Element): void {
  const count = observedElements.get(element) ?? 0;
  if (count > 1) observedElements.set(element, count - 1);
  else {
    observedElements.delete(element);
    sharedObserver?.unobserve(element);
  }
}

function measureRect(
  registration: SlotRegistration,
  hostRect: DOMRect,
): TileSurfaceRect {
  const slotRect = registration.slotElement.getBoundingClientRect();
  return {
    left: slotRect.left - hostRect.left,
    top: slotRect.top - hostRect.top,
    width: slotRect.width,
    height: slotRect.height,
  };
}

function publishRect(
  registration: SlotRegistration,
  rect: TileSurfaceRect,
): void {
  if (slotRegistrations.get(registration.key) !== registration) return;
  const previous = registration.lastRect;
  if (
    previous !== null &&
    previous.left === rect.left &&
    previous.top === rect.top &&
    previous.width === rect.width &&
    previous.height === rect.height
  ) {
    return;
  }
  registration.lastRect = rect;
  registration.onRect(rect);
}

function applyRect(registration: SlotRegistration): void {
  if (hostRegistration === null) return;
  publishRect(
    registration,
    measureRect(registration, hostRegistration.element.getBoundingClientRect()),
  );
}

function applyAllRegisteredRects(): void {
  const hostRect = hostRegistration?.element.getBoundingClientRect() ?? null;
  // Read every slot before a listener can change a hosted body's styles.
  const measurements =
    hostRect === null
      ? []
      : Array.from(slotRegistrations.values(), (registration) => ({
          registration,
          rect: measureRect(registration, hostRect),
        }));
  const strips = readStripMeasurements();
  for (const { registration, rect } of measurements) {
    publishRect(registration, rect);
  }
  for (const publish of strips) publish();
}

/**
 * Re-reads every registered slot's rect right now, outside any observer
 * callback. The shared `ResizeObserver` only fires on a SIZE change, so a
 * layout change that moves a slot without resizing it - "Reverse views" on
 * a top-level split, which swaps the two panes' `left` offsets while each
 * keeps its own width - never reaches `applyAllRegisteredRects` on its own,
 * and every hosted body stays painted at its pre-move rect while the pane
 * chrome around it (tab strip, sidebar) has already moved. The layout that
 * performs such a move calls this after commit, from a layout effect, so the
 * rects it reads are the post-move ones.
 */
export function remeasureTileSurfaceGeometry(): void {
  for (const strip of stripRegistrations.values()) strip.dirty = true;
  applyAllRegisteredRects();
}

/** Reveal changes presentation, not layout. RO/topology owns invalidation. */
export function refreshTileSurfaceGeometrySlot(key: string): void {
  const registration = slotRegistrations.get(key);
  if (registration !== undefined && registration.lastRect !== null) {
    registration.onRect(registration.lastRect);
  }
}

/**
 * Registers the plane's own root element as the coordinate origin every
 * slot rect is reported relative to. Exactly one host element is expected
 * live at a time; a later register replaces the origin outright (the
 * unregister closure only clears it if it is still the one that set it).
 */
export function registerTileSurfaceGeometryHost(element: Element): () => void {
  if (hostRegistration !== null) {
    unobserveElement(hostRegistration.element);
  }
  const registration = { element };
  hostRegistration = registration;
  observeElement(element);
  applyAllRegisteredRects();
  return () => {
    if (hostRegistration === registration) {
      unobserveElement(element);
      hostRegistration = null;
    }
  };
}

/**
 * Registers a slot element (a `ReadyTileSurfaceEnvironment.services.geometryAnchorElement`)
 * to report its host-relative rect to `onRect` - synchronously once on
 * registration, then on every subsequent layout change, directly in the RO
 * callback. `key` is the owning record's stable identity (its `instanceId`)
 * so a structural transfer's destination-slot registration cannot be
 * confused with a still-draining source-slot registration for a different
 * record.
 */
export function registerTileSurfaceGeometrySlot(
  key: string,
  slotElement: Element,
  onRect: TileSurfaceRectListener,
): () => void {
  const previous = slotRegistrations.get(key);
  if (previous !== undefined) {
    unobserveElement(previous.slotElement);
  }
  const registration: SlotRegistration = {
    key,
    slotElement,
    onRect,
    lastRect: null,
  };
  slotRegistrations.set(key, registration);
  observeElement(slotElement);
  applyRect(registration);
  return () => {
    if (slotRegistrations.get(key) === registration) {
      unobserveElement(slotElement);
      slotRegistrations.delete(key);
    }
  };
}

export function resetTileSurfaceGeometryCoordinatorForTesting(): void {
  if (sharedObserver !== null) sharedObserver.disconnect();
  sharedObserver = null;
  hostRegistration = null;
  slotRegistrations.clear();
  observedElements.clear();
  for (const strip of stripRegistrations.values()) strip.dispose();
  stripRegistrations.clear();
  if (stripFrame !== null) cancelAnimationFrame(stripFrame);
  stripFrame = null;
}

export interface StripGeometrySnapshot {
  readonly hiddenTabKeys: {
    readonly left: ReadonlyArray<string>;
    readonly right: ReadonlyArray<string>;
  };
  readonly hasOverflow: boolean;
}

interface StripBounds {
  readonly start: number;
  readonly end: number;
}

interface StripRegistration {
  readonly element: HTMLElement;
  readonly axis: StripAxis;
  readonly onChange: (snapshot: StripGeometrySnapshot) => void;
  readonly dispose: () => void;
  readonly targets: Set<Element>;
  readonly bounds: Map<HTMLElement, StripBounds>;
  dirty: boolean;
  reveal: boolean;
  offset: number;
  extent: number;
  /** The scroller's `scroll-padding` along the axis: room a reveal keeps
   * clear (the sectioned side strip's sticky header and bottom fade). */
  padStart: number;
  padEnd: number;
  overflow: boolean;
  selected: HTMLElement | null;
  selectedVisible: boolean;
}

const stripRegistrations = new Map<HTMLElement, StripRegistration>();
const STRIP_TAB_SELECTOR = '[role="tab"], [data-header-tab-key], [data-tab-id]';
let stripFrame: number | null = null;

function scheduleStrips(): void {
  if (stripFrame !== null) return;
  stripFrame = requestAnimationFrame(() => {
    stripFrame = null;
    for (const publish of readStripMeasurements()) publish();
  });
}

function readStripMeasurements(): Array<() => void> {
  return Array.from(stripRegistrations.values(), readStripMeasurement);
}

function refreshStripBounds(strip: StripRegistration): void {
  const { element, axis, bounds } = strip;
  const viewport = element.getBoundingClientRect();
  strip.offset = axis.scrollOffset(element);
  strip.extent = axis.mainExtent(viewport);
  const padding = axis.scrollPadding(getComputedStyle(element));
  strip.padStart = padding.start;
  strip.padEnd = padding.end;
  let availableExtent =
    axis.id === "x" ? element.clientWidth : element.clientHeight;
  for (const control of element.parentElement?.querySelectorAll<HTMLElement>(
    "[data-hidden-tabs-control]",
  ) ?? []) {
    availableExtent +=
      axis.id === "x" ? control.offsetWidth : control.offsetHeight;
  }
  strip.overflow =
    (axis.id === "x" ? element.scrollWidth : element.scrollHeight) >
    availableExtent + 1;
  bounds.clear();
  // Include whole split frames for reveal, and their members for edge menus.
  const nodes = new Set<HTMLElement>(
    element.querySelectorAll<HTMLElement>(STRIP_TAB_SELECTOR),
  );
  for (const child of element.children) {
    if (child instanceof HTMLElement) nodes.add(child);
  }
  for (const node of nodes) {
    const tileFrame = node.closest<HTMLElement>("[data-tile-item-id]");
    const rect = readHeaderStripLayoutRect(node, axis);
    let start = rect.start;
    let extent = rect.extent;
    if (tileFrame !== null) {
      // Canvas frames tween scale about their centre on drop. The visual
      // centre follows translation, but the layout extent never shrinks.
      const frameRect = tileFrame.getBoundingClientRect();
      extent = axis.id === "x" ? tileFrame.offsetWidth : tileFrame.offsetHeight;
      start =
        axis.mainStart(frameRect) +
        (axis.mainExtent(frameRect) - extent) / 2 -
        readTranslate(tileFrame, axis);
    }
    if (extent <= 0) continue;
    const contentStart = start - axis.mainStart(viewport) + strip.offset;
    bounds.set(node, { start: contentStart, end: contentStart + extent });
  }
  strip.dirty = false;
}

function selectedStripBounds(
  strip: StripRegistration,
  selected: HTMLElement | null,
): StripBounds | undefined {
  if (selected === null) return undefined;
  let member: HTMLElement | null = selected;
  while (member !== null && member.parentElement !== strip.element) {
    member = member.parentElement;
  }
  const memberBounds = member === null ? undefined : strip.bounds.get(member);
  // A split wider than the viewport cannot be revealed whole. Keep its
  // selected half visible instead of scrolling that half behind the start edge.
  if (
    memberBounds !== undefined &&
    memberBounds.end - memberBounds.start <=
      strip.extent - strip.padStart - strip.padEnd
  ) {
    return memberBounds;
  }
  return strip.bounds.get(selected);
}

function readStripMeasurement(strip: StripRegistration): () => void {
  const { element, bounds } = strip;
  const previousExtent = strip.extent;
  if (strip.dirty) refreshStripBounds(strip);
  const selected = element.querySelector<HTMLElement>('[aria-selected="true"]');
  const reveal =
    strip.reveal ||
    selected !== strip.selected ||
    (strip.selectedVisible && strip.extent < previousExtent);
  strip.reveal = false;
  strip.selected = selected;
  const selectedBounds = selectedStripBounds(strip, selected);
  const dnd = useEpicDndStore.getState();
  const nextOffset =
    reveal && dnd.activeHeaderTab === null && dnd.activeSource === null
      ? revealedOffset(strip, selectedBounds)
      : strip.offset;
  strip.selectedVisible =
    selectedBounds !== undefined &&
    selectedBounds.start >= nextOffset + strip.padStart - 1 &&
    selectedBounds.end <= nextOffset + strip.extent - strip.padEnd + 1;
  const left: string[] = [];
  const right: string[] = [];
  if (strip.overflow) {
    for (const [node, rect] of bounds) {
      const key = node.dataset.headerTabKey;
      if (key === undefined) continue;
      if (rect.start < nextOffset - 1) left.push(key);
      if (rect.end > nextOffset + strip.extent + 1) right.push(key);
    }
  }
  return () => {
    if (stripRegistrations.get(element) !== strip) return;
    writeStripOffset(strip, nextOffset);
    strip.onChange({
      hiddenTabKeys: { left, right },
      hasOverflow: strip.overflow,
    });
  };
}

function revealedOffset(
  strip: StripRegistration,
  bounds: StripBounds | undefined,
): number {
  if (bounds === undefined || strip.extent <= 0) return strip.offset;
  // Kept clear of the scroll-padding, as `revealMemberAlongAxis` is.
  const start = bounds.start - strip.padStart;
  const end = bounds.end + strip.padEnd;
  if (end > strip.offset + strip.extent + 1)
    return Math.max(0, end - strip.extent);
  if (start < strip.offset - 1) return Math.max(0, start);
  return strip.offset;
}

function writeStripOffset(strip: StripRegistration, offset: number): void {
  if (offset === strip.offset) return;
  strip.offset = offset;
  if (strip.axis.id === "x") strip.element.scrollLeft = offset;
  else strip.element.scrollTop = offset;
}

/** Observe each strip once; selection and scroll reuse content-space bounds. */
export function registerTabStripGeometry(
  element: HTMLElement,
  axis: StripAxis,
  onChange: (snapshot: StripGeometrySnapshot) => void,
): () => void {
  stripRegistrations.get(element)?.dispose();
  const targets = new Set<Element>();
  const observeChildren = (): void => {
    const next = new Set<Element>([
      element,
      ...element.children,
      ...element.querySelectorAll(STRIP_TAB_SELECTOR),
    ]);
    if (element.parentElement !== null) next.add(element.parentElement);
    for (const target of targets) {
      if (!next.has(target)) {
        unobserveElement(target);
        targets.delete(target);
      }
    }
    for (const target of next) {
      if (!targets.has(target)) {
        observeElement(target);
        targets.add(target);
      }
    }
  };
  const onScroll = (): void => {
    strip.offset = axis.scrollOffset(element);
    scheduleStrips();
  };
  const mutations = new MutationObserver((records) => {
    if (
      records.some((record) =>
        record.type === "attributes"
          ? record.attributeName !== "aria-selected"
          : record.target === element ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.matches(STRIP_TAB_SELECTOR) ||
                  node.querySelector(STRIP_TAB_SELECTOR) !== null),
            ),
      )
    ) {
      strip.dirty = true;
      strip.reveal = true;
      observeChildren();
    }
    scheduleStrips();
  });
  const dispose = (): void => {
    if (stripRegistrations.get(element) !== strip) return;
    mutations.disconnect();
    element.removeEventListener("scroll", onScroll);
    for (const target of targets) unobserveElement(target);
    if (stripRegistrations.get(element) === strip)
      stripRegistrations.delete(element);
  };
  const strip: StripRegistration = {
    element,
    axis,
    onChange,
    dispose,
    targets,
    bounds: new Map(),
    dirty: true,
    reveal: true,
    offset: 0,
    extent: 0,
    padStart: 0,
    padEnd: 0,
    overflow: false,
    selected: null,
    selectedVisible: false,
  };
  stripRegistrations.set(element, strip);
  mutations.observe(element, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-selected", "data-header-tab-key", "data-tab-id"],
  });
  element.addEventListener("scroll", onScroll, { passive: true });
  observeChildren();
  scheduleStrips();
  return dispose;
}

export function invalidateTabStripGeometry(element: HTMLElement): void {
  const strip = stripRegistrations.get(element);
  if (strip === undefined) return;
  strip.dirty = true;
  strip.reveal = true;
  scheduleStrips();
}

export function revealStripTab(element: HTMLElement, key: string): void {
  const strip = stripRegistrations.get(element);
  if (strip === undefined) return;
  for (const [node, bounds] of strip.bounds) {
    if (node.dataset.headerTabKey !== key) continue;
    writeStripOffset(strip, revealedOffset(strip, bounds));
    node.focus({ preventScroll: true });
    scheduleStrips();
    break;
  }
}
