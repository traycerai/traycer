/**
 * Where an agent's name tag actually gets drawn, once its neighbours are
 * accounted for.
 *
 * Characters cluster - two agents at adjacent cafeteria seats, a queue at
 * reception - and their tags are wider than they are, so at rest they overlap
 * into a band of unreadable text. Nothing about the FLOOR is wrong when that
 * happens, so the fix belongs here rather than in the scene: the tag moves,
 * the character does not.
 *
 * GREEDY AND DETERMINISTIC. Tags are placed in a fixed order (top to bottom,
 * then left to right), each takes the first free slot at or below its anchor,
 * and one that finds none is DROPPED rather than drawn over a neighbour. A
 * dropped tag costs a name that hovering still reveals; a drawn one costs both
 * names.
 */
export interface OfficeNameTagCandidate {
  readonly text: string;
  /** Carried through placement so the caller keeps its own colour choice. */
  readonly tone: "default" | "muted";
  /** Horizontal centre, in screen pixels. */
  readonly centerX: number;
  /** Text baseline, in screen pixels. */
  readonly baselineY: number;
  /** Measured text width, in screen pixels. */
  readonly width: number;
}

export interface OfficePlacedNameTag {
  readonly text: string;
  readonly tone: "default" | "muted";
  readonly centerX: number;
  readonly baselineY: number;
}

interface TagBox {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** How far a displaced tag drops per attempt, and how many attempts it gets. */
export const NAME_TAG_LINE_HEIGHT = 11;
const MAX_SHIFTS = 2;

function boxFor(
  candidate: OfficeNameTagCandidate,
  baselineY: number,
  lineHeight: number,
): TagBox {
  const half = candidate.width / 2;
  return {
    left: candidate.centerX - half,
    right: candidate.centerX + half,
    top: baselineY - lineHeight,
    bottom: baselineY,
  };
}

function overlaps(a: TagBox, b: TagBox): boolean {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
}

export function layoutNameTags(
  candidates: ReadonlyArray<OfficeNameTagCandidate>,
  lineHeight: number,
): ReadonlyArray<OfficePlacedNameTag> {
  // Sorted before placing, so the same floor always drops the same tags: a
  // tie broken by iteration order would make a name flicker as the scene
  // re-emits its drawables in a different sequence.
  const ordered = [...candidates].sort(
    (a, b) => a.baselineY - b.baselineY || a.centerX - b.centerX,
  );
  const placedBoxes: TagBox[] = [];
  const placed: OfficePlacedNameTag[] = [];
  for (const candidate of ordered) {
    for (let shift = 0; shift <= MAX_SHIFTS; shift += 1) {
      const baselineY = candidate.baselineY + shift * lineHeight;
      const box = boxFor(candidate, baselineY, lineHeight);
      if (placedBoxes.some((other) => overlaps(box, other))) continue;
      placedBoxes.push(box);
      placed.push({
        text: candidate.text,
        tone: candidate.tone,
        centerX: candidate.centerX,
        baselineY,
      });
      break;
    }
  }
  return placed;
}
