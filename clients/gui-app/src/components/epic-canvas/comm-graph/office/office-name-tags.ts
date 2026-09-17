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
 *
 * AGAINST THE WHOLE FRAME'S LETTERING, not only against other tags. The space
 * this places into arrives already holding the signage and the storey names
 * that were laid down first ({@link OfficeLabelSpace}), because a name tag
 * landing on a room's plate is the same defect as a name tag landing on
 * another name, and for three rounds of feedback it was the one this module's
 * own collision pass could not see.
 */
import {
  officeScreenLabelBaseline,
  officeScreenLabelBox,
  officeScreenLabelLineHeight,
  OFFICE_LABEL_FONT_PX,
  placeOfficeLabel,
  type OfficeLabelBox,
  type OfficeLabelSpace,
} from "@/components/epic-canvas/comm-graph/office/office-label-space";

export interface OfficeNameTagCandidate {
  readonly text: string;
  /** Carried through placement so the caller keeps its own colour choice. */
  readonly tone: "default" | "muted";
  /**
   * Whose name this is, or `null` for lettering that names nobody.
   *
   * Carried through placement because placement can DROP a tag, and a caller
   * that draws names by another route needs to know which agents actually
   * ended up with one - not which ones were offered one.
   */
  readonly ownerAgentId: string | null;
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
  readonly ownerAgentId: string | null;
}

/**
 * How far a displaced tag drops per attempt.
 *
 * DERIVED, not chosen: it is the height of the box a tag reserves, so one
 * attempt is exactly enough to clear the neighbour that displaced it. It was
 * a literal `11` for a 10px face - the halo's top pixel and nothing else -
 * which left a lifted tag's outline painting into the outline above it.
 */
export const NAME_TAG_LINE_HEIGHT =
  officeScreenLabelLineHeight(OFFICE_LABEL_FONT_PX);
const MAX_SHIFTS = 2;

function boxFor(candidate: OfficeNameTagCandidate): OfficeLabelBox {
  return officeScreenLabelBox({
    centerX: candidate.centerX,
    baselineY: candidate.baselineY,
    width: candidate.width,
    fontPx: OFFICE_LABEL_FONT_PX,
  });
}

export function layoutNameTags(
  candidates: ReadonlyArray<OfficeNameTagCandidate>,
  space: OfficeLabelSpace,
): ReadonlyArray<OfficePlacedNameTag> {
  // Sorted before placing, so the same floor always drops the same tags: a
  // tie broken by iteration order would make a name flicker as the scene
  // re-emits its drawables in a different sequence.
  const ordered = [...candidates].sort(
    (a, b) => a.baselineY - b.baselineY || a.centerX - b.centerX,
  );
  const placed: OfficePlacedNameTag[] = [];
  for (const candidate of ordered) {
    const box = placeOfficeLabel(space, boxFor(candidate), {
      dy: NAME_TAG_LINE_HEIGHT,
      max: MAX_SHIFTS,
    });
    if (box === null) continue;
    placed.push({
      text: candidate.text,
      tone: candidate.tone,
      centerX: candidate.centerX,
      // Read back out of the box the space actually reserved, so a displaced
      // tag is drawn where it landed rather than where this asked - the two
      // differ by however many lines the shift took.
      baselineY: officeScreenLabelBaseline(box),
      ownerAgentId: candidate.ownerAgentId,
    });
  }
  return placed;
}
