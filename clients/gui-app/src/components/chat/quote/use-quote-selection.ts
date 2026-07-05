import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * A validated quote gesture, captured once at `mouseup`. This is the single
 * source of truth for the popover: the click handler consumes it and NEVER
 * re-reads the live `Selection` (Chromium/Electron can collapse or retarget the
 * selection before the click dispatches across the portal).
 *
 * `text` is the raw `Selection.toString()` value - normalization (per-line
 * trailing trim, blockquote/codeBlock shaping) is `buildQuoteBlockquote`'s job.
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
  if (end.clampToRootEnd) {
    // The clamp exists for the triple-click tail, where the clamped-away
    // region holds no text. A drag that genuinely selected content past the
    // root would keep that out-of-root text in `selectionText` below (the
    // range is clamped but the emitted text is not), so any non-whitespace
    // in the clamped-away region rejects the gesture instead.
    const clampedAway = liveRange.cloneRange();
    clampedAway.setStart(startRoot, startRoot.childNodes.length);
    if (clampedAway.toString().trim().length > 0) return null;
    range.setEnd(startRoot, startRoot.childNodes.length);
  }

  if (rangeIntersectsExcluded(range, startRoot)) return null;

  return {
    text: selectionText,
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
    return {
      root: closestQuotable(container.parentElement),
      clampToRootEnd: false,
    };
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
