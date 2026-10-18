import { finishAttributeEdit, setAttribute } from "./edits";
import { decodeMapped, mappedRange, type MappedText } from "./mapped-text";
import { asciiLower } from "./parse";
import { applySplices, escapeAttribute, locateElement } from "./source";
import type {
  EditResult,
  ElementLocator,
  SourceRange,
  SourceSplice,
} from "./types";

interface CssScan {
  semicolons: number[];
  colons: number[];
  bangs: number[];
}

interface CssIdentifier {
  value: string;
  end: number;
}

function isCssSpace(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\r" ||
    char === "\f"
  );
}

/** CSS escapes consume up to six hex digits and one optional whitespace. */
function escapedCodePoint(
  value: string,
  start: number,
  end: number,
): CssIdentifier | null {
  let cursor = start + 1;
  if (cursor >= end || /[\n\r\f]/.test(value.charAt(cursor))) return null;
  const hexStart = cursor;
  while (
    cursor < end &&
    cursor - hexStart < 6 &&
    /[0-9a-fA-F]/.test(value.charAt(cursor))
  )
    cursor++;
  if (cursor === hexStart) {
    const code = value.codePointAt(cursor);
    if (code === undefined) return null;
    const decoded = String.fromCodePoint(code);
    return { value: decoded, end: cursor + decoded.length };
  }
  const code = Number.parseInt(value.slice(hexStart, cursor), 16);
  if (isCssSpace(value.charAt(cursor)) && cursor < end) {
    cursor += value[cursor] === "\r" && value[cursor + 1] === "\n" ? 2 : 1;
  }
  return {
    value: String.fromCodePoint(
      code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? 0xfffd
        : code,
    ),
    end: cursor,
  };
}

function cssIdentifier(
  value: string,
  start: number,
  end: number,
): CssIdentifier {
  const parts: string[] = [];
  let cursor = start;
  while (cursor < end) {
    const char = value.charAt(cursor);
    if (char === "\\") {
      const escaped = escapedCodePoint(value, cursor, end);
      if (!escaped) break;
      parts.push(escaped.value);
      cursor = escaped.end;
    } else if (/[a-zA-Z0-9_-]/.test(char) || char.charCodeAt(0) >= 0x80) {
      parts.push(char);
      cursor++;
    } else break;
  }
  return { value: parts.join(""), end: cursor };
}

/** An unquoted url() is one token: '/*' is URL data, never a CSS comment. */
function unquotedUrlEnd(value: string, start: number): number | null {
  let cursor = start;
  while (cursor < value.length) {
    const char = value.charAt(cursor);
    if (char === ")") return cursor + 1;
    if (char === "\\") {
      const escaped = escapedCodePoint(value, cursor, value.length);
      if (!escaped) return null;
      cursor = escaped.end;
    } else if (isCssSpace(char)) {
      while (isCssSpace(value.charAt(cursor))) cursor++;
      return value[cursor] === ")" ? cursor + 1 : null;
    } else if (
      char === '"' ||
      char === "'" ||
      char === "(" ||
      /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(char)
    )
      return null;
    else cursor++;
  }
  return null;
}

/** Find separators only outside strings, comments, URL tokens, and blocks. */
function scanCss(value: string): CssScan | null {
  const stack: string[] = [];
  const result: CssScan = { semicolons: [], colons: [], bangs: [] };
  let quote = "";
  for (let index = 0; index < value.length; index++) {
    const char = value.charAt(index);
    if (quote) {
      if (char === "\\") {
        if (index + 1 === value.length) return null;
        if (/[\n\r\f]/.test(value.charAt(index + 1))) {
          index +=
            value[index + 1] === "\r" && value[index + 2] === "\n" ? 2 : 1;
        } else {
          const escaped = escapedCodePoint(value, index, value.length);
          if (!escaped) return null;
          index = escaped.end - 1;
        }
      } else if (char === quote) quote = "";
      else if (char === "\n" || char === "\r" || char === "\f") return null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "/" && value[index + 1] === "*") {
      const end = value.indexOf("*/", index + 2);
      if (end < 0) return null;
      index = end + 1;
      continue;
    }
    const identifier = cssIdentifier(value, index, value.length);
    if (identifier.end > index) {
      if (
        asciiLower(identifier.value) === "url" &&
        value[identifier.end] === "("
      ) {
        let contentStart = identifier.end + 1;
        while (isCssSpace(value.charAt(contentStart))) contentStart++;
        if (value[contentStart] !== '"' && value[contentStart] !== "'") {
          const end = unquotedUrlEnd(value, contentStart);
          if (end === null) return null;
          index = end - 1;
          continue;
        }
      }
      index = identifier.end - 1;
      continue;
    }
    if (char === "\\") return null;
    if (char === "(" || char === "[" || char === "{") stack.push(char);
    else if (char === ")" || char === "]" || char === "}") {
      const open = stack.pop();
      if (open !== (char === ")" ? "(" : char === "]" ? "[" : "{")) return null;
    } else if (stack.length === 0) {
      if (char === ";") result.semicolons.push(index);
      else if (char === ":") result.colons.push(index);
      else if (char === "!") result.bangs.push(index);
    }
  }
  return quote || stack.length ? null : result;
}

interface Declaration {
  name: string;
  range: SourceRange;
  valueRange: SourceRange;
  important: boolean;
}

function skipTrivia(value: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end) {
    if (isCssSpace(value.charAt(cursor))) cursor++;
    else if (value.slice(cursor, cursor + 2) === "/*") {
      const next = value.indexOf("*/", cursor + 2);
      if (next < 0 || next + 2 > end) break;
      cursor = next + 2;
    } else break;
  }
  return cursor;
}

function importantStart(
  value: string,
  scan: CssScan,
  start: number,
  end: number,
): number | null {
  for (let index = scan.bangs.length - 1; index >= 0; index--) {
    const bang = scan.bangs[index];
    if (bang === undefined || bang < start || bang >= end) continue;
    const identifier = cssIdentifier(
      value,
      skipTrivia(value, bang + 1, end),
      end,
    );
    if (
      asciiLower(identifier.value) === "important" &&
      skipTrivia(value, identifier.end, end) === end
    )
      return bang;
  }
  return null;
}

function propertyKey(property: string): string {
  return property.startsWith("--") ? property : asciiLower(property);
}

function declarations(value: string, scan: CssScan): Declaration[] {
  const result: Declaration[] = [];
  let start = 0;
  for (const end of [...scan.semicolons, value.length]) {
    const colon = scan.colons.find(
      (position) => position >= start && position < end,
    );
    if (colon !== undefined) {
      const propertyStart = skipTrivia(value, start, colon);
      const name = value
        .slice(propertyStart, colon)
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .trim();
      const valueStart = skipTrivia(value, colon + 1, end);
      let valueEnd = end;
      while (valueEnd > valueStart && /\s/u.test(value.charAt(valueEnd - 1)))
        valueEnd--;
      const important = importantStart(value, scan, valueStart, end);
      if (important !== null) {
        valueEnd = important;
        while (valueEnd > valueStart && isCssSpace(value.charAt(valueEnd - 1)))
          valueEnd--;
      }
      result.push({
        name: propertyKey(name),
        range: {
          start: propertyStart,
          end: end < value.length ? end + 1 : end,
        },
        valueRange: { start: valueStart, end: valueEnd },
        important: important !== null,
      });
    }
    start = end + 1;
  }
  return result;
}

function hasBoundary(mapped: MappedText, index: number): boolean {
  const left = mapped.ranges[index - 1];
  const right = mapped.ranges[index];
  return !left || !right || left.end <= right.start;
}

/** Edits inline CSS only. Semantic CSS validation belongs to the browser UI. */
export function setStyleDeclaration(
  text: string,
  locator: ElementLocator,
  property: string,
  value: string | null,
): EditResult {
  const located = locateElement(text, locator);
  if (!located.ok) return located;
  const { element } = located;
  if (!element.startTag) return { ok: false, reason: "not-literal" };
  if (!/^(?:--[\w-]+|-?[a-zA-Z][\w-]*)$/.test(property))
    return { ok: false, reason: "invalid-style-property" };
  if (value !== null) {
    const scan = scanCss(value);
    if (!scan || scan.semicolons.length || !value.trim())
      return { ok: false, reason: "invalid-style-value" };
  }
  const attrs = element.attrs.filter((attr) => attr.name === "style");
  if (attrs.length > 1) return { ok: false, reason: "duplicate-attribute" };
  const attr = attrs[0];
  if (!attr?.valueRange) {
    return value === null
      ? finishAttributeEdit(text, element, [])
      : setAttribute(text, locator, "style", `${property}: ${value}`);
  }
  const mapped = decodeMapped(
    text.slice(attr.valueRange.start, attr.valueRange.end),
    attr.valueRange.start,
    "attribute",
  );
  if (mapped.value !== attr.value)
    return { ok: false, reason: "unsafe-source-range" };
  const scan = scanCss(mapped.value);
  if (!scan) return { ok: false, reason: "malformed-style" };
  const matches = declarations(mapped.value, scan).filter(
    (decl) => decl.name === propertyKey(property),
  );
  const decodedSplices: SourceSplice[] = [];
  if (value === null) {
    for (const declaration of matches)
      decodedSplices.push({ ...declaration.range, replacement: "" });
  } else {
    const importantMatches = matches.filter((decl) => decl.important);
    const winner = importantMatches.length
      ? importantMatches[importantMatches.length - 1]
      : matches[matches.length - 1];
    if (winner) {
      const valueScan = scanCss(value);
      const priority = valueScan
        ? importantStart(value, valueScan, 0, value.length)
        : null;
      const replacement =
        winner.important && priority !== null
          ? value.slice(0, priority).trimEnd()
          : value;
      if (!replacement.trim())
        return { ok: false, reason: "invalid-style-value" };
      decodedSplices.push({ ...winner.valueRange, replacement });
    } else {
      const lastSemicolon = scan.semicolons[scan.semicolons.length - 1];
      const hasContent =
        skipTrivia(mapped.value, 0, mapped.value.length) < mapped.value.length;
      const terminated =
        lastSemicolon !== undefined &&
        skipTrivia(mapped.value, lastSemicolon + 1, mapped.value.length) ===
          mapped.value.length;
      const separator = !hasContent ? "" : terminated ? " " : "; ";
      decodedSplices.push({
        start: mapped.value.length,
        end: mapped.value.length,
        replacement: `${separator}${property}: ${value}`,
      });
    }
  }
  if (!decodedSplices.length) return finishAttributeEdit(text, element, []);
  // An unquoted attribute must acquire delimiters when CSS adds whitespace.
  // Keep its authored value bytes; only new CSS needs HTML escaping.
  if (!attr.quote) {
    const splices = decodedSplices.map((splice) => ({
      ...mappedRange(
        mapped,
        splice.start,
        splice.end,
        attr.valueRange?.end ?? 0,
      ),
      replacement: escapeAttribute(splice.replacement, '"'),
    }));
    if (
      decodedSplices.some(
        (splice) =>
          !hasBoundary(mapped, splice.start) ||
          !hasBoundary(mapped, splice.end),
      )
    )
      return { ok: false, reason: "unsafe-source-range" };
    const changed = applySplices(text, splices).text;
    const delta = splices.reduce(
      (sum, splice) =>
        sum + splice.replacement.length - (splice.end - splice.start),
      0,
    );
    const raw = changed.slice(
      attr.valueRange.start,
      attr.valueRange.end + delta,
    );
    return finishAttributeEdit(text, element, [
      { ...attr.valueRange, replacement: `"${raw.replaceAll('"', "&quot;")}"` },
    ]);
  }
  const splices: SourceSplice[] = [];
  for (const splice of decodedSplices) {
    if (!hasBoundary(mapped, splice.start) || !hasBoundary(mapped, splice.end))
      return { ok: false, reason: "unsafe-source-range" };
    splices.push({
      ...mappedRange(mapped, splice.start, splice.end, attr.valueRange.end),
      replacement: escapeAttribute(splice.replacement, attr.quote),
    });
  }
  return finishAttributeEdit(text, element, splices);
}
