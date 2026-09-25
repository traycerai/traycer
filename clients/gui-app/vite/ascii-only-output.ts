import { parseSync, Visitor, type Plugin } from "vite";

/**
 * # ASCII-only JavaScript output
 *
 * JavaScriptCore (and V8) keep a script's source as an 8-bit string only while
 * every character in it fits in Latin-1. One character above U+00FF - an
 * ellipsis in a UI string, an em dash in a comment, a table of HTML entities -
 * stores the WHOLE chunk as UTF-16, doubling what its source costs to keep
 * resident. Minified output keeps such characters raw, so a handful of them
 * doubles megabytes of boot source.
 *
 * Neither rolldown nor its oxc minifier has an ASCII-only charset option, and
 * the minifier runs AFTER `renderChunk` and prints escapes back out as raw
 * characters. So the rewrite runs in `generateBundle`, on the final code.
 *
 * Each character above U+007F is rewritten by where it sits:
 *
 * - inside a string, regular expression or untagged template: `\uXXXX`, the
 *   same character by the spec in all three (an astral character becomes its
 *   surrogate pair, which a `u`-flag pattern recombines). A backslash that
 *   was escaping the character is folded in - `\…` is the character itself,
 *   and escaping only the character would leave `\\u2026`, a backslash;
 * - inside a TAGGED template: left alone. The tag can read the raw text
 *   (`String.raw`), and an escape would change it;
 * - elsewhere - identifiers and comments - `\uXXXX` for a non-whitespace
 *   character, and a plain space for Unicode whitespace, which an escape
 *   would turn into an identifier character;
 * - U+2028 and U+2029: left alone everywhere. They can be line terminators,
 *   and replacing one would change the chunk's line structure - and every
 *   source-map line after it.
 *
 * Nothing here adds or removes a line, so a chunk's source map only needs its
 * columns shifted along each edited line (see {@link shiftMappingColumns}).
 * The rewritten chunk is parsed again and the build fails if it does not
 * parse, rather than shipping a chunk that might not load.
 */
export function asciiOnlyOutput(): Plugin {
  return {
    name: "traycer-ascii-only-output",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const rewrite = escapeNonAsciiJavaScript(output.code, output.fileName);
        if (rewrite === null) continue;
        output.code = rewrite.code;
        // The map the build writes is this asset, not `output.map`.
        const mapFileName = `${output.fileName}.map`;
        if (!(mapFileName in bundle)) continue;
        const mapAsset = bundle[mapFileName];
        if (mapAsset.type === "asset" && typeof mapAsset.source === "string") {
          mapAsset.source = withShiftedMappings(
            mapAsset.source,
            rewrite.lineEdits,
          );
        }
      }
    },
  };
}

/** One replacement, on one line of the ORIGINAL code, in UTF-16 columns. */
export interface ColumnEdit {
  readonly column: number;
  readonly removed: number;
  readonly inserted: number;
}

export interface AsciiRewrite {
  readonly code: string;
  /** Edits per original line index, in column order. */
  readonly lineEdits: ReadonlyMap<number, readonly ColumnEdit[]>;
}

const NON_ASCII_RE = /[\u0080-\uffff]/g;
const WHITESPACE_RE = /\s/;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;
const BACKSLASH = 0x5c;

type SpanKind = "literal" | "raw";

interface Span {
  readonly start: number;
  readonly end: number;
  readonly kind: SpanKind;
}

/**
 * The rewrite of `code`, or `null` when it is already ASCII. Throws when
 * `code` - or the rewrite - does not parse.
 */
export function escapeNonAsciiJavaScript(
  code: string,
  filename: string,
): AsciiRewrite | null {
  NON_ASCII_RE.lastIndex = 0;
  if (!NON_ASCII_RE.test(code)) return null;
  const spans = literalSpans(code, filename);
  const lineStarts = lineStartOffsets(code);
  const parts: string[] = [];
  const lineEdits = new Map<number, ColumnEdit[]>();
  let copiedThrough = 0;
  let spanIndex = 0;
  NON_ASCII_RE.lastIndex = 0;
  for (
    let match = NON_ASCII_RE.exec(code);
    match !== null;
    match = NON_ASCII_RE.exec(code)
  ) {
    const offset = match.index;
    const unit = code.charCodeAt(offset);
    if (unit === LINE_SEPARATOR || unit === PARAGRAPH_SEPARATOR) continue;
    while (spanIndex < spans.length && spans[spanIndex].end <= offset) {
      spanIndex += 1;
    }
    const inSpan = spanIndex < spans.length && spans[spanIndex].start <= offset;
    const span = spans[spanIndex];
    if (inSpan && span.kind === "raw") continue;

    let start = offset;
    let replacement: string;
    if (inSpan) {
      if (escapedByBackslash(code, offset, span.start)) start -= 1;
      replacement = unicodeEscape(unit);
    } else {
      replacement = WHITESPACE_RE.test(match[0]) ? " " : unicodeEscape(unit);
    }
    parts.push(code.slice(copiedThrough, start), replacement);
    copiedThrough = offset + 1;
    const line = lineIndexOf(lineStarts, start);
    const edits = lineEdits.get(line) ?? [];
    edits.push({
      column: start - lineStarts[line],
      removed: offset + 1 - start,
      inserted: replacement.length,
    });
    lineEdits.set(line, edits);
  }
  if (lineEdits.size === 0) return null;
  parts.push(code.slice(copiedThrough));
  const rewritten = parts.join("");
  const reparsed = parseSync(filename, rewritten);
  if (reparsed.errors.length > 0) {
    throw new Error(
      `ascii-only-output: ${filename} does not parse after escaping: ${reparsed.errors[0].message}`,
    );
  }
  return { code: rewritten, lineEdits };
}

function unicodeEscape(unit: number): string {
  return `\\u${unit.toString(16).padStart(4, "0")}`;
}

/** An odd run of backslashes right before `offset`, within the literal. */
function escapedByBackslash(
  code: string,
  offset: number,
  literalStart: number,
): boolean {
  let backslashes = 0;
  for (
    let index = offset - 1;
    index >= literalStart && code.charCodeAt(index) === BACKSLASH;
    index -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Where the literals are: strings, regular expressions and template text are
 * `literal`; the text of a tagged template is `raw`. Sorted, non-overlapping.
 */
function literalSpans(code: string, filename: string): readonly Span[] {
  const parsed = parseSync(filename, code);
  if (parsed.errors.length > 0) {
    throw new Error(
      `ascii-only-output: ${filename} does not parse: ${parsed.errors[0].message}`,
    );
  }
  const spans: Span[] = [];
  const rawStarts = new Set<number>();
  new Visitor({
    TaggedTemplateExpression(node) {
      for (const quasi of node.quasi.quasis) rawStarts.add(quasi.start);
    },
    TemplateElement(node) {
      spans.push({
        start: node.start,
        end: node.end,
        kind: rawStarts.has(node.start) ? "raw" : "literal",
      });
    },
    Literal(node) {
      if (typeof node.value === "string" || "regex" in node) {
        spans.push({ start: node.start, end: node.end, kind: "literal" });
      }
    },
  }).visit(parsed.program);
  return spans.sort((left, right) => left.start - right.start);
}

function lineStartOffsets(code: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < code.length; index += 1) {
    if (code.charCodeAt(index) === 0x0a) starts.push(index + 1);
  }
  return starts;
}

function lineIndexOf(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function withShiftedMappings(
  source: string,
  lineEdits: ReadonlyMap<number, readonly ColumnEdit[]>,
): string {
  const map: unknown = JSON.parse(source);
  if (
    typeof map !== "object" ||
    map === null ||
    !("mappings" in map) ||
    typeof map.mappings !== "string"
  ) {
    return source;
  }
  return JSON.stringify({
    ...map,
    mappings: shiftMappingColumns(map.mappings, lineEdits),
  });
}

/**
 * `mappings` with every generated column moved to where its character sits
 * after the edits on its line. A column inside a replaced range lands on the
 * start of its replacement.
 */
export function shiftMappingColumns(
  mappings: string,
  lineEdits: ReadonlyMap<number, readonly ColumnEdit[]>,
): string {
  const lines = mappings.split(";");
  return lines
    .map((line, lineIndex) => {
      const edits = lineEdits.get(lineIndex);
      if (edits === undefined || line.length === 0) return line;
      let previousColumn = 0;
      let previousShifted = 0;
      return line
        .split(",")
        .map((segment) => {
          const fields = decodeVlqSegment(segment);
          const column = previousColumn + fields[0];
          previousColumn = column;
          const shifted = shiftedColumn(column, edits);
          fields[0] = shifted - previousShifted;
          previousShifted = shifted;
          return encodeVlqSegment(fields);
        })
        .join(",");
    })
    .join(";");
}

function shiftedColumn(column: number, edits: readonly ColumnEdit[]): number {
  let delta = 0;
  for (const edit of edits) {
    if (edit.column >= column) break;
    if (column < edit.column + edit.removed) return edit.column + delta;
    delta += edit.inserted - edit.removed;
  }
  return column + delta;
}

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUE = new Map(
  Array.from(BASE64, (character, index) => [character, index]),
);

function decodeVlqSegment(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const character of segment) {
    const digit = BASE64_VALUE.get(character);
    if (digit === undefined) {
      throw new Error(`ascii-only-output: bad VLQ digit ${character}`);
    }
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    values.push((value & 1) === 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return values;
}

function encodeVlqSegment(values: readonly number[]): string {
  let out = "";
  for (const signed of values) {
    let value = signed < 0 ? (-signed << 1) | 1 : signed << 1;
    do {
      let digit = value & 31;
      value >>>= 5;
      if (value > 0) digit |= 32;
      out += BASE64[digit];
    } while (value > 0);
  }
  return out;
}
