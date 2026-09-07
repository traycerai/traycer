/**
 * Its callback applies every registered rect DIRECTLY - synchronously, in the same task, no `requestAnimationFrame` hop - because `document.hidden` is `true` in the automated renderer and a prior live investigation established that rAF never services a state mirror there.
 * Resize observation already fires after layout and before paint; scheduling rAF from that callback would push the record-box write a full rendering opportunity late during a continuous divider drag, and can stall indefinitely in that hidden renderer.
 */

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
}

let hostRegistration: { readonly element: Element } | null = null;
const slotRegistrations = new Map<string, SlotRegistration>();
let sharedObserver: ResizeObserver | null = null;

function ensureSharedObserver(): ResizeObserver {
  if (sharedObserver === null) {
    sharedObserver = new ResizeObserver(applyAllRegisteredRects);
  }
  return sharedObserver;
}

function applyRectAgainstHost(
  registration: SlotRegistration,
  hostRect: DOMRect,
): void {
  const slotRect = registration.slotElement.getBoundingClientRect();
  registration.onRect({
    left: slotRect.left - hostRect.left,
    top: slotRect.top - hostRect.top,
    width: slotRect.width,
    height: slotRect.height,
  });
}

function applyRect(registration: SlotRegistration): void {
  if (hostRegistration === null) return;
  applyRectAgainstHost(
    registration,
    hostRegistration.element.getBoundingClientRect(),
  );
}

function applyAllRegisteredRects(): void {
  if (hostRegistration === null) return;
  const hostRect = hostRegistration.element.getBoundingClientRect();
  for (const registration of slotRegistrations.values()) {
    applyRectAgainstHost(registration, hostRect);
  }
}

/**
 * The shared `ResizeObserver` only fires on a SIZE change, so a layout change that moves a slot without resizing it - "Reverse views" on a top-level split, which swaps the two panes' `left` offsets while each keeps its own width - never reaches `applyAllRegisteredRects` on its own, and every hosted body stays painted at its pre-move rect while the pane chrome around it (tab strip, sidebar) has already moved.
 */
export function remeasureTileSurfaceGeometry(): void {
  applyAllRegisteredRects();
}

/**
 * Exactly one host element is expected live at a time; a later register replaces the origin outright (the unregister closure only clears it if it is still the one that set it).
 */
export function registerTileSurfaceGeometryHost(element: Element): () => void {
  if (hostRegistration !== null) {
    ensureSharedObserver().unobserve(hostRegistration.element);
  }
  const registration = { element };
  hostRegistration = registration;
  ensureSharedObserver().observe(element);
  applyAllRegisteredRects();
  return () => {
    if (hostRegistration === registration) {
      sharedObserver?.unobserve(element);
      hostRegistration = null;
    }
  };
}

/**
 * `key` is the owning record's stable identity (its `instanceId`) so a structural transfer's destination-slot registration cannot be confused with a still-draining source-slot registration for a different record.
 */
export function registerTileSurfaceGeometrySlot(
  key: string,
  slotElement: Element,
  onRect: TileSurfaceRectListener,
): () => void {
  const previous = slotRegistrations.get(key);
  if (previous !== undefined) {
    ensureSharedObserver().unobserve(previous.slotElement);
  }
  const registration: SlotRegistration = { key, slotElement, onRect };
  slotRegistrations.set(key, registration);
  ensureSharedObserver().observe(slotElement);
  applyRect(registration);
  return () => {
    if (slotRegistrations.get(key) === registration) {
      sharedObserver?.unobserve(slotElement);
      slotRegistrations.delete(key);
    }
  };
}

export function resetTileSurfaceGeometryCoordinatorForTesting(): void {
  if (sharedObserver !== null) sharedObserver.disconnect();
  sharedObserver = null;
  hostRegistration = null;
  slotRegistrations.clear();
}
