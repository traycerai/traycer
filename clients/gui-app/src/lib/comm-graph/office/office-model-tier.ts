/**
 * The coarse size class of a model, from its NAME alone.
 *
 * A name heuristic, and deliberately so: the office wants a desk to say
 * "big model" or "small model" at a glance, and there is no field on the
 * record that says it. Nothing downstream is decided by this - it picks a
 * monitor sprite and a word on the hover card - so being wrong about an
 * unfamiliar name costs a slightly wrong desk, never a wrong answer.
 *
 * SMALL BEATS LARGE when a name matches both. `gpt-5-mini` carries its family
 * and its size, and the size is the more specific claim: a mini is a mini
 * whatever it is a mini OF. The same rule makes `o3-mini` small and
 * `gemini-2.5-flash` small while their full-size siblings stay large.
 */
import type { OfficeModelTier } from "@/lib/comm-graph/office/office-types";

/**
 * Markers match on TOKEN boundaries, not as bare substrings. Model slugs are
 * `-`, `.`, `_` and `/` separated, and a bare `includes` reads "mini" inside
 * "gemini" - which made every Gemini model a small one. The boundary is the
 * difference between naming a size and finding three letters.
 */
const MARKER_BOUNDARY = String.raw`(?:^|[-_./\s])`;
const MARKER_END = String.raw`(?:[-_./\s]|$)`;

function hasMarker(name: string, marker: string): boolean {
  const escaped = marker.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`${MARKER_BOUNDARY}${escaped}${MARKER_END}`).test(name);
}

/** Size qualifiers. Checked FIRST - see the note on precedence above. */
const SMALL_MARKERS: ReadonlyArray<string> = [
  "haiku",
  "mini",
  "nano",
  "flash",
  "lite",
  "small",
];

/** Families and qualifiers that mean a frontier-size model. */
const LARGE_MARKERS: ReadonlyArray<string> = [
  "opus",
  "gpt-5",
  "gpt-4.5",
  "o1",
  "o3",
  "grok-4",
  "gemini-2.5-pro",
  "max",
  "ultra",
  "pro",
];

/**
 * Sonnet is the one family that spans the classes: 3.5 is a mid-size model and
 * 4.5 onwards is not. Version-gated rather than listed, so a future 6 lands on
 * the right side without an edit here.
 *
 * A DASH is a decimal point here. Slugs write the same version both ways -
 * `sonnet-4.5` and `sonnet-4-5` are one model - and reading only the dot form
 * parsed the second as bare 4, putting a frontier model at a mid-size desk.
 *
 * Each number is capped at two digits and must not be followed by another,
 * which is what keeps a DATE out of the version. `claude-sonnet-4-20250514` is
 * Sonnet 4 with a release stamp, not Sonnet 4.20250514, and
 * `claude-3-5-sonnet-20241022` has no version after the word at all - matching
 * its stamp read that model as version 20241022 and called it large.
 */
const SONNET_VERSION = /sonnet[-\s_]?(\d{1,2}(?:[.-]\d{1,2}(?!\d))?)(?!\d)/;
const LARGE_SONNET_FROM = 4.5;

function isLargeSonnet(name: string): boolean {
  const match = SONNET_VERSION.exec(name);
  if (match === null) return false;
  // At most one separator can appear inside the captured version, so a single
  // replacement normalizes the dashed form onto the dotted one.
  const version = Number.parseFloat(match[1].replace("-", "."));
  return Number.isFinite(version) && version >= LARGE_SONNET_FROM;
}

export function officeModelTier(model: string | null): OfficeModelTier {
  // No model named is not a claim that it is small; an unconfigured chat gets
  // the ordinary desk rather than being singled out by its furniture.
  if (model === null) return "medium";
  const name = model.toLowerCase();
  if (SMALL_MARKERS.some((marker) => hasMarker(name, marker))) return "small";
  if (isLargeSonnet(name)) return "large";
  if (LARGE_MARKERS.some((marker) => hasMarker(name, marker))) return "large";
  return "medium";
}
