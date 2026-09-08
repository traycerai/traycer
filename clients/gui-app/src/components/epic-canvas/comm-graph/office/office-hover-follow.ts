/**
 * How the office floor's hover card keeps up with a moving character.
 *
 * The floor is one `<canvas>` repainted every frame, and a character away from
 * its desk moves a fraction of a tile per frame. The card is placed on a
 * pointer event, so between events it is the frame loop that has to decide
 * whether the pointer is still on the agent and where the agent has got to.
 * Kept out of the component file so the card itself stays a pure component.
 */
import type {
  OfficeHitRegion,
  OfficePoint,
  OfficeRect,
} from "@/lib/comm-graph/office/office-types";

/** The floor's camera, as the hover needs it: a screen offset and a scale. */
export interface OfficeHoverCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/**
 * The open hover's subject and the pointer's last position over the floor, in
 * container screen pixels.
 *
 * The pointer is remembered rather than the character's box: the box is what
 * MOVES between pointer events - the character walks off to lunch, an
 * auto-pan slides the floor under a stationary cursor - so a box measured once
 * stops being true within a frame of either. The pointer only changes when
 * the pointer moves, and a hit test at it against the frame just built answers
 * both "is the cursor still on this agent" and "where is the agent now".
 */
export interface OfficeHoverAnchor {
  readonly agentId: string;
  readonly screenX: number;
  readonly screenY: number;
}

export function hitRegionFor(
  regions: ReadonlyArray<OfficeHitRegion>,
  point: OfficePoint,
): OfficeHitRegion | null {
  // Last match wins: `hitRegions` follows the frame's own draw order, so the
  // character painted on top of another is the one the pointer is over.
  let found: OfficeHitRegion | null = null;
  for (const region of regions) {
    if (
      point.x >= region.rect.x &&
      point.x <= region.rect.x + region.rect.width &&
      point.y >= region.rect.y &&
      point.y <= region.rect.y + region.rect.height
    ) {
      found = region;
    }
  }
  return found;
}

/**
 * Where the open hover's trigger belongs on THIS frame, in container screen
 * pixels - or `null` once the pointer's last position no longer lands on the
 * hovered agent, because the character walked out from under it, the floor
 * panned, or another character was painted over it.
 *
 * A moving character keeps its card as long as the cursor stays on it, and
 * the card moves with it; a card is never left anchored to empty floor.
 */
export function followOfficeHover(
  anchor: OfficeHoverAnchor,
  regions: ReadonlyArray<OfficeHitRegion>,
  camera: OfficeHoverCamera,
): OfficeRect | null {
  const region = hitRegionFor(regions, {
    x: (anchor.screenX - camera.x) / camera.zoom,
    y: (anchor.screenY - camera.y) / camera.zoom,
  });
  if (region === null || region.agentId !== anchor.agentId) return null;
  return {
    x: region.rect.x * camera.zoom + camera.x,
    y: region.rect.y * camera.zoom + camera.y,
    width: region.rect.width * camera.zoom,
    height: region.rect.height * camera.zoom,
  };
}
