/**
 * Ticket 21 slice 3: the direct-flush geometry coordinator design-review
 * finding 2 requires in place of `ResizeObserver -> requestAnimationFrame`.
 *
 * ONE shared `ResizeObserver` for the host root and every registered slot.
 * Its callback applies every registered rect DIRECTLY - synchronously, in
 * the same task, no `requestAnimationFrame` hop - because `document.hidden`
 * is `true` in the automated renderer and a prior live investigation
 * established that rAF never services a state mirror there. Resize
 * observation already fires after layout and before paint; scheduling rAF
 * from that callback would push the record-box write a full rendering
 * opportunity late during a continuous divider drag, and can stall
 * indefinitely in that hidden renderer.
 *
 * The callback recomputes EVERY currently registered rect on any observed
 * change, not only the entries in that batch: a host-root move (a real
 * `TopLevelTabHost` resize, e.g. a sidebar toggle) must invalidate every
 * live record's position, not just the slot that happened to report in this
 * particular batch. `getBoundingClientRect()` is read fresh for both the
 * host and the slot at apply time rather than trusted from the RO entry -
 * `ResizeObserverEntry.contentRect` only carries size, never position.
 *
 * Writing an absolutely positioned record does not resize its OWN observed
 * slot (the record is not a descendant of the slot), so applying rects
 * directly here cannot re-trigger this same observer in a feedback loop.
 *
 * Registration is callback-ref driven (a synchronous initial measurement on
 * attach, matching the design's structural-transfer requirement) and
 * StrictMode-safe by construction: every register call creates a fresh
 * registration object, and its own unregister closure only ever removes
 * that EXACT object (`registrations.get(key) === registration`), so a stale
 * cleanup from an earlier registration can never clobber a newer one that
 * has already replaced it - the same compare-before-clear discipline
 * ticket 22's geometry scheduler needed for its own StrictMode replay.
 *
 * A same-key re-registration (slice-3 review finding 2) unobserves the
 * DISPLACED element before observing the new one, at replacement time -
 * the identity-guarded cleanup above correctly refuses to remove the new
 * mapping entry, but that guard alone left the old element observed
 * forever (its own late cleanup skips `unobserve` along with the deletion
 * it correctly declines). Repeated structural transfers would otherwise
 * retain every detached source element in the shared observer's target set
 * and pay a redundant all-record recompute pass per stale target.
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
 * Registers the plane's own root element as the coordinate origin every
 * slot rect is reported relative to. Exactly one host element is expected
 * live at a time; a later register replaces the origin outright (the
 * unregister closure only clears it if it is still the one that set it).
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
