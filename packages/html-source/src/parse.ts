import {
  parse,
  parseFragment,
  Parser,
  TokenizerMode,
  type DefaultTreeAdapterTypes,
} from "parse5";
import type {
  HtmlAttribute,
  HtmlChild,
  HtmlElement,
  HtmlSourceDocument,
  SourceRange,
} from "./types";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** A fragment must finish in data state before EOF can recover broken syntax. */
export function hasCompleteHtmlTokens(text: string): boolean {
  const parser = Parser.getFragmentParser(null, {});
  parser.tokenizer.write(text, false);
  return parser.tokenizer.state === TokenizerMode.DATA;
}
// HTML tree construction can synthesize these without an authored start tag.
// Other source-less elements must be tied to a formatting origin before edits.
const IMPLIED_TAGS = new Set([
  "html",
  "head",
  "body",
  "p",
  "br",
  "colgroup",
  "tbody",
  "tr",
]);
const VOID_TAGS = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const RAW_TAGS = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);

export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function isHtmlSpace(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\r" ||
    char === "\f"
  );
}

/** Use HTML's own attribute decoder, including its ambiguous-ampersand rules. */
export function decodeAttribute(value: string): string {
  const fragment = parseFragment(
    `<x a="${value.replaceAll('"', "&quot;")}"></x>`,
  );
  const node = fragment.childNodes[0];
  return node && "tagName" in node ? (node.attrs[0]?.value ?? "") : "";
}

export function decodeText(value: string): string {
  // Text callers pass literal text ranges, never markup. Escaping '<' also
  // keeps an entity candidate from becoming syntax in this decoding fragment.
  const fragment = parseFragment(value.replaceAll("<", "&lt;"));
  return fragment.childNodes
    .flatMap((node) => ("value" in node ? [node.value] : []))
    .join("");
}

function sourceRange(
  location: { startOffset: number; endOffset: number },
  offset: number,
): SourceRange {
  return {
    start: location.startOffset + offset,
    end: location.endOffset + offset,
  };
}

export function parseDocument(text: string): {
  document: DefaultTreeAdapterTypes.Document;
  offset: number;
  elements: DefaultTreeAdapterTypes.Element[];
  nonUniqueNodes: Set<DefaultTreeAdapterTypes.Element>;
  /** Original-input offsets for reconstructed nodes without a start range. */
  cloneOrigins: Map<DefaultTreeAdapterTypes.Element, number>;
  hasUnresolvedOrigins: boolean;
} {
  // A UTF-8 document decoder consumes its BOM before HTML tokenization. parse5
  // accepts strings, so consume it ourselves and translate every range back.
  const offset = text.startsWith("\ufeff") ? 1 : 0;
  const document = parse(text.slice(offset), { sourceCodeLocationInfo: true });
  const elements: DefaultTreeAdapterTypes.Element[] = [];
  const pending = [...document.childNodes];
  const starts = new Map<number, number>();
  const attributeLists = new Map<
    DefaultTreeAdapterTypes.Element["attrs"],
    number
  >();
  const attributeOrigins = new Map<
    DefaultTreeAdapterTypes.Element["attrs"],
    number | null
  >();
  while (pending.length) {
    const node = pending.pop();
    if (!node || !("tagName" in node)) continue;
    elements.push(node);
    const start = node.sourceCodeLocation?.startTag?.startOffset;
    if (start !== undefined) {
      starts.set(start, (starts.get(start) ?? 0) + 1);
      const origin = attributeOrigins.get(node.attrs);
      attributeOrigins.set(
        node.attrs,
        origin === undefined || origin === start ? start : null,
      );
    }
    // parse5 8 reuses the start-token attribute array when it reconstructs a
    // formatting element. Adoption-agency clones may have NO location at all;
    // this identity connects those clones back to the authored start tag.
    attributeLists.set(node.attrs, (attributeLists.get(node.attrs) ?? 0) + 1);
    for (const child of "content" in node
      ? node.content.childNodes
      : node.childNodes)
      pending.push(child);
  }
  const nonUniqueNodes = new Set(
    elements.filter((node) => {
      const start = node.sourceCodeLocation?.startTag?.startOffset;
      return (
        start === undefined ||
        starts.get(start) !== 1 ||
        attributeLists.get(node.attrs) !== 1
      );
    }),
  );
  const cloneOrigins = new Map<DefaultTreeAdapterTypes.Element, number>();
  let hasUnresolvedOrigins = false;
  for (const node of elements) {
    if (node.sourceCodeLocation?.startTag) continue;
    const origin = attributeOrigins.get(node.attrs);
    if (origin !== undefined && origin !== null) {
      cloneOrigins.set(node, origin + offset);
    } else if (
      node.namespaceURI !== HTML_NAMESPACE ||
      !IMPLIED_TAGS.has(node.tagName)
    ) {
      // A missing (or conflicting) authored origin is not interchangeable with
      // an implied structural element. Refuse mutations rather than losing it
      // in the source-multiset comparison.
      hasUnresolvedOrigins = true;
    }
  }
  return {
    document,
    offset,
    elements,
    nonUniqueNodes,
    cloneOrigins,
    hasUnresolvedOrigins,
  };
}

export function readAttributes(
  text: string,
  node: DefaultTreeAdapterTypes.Element,
  nameEnd: number,
  end: number,
): HtmlAttribute[] {
  const attrs: HtmlAttribute[] = [];
  const seen = new Set<string>();
  // Indexed once per tag: a lookup per authored attribute made a tag with
  // thousands of attributes quadratic.
  const parsedByName = new Map<
    string,
    DefaultTreeAdapterTypes.Element["attrs"][number]
  >();
  for (const attr of node.attrs) {
    const qualifiedName = asciiLower(
      attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name,
    );
    if (!parsedByName.has(qualifiedName)) parsedByName.set(qualifiedName, attr);
  }
  let cursor = nameEnd;
  while (cursor < end) {
    while (isHtmlSpace(text.charAt(cursor))) cursor++;
    if (
      text[cursor] === ">" ||
      (text[cursor] === "/" && text[cursor + 1] === ">")
    )
      break;
    // A stray solidus between attributes is ignored by the HTML tokenizer.
    if (text[cursor] === "/") {
      cursor++;
      continue;
    }
    const start = cursor;
    // '=' is permitted as the FIRST character of a malformed attribute name.
    cursor++;
    while (
      cursor < end &&
      !isHtmlSpace(text.charAt(cursor)) &&
      !"=/>".includes(text.charAt(cursor))
    )
      cursor++;
    const nameRange = { start, end: cursor };
    const name = asciiLower(text.slice(start, cursor));
    while (isHtmlSpace(text.charAt(cursor))) cursor++;
    let valueRange: SourceRange | null = null;
    let quote: '"' | "'" | null = null;
    if (text[cursor] === "=") {
      cursor++;
      while (isHtmlSpace(text.charAt(cursor))) cursor++;
      if (text[cursor] === '"' || text[cursor] === "'") {
        quote = text[cursor] === '"' ? '"' : "'";
        cursor++;
        const valueStart = cursor;
        while (cursor < end && text[cursor] !== quote) cursor++;
        valueRange = { start: valueStart, end: cursor };
        if (cursor < end) cursor++;
      } else {
        const valueStart = cursor;
        while (
          cursor < end &&
          !isHtmlSpace(text.charAt(cursor)) &&
          text[cursor] !== ">"
        )
          cursor++;
        valueRange = { start: valueStart, end: cursor };
      }
    } else {
      cursor = nameRange.end;
    }
    const parsed = seen.has(name) ? undefined : parsedByName.get(name);
    seen.add(name);
    attrs.push({
      name,
      value:
        parsed?.value ??
        (valueRange
          ? decodeAttribute(text.slice(valueRange.start, valueRange.end))
          : ""),
      range: { start, end: cursor },
      nameRange,
      valueRange,
      quote,
    });
  }
  return attrs;
}

/** Parse the browser's tree without serializing or normalizing the source. */
export function parseHtmlSource(text: string): HtmlSourceDocument {
  const { document, offset, nonUniqueNodes } = parseDocument(text);
  const result: HtmlSourceDocument = { children: [], elements: [] };
  const pending: {
    nodes: DefaultTreeAdapterTypes.ChildNode[];
    target: HtmlChild[];
  }[] = [{ nodes: document.childNodes, target: result.children }];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    for (const node of entry.nodes) {
      const location = node.sourceCodeLocation;
      if ("tagName" in node) {
        const elementLocation = node.sourceCodeLocation;
        const startTag = elementLocation?.startTag
          ? sourceRange(elementLocation.startTag, offset)
          : null;
        let tagNameRange: SourceRange | null = null;
        if (startTag) {
          let end = startTag.start + 1;
          while (
            end < startTag.end &&
            !isHtmlSpace(text.charAt(end)) &&
            !"/>".includes(text.charAt(end))
          )
            end++;
          tagNameRange = { start: startTag.start + 1, end };
        }
        const tagName = asciiLower(node.tagName);
        const element: HtmlElement = {
          kind: "element",
          tagName,
          namespaceURI: node.namespaceURI,
          isUniqueSource: !nonUniqueNodes.has(node),
          effectiveTid:
            node.attrs.find((attr) => attr.name === "data-tid")?.value ?? null,
          startTag,
          tagNameRange,
          endTag: elementLocation?.endTag
            ? sourceRange(elementLocation.endTag, offset)
            : null,
          attrs:
            startTag && tagNameRange
              ? readAttributes(text, node, tagNameRange.end, startTag.end)
              : [],
          children: [],
          isVoid:
            node.namespaceURI === HTML_NAMESPACE && VOID_TAGS.has(tagName),
          isRawText:
            RAW_TAGS.has(tagName) &&
            (node.namespaceURI === HTML_NAMESPACE ||
              tagName === "script" ||
              tagName === "style"),
        };
        result.elements.push(element);
        entry.target.push(element);
        pending.push({
          nodes: "content" in node ? node.content.childNodes : node.childNodes,
          target: element.children,
        });
      } else if (location && "value" in node) {
        entry.target.push({
          kind: "text",
          value: node.value,
          range: sourceRange(location, offset),
        });
      } else if (location && "data" in node) {
        entry.target.push({
          kind: "comment",
          range: sourceRange(location, offset),
        });
      }
    }
  }
  result.elements.sort(
    (a, b) => (a.startTag?.start ?? Infinity) - (b.startTag?.start ?? Infinity),
  );
  return result;
}
