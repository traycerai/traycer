import { decodeMapped, mappedRange } from "./mapped-text";
import { parseHtmlSource } from "./parse";
import {
  applySplices,
  attributeRemoval,
  escapeAttribute,
  locateElement,
} from "./source";
import type {
  EditResult,
  ElementLocator,
  HtmlChild,
  HtmlElement,
  HtmlTextNode,
  SourceRange,
  SourceSplice,
} from "./types";

export type TextFormatTag = "b" | "i" | "u" | "a";
interface TextSelection {
  node: HtmlTextNode;
  parent: HtmlElement;
  ancestors: HtmlElement[];
  range: SourceRange;
  value: string;
}

function textContent(children: HtmlChild[]): string {
  return children
    .map((child) =>
      child.kind === "text"
        ? child.value
        : child.kind === "element" && child.tagName !== "template"
          ? textContent(child.children)
          : "",
    )
    .join("");
}

function selectedText(
  text: string,
  element: HtmlElement,
  start: number,
  end: number,
): TextSelection | null {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start
  )
    return null;
  let offset = 0;
  let result: TextSelection | null = null;
  const visit = (parent: HtmlElement, ancestors: HtmlElement[]): void => {
    if (parent.tagName === "template") return;
    for (const node of parent.children) {
      if (node.kind === "element") visit(node, [...ancestors, parent]);
      else if (node.kind === "text") {
        const localStart = start - offset;
        const localEnd = end - offset;
        offset += node.value.length;
        if (
          localStart < 0 ||
          localEnd > node.value.length ||
          parent.isRawText ||
          !parent.startTag ||
          !parent.isUniqueSource ||
          parent.namespaceURI !== "http://www.w3.org/1999/xhtml"
        )
          continue;
        const mapped = decodeMapped(
          text.slice(node.range.start, node.range.end),
          node.range.start,
          "text",
        );
        if (
          (parent.tagName === "pre" || parent.tagName === "listing") &&
          node.range.start === parent.startTag.end &&
          mapped.value.startsWith("\n")
        ) {
          mapped.value = mapped.value.slice(1);
          mapped.ranges.shift();
        }
        const boundary = (index: number): boolean => {
          const left = mapped.ranges[index - 1];
          const right = mapped.ranges[index];
          return !left || !right || left.end <= right.start;
        };
        const value = node.value.slice(localStart, localEnd);
        if (
          mapped.value !== node.value ||
          !boundary(localStart) ||
          !boundary(localEnd) ||
          !value.isWellFormed() ||
          !node.value.slice(0, localStart).isWellFormed() ||
          !node.value.slice(localEnd).isWellFormed()
        )
          continue;
        const range = mappedRange(mapped, localStart, localEnd, node.range.end);
        if (
          range.start < parent.startTag.end ||
          !parent.endTag ||
          range.end > parent.endTag.start
        )
          continue;
        result = { node, parent, ancestors, range, value };
      }
    }
  };
  visit(element, []);
  return result;
}

function shifted(start: number, splices: SourceSplice[]): number {
  return splices.reduce(
    (offset, splice) =>
      offset +
      (splice.end <= start
        ? splice.replacement.length - (splice.end - splice.start)
        : 0),
    start,
  );
}

/** Check unchanged source-backed elements and text after HTML tree construction. */
function unchangedOutside(
  text: string,
  changed: string,
  splice: SourceSplice,
  removed: HtmlElement | null,
  addedCount: number,
): boolean {
  const before = parseHtmlSource(text);
  const after = parseHtmlSource(changed);
  if (
    textContent(before.children) !== textContent(after.children) ||
    after.elements.length !==
      before.elements.length - (removed ? 1 : 0) + addedCount
  )
    return false;
  for (const node of before.elements) {
    if (!node.startTag || node.startTag.start === removed?.startTag?.start)
      continue;
    const start = shifted(node.startTag.start, [splice]);
    const matches = after.elements.filter(
      (candidate) =>
        candidate.startTag?.start === start &&
        candidate.tagName === node.tagName &&
        candidate.namespaceURI === node.namespaceURI,
    );
    if (
      matches.length !== 1 ||
      matches[0].isUniqueSource !== node.isUniqueSource
    )
      return false;
  }
  return true;
}

/** Offsets count decoded UTF-16 units in the element's full textContent. */
export function wrapTextRange(
  text: string,
  locator: ElementLocator,
  start: number,
  end: number,
  tag: TextFormatTag,
  href: string | null,
): EditResult {
  const located = locateElement(text, locator);
  if (!located.ok) return located;
  if (!["b", "i", "u", "a"].includes(tag))
    return { ok: false, reason: "unsafe-context" };
  if (tag === "a") {
    try {
      if (
        href === null ||
        !/^https?:\/\//i.test(href) ||
        !["http:", "https:"].includes(new URL(href).protocol)
      )
        return { ok: false, reason: "unsafe-context" };
    } catch {
      return { ok: false, reason: "unsafe-context" };
    }
  } else if (href !== null) return { ok: false, reason: "unsafe-context" };
  const selection = selectedText(text, located.element, start, end);
  if (
    !selection ||
    (tag === "a" &&
      [...selection.ancestors, selection.parent].some(
        (node) => node.tagName === "a",
      ))
  )
    return { ok: false, reason: "unsafe-context" };
  const opening =
    tag === "a" ? `<a href="${escapeAttribute(href ?? "", '"')}">` : `<${tag}>`;
  // This is already validated text source, with whole entity boundaries.
  // Keeping those bytes preserves entity spelling and CRLF inside the range.
  const splice = {
    ...selection.range,
    replacement: `${opening}${text.slice(selection.range.start, selection.range.end)}</${tag}>`,
  };
  const changed = applySplices(text, [splice]);
  const wrapper = locateElement(changed.text, {
    kind: "position",
    startTagOffset: splice.start,
    tagName: tag,
  });
  const owner = parseHtmlSource(changed.text).elements.find(
    (node) => node.startTag?.start === selection.parent.startTag?.start,
  );
  if (
    !wrapper.ok ||
    !wrapper.element.isUniqueSource ||
    !owner?.children.some(
      (child) =>
        child.kind === "element" && child.startTag?.start === splice.start,
    ) ||
    textContent(wrapper.element.children) !== selection.value ||
    !unchangedOutside(text, changed.text, splice, null, 1)
  )
    return { ok: false, reason: "unsafe-context" };
  return { ok: true, element: located.element, ...changed };
}

/** Bounded unwrap: the matching literal wrapper directly owns one text child. */
export function unwrapTextRange(
  text: string,
  locator: ElementLocator,
  start: number,
  end: number,
  tag: TextFormatTag,
): EditResult {
  const located = locateElement(text, locator);
  if (!located.ok) return located;
  const selection = selectedText(text, located.element, start, end);
  if (!selection) return { ok: false, reason: "unsafe-context" };
  const wrapper = selection.parent;
  if (
    wrapper.tagName !== tag ||
    !wrapper.startTag ||
    !wrapper.endTag ||
    wrapper.children.length !== 1 ||
    wrapper.attrs.some(
      (attr) =>
        attr.name !== "data-tid" &&
        attr.name !== "data-traycer-pos" &&
        !(tag === "a" && attr.name === "href"),
    )
  )
    return { ok: false, reason: "unsafe-context" };
  const open = text.slice(wrapper.startTag.start, wrapper.startTag.end);
  const close = text.slice(wrapper.endTag.start, wrapper.endTag.end);
  const prefix = text.slice(wrapper.startTag.end, selection.range.start);
  const suffix = text.slice(selection.range.end, wrapper.endTag.start);
  const stripped = applySplices(
    open,
    wrapper.attrs
      .filter(
        (attr) => attr.name === "data-tid" || attr.name === "data-traycer-pos",
      )
      .map((attr) => {
        const removal = attributeRemoval(text, attr);
        return {
          ...removal,
          start: removal.start - (wrapper.startTag?.start ?? 0),
          end: removal.end - (wrapper.startTag?.start ?? 0),
        };
      }),
  ).text;
  const replacement =
    (prefix ? open + prefix + close : "") +
    text.slice(selection.range.start, selection.range.end) +
    (suffix ? (prefix ? stripped : open) + suffix + close : "");
  const splice = {
    start: wrapper.startTag.start,
    end: wrapper.endTag.end,
    replacement,
  };
  const changed = applySplices(text, [splice]);
  const count = Number(prefix.length > 0) + Number(suffix.length > 0);
  if (!unchangedOutside(text, changed.text, splice, wrapper, count))
    return { ok: false, reason: "unsafe-context" };
  const copies = parseHtmlSource(changed.text).elements.filter(
    (node) =>
      node.startTag !== null &&
      node.startTag.start >= splice.start &&
      node.startTag.start < splice.start + replacement.length,
  );
  if (
    copies.length !== count ||
    copies.some((node) => node.tagName !== tag || !node.isUniqueSource)
  )
    return { ok: false, reason: "unsafe-context" };
  return { ok: true, element: located.element, ...changed };
}
