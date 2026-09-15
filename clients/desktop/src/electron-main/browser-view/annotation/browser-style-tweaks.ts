import { boundedString } from "../guards";
import { ELEMENT_PICKER_LIMITS } from "./browser-element-picker-script";

/**
 * Live CSS tweaks a user tries on the elements they are annotating.
 *
 * ## Why this exists
 *
 * "Make this button bigger" is a request an agent has to guess at. "I set
 * `padding: 12px 20px` and `font-size: 15px` and it looks right" is not. Letting
 * someone try the change in the page and then SEND what they tried turns a
 * description into a specification, and the trying is the part that was missing -
 * a marked element with a comment carries the intent but never the values.
 *
 * ## Why declarations, not a property inspector
 *
 * A property-by-property inspector is a lot of overlay UI for a narrower result:
 * it can only offer the properties it was built to know about, and the thing a
 * developer already has in their head is the declaration they would type in a
 * stylesheet. Parsing `padding: 12px; color: #333` accepts exactly that, and
 * anything the browser rejects simply does not apply - which is the same feedback
 * a stylesheet gives.
 *
 * ## Why the previous value is recorded
 *
 * A tweak is only meaningful as a change. `font-size: 15px` alone does not say
 * whether that is bigger or smaller, and an agent editing a stylesheet needs to
 * find what is there now. The previous COMPUTED value answers both.
 */
export interface BrowserStyleTweak {
  /** The selector of the element the tweak was applied to. */
  readonly selector: string;
  readonly property: string;
  /** Computed value before the tweak, so the change is legible. */
  readonly previousValue: string;
  readonly value: string;
}

/** A single parsed declaration, before it is applied to anything. */
export interface BrowserStyleDeclaration {
  readonly property: string;
  readonly value: string;
}

/**
 * How many declarations one annotation can carry.
 *
 * Generous for a real tweak (a handful of properties on a handful of elements)
 * and bounded because this text reaches a prompt, where an unbounded paste would
 * crowd out the annotation it is meant to explain.
 */
export const STYLE_TWEAK_MAX_DECLARATIONS = 24;
/**
 * How many tweak rows the summary may carry.
 *
 * `STYLE_TWEAK_MAX_DECLARATIONS` bounds what one TEXTAREA can express; this
 * bounds the product of that and the mark set, which is what actually reaches a
 * chat: 24 declarations applied to 30 marked elements is 720 rows, each carrying
 * a page-controlled previous value.
 */
const STYLE_TWEAK_MAX_SUMMARY_ROWS = 60;
/**
 * How long the whole summary may be.
 *
 * The row cap alone is not enough: `previousValue` is a COMPUTED value read off
 * the page, and computed values are not short - a `background-image` with inline
 * data, a long `font-family` stack, a `grid-template-areas`. The row cap bounds
 * the count and this bounds the size.
 */
const STYLE_TWEAK_MAX_SUMMARY_CHARS = 4_000;

/**
 * Parses a CSS declaration list the way a stylesheet would read it.
 *
 * Total, never throwing: the input is half-typed text from a textarea, so an
 * incomplete declaration is the normal state rather than an error. Anything that
 * is not `property: value` is skipped, which means a user mid-keystroke sees the
 * declarations they have finished applied and nothing else.
 *
 * Splitting is structural rather than `split(";")` because both delimiters occur
 * INSIDE legal values: `background: url(data:image/png;base64,...)` carries a
 * colon and a semicolon, `content: "a;b"` carries one in a string, and a comment
 * can carry either. A plain split turned each of those into two broken
 * declarations, silently discarding what the user typed.
 */
export function parseStyleDeclarations(
  input: string,
): readonly BrowserStyleDeclaration[] {
  const out: BrowserStyleDeclaration[] = [];
  for (const chunk of splitTopLevel(input, ";")) {
    if (out.length >= STYLE_TWEAK_MAX_DECLARATIONS) break;
    const separator = indexOfTopLevel(chunk, ":");
    if (separator < 0) continue;
    const property = normalizeProperty(chunk.slice(0, separator));
    const value = chunk.slice(separator + 1).trim();
    if (property === null || value.length === 0) continue;
    out.push({
      property,
      value: boundedString(value, ELEMENT_PICKER_LIMITS.styleValue, ""),
    });
  }
  return out;
}

/**
 * Walks CSS text, calling back only at positions that are structurally top level.
 *
 * One pass, because quotes, parentheses and comments all have to be tracked
 * together: a parenthesis can be unbalanced inside a string, as in
 * `url("a)b")`, and a quote can appear inside a comment.
 *
 * The callback returns `true` to stop the walk, which is what lets one scanner
 * serve both "split at every delimiter" and "find the first one".
 */
function scanCss(
  input: string,
  onTopLevel: (index: number, character: string) => boolean,
): void {
  let quote: string | null = null;
  let depth = 0;
  let inComment = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) continue;
    if (inComment) {
      if (character === "*" && input[index + 1] === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      // A backslash escapes the next character, including the closing quote.
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\\") {
      // An escape outside a string too. CSS strips the syntactic meaning of an
      // escaped code point, so `--x: a\;b` is ONE declaration whose value
      // contains a semicolon - treating it as a separator truncated the value at
      // the very character the author wrote to protect it.
      index += 1;
      continue;
    }
    if (character === "/" && input[index + 1] === "*") {
      inComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth = depth > 0 ? depth - 1 : 0;
      continue;
    }
    if (depth === 0 && onTopLevel(index, character)) return;
  }
}

/** Splits on a delimiter that is not inside a string, parentheses or a comment. */
function splitTopLevel(input: string, delimiter: string): string[] {
  const out: string[] = [];
  let start = 0;
  scanCss(input, (index, character) => {
    if (character !== delimiter) return false;
    out.push(input.slice(start, index));
    start = index + 1;
    return false;
  });
  out.push(input.slice(start));
  return out;
}

/** The first occurrence of a delimiter at the top level, or `-1`. */
function indexOfTopLevel(input: string, delimiter: string): number {
  let found = -1;
  scanCss(input, (index, character) => {
    if (character !== delimiter) return false;
    found = index;
    return true;
  });
  return found;
}

/**
 * A property name, or `null` when the text is not one.
 *
 * Custom properties (`--brand`) are allowed through because they are exactly the
 * kind of thing a themed page is tuned with. Anything else must look like a CSS
 * identifier: this string is handed to `style.setProperty`, and a value that is
 * not a property name is a silent no-op that would still be recorded as a tweak.
 */
function normalizeProperty(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("--")) {
    // Custom property names are case-SENSITIVE: `--Brand` and `--brand` are two
    // different properties, so lowercasing here would set one the page never
    // declared and report a tweak that changes nothing.
    return /^--[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
  }
  const lowered = trimmed.toLowerCase();
  // A leading hyphen is a vendor prefix (`-webkit-transform`), but a name has
  // to contain a letter: `-` alone matched a hyphen-only pattern and would have
  // been recorded as a tweak that did nothing.
  return /^-?[a-z][a-z0-9-]*$/.test(lowered) ? lowered : null;
}

/**
 * Renders tweaks as the sentence an agent reads.
 *
 * The annotation's own `comment` is the only free-form text that reaches a chat,
 * so the tweaks ride there rather than in a new persisted field: the annotation
 * record is a released wire contract, and a new property on it at a shipped
 * version is a break with no upside for something that is, in the end, prose for
 * a model to read.
 *
 * Grouped by element rather than listed flat, because "this element, these
 * properties" is how a stylesheet edit is shaped.
 */
export function describeStyleTweaks(
  tweaks: readonly BrowserStyleTweak[],
): string {
  if (tweaks.length === 0) return "";
  const bySelector = new Map<string, BrowserStyleTweak[]>();
  for (const tweak of tweaks) {
    const existing = bySelector.get(tweak.selector);
    if (existing === undefined) bySelector.set(tweak.selector, [tweak]);
    else existing.push(tweak);
  }
  const lines: string[] = ["Style tweaks tried in the page:"];
  let rows = 0;
  let truncated = false;
  for (const [selector, group] of bySelector) {
    if (rows >= STYLE_TWEAK_MAX_SUMMARY_ROWS) {
      truncated = true;
      break;
    }
    lines.push(`- ${selector}`);
    for (const tweak of group) {
      if (rows >= STYLE_TWEAK_MAX_SUMMARY_ROWS) {
        truncated = true;
        break;
      }
      lines.push(
        `  ${tweak.property}: ${tweak.value} (was ${boundedString(
          tweak.previousValue,
          ELEMENT_PICKER_LIMITS.styleValue,
          "",
        )})`,
      );
      rows += 1;
    }
  }
  // Said rather than silently dropped: an agent reading a list that stops has to
  // know the list stopped, or it will treat what it got as the whole intent.
  if (truncated) lines.push("  (further tweaks omitted)");
  const summary = lines.join("\n");
  if (summary.length <= STYLE_TWEAK_MAX_SUMMARY_CHARS) return summary;
  // Room reserved for the marker BEFORE slicing, or the cap is not a cap: the
  // previous form cut to the limit and then appended, returning a string longer
  // than the bound it exists to enforce.
  const marker = "\n  (truncated)";
  // `Math.max(0, ...)` so the cap holds even if it were ever set below the
  // marker's own length: `slice(0, negative)` counts from the END and would
  // return a string LONGER than the bound, which is the opposite of a cap.
  return (
    summary.slice(
      0,
      Math.max(0, STYLE_TWEAK_MAX_SUMMARY_CHARS - marker.length),
    ) + marker
  );
}

/**
 * Folds a tweak summary into the user's comment.
 *
 * The user's own words come first and are never edited: they are the request, and
 * the tweaks are evidence for it. A comment that is empty still gets the summary,
 * because the tweaks alone are a complete enough instruction.
 */
export function commentWithStyleTweaks(
  comment: string,
  tweaks: readonly BrowserStyleTweak[],
): string {
  const summary = describeStyleTweaks(tweaks);
  if (summary.length === 0) return comment;
  const trimmed = comment.trim();
  return trimmed.length === 0 ? summary : `${trimmed}\n\n${summary}`;
}
