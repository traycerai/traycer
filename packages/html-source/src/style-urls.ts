import { asciiLower } from "./parse";
import {
  cssIdentifier,
  declarations,
  escapedCodePoint,
  isCssSpace,
  scanCss,
  unquotedUrlEnd,
  type CssIdentifier,
} from "./style";

function safeUrl(value: string): boolean {
  try {
    const url = new URL(value, "https://canvas.invalid/");
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function decodedString(css: string, start: number): CssIdentifier | null {
  const quote = css.charAt(start);
  let value = "";
  for (let cursor = start + 1; cursor < css.length;) {
    const char = css.charAt(cursor);
    if (char === quote) return { value, end: cursor + 1 };
    if (char === "\\") {
      const next = css.charAt(cursor + 1);
      if (/[\n\r\f]/.test(next)) {
        cursor += next === "\r" && css[cursor + 2] === "\n" ? 3 : 2;
        continue;
      }
      const escaped = escapedCodePoint(css, cursor, css.length);
      if (!escaped) return null;
      value += escaped.value;
      cursor = escaped.end;
    } else {
      value += char;
      cursor++;
    }
  }
  return null;
}

const URL_STRING_FUNCTIONS = new Set([
  "url",
  "src",
  "image-set",
  "-webkit-image-set",
]);

/** Walk component values, retaining strings and unquoted URL tokens as units. */
function safeValues(css: string): boolean {
  const functions: string[] = [];
  for (let cursor = 0; cursor < css.length;) {
    const char = css.charAt(cursor);
    if (css.slice(cursor, cursor + 2) === "/*") {
      const end = css.indexOf("*/", cursor + 2);
      if (end < 0) return false;
      cursor = end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const string = decodedString(css, cursor);
      if (!string) return false;
      if (
        URL_STRING_FUNCTIONS.has(functions.at(-1) ?? "") &&
        !safeUrl(string.value)
      )
        return false;
      cursor = string.end;
      continue;
    }
    const identifier = cssIdentifier(css, cursor, css.length);
    if (identifier.end > cursor) {
      const name = asciiLower(identifier.value);
      // At-rules cannot occur in an inline declaration list. Check the raw
      // list too, so an @import omitted by the declaration scanner is refused.
      if (css[cursor - 1] === "@" && name === "import") return false;
      if (css[identifier.end] === "(") {
        if (
          (name === "var" || name === "env") &&
          functions.some((fn) => URL_STRING_FUNCTIONS.has(fn))
        )
          return false;
        let content = identifier.end + 1;
        while (isCssSpace(css.charAt(content))) content++;
        if (
          (name === "url" || name === "src") &&
          css[content] !== '"' &&
          css[content] !== "'"
        ) {
          const end = unquotedUrlEnd(css, content);
          if (end === null) return false;
          let url = "";
          while (content < end - 1) {
            if (css[content] === "\\") {
              const escaped = escapedCodePoint(css, content, end - 1);
              if (!escaped) return false;
              url += escaped.value;
              content = escaped.end;
            } else url += css.charAt(content++);
          }
          if (!safeUrl(url)) return false;
          cursor = end;
          continue;
        }
        functions.push(name);
        cursor = identifier.end + 1;
        continue;
      }
      cursor = identifier.end;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") functions.push("");
    if (char === ")" || char === "]" || char === "}") functions.pop();
    cursor++;
  }
  return true;
}

/** Paste policy: only HTTP(S) and relative CSS resource URLs are allowed. */
export function hasSafeStyleUrls(css: string): boolean {
  const scan = scanCss(css);
  return (
    scan !== null &&
    declarations(css, scan).every((declaration) =>
      safeValues(
        css.slice(declaration.valueRange.start, declaration.valueRange.end),
      ),
    ) &&
    safeValues(css)
  );
}
