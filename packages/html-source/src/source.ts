import {
  asciiLower,
  isHtmlSpace,
  parseDocument,
  parseHtmlSource,
  readAttributes,
} from "./parse";
import type {
  ElementLocator,
  HtmlAttribute,
  HtmlElement,
  LocateResult,
  SourceChange,
  SourceSplice,
} from "./types";

export function applySplices(
  text: string,
  splices: SourceSplice[],
): SourceChange {
  const ordered = [...splices].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  const parts: string[] = [];
  let cursor = 0;
  for (const splice of ordered) {
    if (
      !Number.isInteger(splice.start) ||
      !Number.isInteger(splice.end) ||
      splice.start < cursor ||
      splice.end < splice.start ||
      splice.end > text.length
    ) {
      throw new RangeError(
        "Splices must be non-overlapping UTF-16 ranges within the source",
      );
    }
    parts.push(text.slice(cursor, splice.start), splice.replacement);
    cursor = splice.end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(""), splices: ordered };
}

/** The primitive has no HTML semantics. Ranges always refer to its input. */
export function replaceRange(text: string, splice: SourceSplice): SourceChange {
  return applySplices(text, [splice]);
}

export function locateElement(
  text: string,
  locator: ElementLocator,
): LocateResult {
  const elements = parseHtmlSource(text).elements;
  if (locator.kind === "position") {
    const matches = elements.filter(
      (candidate) => candidate.startTag?.start === locator.startTagOffset,
    );
    const element = matches[0];
    if (!element) return { ok: false, reason: "not-found" };
    if (matches.length !== 1 || !element.isUniqueSource)
      return { ok: false, reason: "not-unique" };
    if (element.tagName !== asciiLower(locator.tagName))
      return { ok: false, reason: "tag-mismatch" };
    return { ok: true, element };
  }
  const matches = elements.filter(
    (element) => element.effectiveTid === locator.tid,
  );
  if (matches.some((element) => !element.isUniqueSource))
    return { ok: false, reason: "not-unique" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  const element = matches[0];
  return element ? { ok: true, element } : { ok: false, reason: "not-found" };
}

export function validAttributeName(name: string): boolean {
  return name.length > 0 && !/[\s\u0000-\u001f\u007f"'<>/=]/u.test(name);
}

/** Values passed by callers are decoded, just like DOM getAttribute(). */
export function escapeAttribute(
  value: string,
  quote: '"' | "'" | null,
): string {
  const escaped = value.replaceAll("&", "&amp;");
  return quote === "'"
    ? escaped.replaceAll("'", "&#39;")
    : escaped.replaceAll('"', "&quot;");
}

export function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function attributeRemoval(
  text: string,
  attr: HtmlAttribute,
): SourceSplice {
  // Adjacent quoted attributes are legal error recovery. Keep the separator
  // before the removed one if it is also the next attribute's only separator.
  const next = text.charAt(attr.range.end);
  const removeSpace =
    text[attr.range.start - 1] === " " &&
    (isHtmlSpace(next) || next === "/" || next === ">");
  return {
    start: attr.range.start - (removeSpace ? 1 : 0),
    end: attr.range.end,
    replacement: "",
  };
}

export function attributeInsertionOffset(
  text: string,
  element: HtmlElement,
): number | null {
  if (!element.startTag || text[element.startTag.end - 1] !== ">") return null;
  const slash = element.startTag.end - 2;
  return text[slash] === "/" &&
    !element.attrs.some(
      (attr) => attr.range.start <= slash && attr.range.end > slash,
    )
    ? slash
    : element.startTag.end - 1;
}

export function attributeValueSplice(
  attr: HtmlAttribute,
  value: string,
): SourceSplice {
  if (!attr.valueRange) {
    return {
      start: attr.nameRange.end,
      end: attr.nameRange.end,
      replacement: `="${escapeAttribute(value, '"')}"`,
    };
  }
  if (attr.quote || (value.length > 0 && !/[\s"'`=<>]/u.test(value))) {
    return {
      ...attr.valueRange,
      replacement: escapeAttribute(value, attr.quote),
    };
  }
  return {
    ...attr.valueRange,
    replacement: `"${escapeAttribute(value, '"')}"`,
  };
}

function applyStampPlan(
  text: string,
  insertions: Map<string, SourceSplice>,
  removals: SourceSplice[],
): SourceChange {
  const atPosition = new Map(
    [...insertions.values()].map((splice) => [splice.start, { ...splice }]),
  );
  const splices: SourceSplice[] = [];
  for (const removal of removals) {
    const insertion = atPosition.get(removal.start);
    if (insertion) insertion.end = removal.end;
    else splices.push(removal);
  }
  return applySplices(text, [...splices, ...atPosition.values()]);
}

/** Every inserted marker identifies exactly one element with a unique source. */
export function stampPositions(
  text: string,
  options: { attributeName: string },
): SourceChange {
  if (!validAttributeName(options.attributeName))
    throw new TypeError("Invalid stamp attribute name");
  const name = asciiLower(options.attributeName);
  const insertions = new Map<string, SourceSplice>();
  const removals: SourceSplice[] = [];
  const seen = new Set<number>();
  // The hot serve path needs only start tags. Avoid allocating a second tree
  // and decoding every attribute just to insert one marker per element.
  const { elements, offset, nonUniqueNodes } = parseDocument(text);
  for (const node of elements) {
    const start = node.sourceCodeLocation?.startTag;
    // Uniqueness was checked against EVERY node, before deduplicating the
    // source edits themselves. An existing marker must also be stripped from
    // reconstructed tags, otherwise the browser would copy it to each clone.
    if (!start || seen.has(start.startOffset)) continue;
    seen.add(start.startOffset);
    let nameEnd = start.startOffset + offset + 1;
    while (
      nameEnd < start.endOffset + offset &&
      !isHtmlSpace(text.charAt(nameEnd)) &&
      !"/>".includes(text.charAt(nameEnd))
    )
      nameEnd++;
    const marker = String(start.startOffset + offset);
    if (
      node.attrs.some(
        (attr) =>
          asciiLower(
            attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name,
          ) === name,
      )
    ) {
      for (const attr of readAttributes(
        text,
        node,
        nameEnd,
        start.endOffset + offset,
      )) {
        if (attr.name !== name) continue;
        removals.push(attributeRemoval(text, attr));
      }
    }
    if (!nonUniqueNodes.has(node))
      insertions.set(marker, {
        start: nameEnd,
        end: nameEnd,
        replacement: ` ${options.attributeName}="${marker}"`,
      });
  }
  // The markers themselves change active-formatting identity. Removing a
  // conflicting marker can in turn change reconstruction of another tag, so
  // each round is checked against the served tree. Rebuild from the ORIGINAL
  // source every time: returned splices must never reference an intermediate.
  for (let round = 0; round < 6; round++) {
    const changed = applyStampPlan(text, insertions, removals);
    const served = parseDocument(changed.text);
    const marked = new Set<string>();
    const conflicts = new Set<string>();
    for (const node of served.elements) {
      const attr = node.attrs.find(
        (candidate) =>
          asciiLower(
            candidate.prefix
              ? `${candidate.prefix}:${candidate.name}`
              : candidate.name,
          ) === name,
      );
      if (!attr) continue;
      if (
        insertions.has(attr.value) &&
        (marked.has(attr.value) || served.nonUniqueNodes.has(node))
      )
        conflicts.add(attr.value);
      marked.add(attr.value);
    }
    if (conflicts.size === 0) return changed;
    for (const conflict of conflicts) insertions.delete(conflict);
  }
  // Bounded work on adversarial markup. If removing markers has not settled
  // the tree, serving without markers is safer than exposing ambiguous ones.
  return applyStampPlan(text, new Map(), removals);
}
