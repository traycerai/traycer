export type {
  EditMissReason,
  EditResult,
  ElementLocator,
  HtmlAttribute,
  HtmlChild,
  HtmlCommentNode,
  HtmlElement,
  HtmlSourceDocument,
  HtmlTextNode,
  LocateMiss,
  LocateMissReason,
  LocateResult,
  SourceChange,
  SourceRange,
  SourceSplice,
} from "./types";
export { parseHtmlSource } from "./parse";
export { locateElement, replaceRange, stampPositions } from "./source";
export { insertTid, setAttribute, setTextContent, setTextNode } from "./edits";
export { setStyleDeclaration } from "./style";
export { findLiteralText } from "./text";
