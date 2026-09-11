/**
 * The SHIPPED judge policy as a document: which of its sections the read-only
 * "what the judge already blocks" view shows, and how they are found in it.
 *
 * The host sends the whole of its bundled `auto-judge/defaults.md` on
 * `autoPolicy.get` (`shippedDefaults`), so the view renders the rules that host
 * would actually apply rather than a list maintained here that could drift from
 * them. What is maintained here is only the mapping from the document's
 * headings - which are PROMPT text, addressed to the judge - to the three
 * labels a person reads.
 *
 * **The heading literals are restated, not shared.** They live in the host
 * repository (`AUTO_JUDGE_HARD_BLOCK_HEADING`, and the shipped file itself) and
 * nothing crosses that boundary, so this is an independent change-detector
 * rather than a second reference to one constant. That is the right direction
 * for this particular coupling: if the shipped document renames a tier, the
 * view drops that tier and its test goes red, where a looser match would
 * quietly file the renamed section under the wrong user-facing label - and a
 * mislabelled tier teaches somebody a rule the judge does not follow.
 *
 * The match is on the heading's opening words, case-insensitively, so
 * `## Hard block (non-overridable)` is found without pinning the parenthetical
 * the host's own constant owns.
 */

export type ShippedAutoPolicySections = {
  /** Body of `## Allow exceptions`; `""` when the document has no such section. */
  readonly allowExceptions: string;
  /** Body of `## Soft block`; `""` when absent. */
  readonly softBlock: string;
  /** Body of `## Hard block (non-overridable)`; `""` when absent. */
  readonly hardBlock: string;
};

const TIER_HEADING_OPENINGS = {
  allowExceptions: "allow exceptions",
  softBlock: "soft block",
  hardBlock: "hard block",
} as const;

type Heading = {
  readonly depth: number;
  readonly title: string;
  /** Index into the split lines of the heading line itself. */
  readonly line: number;
};

/**
 * Splits the shipped document into the three tiers the view renders.
 *
 * A section runs from its heading to the next heading at the SAME depth or
 * shallower, so a subsection keeps its parent's body (the shipped document
 * carries `###` subsections, and one of them - the out-of-scope note - lives
 * under a `##` the view does not render at all).
 *
 * Only the FIRST heading that opens a given tier counts; a document with two is
 * malformed and taking the first is at least deterministic.
 */
export function parseShippedAutoPolicy(
  document: string,
): ShippedAutoPolicySections {
  const lines = document.split("\n");
  const headings = collectHeadings(lines);
  return {
    allowExceptions: sectionBody(
      lines,
      headings,
      TIER_HEADING_OPENINGS.allowExceptions,
    ),
    softBlock: sectionBody(lines, headings, TIER_HEADING_OPENINGS.softBlock),
    hardBlock: sectionBody(lines, headings, TIER_HEADING_OPENINGS.hardBlock),
  };
}

/**
 * Whether there is anything to show.
 *
 * The view is hidden outright when this is false, which covers both hosts that
 * send no `shippedDefaults` at all (the property is optional on the wire) and a
 * document this build cannot find a single tier in. Showing a card with three
 * empty headings would be worse than showing nothing: it reads as "the judge
 * blocks nothing".
 */
export function hasShippedAutoPolicySections(
  sections: ShippedAutoPolicySections,
): boolean {
  return (
    sections.allowExceptions.length > 0 ||
    sections.softBlock.length > 0 ||
    sections.hardBlock.length > 0
  );
}

function collectHeadings(lines: readonly string[]): readonly Heading[] {
  const headings: Heading[] = [];
  // A `#` at the start of a line inside a fenced block is a comment in whatever
  // the fence holds, not a heading. The shipped document has no fences today;
  // tracking them costs three lines and stops a future shell example from
  // cutting a tier in half.
  let fence: string | null = null;
  for (const [line, text] of lines.entries()) {
    const fenceMatch = /^[ \t]{0,3}(```+|~~~+)/.exec(text);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = /^(#{1,6})[ \t]+(.*)$/.exec(text);
    if (match === null) continue;
    headings.push({
      depth: match[1].length,
      title: match[2].trim().toLowerCase(),
      line,
    });
  }
  return headings;
}

function sectionBody(
  lines: readonly string[],
  headings: readonly Heading[],
  opening: string,
): string {
  const index = headings.findIndex((heading) =>
    heading.title.startsWith(opening),
  );
  if (index < 0) return "";
  const heading = headings[index];
  const next = headings
    .slice(index + 1)
    .find((candidate) => candidate.depth <= heading.depth);
  const end = next === undefined ? lines.length : next.line;
  return lines
    .slice(heading.line + 1, end)
    .join("\n")
    .trim();
}
