import { asciiLower, parseDocument } from "./parse";
import { decodeMapped } from "./mapped-text";
import {
  applySplices,
  attributeInsertionOffset,
  attributeRemoval,
  attributeValueSplice,
  escapeAttribute,
  escapeText,
  locateElement,
  validAttributeName,
} from "./source";
import type {
  EditResult,
  ElementLocator,
  HtmlElement,
  SourceSplice,
} from "./types";

const TABLE_TEXT_CONTEXTS = new Set(["table", "tbody", "thead", "tfoot", "tr"]);

function ignoresLeadingNewline(element: HtmlElement): boolean {
  return (
    element.namespaceURI === "http://www.w3.org/1999/xhtml" &&
    (element.tagName === "pre" || element.tagName === "listing")
  );
}

function textReplacement(
  element: HtmlElement,
  start: number,
  newText: string,
): string {
  const prefix =
    ignoresLeadingNewline(element) &&
    start === element.startTag?.end &&
    newText.startsWith("\n")
      ? "\n"
      : "";
  return prefix + escapeText(newText);
}

function finishTextEdit(
  text: string,
  element: HtmlElement,
  splice: SourceSplice,
  expectedTextNodes: string[],
): EditResult {
  if (!element.startTag) return { ok: false, reason: "not-literal" };
  const changed = applySplices(text, [splice]);
  const reparsed = locateElement(changed.text, {
    kind: "position",
    startTagOffset: element.startTag.start,
    tagName: element.tagName,
  });
  if (!reparsed.ok) return { ok: false, reason: "unsafe-context" };
  const actualTextNodes = reparsed.element.children
    .filter((child) => child.kind === "text")
    .map((child) => child.value);
  if (
    actualTextNodes.length !== expectedTextNodes.length ||
    actualTextNodes.some((value, index) => value !== expectedTextNodes[index])
  ) {
    return { ok: false, reason: "unsafe-context" };
  }
  return { ok: true, element, ...changed };
}

function shiftedOffset(offset: number, splices: SourceSplice[]): number {
  let shifted = offset;
  for (const splice of splices) {
    if (splice.end > offset) break;
    shifted += splice.replacement.length - (splice.end - splice.start);
  }
  return shifted;
}

export function finishAttributeEdit(
  text: string,
  element: HtmlElement,
  splices: SourceSplice[],
): EditResult {
  const changed = applySplices(text, splices);
  if (splices.length === 0) return { ok: true, element, ...changed };
  if (!element.startTag) return { ok: false, reason: "not-literal" };
  const before = parseDocument(text);
  const after = parseDocument(changed.text);
  const targetStart = shiftedOffset(element.startTag.start, changed.splices);
  const targets = after.elements.filter(
    (node) =>
      node.sourceCodeLocation?.startTag &&
      node.sourceCodeLocation.startTag.startOffset + after.offset ===
        targetStart,
  );
  const target = targets[0];
  if (
    targets.length !== 1 ||
    !target ||
    after.nonUniqueNodes.has(target) ||
    before.elements.length !== after.elements.length ||
    before.hasUnresolvedOrigins ||
    after.hasUnresolvedOrigins
  )
    return { ok: false, reason: "unsafe-context" };

  // Attributes participate in HTML's active-formatting identity. An edit can
  // change which tags are reconstructed elsewhere, even if this target stays
  // unique. Source-less clones use their authored origin, not a generic null
  // key: otherwise a clone switching between two tags would go unnoticed.
  // Positions after the edits are translated from the original source.
  const sourceCounts = new Map<string, number>();
  for (const node of before.elements) {
    const start = node.sourceCodeLocation?.startTag?.startOffset;
    const origin =
      start === undefined
        ? before.cloneOrigins.get(node)
        : start + before.offset;
    const key = `${node.namespaceURI}\0${node.tagName}\0${origin === undefined ? "implied" : shiftedOffset(origin, changed.splices)}`;
    sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
  }
  for (const node of after.elements) {
    const start = node.sourceCodeLocation?.startTag?.startOffset;
    const origin =
      start === undefined ? after.cloneOrigins.get(node) : start + after.offset;
    const key = `${node.namespaceURI}\0${node.tagName}\0${origin === undefined ? "implied" : origin}`;
    const count = sourceCounts.get(key) ?? 0;
    if (count === 0) return { ok: false, reason: "unsafe-context" };
    sourceCounts.set(key, count - 1);
  }
  return { ok: true, element, ...changed };
}

export function insertTid(
  text: string,
  locator: ElementLocator,
  tid: string,
): EditResult {
  const located = locateElement(text, locator);
  if (!located.ok) return located;
  const { element } = located;
  if (!element.startTag || !element.tagNameRange)
    return { ok: false, reason: "not-literal" };
  if (element.attrs.some((attr) => attr.name === "data-tid"))
    return { ok: false, reason: "already-has-tid" };
  return finishAttributeEdit(text, element, [
    {
      start: element.tagNameRange.end,
      end: element.tagNameRange.end,
      replacement: ` data-tid="${escapeAttribute(tid, '"')}"`,
    },
  ]);
}

export function setAttribute(
  text: string,
  locator: ElementLocator,
  name: string,
  value: string | null,
): EditResult {
  const located = locateElement(text, locator);
  if (!located.ok) return located;
  const { element } = located;
  if (!element.startTag) return { ok: false, reason: "not-literal" };
  if (!validAttributeName(name))
    return { ok: false, reason: "invalid-attribute-name" };
  const attrs = element.attrs.filter((attr) => attr.name === asciiLower(name));
  if (attrs.length > 1) return { ok: false, reason: "duplicate-attribute" };
  const attr = attrs[0];
  if (value === null)
    return finishAttributeEdit(
      text,
      element,
      attr ? [attributeRemoval(text, attr)] : [],
    );
  if (attr)
    return finishAttributeEdit(
      text,
      element,
      attr.valueRange && attr.value === value
        ? []
        : [attributeValueSplice(attr, value)],
    );
  const at = attributeInsertionOffset(text, element);
  if (at === null) return { ok: false, reason: "unsafe-source-range" };
  return finishAttributeEdit(text, element, [
    {
      start: at,
      end: at,
      replacement: ` ${name}="${escapeAttribute(value, '"')}"`,
    },
  ]);
}

/** newText is decoded DOM textContent, not HTML or pre-escaped entities. */
export function setTextContent(
  text: string,
  locator: ElementLocator,
  newText: string,
): EditResult {
  const located = locateElement(text, locator);
  if (!located.ok) return located;
  const { element } = located;
  if (!element.startTag) return { ok: false, reason: "not-literal" };
  if (element.isRawText) return { ok: false, reason: "raw-text" };
  if (element.isVoid) return { ok: false, reason: "void-element" };
  if (element.children.some((node) => node.kind === "element"))
    return { ok: false, reason: "has-element-children" };
  if (element.children.some((node) => node.kind !== "text"))
    return { ok: false, reason: "has-non-text-children" };
  if (!element.endTag) return { ok: false, reason: "missing-end-tag" };
  const start = element.startTag.end;
  const end = element.endTag.start;
  if (
    end < start ||
    element.children.some(
      (node) =>
        node.kind === "text" &&
        (node.range.start < start || node.range.end > end),
    )
  ) {
    return { ok: false, reason: "unsafe-source-range" };
  }
  // HTML error recovery can move both markup and text outside this element.
  // Never erase content that doesn't actually belong to its parsed children.
  const content = element.children
    .filter((node) => node.kind === "text")
    .map((node) => node.value)
    .join("");
  let decoded = decodeMapped(text.slice(start, end), start, "text").value;
  if (ignoresLeadingNewline(element) && decoded.startsWith("\n"))
    decoded = decoded.slice(1);
  if (decoded !== content) return { ok: false, reason: "unsafe-source-range" };
  return finishTextEdit(
    text,
    element,
    { start, end, replacement: textReplacement(element, start, newText) },
    newText ? [newText] : [],
  );
}

/** index counts direct text children, including whitespace, excluding elements. */
export function setTextNode(
  text: string,
  locator: ElementLocator,
  textNodeIndex: number,
  newText: string,
): EditResult {
  const located = locateElement(text, locator);
  if (!located.ok) return located;
  const { element } = located;
  if (!element.startTag) return { ok: false, reason: "not-literal" };
  if (element.isRawText) return { ok: false, reason: "raw-text" };
  const textNodes = element.children.filter((child) => child.kind === "text");
  const node =
    Number.isInteger(textNodeIndex) && textNodeIndex >= 0
      ? textNodes[textNodeIndex]
      : undefined;
  if (!node) return { ok: false, reason: "text-node-not-found" };
  if (
    element.namespaceURI === "http://www.w3.org/1999/xhtml" &&
    TABLE_TEXT_CONTEXTS.has(element.tagName) &&
    /[^\t\n\f\r ]/.test(newText)
  ) {
    return { ok: false, reason: "unsafe-context" };
  }
  let decoded = decodeMapped(
    text.slice(node.range.start, node.range.end),
    node.range.start,
    "text",
  ).value;
  if (
    ignoresLeadingNewline(element) &&
    node.range.start === element.startTag.end &&
    decoded.startsWith("\n")
  )
    decoded = decoded.slice(1);
  if (
    node.range.start < element.startTag.end ||
    (element.endTag && node.range.end > element.endTag.start) ||
    decoded !== node.value
  ) {
    return { ok: false, reason: "unsafe-source-range" };
  }
  const expectedTextNodes = textNodes.flatMap((child, index) =>
    index === textNodeIndex ? (newText ? [newText] : []) : [child.value],
  );
  return finishTextEdit(
    text,
    element,
    {
      ...node.range,
      replacement: textReplacement(element, node.range.start, newText),
    },
    expectedTextNodes,
  );
}
