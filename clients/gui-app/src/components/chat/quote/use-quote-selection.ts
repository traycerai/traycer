import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * A validated quote gesture, captured once at `mouseup`. This is the single
 * source of truth for the popover: the click handler consumes it and NEVER
 * re-reads the live `Selection` (Chromium/Electron can collapse or retarget the
 * selection before the click dispatches across the portal).
 *
 * `text` is the raw `Selection.toString()` value - this preserves the
 * browser's own block-boundary blank lines (`\n\n` between paragraphs),
 * which a derived `Range.toString()` would flatten away. EXCEPTION: when the
 * end was clamped back into the quotable root (the triple-click tail) and
 * the clamped-away region held visible `[data-quote-exclude]` text, that
 * text is stripped from the tail - real `Selection.toString()` DOES include
 * it (it's ordinary rendered HTML, just excluded from quoting), unlike an
 * SVG `<title>`/`<desc>`/`<metadata>`/`<defs>`, which produces no layout box
 * and so the browser's own stringifier already omits. Further normalization
 * (per-line trailing trim, dropping trailing blank lines, blockquote/
 * codeBlock shaping) is `buildQuoteBlockquote`'s job.
 * `range` is a detached clone of the live range; the popover reads its live
 * `getBoundingClientRect()` for anchoring and guards against its nodes being
 * disconnected.
 */
export interface QuoteSelectionSnapshot {
  readonly text: string;
  readonly fenceLanguage: string | null;
  readonly range: Range;
  /** The `[data-quotable]` root both endpoints resolved into. The popover uses
   *  it to confirm the live selection still belongs here before showing. */
  readonly root: Element;
}

export interface QuoteSelectionState {
  readonly snapshot: QuoteSelectionSnapshot | null;
  readonly dismiss: () => void;
}

const QUOTABLE_SELECTOR = "[data-quotable]";
const CODE_BLOCK_SELECTOR = "[data-quote-code-block]";
const EXCLUDED_SELECTOR = "[data-md-unstable],[data-quote-exclude]";

/**
 * Tracks text selections inside a chat transcript and, at `mouseup`, resolves +
 * validates them into a {@link QuoteSelectionSnapshot}. `selectionchange` is
 * used for DISMISSAL ONLY: when the selection collapses (a click elsewhere, a
 * virtualized row unmounting) the snapshot is dropped.
 *
 * The listeners are passive observers - the hook never calls `focus()`,
 * `blur()`, or `preventDefault()`. When `enabled` is false no listeners are
 * attached, nothing is snapshotted, and any open snapshot is torn down.
 */
export function useQuoteSelection(params: {
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly enabled: boolean;
}): QuoteSelectionState {
  const { containerRef, enabled } = params;
  const [snapshot, setSnapshot] = useState<QuoteSelectionSnapshot | null>(null);

  const dismiss = useCallback(() => setSnapshot(null), []);

  useEffect(() => {
    // While disabled, attach nothing. The returned snapshot is also gated on
    // `enabled` below, so toggling the setting off hides any open popover
    // immediately without a state write here (a lingering snapshot self-heals:
    // on re-enable its anchor guard dismisses a now-stale range on mount).
    if (!enabled) return;
    const container = containerRef.current;
    if (container === null) return;

    let pendingFrame: number | null = null;
    const cancelPending = (): void => {
      if (pendingFrame !== null) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = null;
      }
    };

    // A fresh press invalidates a snapshot that mouseup deferred but hasn't taken.
    const handleMouseDown = (): void => cancelPending();

    const handleMouseUp = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || !container.contains(target)) return;
      // Defer the Selection read by one frame: on double-click-drag and
      // shift-click the browser can finalize (extend) the selection AFTER
      // mouseup, so a synchronous read here would snapshot a stale/incomplete
      // range. Reading next frame captures the settled selection. Passive: this
      // still never focuses/blurs/preventDefaults.
      cancelPending();
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null;
        const next = resolveFromLiveSelection();
        // Summon (or replace) the snapshot; reuse the previous reference when
        // unchanged so an equivalent re-read - e.g. a preceding selectionchange
        // for the same shift-extend gesture - doesn't churn the popover.
        setSnapshot((prev) => reuseEquivalentSnapshot(prev, next));
      });
    };

    const handleSelectionChange = (): void => {
      const next = resolveFromLiveSelection();
      setSnapshot((prev) => {
        // Release-only trigger: a selection change never summons the popover on
        // its own - it only tracks or dismisses one that mouseup already opened.
        // This also keeps a purely keyboard-built selection (no prior mouseup)
        // from showing it.
        if (prev === null) return null;
        // Re-snapshot so the anchor AND captured text stay consistent with the
        // live highlight when the user extends/adjusts the selection (Shift+
        // Arrow/End/click). A null result - collapsed, multi-range, moved out of
        // the root, intersecting excluded/unstable, or whitespace - dismisses.
        return reuseEquivalentSnapshot(prev, next);
      });
    };

    container.addEventListener("mousedown", handleMouseDown);
    container.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      cancelPending();
      container.removeEventListener("mousedown", handleMouseDown);
      container.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [containerRef, enabled]);

  return { snapshot: enabled ? snapshot : null, dismiss };
}

export interface UsableSelectionInfo {
  readonly rangeCount: number;
  readonly isCollapsed: boolean;
}

/**
 * A selection yields a quote only when it holds exactly ONE, non-collapsed
 * range. Multi-range selections (Firefox Ctrl/Cmd-select) are rejected: the
 * native highlight would span more than the single `getRangeAt(0)` we capture,
 * so the popover could promise more than it quotes.
 */
export function isSingleUsableSelection(info: UsableSelectionInfo): boolean {
  return info.rangeCount === 1 && !info.isCollapsed;
}

/** Reads the live selection and resolves it, or `null` when it is collapsed,
 *  empty, multi-range, or fails validation. */
function resolveFromLiveSelection(): QuoteSelectionSnapshot | null {
  const selection = window.getSelection();
  if (selection === null || !isSingleUsableSelection(selection)) return null;
  return resolveQuoteSelection(selection.getRangeAt(0), selection.toString());
}

/** Preserves referential stability: when `next` is equivalent to `prev` (same
 *  root, text, fence, and range boundary points) returns `prev`, so a no-op
 *  selectionchange doesn't tear down and re-arm the popover effect/autoUpdate. */
function reuseEquivalentSnapshot(
  prev: QuoteSelectionSnapshot | null,
  next: QuoteSelectionSnapshot | null,
): QuoteSelectionSnapshot | null {
  if (prev !== null && next !== null && snapshotsEquivalent(prev, next)) {
    return prev;
  }
  return next;
}

// Compare boundary NODE identity + offsets rather than
// `range.compareBoundaryPoints`: both ranges are clones of the same live
// selection, so their boundary nodes are the same objects when unchanged, and
// this never throws a WrongDocumentError when `a`'s nodes were disconnected by a
// streaming re-render while `b` is a fresh live range (different range roots).
function snapshotsEquivalent(
  a: QuoteSelectionSnapshot,
  b: QuoteSelectionSnapshot,
): boolean {
  return (
    a.root === b.root &&
    a.text === b.text &&
    a.fenceLanguage === b.fenceLanguage &&
    a.range.startContainer === b.range.startContainer &&
    a.range.startOffset === b.range.startOffset &&
    a.range.endContainer === b.range.endContainer &&
    a.range.endOffset === b.range.endOffset
  );
}

/**
 * Resolves a live selection range into a validated snapshot, or `null` when the
 * gesture is not a legal quote. Pure and DOM-only (no React) so the endpoint,
 * validity, and fence rules can be unit-tested against a hand-built `Range`.
 *
 * Rules:
 * - text non-empty after trim;
 * - both endpoints resolve to the SAME `[data-quotable]` root (boundary-aware:
 *   element-node containers resolve to a child at/before the offset, then climb;
 *   a triple-click whose end lands at offset 0 outside the root is clamped back
 *   to the root's end instead of being rejected);
 * - the range does not intersect `[data-md-unstable]` or `[data-quote-exclude]`.
 *
 * Fence detection: when the whole (post-clamp) range sits inside a single
 * `[data-quote-code-block]`, its `data-language` is captured so the quote is
 * emitted as a code block.
 */
export function resolveQuoteSelection(
  liveRange: Range,
  selectionText: string,
): QuoteSelectionSnapshot | null {
  if (selectionText.trim().length === 0) return null;

  const startRoot = quotableRootForStart(
    liveRange.startContainer,
    liveRange.startOffset,
  );
  if (startRoot === null) return null;

  const end = quotableRootForEnd(
    liveRange.endContainer,
    liveRange.endOffset,
    startRoot,
  );
  if (end.root !== startRoot) return null;

  // Clone so the snapshot is immutable against later selection mutations; the
  // clone still references the live nodes, so its rect tracks their position.
  const range = liveRange.cloneRange();
  // Text found under a [data-quote-exclude] ancestor in the clamped-away
  // region, one entry per rendered descendant - real `Selection.toString()`
  // includes it (unlike non-rendered SVG chrome), so it's stripped from the
  // tail of `selectionText` below.
  let excludedTailParts: ReadonlyArray<string> = [];
  if (end.clampToRootEnd) {
    // The clamp exists for the triple-click tail, where the clamped-away
    // region holds no USER-VISIBLE, non-excluded text (only whitespace,
    // non-rendered SVG chrome like <title>/<desc>, or a [data-quote-exclude]
    // sibling). A drag that genuinely selected visible content past the root
    // rejects instead of clamping.
    const clampedAway = liveRange.cloneRange();
    clampedAway.setStart(startRoot, startRoot.childNodes.length);
    if (rangeHasVisibleText(clampedAway)) return null;
    excludedTailParts = excludedVisibleTailParts(clampedAway);
    range.setEnd(startRoot, startRoot.childNodes.length);
  }

  if (rangeIntersectsExcluded(range, startRoot)) return null;

  return {
    text: end.clampToRootEnd
      ? stripExcludedTail(selectionText, excludedTailParts)
      : selectionText,
    fenceLanguage: detectFenceLanguage(range, startRoot),
    range,
    root: startRoot,
  };
}

function quotableRootForStart(container: Node, offset: number): Element | null {
  if (isTextNode(container)) {
    return closestQuotable(container.parentElement);
  }
  const element = asElement(container);
  if (element === null) return null;
  // The start endpoint belongs to the child AT/after the offset (or the element
  // itself when the offset is past the last child).
  const child = childAt(element, offset);
  return closestQuotable(elementForNode(child) ?? element);
}

interface EndResolution {
  readonly root: Element | null;
  readonly clampToRootEnd: boolean;
}

function quotableRootForEnd(
  container: Node,
  offset: number,
  startRoot: Element,
): EndResolution {
  if (isTextNode(container)) {
    const here = closestQuotable(container.parentElement);
    // A double-click's word selection can absorb the block's trailing
    // whitespace and finalize at offset 0 of the NEXT text node - on a turn's
    // LAST block that node sits outside the quotable root. offset 0 means no
    // character of this text node is selected, so it's the same tail landing
    // as the triple-click element@0 case below: clamp back into the root
    // rather than rejecting, and let the caller's clamped-away guard reject a
    // drag that genuinely selected content past the root.
    if (here !== startRoot && offset === 0) {
      return { root: startRoot, clampToRootEnd: true };
    }
    return { root: here, clampToRootEnd: false };
  }
  const element = asElement(container);
  if (element === null) return { root: null, clampToRootEnd: false };
  if (offset === 0) {
    // No child precedes the boundary. This is the triple-click tail: the
    // selection extends to the very start of the following node. If that node
    // is outside the start root, clamp the end back into the root rather than
    // rejecting the gesture.
    const here = closestQuotable(element);
    if (here !== startRoot) {
      return { root: startRoot, clampToRootEnd: true };
    }
    return { root: here, clampToRootEnd: false };
  }
  // The end endpoint belongs to the child BEFORE the offset.
  const child = childAt(element, offset - 1);
  return {
    root: closestQuotable(elementForNode(child) ?? element),
    clampToRootEnd: false,
  };
}

function detectFenceLanguage(range: Range, root: Element): string | null {
  const startBlock = closestCodeBlock(
    fenceBoundaryNode(range.startContainer, range.startOffset, "start"),
  );
  const endBlock = closestCodeBlock(
    fenceBoundaryNode(range.endContainer, range.endOffset, "end"),
  );
  if (startBlock === null || startBlock !== endBlock) return null;
  if (!root.contains(startBlock)) return null;
  // Present-but-empty `data-language` (a plaintext fence) still yields a code
  // block, so an empty string is a valid, non-null result.
  return startBlock.getAttribute("data-language") ?? "";
}

// An element-node boundary belongs to the child just inside it (at the offset
// for a start, before it for an end), not the container itself. Without this
// a clamped triple-click end - which sits on the quotable root - would never
// resolve into the trailing code block the selection actually covers.
function fenceBoundaryNode(
  container: Node,
  offset: number,
  edge: "start" | "end",
): Node {
  if (isTextNode(container)) return container;
  const child =
    edge === "start"
      ? childAt(container, offset)
      : childAt(container, offset - 1);
  return child ?? container;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// SVG element names whose subtree is never painted even though it appears in
// `Range.toString()` - a provider icon's `<title>Claude</title>`, `<desc>`,
// and definition containers (`<metadata>`, `<defs>`) that only exist to be
// referenced via `<use>`. Scoped to the SVG namespace below so an
// HTML-authored element that happens to be named e.g. `desc` isn't mistaken
// for one. SVG `<text>` IS painted and is deliberately excluded from this set.
const NON_VISIBLE_SVG_TAGS = new Set(["title", "desc", "metadata", "defs"]);

/** Whether `range` covers any user-visible, non-whitespace text - i.e. text
 *  outside SVG `<title>`/`<desc>` and `[data-quote-exclude]` subtrees. Walks a
 *  `cloneContents()` snapshot (which already slices partial boundary text
 *  nodes to just their in-range portion) instead of `Range.toString()`, so
 *  invisible accessibility text doesn't get counted as real tail content by
 *  the clamped-away guard above. */
function rangeHasVisibleText(range: Range): boolean {
  const fragment = range.cloneContents();
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    if (
      node.textContent !== null &&
      node.textContent.trim().length > 0 &&
      !hasNonVisibleTextAncestor(node)
    ) {
      return true;
    }
    node = walker.nextNode();
  }
  return false;
}

function hasNonVisibleTextAncestor(node: Node): boolean {
  return (
    isUnderNonVisibleSvgAncestor(node) || isUnderQuoteExcludeAncestor(node)
  );
}

function isUnderNonVisibleSvgAncestor(node: Node): boolean {
  let ancestor = node.parentElement;
  while (ancestor !== null) {
    if (
      ancestor.namespaceURI === SVG_NAMESPACE &&
      NON_VISIBLE_SVG_TAGS.has(ancestor.tagName.toLowerCase())
    ) {
      return true;
    }
    ancestor = ancestor.parentElement;
  }
  return false;
}

function isUnderQuoteExcludeAncestor(node: Node): boolean {
  let ancestor = node.parentElement;
  while (ancestor !== null) {
    if (ancestor.hasAttribute("data-quote-exclude")) return true;
    ancestor = ancestor.parentElement;
  }
  return false;
}

/** Collects the text found under a `[data-quote-exclude]` ancestor within
 *  `range`'s content, ONE ENTRY PER TEXT NODE (document order) rather than a
 *  single joined string - real `[data-quote-exclude]` chrome (e.g.
 *  `NextStepsActionGroup`) commonly renders several SEPARATE descendants
 *  (one button per option) under one excluded container, and Chromium
 *  synthesizes a layout separator between them in `Selection.toString()`
 *  even though they share an ancestor. Joining the parts directly would lose
 *  that boundary and make the tail unmatchable. Non-rendered SVG chrome
 *  (which the browser's own stringifier already omits) is excluded. */
function excludedVisibleTailParts(range: Range): ReadonlyArray<string> {
  const fragment = range.cloneContents();
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    if (
      isUnderQuoteExcludeAncestor(node) &&
      !isUnderNonVisibleSvgAncestor(node)
    ) {
      const text = node.textContent ?? "";
      if (text.trim().length > 0) parts.push(text);
    }
    node = walker.nextNode();
  }
  return parts;
}

/** Removes a whitespace-tolerant trailing occurrence of `excludedParts` from
 *  the end of `selectionText`. Each part matches with internal `\s+`
 *  tolerance (a single rendered node's own whitespace/line-break layout),
 *  and CONSECUTIVE parts are joined with `\s*` (an optional Chromium-inserted
 *  layout separator between separately rendered descendants of one excluded
 *  container) - see {@link excludedVisibleTailParts}. A miss (the parts
 *  don't actually form a trailing suffix) safely no-ops rather than
 *  mangling `selectionText`. */
function stripExcludedTail(
  selectionText: string,
  excludedParts: ReadonlyArray<string>,
): string {
  const partPatterns = excludedParts
    .map(wordsToPattern)
    .filter((pattern): pattern is string => pattern !== null);
  if (partPatterns.length === 0) return selectionText;
  const pattern = partPatterns.join("\\s*");
  return selectionText.replace(new RegExp(`\\s*${pattern}\\s*$`), "");
}

function wordsToPattern(text: string): string | null {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;
  return words.map(escapeRegExpLiteral).join("\\s+");
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rangeIntersectsExcluded(range: Range, root: Element): boolean {
  const excluded = root.querySelectorAll(EXCLUDED_SELECTOR);
  for (const element of excluded) {
    if (rangeIntersectsNode(range, element)) return true;
  }
  return false;
}

// Overlap via boundary-point comparison (robust across jsdom, whose
// `Range.intersectsNode` has been spec-noncompliant). Two ranges overlap iff
// A.end is after B.start AND A.start is before B.end; touching boundaries do
// not count as an intersection.
function rangeIntersectsNode(range: Range, node: Node): boolean {
  const ownerDocument = node.ownerDocument;
  if (ownerDocument === null) return false;
  const nodeRange = ownerDocument.createRange();
  nodeRange.selectNode(node);
  const endVsStart = range.compareBoundaryPoints(Range.START_TO_END, nodeRange);
  const startVsEnd = range.compareBoundaryPoints(Range.END_TO_START, nodeRange);
  return endVsStart > 0 && startVsEnd < 0;
}

function closestQuotable(element: Element | null): Element | null {
  return element?.closest(QUOTABLE_SELECTOR) ?? null;
}

function closestCodeBlock(node: Node): Element | null {
  return elementForNode(node)?.closest(CODE_BLOCK_SELECTOR) ?? null;
}

// `childNodes[i]` is typed non-null here (no `noUncheckedIndexedAccess`) yet
// returns undefined out of range, so index explicitly with a bounds check.
function childAt(parent: Node, index: number): Node | null {
  const children = parent.childNodes;
  if (index < 0 || index >= children.length) return null;
  return children[index];
}

function elementForNode(node: Node | null): Element | null {
  if (node === null) return null;
  if (isTextNode(node)) return node.parentElement;
  return asElement(node);
}

function asElement(node: Node): Element | null {
  return node instanceof Element ? node : null;
}

function isTextNode(node: Node): node is Text {
  return node instanceof Text;
}
