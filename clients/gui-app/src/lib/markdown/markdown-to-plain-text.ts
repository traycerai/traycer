/**
 * Project markdown down to the prose a reader would actually see, for one-line
 * previews and snippets.
 *
 * A clamped preview that shows `## Heading` or `[docs](https://…/very/long)` is
 * showing the reader the source, not the message - the markers eat the budget
 * and the URL can consume the whole line. `formatSingleLine` cannot help: it
 * only folds whitespace, so it faithfully preserves every `#`, backtick and
 * bracket.
 *
 * SO THIS IS A PARSE, not a regex strip. The same `marked` lexer the renderer
 * uses decides what is emphasis and what is a literal asterisk, which fences are
 * code and which text is inside a link label - a pattern-based stripper gets all
 * of those wrong on exactly the inputs agents produce.
 *
 * WHAT SURVIVES: heading text without its `#`, emphasis and link LABELS without
 * markers or URLs, inline-code text, image alt text, list items, table cells.
 * Prose, labels and alt text also get their HTML character references decoded,
 * so a preview and its own expansion agree on what the message says.
 * WHAT DOES NOT: fenced code bodies (a `mermaid` fence becomes `Diagram`, any
 * other fence `Code`, because a preview of graph syntax tells the reader
 * nothing), and raw HTML, which is dropped entirely.
 *
 * This is a LOSSY, one-way projection for display only. Never feed the result
 * back into a renderer, and never key a decision on it - the collapse predicate
 * deliberately measures the ORIGINAL source, because that is what expanding
 * actually reveals.
 *
 * The walk is over `unknown` rather than `marked`'s `Token` union on purpose.
 * That union includes a `Generic` member carrying an `[index: string]: any`
 * signature, so narrowing on `type` still leaves every field `any` - the types
 * would look precise while checking nothing. Reading each field through a
 * validating accessor is honest about what the lexer actually guarantees.
 */
import { marked } from "marked";

/** Blocks read as one line, so they need a visible separator between them. */
const BLOCK_SEPARATOR = " · ";

const MERMAID_LABEL = "Diagram";
const CODE_LABEL = "Code";

/**
 * HTML character references survive the lexer: a `text` token for `R&amp;D`
 * carries `R&amp;D`, not `R&D`. The expanded body decodes them (react-markdown
 * does it downstream), so without this a preview and its own expansion disagree
 * about what the message says.
 *
 * A SMALL TABLE, deliberately. `marked` exports no unescape helper and the repo
 * has no entity decoder to reuse - only an encoder in `composer-clipboard` - and
 * the alternative, round-tripping through `innerHTML`, turns a display helper
 * into an HTML sink. An unknown name is left exactly as written rather than
 * guessed at or dropped.
 */
const NAMED_CHARACTER_REFERENCES: Readonly<Record<string, string | undefined>> =
  {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    ndash: "–",
    nbsp: " ",
    quot: '"',
    rdquo: "”",
    rsquo: "’",
  };

const CHARACTER_REFERENCE =
  /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g;

/**
 * ONE pass over the string, not a chain of replaces. `&amp;lt;` must decode to
 * the literal text `&lt;` - decoding `&amp;` first and then re-scanning would
 * turn it into `<`, silently rewriting what the author wrote.
 */
function decodeCharacterReferences(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    CHARACTER_REFERENCE,
    (
      match: string,
      decimal: string | undefined,
      hex: string | undefined,
      name: string | undefined,
    ): string => {
      if (decimal !== undefined) {
        return codePointText(Number.parseInt(decimal, 10), match);
      }
      if (hex !== undefined) {
        return codePointText(Number.parseInt(hex, 16), match);
      }
      if (name !== undefined) {
        // Own-properties only: `&constructor;` must stay literal text, not
        // resolve through Object.prototype into coerced function source.
        return Object.hasOwn(NAMED_CHARACTER_REFERENCES, name)
          ? (NAMED_CHARACTER_REFERENCES[name] ?? match)
          : match;
      }
      return match;
    },
  );
}

function codePointText(code: number, fallback: string): string {
  // Out of range, or a lone surrogate, is not a character. Showing the source
  // as written beats emitting a replacement glyph the author never typed.
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  if (code >= 0xd800 && code <= 0xdfff) return fallback;
  return String.fromCodePoint(code);
}

/**
 * Projection is pure in its input, and the same text is re-projected constantly
 * - every row re-renders on any cursor move, and a virtualized list re-mounts
 * rows as it scrolls, so a `useMemo` in the row would miss most of the reuse.
 * Bounded because an epic's log is unbounded; oldest-first eviction is enough
 * for a cache whose whole job is to survive a scroll.
 */
const CACHE_LIMIT = 500;
const cache = new Map<string, string>();

export function markdownToPlainText(markdown: string): string {
  const hit = cache.get(markdown);
  if (hit !== undefined) return hit;
  const plain = joinBlocks(marked.lexer(markdown));
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(markdown, plain);
  return plain;
}

function readProperty(node: unknown, key: string): unknown {
  if (typeof node !== "object" || node === null) return undefined;
  return Reflect.get(node, key);
}

function readString(node: unknown, key: string): string {
  const value = readProperty(node, key);
  return typeof value === "string" ? value : "";
}

/**
 * The return annotation is load-bearing: `Array.isArray` narrows `unknown` to
 * `any[]`, so without a declared `ReadonlyArray<unknown>` here the `any` escapes
 * into every caller's inferred type.
 */
function toList(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function readList(node: unknown, key: string): ReadonlyArray<unknown> {
  return toList(readProperty(node, key));
}

function joinBlocks(tokens: ReadonlyArray<unknown>): string {
  return joinParts(tokens.map(blockText), BLOCK_SEPARATOR);
}

function joinParts(parts: ReadonlyArray<string>, separator: string): string {
  return parts.filter((part) => part.length > 0).join(separator);
}

function blockText(token: unknown): string {
  switch (readString(token, "type")) {
    case "heading":
    case "paragraph":
      return inlineText(readList(token, "tokens"));
    case "text":
      return textOrChildren(token);
    case "code":
      return codeLabel(token);
    case "blockquote":
      return joinBlocks(readList(token, "tokens"));
    case "list":
      return listText(token);
    case "table":
      return tableText(token);
    // Structural or invisible: a rule, a blank line, a link-reference
    // definition, and raw HTML all contribute no prose.
    case "hr":
    case "space":
    case "def":
    case "html":
      return "";
    default:
      return inlineText(readList(token, "tokens"));
  }
}

/**
 * A fence is summarised, never previewed. `mermaid` earns its own word because
 * the panel renders it as a diagram when expanded, so "Code" would misdescribe
 * what is behind the fold.
 */
function codeLabel(token: unknown): string {
  const lang = readString(token, "lang").trim().toLowerCase();
  return lang.startsWith("mermaid") ? MERMAID_LABEL : CODE_LABEL;
}

function listText(token: unknown): string {
  const items = readList(token, "items").map((item) =>
    joinBlocks(readList(item, "tokens")),
  );
  return joinParts(items, BLOCK_SEPARATOR);
}

function tableText(token: unknown): string {
  const rows = readList(token, "rows").flatMap((row) => toList(row));
  const cells = [...readList(token, "header"), ...rows].map((cell) =>
    inlineText(readList(cell, "tokens")),
  );
  return joinParts(cells, " ");
}

function inlineText(tokens: ReadonlyArray<unknown>): string {
  return tokens.map(inlineTokenText).join("");
}

function inlineTokenText(token: unknown): string {
  switch (readString(token, "type")) {
    case "text":
      return textOrChildren(token);
    // The LABEL, never the target: a preview's whole budget can otherwise go to
    // one URL the reader cannot click anyway.
    case "link":
    case "strong":
    case "em":
    case "del":
      return inlineText(readList(token, "tokens"));
    // LITERAL, both of them. CommonMark treats a character reference inside a
    // code span as text, so `` `&amp;` `` really does read `&amp;` - and an
    // `escape` token's text is already the resolved character.
    case "codespan":
    case "escape":
      return readString(token, "text");
    // Alt text is the only part of an image that is prose.
    case "image":
      return decodeCharacterReferences(readString(token, "text"));
    case "br":
      return " ";
    case "html":
      return "";
    default:
      return inlineText(readList(token, "tokens"));
  }
}

/**
 * A `text` token carries children only when it contains inline markup; when it
 * does, they are the authority, because `text` itself is the unparsed source.
 */
function textOrChildren(token: unknown): string {
  const children = readList(token, "tokens");
  if (children.length > 0) return inlineText(children);
  // The leaf: this is where prose actually lands, so this is where character
  // references get resolved. Code spans reach their own branch and stay literal.
  return decodeCharacterReferences(readString(token, "text"));
}
