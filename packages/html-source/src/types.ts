/** Half-open UTF-16 indices into the exact original source string. */
export interface SourceRange {
  start: number;
  end: number;
}

export interface SourceSplice extends SourceRange {
  replacement: string;
}

export interface HtmlAttribute {
  /** ASCII-normalized name, including a namespace prefix when present. */
  name: string;
  /** Decoded HTML attribute value. */
  value: string;
  range: SourceRange;
  nameRange: SourceRange;
  /** Excludes surrounding quotes; null for a valueless attribute. */
  valueRange: SourceRange | null;
  quote: '"' | "'" | null;
}

export interface HtmlTextNode {
  kind: "text";
  value: string;
  range: SourceRange;
}

export interface HtmlCommentNode {
  kind: "comment";
  range: SourceRange;
}

export interface HtmlElement {
  kind: "element";
  tagName: string;
  namespaceURI: string;
  /** False for implied elements and all copies of a reconstructed start tag. */
  isUniqueSource: boolean;
  /** Browser-effective first data-tid, including on source-less clones. */
  effectiveTid: string | null;
  startTag: SourceRange | null;
  tagNameRange: SourceRange | null;
  endTag: SourceRange | null;
  attrs: HtmlAttribute[];
  children: HtmlChild[];
  isVoid: boolean;
  /** Includes RCDATA and other HTML elements whose contents aren't markup. */
  isRawText: boolean;
}

export type HtmlChild = HtmlElement | HtmlTextNode | HtmlCommentNode;

export interface HtmlSourceDocument {
  children: HtmlChild[];
  /** Flattened elements in source order; implied elements follow literal ones. */
  elements: HtmlElement[];
}

export type ElementLocator =
  | { kind: "position"; startTagOffset: number; tagName: string }
  | { kind: "tid"; tid: string };

export type LocateMissReason =
  | "not-found"
  | "tag-mismatch"
  | "ambiguous"
  | "not-unique";
export interface LocateMiss {
  ok: false;
  reason: LocateMissReason;
}
export type LocateResult = { ok: true; element: HtmlElement } | LocateMiss;

export interface SourceChange {
  text: string;
  /** Ordered, non-overlapping splices, all relative to the original source. */
  splices: SourceSplice[];
}

export type EditMissReason =
  | LocateMissReason
  | "not-literal"
  | "already-has-tid"
  | "duplicate-attribute"
  | "invalid-attribute-name"
  | "invalid-style-property"
  | "invalid-style-value"
  | "malformed-style"
  | "has-element-children"
  | "has-non-text-children"
  | "raw-text"
  | "missing-end-tag"
  | "void-element"
  | "text-node-not-found"
  | "unsafe-source-range"
  | "unsafe-context";

export type EditResult =
  | (SourceChange & { ok: true; element: HtmlElement })
  | { ok: false; reason: EditMissReason };
