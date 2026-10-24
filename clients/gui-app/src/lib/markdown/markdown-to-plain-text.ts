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
      return inlineText(readList(token, "tokens"), PREVIEW);
    case "text":
      return textOrChildren(token, PREVIEW);
    case "code":
      return codeLabel(token);
    case "blockquote":
      return joinBlocks(readList(token, "tokens"));
    case "list":
      return listText(token);
    case "table":
      return tableText(token, PREVIEW);
    // Structural or invisible: a rule, a blank line, a link-reference
    // definition, and raw HTML all contribute no prose.
    case "hr":
    case "space":
    case "def":
    case "html":
      return "";
    default:
      return inlineText(readList(token, "tokens"), PREVIEW);
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
 * between raw HTML tags; speech reads neither (see `spokenRun`). Speech also
 * carries the elements an enclosing run closes after the current token.
 */
type Projection =
  | { readonly kind: "preview" }
  | { readonly kind: "speech"; readonly closedLater: ReadonlySet<string> };

const PREVIEW: Projection = { kind: "preview" };

function inlineText(
  tokens: ReadonlyArray<unknown>,
  projection: Projection,
): string {
  if (projection.kind === "preview") {
    return tokens.map((token) => inlineTokenText(token, projection)).join("");
  }
  return spokenRun(tokens, projection.closedLater)
    .map(({ token, closedLater }) =>
      inlineTokenText(token, { kind: "speech", closedLater }),
    )
    .join("");
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
      return projection.kind === "preview"
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
  return spokenBlocks(marked.lexer(markdown), new Set())
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
}

function spokenBlocks(
  tokens: ReadonlyArray<unknown>,
  closedLaterOutside: ReadonlySet<string>,
): string[] {
  return spokenRun(tokens, closedLaterOutside).flatMap(
    ({ token, closedLater }): string[] => {
      const projection: Projection = { kind: "speech", closedLater };
      switch (readString(token, "type")) {
        case "code":
        case "hr":
        case "space":
        case "def":
        case "html":
          return [];
        case "blockquote":
          return spokenBlocks(readList(token, "tokens"), closedLater);
        case "list":
          return readList(token, "items").flatMap((item) =>
            spokenBlocks(readList(item, "tokens"), closedLater),
          );
        case "table":
          return [tableText(token, projection)];
        case "text":
          return [textOrChildren(token, projection)];
        default:
          return [inlineText(readList(token, "tokens"), projection)];
      }
    },
  );
}

/**
 * Elements whose contents are never prose. The HTML parser reads them as raw
 * text: nothing inside is markup, the element ends at its first matching close
 * tag, and left open it runs to the end.
 */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

/** The only elements with no contents. A `/>` on any other tag is ignored. */
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

const HTML_COMMENT_OR_TAG =
  /<!--[\s\S]*?-->|<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])[^>]*>/g;

interface HtmlTagEvent {
  readonly token: number;
  readonly name: string;
  readonly closing: boolean;
}

interface HtmlRun {
  /** Opening and closing tags of ordinary elements, in order. */
  readonly events: ReadonlyArray<HtmlTagEvent>;
  /** Token ranges `[open, close)` a raw-text element covers. */
  readonly rawText: ReadonlyArray<readonly [number, number]>;
}

/**
 * Reads the tags in a run's `html` tokens the way the HTML parser does: a raw
 * text element swallows everything up to its first matching close tag, which
 * may sit several tokens later, and the tags inside it are not tags.
 */
function scanHtmlRun(tokens: ReadonlyArray<unknown>): HtmlRun {
  const events: HtmlTagEvent[] = [];
  const rawText: Array<readonly [number, number]> = [];
  // A field, not a `let`: the callback below reassigns it, and narrowing of a
  // local `let` does not see assignments made inside a callback.
  const scan: {
    openRawText: { readonly name: string; readonly token: number } | null;
  } = { openRawText: null };
  tokens.forEach((token, index) => {
    if (readString(token, "type") !== "html") return;
    const raw = readString(token, "raw");
    let position = 0;
    while (position < raw.length) {
      const open = scan.openRawText;
      if (open !== null) {
        const close = new RegExp(`</${open.name}(?=[\\s/>])`, "gi");
        close.lastIndex = position;
        const closing = close.exec(raw);
        if (closing === null) return;
        rawText.push([open.token, index]);
        scan.openRawText = null;
        const end = raw.indexOf(">", closing.index);
        position = end === -1 ? raw.length : end + 1;
        continue;
      }
      HTML_COMMENT_OR_TAG.lastIndex = position;
      const match = HTML_COMMENT_OR_TAG.exec(raw);
      if (match === null) return;
      position = match.index + match[0].length;
      if (match[0].startsWith("<!--")) continue;
      const [, closingSlash, tagName] = match;
      const name = tagName.toLowerCase();
      if (closingSlash === "/") {
        events.push({ token: index, name, closing: true });
      } else if (RAW_TEXT_ELEMENTS.has(name)) {
        scan.openRawText = { name, token: index };
      } else if (!VOID_ELEMENTS.has(name)) {
        events.push({ token: index, name, closing: false });
      }
    }
  });
  if (scan.openRawText !== null) {
    rawText.push([scan.openRawText.token, tokens.length]);
  }
  return { events, rawText };
}

interface SpokenToken {
  readonly token: unknown;
  /** Elements this run, or one enclosing it, closes after this token. */
  readonly closedLater: ReadonlySet<string>;
}

/**
 * A run of sibling tokens without its raw HTML, for speech. `marked` lexes an
 * element as separate tokens - its opening tag, the text between, its closing
 * tag (inline, and at block level when blank lines split the element) - so
 * dropping the `html` tokens alone would still read `<script>`'s contents.
 * Here an element is dropped with everything up to its matching closing tag.
 *
 * An element left open in this run is closed by the end of the run's
 * container, as HTML closes it, when its closing tag comes later in an
 * enclosing run (`closedLaterOutside`): it covers the rest of this run. One
 * closed nowhere drops only its tag, as the renderer then shows the text after
 * it. A raw-text element left open drops the rest of the run.
 */
function spokenRun(
  tokens: ReadonlyArray<unknown>,
  closedLaterOutside: ReadonlySet<string>,
): SpokenToken[] {
  const { events, rawText } = scanHtmlRun(tokens);
  const hidden = new Set<number>();
  const hide = (open: number, close: number): void => {
    for (let index = open + 1; index < close; index += 1) hidden.add(index);
  };
  for (const [open, close] of rawText) hide(open, close);
  events.forEach((event, at) => {
    if (event.closing) return;
    const close = matchingCloseToken(events.slice(at + 1), event.name);
    if (close !== null) {
      hide(event.token, close);
    } else if (closedLaterOutside.has(event.name)) {
      hide(event.token, tokens.length);
    }
  });
  return tokens.flatMap((token, index): SpokenToken[] => {
    if (hidden.has(index) || readString(token, "type") === "html") return [];
    const closedHere = events
      .filter((event) => event.closing && event.token > index)
      .map((event) => event.name);
    const closedLater =
      closedHere.length === 0
        ? closedLaterOutside
        : new Set([...closedLaterOutside, ...closedHere]);
    return [{ token, closedLater }];
  });
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
