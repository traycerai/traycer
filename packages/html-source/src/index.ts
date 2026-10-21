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
export { parseHtmlSource, hasCompleteHtmlTokens } from "./parse";
export { locateElement, replaceRange, stampPositions } from "./source";
export { insertTid, setAttribute, setTextContent, setTextNode } from "./edits";
export { setStyleDeclaration } from "./style";
export { findLiteralText, textInSourceRange } from "./text";
export { commentAnchorStatus, type CommentAnchorQuery } from "./comment-anchor";
export { hasSafeStyleUrls } from "./style-urls";
export {
  readRootCustomProperties,
  setRootCustomProperty,
  type RootCustomProperty,
  type RootStyleMiss,
} from "./root-style";
export {
  wrapTextRange,
  unwrapTextRange,
  type TextFormatTag,
} from "./text-range";
