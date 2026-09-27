import { Buffer } from "node:buffer";
import { parseSync, Visitor, type Plugin, type Rolldown } from "vite";

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
 *   would turn into an identifier character. An astral character becomes one
 *   `\u{XXXXX}` code point escape: an identifier cannot be spelled with the
 *   two halves of a surrogate pair;
 * - U+2028 and U+2029: left alone everywhere. They can be line terminators,
 *   and replacing one would change the chunk's line structure - and every
 *   source-map line after it.
 *
 * Nothing here adds or removes a line, so a chunk's source map only needs its
 * columns shifted along each edited line (see {@link shiftMappingColumns}).
 * The rewritten chunk is parsed again and the build fails if it does not
 * parse, rather than shipping a chunk that might not load.
 *
 * A chunk's map lives in two places, and both are shifted. The `.map` asset is
 * what gets written. `output.map` is what LATER `generateBundle` hooks build
 * on: Vite's own run after every `post` plugin, and its import analysis, on
 * rewriting a chunk's preload list, composes that edit onto `output.map` and
 * rewrites the asset from the result. With only the asset shifted, that
 * rewrite silently brings back the unshifted columns.
 *
 * JavaScript that a library ships prebuilt - pdf.js's worker - reaches the
 * bundle as an ASSET, not a chunk, and is rewritten the same way.
 */
export function asciiOnlyOutput(): Plugin {
  return {
    name: "traycer-ascii-only-output",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          const rewrite = escapeNonAsciiJavaScript(
            output.code,
            output.fileName,
          );
          if (rewrite === null) continue;
          output.code = rewrite.code;
          if (output.map !== null) {
            output.map = withShiftedSourceMap(output.map, rewrite.lineEdits);
          }
          shiftMapAsset(bundle, output.fileName, rewrite.lineEdits);
        } else if (JAVASCRIPT_FILE_RE.test(output.fileName)) {
          const rewrite = escapeNonAsciiJavaScript(
            assetText(output.source),
            output.fileName,
          );
          if (rewrite === null) continue;
          output.source = rewrite.code;
          shiftMapAsset(bundle, output.fileName, rewrite.lineEdits);
        }
      }
    },
  };
}

const JAVASCRIPT_FILE_RE = /\.m?js$/;

/** Strict UTF-8: a JavaScript asset that is not valid UTF-8 fails the build. */
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function assetText(source: string | Uint8Array): string {
  return typeof source === "string" ? source : UTF8.decode(source);
}

/** Shifts the columns of `<fileName>.map`, when the bundle carries one. */
function shiftMapAsset(
  bundle: Rolldown.OutputBundle,
  fileName: string,
  lineEdits: ReadonlyMap<number, readonly ColumnEdit[]>,
): void {
  const mapFileName = `${fileName}.map`;
  if (!(mapFileName in bundle)) return;
  const mapAsset = bundle[mapFileName];
  if (mapAsset.type !== "asset") return;
  // An asset's source can be bytes as well as text; both carry the mappings.
  mapAsset.source = withShiftedMappings(assetText(mapAsset.source), lineEdits);
}

/**
 * `map` with its columns shifted. A new object, assigned back to the chunk:
 * rolldown hands the next hook the map it was given, and `toString` and
 * `toUrl` must serialise the shifted mappings, not the original ones.
 */
function withShiftedSourceMap(
  map: Rolldown.SourceMap,
  lineEdits: ReadonlyMap<number, readonly ColumnEdit[]>,
): Rolldown.SourceMap {
  const shifted: Rolldown.SourceMap = {
    ...map,
    mappings: shiftMappingColumns(map.mappings, lineEdits),
    toString: () => JSON.stringify(shifted),
    toUrl: () =>
      `data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(shifted), "utf-8").toString("base64")}`,
  };
  return shifted;
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
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;
const BACKSLASH = 0x5c;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

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

    const { start, end, text } = replacementAt(
      code,
      offset,
      inSpan ? span : null,
    );
    NON_ASCII_RE.lastIndex = end;
    parts.push(code.slice(copiedThrough, start), text);
    copiedThrough = end;
    const line = lineIndexOf(lineStarts, start);
    const edits = lineEdits.get(line) ?? [];
    edits.push({
      column: start - lineStarts[line],
      removed: end - start,
      inserted: text.length,
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

interface Replacement {
  /** First code unit replaced: an escaping backslash, when one is folded in. */
  readonly start: number;
  /** One past the last code unit replaced. */
  readonly end: number;
  readonly text: string;
}

/** How the character at `offset` is rewritten, inside `span` or outside any. */
function replacementAt(
  code: string,
  offset: number,
  span: Span | null,
): Replacement {
  const unit = code.charCodeAt(offset);
  if (span !== null) {
    const start = escapedByBackslash(code, offset, span.start)
      ? offset - 1
      : offset;
    return { start, end: offset + 1, text: unicodeEscape(unit) };
  }
  if (isSurrogatePairAt(code, offset)) {
    return {
      start: offset,
      end: offset + 2,
      text: codePointEscape(code.codePointAt(offset) ?? unit),
    };
  }
  return {
    start: offset,
    end: offset + 1,
    text: WHITESPACE_RE.test(code[offset]) ? " " : unicodeEscape(unit),
  };
}

function unicodeEscape(unit: number): string {
  return `\\u${unit.toString(16).padStart(4, "0")}`;
}

function codePointEscape(codePoint: number): string {
  return `\\u{${codePoint.toString(16)}}`;
}

function isSurrogatePairAt(code: string, offset: number): boolean {
  const high = code.charCodeAt(offset);
  const low = code.charCodeAt(offset + 1);
  return (
    high >= HIGH_SURROGATE_MIN &&
    high <= HIGH_SURROGATE_MAX &&
    low >= LOW_SURROGATE_MIN &&
    low <= LOW_SURROGATE_MAX
  );
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

/**
 * Where each line of `code` starts, by ECMAScript's line terminators: LF, CR,
 * CRLF (one break), U+2028 and U+2029. That is how rolldown numbers a map's
 * lines - a separator kept in a tagged template starts a new `mappings` line -
 * so counting LF alone would put every edit after one on the wrong line.
 */
function lineStartOffsets(code: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < code.length; index += 1) {
    const unit = code.charCodeAt(index);
    if (unit === CARRIAGE_RETURN && code.charCodeAt(index + 1) === LINE_FEED) {
      continue;
    }
    if (
      unit === LINE_FEED ||
      unit === CARRIAGE_RETURN ||
      unit === LINE_SEPARATOR ||
      unit === PARAGRAPH_SEPARATOR
    ) {
      starts.push(index + 1);
    }
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
