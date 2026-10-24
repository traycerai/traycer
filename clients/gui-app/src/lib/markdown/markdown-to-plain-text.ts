/**
 * Project markdown down to the prose a reader would actually see, for one-line
 * previews and snippets, and (`markdownToSpokenParagraphs`) for reading a reply
 * aloud.
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
const WIREFRAME_LABEL = "Wireframe";
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
      return inlineText(readList(token, "tokens"), "preview");
    case "text":
      return textOrChildren(token, "preview");
    case "code":
      return codeLabel(token);
    case "blockquote":
      return joinBlocks(readList(token, "tokens"));
    case "list":
      return listText(token);
    case "table":
      return tableText(token, "preview");
    // Structural or invisible: a rule, a blank line, a link-reference
    // definition, and raw HTML all contribute no prose.
    case "hr":
    case "space":
    case "def":
    case "html":
      return "";
    default:
      return inlineText(readList(token, "tokens"), "preview");
  }
}

/**
 * A fence is summarised, never previewed. `mermaid` and `wireframe` earn their
 * own words because the panel renders them as a diagram and a live preview
 * when expanded, so "Code" would misdescribe what is behind the fold.
 */
function codeLabel(token: unknown): string {
  const lang = readString(token, "lang").trim().toLowerCase();
  if (lang.startsWith("mermaid")) return MERMAID_LABEL;
  if (lang.startsWith("wireframe")) return WIREFRAME_LABEL;
  return CODE_LABEL;
}

function listText(token: unknown): string {
  const items = readList(token, "items").map((item) =>
    joinBlocks(readList(item, "tokens")),
  );
  return joinParts(items, BLOCK_SEPARATOR);
}

function tableText(token: unknown, projection: Projection): string {
  const rows = readList(token, "rows").flatMap((row) => toList(row));
  const cells = [...readList(token, "header"), ...rows].map((cell) =>
    inlineText(readList(cell, "tokens"), projection),
  );
  return joinParts(cells, " ");
}

/**
 * Who reads the projection. A preview shows an image's alt text and the text
 * between raw HTML tags; speech reads neither (see `withoutHtmlElements`).
 */
type Projection = "preview" | "speech";

function inlineText(
  tokens: ReadonlyArray<unknown>,
  projection: Projection,
): string {
  const shown = projection === "speech" ? withoutHtmlElements(tokens) : tokens;
  return shown.map((token) => inlineTokenText(token, projection)).join("");
}

function inlineTokenText(token: unknown, projection: Projection): string {
  switch (readString(token, "type")) {
    case "text":
      return textOrChildren(token, projection);
    // The LABEL, never the target: a preview's whole budget can otherwise go to
    // one URL the reader cannot click anyway.
    case "link":
    case "strong":
    case "em":
    case "del":
      return inlineText(readList(token, "tokens"), projection);
    // LITERAL, both of them. CommonMark treats a character reference inside a
    // code span as text, so `` `&amp;` `` really does read `&amp;` - and an
    // `escape` token's text is already the resolved character.
    case "codespan":
    case "escape":
      return readString(token, "text");
    // Alt text is the only part of an image that is prose.
    case "image":
      return projection === "preview"
        ? decodeCharacterReferences(readString(token, "text"))
        : "";
    case "br":
      return " ";
    case "html":
      return "";
    default:
      return inlineText(readList(token, "tokens"), projection);
  }
}

/**
 * A `text` token carries children only when it contains inline markup; when it
 * does, they are the authority, because `text` itself is the unparsed source.
 */
function textOrChildren(token: unknown, projection: Projection): string {
  const children = readList(token, "tokens");
  if (children.length > 0) return inlineText(children, projection);
  // The leaf: this is where prose actually lands, so this is where character
  // references get resolved. Code spans reach their own branch and stay literal.
  return decodeCharacterReferences(readString(token, "text"));
}

/**
 * The same parse, read aloud: one entry per paragraph, heading, list item or
 * table, in order. Unlike a preview, nothing that is not prose is spoken - no
 * code (not even a "Code" label), no link targets or definitions, no images,
 * no raw HTML and no text inside an HTML element - wherever it sits, a fence
 * inside a blockquote or a list item included.
 */
export function markdownToSpokenParagraphs(markdown: string): string[] {
  return spokenBlocks(marked.lexer(markdown))
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
}

function spokenBlocks(tokens: ReadonlyArray<unknown>): string[] {
  return withoutHtmlElements(tokens).flatMap((token): string[] => {
    switch (readString(token, "type")) {
      case "code":
      case "hr":
      case "space":
      case "def":
      case "html":
        return [];
      case "blockquote":
        return spokenBlocks(readList(token, "tokens"));
      case "list":
        return readList(token, "items").flatMap((item) =>
          spokenBlocks(readList(item, "tokens")),
        );
      case "table":
        return [tableText(token, "speech")];
      case "text":
        return [textOrChildren(token, "speech")];
      default:
        return [inlineText(readList(token, "tokens"), "speech")];
    }
  });
}

/**
 * Elements whose contents are never prose and, left open, run to the end: a
 * browser reads everything after an unclosed `<script>` as script.
 */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "script",
  "style",
  "template",
  "textarea",
  "title",
  "xmp",
]);

const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)\b[^>]*?(\/?)>/g;

interface HtmlTagEvent {
  readonly token: number;
  readonly name: string;
  readonly closing: boolean;
}

/** The element-opening and -closing tags of a run's `html` tokens, in order. */
function htmlTagEvents(tokens: ReadonlyArray<unknown>): HtmlTagEvent[] {
  return tokens.flatMap((token, index): HtmlTagEvent[] => {
    if (readString(token, "type") !== "html") return [];
    const raw = readString(token, "raw").replace(HTML_COMMENT, "");
    return [...raw.matchAll(HTML_TAG)].flatMap((match): HtmlTagEvent[] => {
      // Every group of HTML_TAG takes part in a match (the slashes as "").
      const [, closingSlash, tagName, selfClosingSlash] = match;
      const name = tagName.toLowerCase();
      const closing = closingSlash === "/";
      if (!closing && (selfClosingSlash === "/" || VOID_ELEMENTS.has(name))) {
        return [];
      }
      return [{ token: index, name, closing }];
    });
  });
}

/**
 * A run of sibling tokens without its raw HTML, for speech. `marked` lexes an
 * element as separate tokens - its opening tag, the text between, its closing
 * tag (inline, and at block level when blank lines split the element) - so
 * dropping the `html` tokens alone would still read `<script>`'s contents.
 * Here an element is dropped with everything up to its matching closing tag.
 * An element left open drops only its tag, as the renderer then shows the text
 * after it, except a raw-text element, which drops the rest of the run.
 */
function withoutHtmlElements(
  tokens: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> {
  const events = htmlTagEvents(tokens);
  const hidden = new Set<number>();
  events.forEach((event, at) => {
    if (event.closing) return;
    const end = matchingCloseToken(events.slice(at + 1), event.name);
    const last =
      end ?? (RAW_TEXT_ELEMENTS.has(event.name) ? tokens.length : event.token);
    for (let index = event.token + 1; index < last; index += 1) {
      hidden.add(index);
    }
  });
  return tokens.filter(
    (token, index) =>
      !hidden.has(index) && readString(token, "type") !== "html",
  );
}

/** The token holding the tag that closes `name`, among the events after it. */
function matchingCloseToken(
  later: ReadonlyArray<HtmlTagEvent>,
  name: string,
): number | null {
  let depth = 0;
  for (const event of later) {
    if (event.name !== name) continue;
    if (!event.closing) {
      depth += 1;
      continue;
    }
    if (depth === 0) return event.token;
    depth -= 1;
  }
  return null;
}
