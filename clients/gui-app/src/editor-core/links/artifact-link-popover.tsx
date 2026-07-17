import { getMarkRange, type Editor, type Range } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import {
  absolutePositionToRelativePosition,
  ProsemirrorBinding,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import {
  autoUpdate,
  computePosition,
  flip,
  hide,
  offset,
  shift,
  type VirtualElement,
} from "@floating-ui/dom";
import { Check, Copy, File, Globe2, Hash, Link2, Link2Off } from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
} from "react";
import { createPortal } from "react-dom";
import * as Y from "yjs";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { HOVER_PREVIEW_SURFACE_CLASS } from "@/components/ui/hover-preview-surface";
import { Input } from "@/components/ui/input";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import {
  classifyHref,
  type ClassifiedHref,
} from "@/markdown/links/classify-href";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { cn } from "@/lib/utils";
import { isSingleTextblockLinkRange } from "./artifact-link-selection";

const HOVER_SHOW_DELAY_MS = 300;
const HOVER_HIDE_DELAY_MS = 100;

export const ARTIFACT_LINK_CREATE_EVENT = "traycer:artifact-link-create";

export type OpenableArtifactLink = Extract<
  ClassifiedHref,
  { readonly kind: "external" | "file" }
>;

export interface ArtifactLinkPopoverProps {
  readonly editor: Editor;
  readonly editable: boolean;
  readonly scrollContainer: HTMLElement | null;
  readonly openLink: (link: OpenableArtifactLink) => void;
  readonly openLinkPending: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

interface LinkTargetBase {
  readonly range: Range;
  readonly href: string;
  readonly text: string;
  readonly identityText: string;
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly anchor: VirtualElement;
  readonly yBookmark: YRangeBookmark | null;
  /**
   * Document position this target visually anchors to - the caret's own
   * position for a caret trigger, or wherever `posAtCoords` resolved the
   * pointer for a hover trigger (clamped into `range`). `rangeAnchor` re-reads
   * `coordsAtPos` of THIS position live on every floating-ui reposition
   * (`autoUpdate`, which fires on scroll/resize), so the anchor never goes
   * stale - unlike a frozen viewport pixel point, a ProseMirror document
   * position is scroll-independent and always resolves to wherever that
   * character currently renders. Re-mapped through each transaction (locally
   * via `transaction.mapping`, or across remote edits via `yBookmark`) so it
   * keeps tracking the SAME character rather than resetting to the link's
   * start.
   */
  readonly anchorDocPosition: number;
}

interface EditLinkTarget extends LinkTargetBase {
  readonly mode: "edit";
  readonly trigger: "hover" | "caret";
}

interface CreateLinkTarget extends LinkTargetBase {
  readonly mode: "create";
}

type LinkTarget = EditLinkTarget | CreateLinkTarget;

interface YRangeBookmark {
  readonly from: Y.RelativePosition;
  readonly to: Y.RelativePosition;
  readonly anchor: Y.RelativePosition;
}

interface ResolvedYBookmark {
  readonly range: Range;
  readonly anchor: number;
}

interface YSyncState {
  readonly binding: ProsemirrorBinding;
  readonly doc: Y.Doc;
  readonly type: Y.XmlFragment;
}

function linkAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest<HTMLAnchorElement>("a");
}

function anchorPosition(editor: Editor, anchor: HTMLAnchorElement): number {
  return editor.view.posAtDOM(anchor.firstChild ?? anchor, 0);
}

function linkElementAtRange(editor: Editor, range: Range): HTMLElement {
  const domAtPosition = editor.view.domAtPos(range.from);
  const element =
    domAtPosition.node instanceof HTMLElement
      ? domAtPosition.node
      : domAtPosition.node.parentElement;
  return element?.closest<HTMLElement>("a[data-link-href]") ?? editor.view.dom;
}

/**
 * Resolves the ProseMirror document position under viewport coordinates
 * (`event.clientX`/`clientY`), falling back to `fallback` when the point
 * doesn't land inside the document (rare - e.g. a coordinate right at a
 * scrollbar edge). Called ONCE at hover-entry: the returned position is a
 * STABLE document identity, unlike the raw pixel coordinates, so capturing it
 * early and re-resolving its on-screen rect later (via `coordsAtPos` in
 * `rangeAnchor`) never goes stale across a scroll.
 */
function pointerDocPosition(
  editor: Editor,
  event: PointerEvent,
  fallback: number,
): number {
  const result = editor.view.posAtCoords({
    left: event.clientX,
    top: event.clientY,
  });
  return result === null ? fallback : result.pos;
}

function clampToRange(position: number, range: Range): number {
  return Math.min(Math.max(position, range.from), range.to);
}

/**
 * The `coordsAtPos` side to resolve `position` on: `range.to` is the
 * end-EXCLUSIVE boundary of the mark, so the default positive side (biased
 * toward the character AFTER the position) would report coordinates for
 * whatever follows the link - at a line-wrap boundary, that's the start of
 * the NEXT visual line, landing the card a line low. Every other position
 * (including `range.from`, the boundary BEFORE the mark's first character)
 * wants the default positive side.
 */
function anchorSide(position: number, range: Range): number {
  return position === range.to ? -1 : 1;
}

/**
 * Builds the floating-ui reference for a link target, anchored to a single
 * ProseMirror document position re-resolved LIVE on every call via
 * `coordsAtPos`.
 *
 * Anchoring must resolve to a SINGLE visual line, never a box spanning
 * several: a link (or a create-mode selection) that wraps across lines, or
 * sits inside a table cell, exposes multiple client rects. Unioning
 * `coordsAtPos(range.from)`/`coordsAtPos(range.to)` - an earlier approach -
 * builds a box enclosing every fragment, so `placement: "top-start"` lands
 * the card above the topmost line at the leftmost edge, which can be far from
 * the line the pointer is actually over. Because `coordsAtPos` is invoked
 * FRESH every time floating-ui's `autoUpdate` calls this (scroll, resize,
 * mutation), the anchor also can't go stale the way a frozen viewport pixel
 * point could - there's no cached rect to invalidate. `side` carries the
 * endpoint bias from `anchorSide` so a boundary position resolves to the
 * correct side of the wrap.
 */
function rangeAnchor(
  editor: Editor,
  contextElement: HTMLElement,
  position: number,
  side: number,
): VirtualElement {
  return {
    contextElement,
    getBoundingClientRect: () => {
      if (editor.isDestroyed) return new DOMRect();
      const coords = editor.view.coordsAtPos(position, side);
      return new DOMRect(
        coords.left,
        coords.top,
        Math.max(coords.right - coords.left, 0),
        coords.bottom - coords.top,
      );
    },
  };
}

function markAtRange(editor: Editor, range: Range): Mark | null {
  const linkType = editor.schema.marks.link;
  return (
    editor.state.doc
      .nodeAt(range.from)
      ?.marks.find((candidate) => candidate.type === linkType) ?? null
  );
}

function rangeContainsPosition(range: Range, position: number): boolean {
  return position >= range.from && position <= range.to;
}

function targetExcludesPosition(target: LinkTarget, position: number): boolean {
  return position < target.range.from || position > target.range.to;
}

function ySyncState(editor: Editor): YSyncState | null {
  const value: unknown = ySyncPluginKey.getState(editor.state);
  if (typeof value !== "object" || value === null) return null;
  if (!("binding" in value) || !(value.binding instanceof ProsemirrorBinding)) {
    return null;
  }
  const binding = value.binding;
  return { binding, doc: binding.doc, type: binding.type };
}

function typedRelativePosition(
  position: number,
  type: Y.XmlFragment,
  mapping: ProsemirrorBinding["mapping"],
): Y.RelativePosition {
  const relativePosition: unknown = absolutePositionToRelativePosition(
    position,
    type,
    mapping,
  );
  if (!(relativePosition instanceof Y.RelativePosition)) {
    throw new Error("Yjs returned an invalid relative position.");
  }
  return relativePosition;
}

function createYBookmark(
  editor: Editor,
  range: Range,
  anchorPositionValue: number,
): YRangeBookmark | null {
  const syncState = ySyncState(editor);
  if (syncState === null) return null;
  return {
    from: typedRelativePosition(
      range.from,
      syncState.type,
      syncState.binding.mapping,
    ),
    to: typedRelativePosition(
      range.to,
      syncState.type,
      syncState.binding.mapping,
    ),
    anchor: typedRelativePosition(
      anchorPositionValue,
      syncState.type,
      syncState.binding.mapping,
    ),
  };
}

function resolveYBookmark(
  editor: Editor,
  bookmark: YRangeBookmark,
): ResolvedYBookmark | null {
  const syncState = ySyncState(editor);
  if (syncState === null) return null;
  const from = relativePositionToAbsolutePosition(
    syncState.doc,
    syncState.type,
    bookmark.from,
    syncState.binding.mapping,
  );
  const to = relativePositionToAbsolutePosition(
    syncState.doc,
    syncState.type,
    bookmark.to,
    syncState.binding.mapping,
  );
  const anchor = relativePositionToAbsolutePosition(
    syncState.doc,
    syncState.type,
    bookmark.anchor,
    syncState.binding.mapping,
  );
  if (from === null || to === null || anchor === null || from >= to) {
    return null;
  }
  return { range: { from, to }, anchor };
}

function linkTargetAtPosition(
  editor: Editor,
  position: number,
  options: {
    readonly trigger: "hover" | "caret";
    readonly contextElement: HTMLElement | null;
    readonly anchorDocPosition: number | null;
  },
): EditLinkTarget | null {
  const safePosition = Math.max(
    0,
    Math.min(position, editor.state.doc.content.size),
  );
  const range = getMarkRange(
    editor.state.doc.resolve(safePosition),
    editor.schema.marks.link,
  );
  if (range === undefined) return null;
  const mark = markAtRange(editor, range);
  const href = typeof mark?.attrs.href === "string" ? mark.attrs.href : "";
  if (mark === null || href.length === 0) return null;
  const liveContext =
    options.contextElement ?? linkElementAtRange(editor, range);
  const anchorDocPosition = clampToRange(
    options.anchorDocPosition ?? safePosition,
    range,
  );
  return {
    range,
    href,
    text: editor.state.doc.textBetween(range.from, range.to),
    identityText: editor.state.doc.textBetween(range.from, range.to),
    attrs: mark.attrs,
    anchor: rangeAnchor(
      editor,
      liveContext,
      anchorDocPosition,
      anchorSide(anchorDocPosition, range),
    ),
    mode: "edit",
    trigger: options.trigger,
    yBookmark: createYBookmark(editor, range, anchorDocPosition),
    anchorDocPosition,
  };
}

function linkHrefAtPosition(editor: Editor, position: number): string | null {
  const safePosition = Math.max(
    0,
    Math.min(position, editor.state.doc.content.size),
  );
  const range = getMarkRange(
    editor.state.doc.resolve(safePosition),
    editor.schema.marks.link,
  );
  if (range === undefined) return null;
  const href: unknown = markAtRange(editor, range)?.attrs.href;
  return typeof href === "string" && href.length > 0 ? href : null;
}

function refreshCreateTarget(
  editor: Editor,
  target: CreateLinkTarget,
  mappedRange: Range,
  mappedAnchor: number,
): LinkTarget | null {
  if (!isSingleTextblockLinkRange(editor, mappedRange)) return null;
  return {
    ...target,
    range: mappedRange,
    text: editor.state.doc.textBetween(mappedRange.from, mappedRange.to),
    anchorDocPosition: mappedAnchor,
    anchor: rangeAnchor(
      editor,
      editor.view.dom,
      mappedAnchor,
      anchorSide(mappedAnchor, mappedRange),
    ),
  };
}

function refreshEditTarget(
  editor: Editor,
  target: EditLinkTarget,
  mappedRange: Range,
  mappedAnchor: number,
): LinkTarget | null {
  const { from, to } = mappedRange;
  const linkType = editor.schema.marks.link;
  const startRange = getMarkRange(editor.state.doc.resolve(from), linkType);
  const endRange = getMarkRange(editor.state.doc.resolve(to - 1), linkType);
  if (startRange === undefined || endRange === undefined) return null;
  const rangeIsExact =
    startRange.from === endRange.from &&
    startRange.to === endRange.to &&
    startRange.from === from &&
    startRange.to === to;
  if (!rangeIsExact) return null;
  const mark = markAtRange(editor, startRange);
  const href = typeof mark?.attrs.href === "string" ? mark.attrs.href : "";
  if (mark === null || href.length === 0) return null;
  const mappedText = editor.state.doc.textBetween(from, to);
  const absorbedAtBoundary =
    mappedText !== target.identityText &&
    (mappedText.startsWith(target.identityText) ||
      mappedText.endsWith(target.identityText));
  if (absorbedAtBoundary) return null;
  return {
    ...target,
    range: mappedRange,
    href,
    attrs: mark.attrs,
    text: mappedText,
    identityText: mappedText,
    anchorDocPosition: mappedAnchor,
    anchor: rangeAnchor(
      editor,
      linkElementAtRange(editor, mappedRange),
      mappedAnchor,
      anchorSide(mappedAnchor, mappedRange),
    ),
  };
}

function refreshMappedTarget(
  editor: Editor,
  target: LinkTarget,
  transaction: Transaction,
): LinkTarget | null {
  const yResolved =
    target.yBookmark === null
      ? null
      : resolveYBookmark(editor, target.yBookmark);
  if (target.yBookmark !== null && yResolved === null) return null;
  const mappedFrom =
    yResolved?.range.from ?? transaction.mapping.map(target.range.from, 1);
  const mappedTo =
    yResolved?.range.to ?? transaction.mapping.map(target.range.to, -1);
  if (mappedFrom >= mappedTo) return null;
  const mappedRange = { from: mappedFrom, to: mappedTo };
  const mappedAnchor = clampToRange(
    yResolved?.anchor ?? transaction.mapping.map(target.anchorDocPosition, 1),
    mappedRange,
  );
  if (target.mode === "create") {
    return refreshCreateTarget(editor, target, mappedRange, mappedAnchor);
  }
  return refreshEditTarget(editor, target, mappedRange, mappedAnchor);
}

/**
 * Moves the anchor to `position` (the caret's new spot, still within
 * `target.range`) without touching `href`/`text`/`identityText` or any of
 * the dirty-edit-field bookkeeping the caller owns - unlike `open`, this
 * must not reset an in-progress edit just because the caret moved to a
 * different visual fragment of the same wrapped link.
 */
function refreshCaretAnchor(
  editor: Editor,
  target: EditLinkTarget,
  position: number,
): EditLinkTarget {
  return {
    ...target,
    anchorDocPosition: position,
    anchor: rangeAnchor(
      editor,
      linkElementAtRange(editor, target.range),
      position,
      anchorSide(position, target.range),
    ),
    yBookmark: createYBookmark(editor, target.range, position),
  };
}

function createTargetFromSelection(editor: Editor): LinkTarget | null {
  const { from, to } = editor.state.selection;
  const caretOptions = {
    trigger: "caret" as const,
    contextElement: null,
    anchorDocPosition: null,
  };
  if (from === to) {
    return linkTargetAtPosition(editor, from, caretOptions);
  }
  const existing = linkTargetAtPosition(editor, from, caretOptions);
  if (
    existing !== null &&
    existing.range.from <= from &&
    existing.range.to >= to
  ) {
    return existing;
  }
  const range = { from, to };
  if (!isSingleTextblockLinkRange(editor, range)) return null;
  return {
    range,
    href: "",
    text: editor.state.doc.textBetween(from, to),
    identityText: editor.state.doc.textBetween(from, to),
    attrs: {},
    anchor: rangeAnchor(
      editor,
      editor.view.dom,
      range.from,
      anchorSide(range.from, range),
    ),
    mode: "create",
    yBookmark: createYBookmark(editor, range, range.from),
    anchorDocPosition: range.from,
  };
}

interface LinkKindIndicatorProps {
  readonly classifiedHref: ClassifiedHref;
  readonly href: string;
}

function LinkKindIndicator(props: LinkKindIndicatorProps) {
  const iconClassName = "mx-1 size-3.5 shrink-0 text-muted-foreground/75";
  if (props.classifiedHref.kind === "external") {
    return (
      <Globe2 role="img" aria-label="External link" className={iconClassName} />
    );
  }
  if (props.classifiedHref.kind === "file") {
    return (
      <File
        role="img"
        aria-label="Internal file link"
        className={iconClassName}
      />
    );
  }
  if (props.href.trim().startsWith("#")) {
    return (
      <Hash role="img" aria-label="Section link" className={iconClassName} />
    );
  }
  return <Link2 role="img" aria-label="Link" className={iconClassName} />;
}

interface LinkPreviewProps {
  readonly classifiedHref: ClassifiedHref;
  readonly copied: boolean;
  readonly editable: boolean;
  readonly href: string;
  readonly openLinkPending: boolean;
  readonly onCopy: () => void;
  readonly onEdit: () => void;
  readonly onOpen: () => void;
}

function LinkPreview(props: LinkPreviewProps) {
  const openable =
    props.classifiedHref.kind === "external" ||
    props.classifiedHref.kind === "file";
  const externalOpenPending =
    props.classifiedHref.kind === "external" && props.openLinkPending;
  return (
    <>
      <LinkKindIndicator
        classifiedHref={props.classifiedHref}
        href={props.href}
      />
      {openable ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`Open link: ${props.href}`}
          title={props.href}
          className="min-w-0 max-w-[min(55vw,16rem)] justify-start px-1.5 font-normal text-muted-foreground hover:text-foreground"
          disabled={props.href.trim().length === 0 || externalOpenPending}
          onClick={props.onOpen}
        >
          <span className="truncate">{props.href}</span>
          {externalOpenPending ? (
            <AgentSpinningDots
              className={undefined}
              testId="artifact-link-open-pending"
              variant={undefined}
            />
          ) : null}
        </Button>
      ) : (
        <span
          title={props.href}
          className="min-w-0 max-w-[min(55vw,16rem)] truncate px-1.5 text-ui-xs text-muted-foreground"
        >
          {props.href}
        </span>
      )}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={props.href.trim().length === 0}
        aria-label={props.copied ? "Copied" : "Copy link"}
        title={props.copied ? "Copied" : "Copy link"}
        onClick={props.onCopy}
      >
        {props.copied ? (
          <Check aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
      </Button>
      {props.editable ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="px-1.5 text-muted-foreground hover:text-foreground"
          onClick={props.onEdit}
        >
          Edit
        </Button>
      ) : null}
    </>
  );
}

/**
 * One trigger-aware floating surface for authored ProseMirror links.
 *
 * Viewer links participate in Tab order and activate with Enter. Editable
 * links deliberately use caret ownership instead: arrow/click navigation opens
 * this card, whose controls then provide the tabbable editing affordances.
 */
export function ArtifactLinkPopover(props: ArtifactLinkPopoverProps) {
  const {
    editor,
    editable,
    scrollContainer,
    openLink,
    openLinkPending,
    onOpenChange,
  } = props;
  const [target, setTargetState] = useState<LinkTarget | null>(null);
  const [href, setHref] = useState("");
  const [displayText, setDisplayText] = useState("");
  const targetRef = useRef<LinkTarget | null>(null);
  const hrefDirtyRef = useRef(false);
  const textDirtyRef = useRef(false);
  const expectedCaretPositionRef = useRef<number | null>(null);
  const focusEditUrlRef = useRef(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const fieldId = useId();
  const urlFieldId = `${fieldId}-url`;
  const displayFieldId = `${fieldId}-display`;
  const { copied, copy } = useClipboardCopy({
    resetMs: 1_600,
    onSuccess: null,
    onError: () =>
      reportableErrorToast("Couldn't copy to clipboard.", undefined, {
        title: "Could not copy to clipboard",
        message: null,
        code: null,
        source: "Clipboard",
      }),
  });

  const setLiveTarget = useCallback((nextTarget: LinkTarget | null): void => {
    targetRef.current = nextTarget;
    setTargetState(nextTarget);
  }, []);

  const cancelShow = useCallback((): void => {
    if (showTimerRef.current === null) return;
    window.clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
  }, []);

  const cancelHide = useCallback((): void => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const close = useCallback((): void => {
    cancelShow();
    cancelHide();
    if (targetRef.current === null) return;
    setLiveTarget(null);
    onOpenChange(false);
  }, [cancelHide, cancelShow, onOpenChange, setLiveTarget]);

  const open = useCallback(
    (nextTarget: LinkTarget): void => {
      cancelShow();
      cancelHide();
      hrefDirtyRef.current = false;
      textDirtyRef.current = false;
      setLiveTarget(nextTarget);
      setHref(nextTarget.href);
      setDisplayText(nextTarget.text);
      onOpenChange(true);
    },
    [cancelHide, cancelShow, onOpenChange, setLiveTarget],
  );

  const beginEditing = useCallback((): void => {
    const current = targetRef.current;
    if (!editable || current?.mode !== "edit") return;
    cancelHide();
    focusEditUrlRef.current = true;
    setLiveTarget({ ...current, trigger: "caret" });
  }, [cancelHide, editable, setLiveTarget]);

  const expectCaretPosition = useCallback((position: number): void => {
    expectedCaretPositionRef.current = position;
    queueMicrotask(() => {
      if (expectedCaretPositionRef.current === position) {
        expectedCaretPositionRef.current = null;
      }
    });
  }, []);

  const routeHref = useCallback(
    (rawHref: string): "default" | "handled" => {
      const classified = classifyHref(rawHref);
      if (classified.kind === "default") return "default";
      if (classified.kind === "external" || classified.kind === "file") {
        if (classified.kind === "external" && openLinkPending) return "handled";
        openLink(classified);
      }
      return "handled";
    },
    [openLink, openLinkPending],
  );

  const scheduleHoverHide = useCallback((): void => {
    cancelHide();
    const current = targetRef.current;
    if (current?.mode !== "edit" || current.trigger !== "hover") return;
    if (cardRef.current?.contains(document.activeElement)) return;
    hideTimerRef.current = window.setTimeout(() => {
      const liveTarget = targetRef.current;
      if (liveTarget?.mode !== "edit" || liveTarget.trigger !== "hover") return;
      if (cardRef.current?.contains(document.activeElement)) return;
      close();
    }, HOVER_HIDE_DELAY_MS);
  }, [cancelHide, close]);

  const handlePointerOver = useEffectEvent((event: PointerEvent): void => {
    if (!editor.state.selection.empty) return;
    if (targetRef.current !== null) return;
    if (cardRef.current?.contains(document.activeElement)) return;
    const anchor = linkAnchor(event.target);
    if (anchor === null) return;
    cancelShow();
    const fallbackPosition = anchorPosition(editor, anchor);
    // Captured at hover-entry so the card anchors to the character the
    // pointer actually entered through, even if the link itself spans
    // several visual lines (a wrapped link) by the time the show delay
    // elapses - a document position stays valid across that delay, unlike a
    // frozen viewport pixel point.
    const anchorDocPosition = pointerDocPosition(
      editor,
      event,
      fallbackPosition,
    );
    showTimerRef.current = window.setTimeout(() => {
      showTimerRef.current = null;
      if (!anchor.isConnected) return;
      if (!editor.state.selection.empty) return;
      const nextTarget = linkTargetAtPosition(editor, fallbackPosition, {
        trigger: "hover",
        contextElement: anchor,
        anchorDocPosition,
      });
      if (nextTarget !== null) open(nextTarget);
    }, HOVER_SHOW_DELAY_MS);
  });

  const handlePointerOut = useEffectEvent((event: PointerEvent): void => {
    const from = linkAnchor(event.target);
    const to = linkAnchor(event.relatedTarget);
    if (from !== null && from === to) return;
    cancelShow();
    scheduleHoverHide();
  });

  const routeAnchor = useEffectEvent(
    (event: MouseEvent, routeAuxiliary: boolean): void => {
      const anchor = linkAnchor(event.target);
      if (anchor === null) return;
      const rawHref = linkHrefAtPosition(
        editor,
        anchorPosition(editor, anchor),
      );
      if (rawHref === null) return;
      if (!routeAuxiliary && editable && !event.metaKey && !event.ctrlKey) {
        if (classifyHref(rawHref).kind === "default") event.preventDefault();
        return;
      }
      const result = routeHref(rawHref);
      if (result === "default") {
        const normalizedHref = rawHref.trim();
        if (
          editable &&
          !routeAuxiliary &&
          (event.metaKey || event.ctrlKey) &&
          normalizedHref.startsWith("#")
        ) {
          // Match chat parity until the heading-anchor follow-up adds tile-local targets.
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
  );

  const handleClick = useEffectEvent((event: MouseEvent): void => {
    routeAnchor(event, false);
  });

  const handleAuxClick = useEffectEvent((event: MouseEvent): void => {
    if (event.button !== 1) return;
    routeAnchor(event, true);
  });

  const handleMouseDown = useEffectEvent((event: MouseEvent): void => {
    const anchor = linkAnchor(event.target);
    if (anchor === null) return;
    const modifierPrimary =
      event.button === 0 && (event.metaKey || event.ctrlKey);
    const middleClick = event.button === 1;
    if (!modifierPrimary && !middleClick) return;
    const rawHref = linkHrefAtPosition(editor, anchorPosition(editor, anchor));
    if (rawHref === null) return;
    const classified = classifyHref(rawHref);
    const editableHash =
      editable &&
      modifierPrimary &&
      classified.kind === "default" &&
      rawHref.trim().startsWith("#");
    if (classified.kind === "default" && !editableHash) return;
    event.preventDefault();
    event.stopPropagation();
  });

  const openFromSelection = useEffectEvent((): void => {
    if (!editable) return;
    const nextTarget = createTargetFromSelection(editor);
    if (nextTarget !== null) open(nextTarget);
  });

  const handleKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    const anchor = linkAnchor(event.target);
    if (anchor !== null && event.key === "Enter") {
      const rawHref = linkHrefAtPosition(
        editor,
        anchorPosition(editor, anchor),
      );
      if (rawHref === null) return;
      if (routeHref(rawHref) === "default") return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) {
      return;
    }
    const nextTarget = createTargetFromSelection(editor);
    if (!editable || nextTarget === null) return;
    event.preventDefault();
    open(nextTarget);
  });

  const handleFocusIn = useEffectEvent((event: FocusEvent): void => {
    if (!editor.state.selection.empty) return;
    const anchor = linkAnchor(event.target);
    if (anchor === null) return;
    const nextTarget = linkTargetAtPosition(
      editor,
      anchorPosition(editor, anchor),
      { trigger: "caret", contextElement: anchor, anchorDocPosition: null },
    );
    if (nextTarget === null) return;
    const current = targetRef.current;
    if (
      current !== null &&
      current.range.from === nextTarget.range.from &&
      current.range.to === nextTarget.range.to
    ) {
      return;
    }
    open(nextTarget);
  });

  const handleFocusOut = useEffectEvent((event: FocusEvent): void => {
    if (targetRef.current === null) return;
    const next = event.relatedTarget;
    if (next instanceof Node && cardRef.current?.contains(next)) return;
    const nextAnchor = linkAnchor(next);
    if (nextAnchor !== null && editor.view.dom.contains(nextAnchor)) return;
    if (editable && editor.state.selection.empty) {
      const nextTarget = linkTargetAtPosition(
        editor,
        editor.state.selection.from,
        { trigger: "caret", contextElement: null, anchorDocPosition: null },
      );
      if (nextTarget !== null) {
        open(nextTarget);
        return;
      }
    }
    close();
  });

  const syncCollapsedSelection = useEffectEvent(
    (current: LinkTarget | null): void => {
      if (
        current?.mode === "create" ||
        (current?.mode === "edit" && current.trigger === "hover")
      ) {
        return;
      }
      const position = editor.state.selection.from;
      if (current !== null && rangeContainsPosition(current.range, position)) {
        // The caret moved to a different visual fragment of the SAME
        // wrapped link (still inside current.range): keep the open target
        // (don't reset href/text/dirty-edit state via `open`), but refresh
        // where it anchors so the card follows the caret across the wrap
        // instead of staying pinned to the position it first opened at.
        if (position !== current.anchorDocPosition) {
          setLiveTarget(refreshCaretAnchor(editor, current, position));
        }
        return;
      }
      const expectedPosition = expectedCaretPositionRef.current;
      if (expectedPosition !== null && position === expectedPosition) {
        expectedCaretPositionRef.current = null;
        return;
      }
      expectedCaretPositionRef.current = null;
      const nextTarget = linkTargetAtPosition(editor, position, {
        trigger: "caret",
        contextElement: null,
        anchorDocPosition: null,
      });
      if (nextTarget === null) {
        if (current !== null) close();
        return;
      }
      if (
        current !== null &&
        current.range.from === nextTarget.range.from &&
        current.range.to === nextTarget.range.to
      ) {
        return;
      }
      open(nextTarget);
    },
  );

  const syncSelection = useEffectEvent(
    ({ transaction }: { readonly transaction: Transaction | null }): void => {
      cancelShow();
      const { selection } = editor.state;
      const current = targetRef.current;
      if (
        current !== null &&
        cardRef.current?.contains(document.activeElement) === true
      ) {
        return;
      }
      if (!selection.empty) {
        expectedCaretPositionRef.current = null;
        if (current?.mode === "edit") close();
        return;
      }
      if (
        current?.mode === "create" ||
        (current?.mode === "edit" && current.trigger === "hover")
      ) {
        return;
      }
      if (transaction?.docChanged === true) {
        if (
          current !== null &&
          targetExcludesPosition(current, selection.from)
        ) {
          close();
        }
        return;
      }
      syncCollapsedSelection(current);
    },
  );

  const syncTransaction = useEffectEvent(
    ({ transaction }: { readonly transaction: Transaction }): void => {
      cancelShow();
      if (transaction.docChanged) expectedCaretPositionRef.current = null;
      const current = targetRef.current;
      if (current === null) return;
      const refreshed = refreshMappedTarget(editor, current, transaction);
      if (refreshed === null) {
        close();
        return;
      }
      setLiveTarget(refreshed);
      if (!hrefDirtyRef.current) setHref(refreshed.href);
      if (!textDirtyRef.current) setDisplayText(refreshed.text);
    },
  );

  const dismissAndFocusEditor = useCallback((): void => {
    close();
    expectCaretPosition(editor.state.selection.from);
    editor.view.focus();
  }, [close, editor, expectCaretPosition]);

  const handleCardKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    dismissAndFocusEditor();
  });

  useLayoutEffect(() => {
    const syncLinkInteractionAttributes = (): void => {
      editor.view.dom
        .querySelectorAll<HTMLAnchorElement>("a[data-link-href]")
        .forEach((anchor) => {
          const rawHref = anchor.dataset.linkHref ?? "";
          const normalizedHref = rawHref.trim();
          if (editable) {
            anchor.removeAttribute("href");
            anchor.removeAttribute("tabindex");
            return;
          }
          anchor.tabIndex = 0;
          if (normalizedHref.startsWith("#")) {
            anchor.setAttribute("href", normalizedHref);
          } else {
            anchor.removeAttribute("href");
          }
        });
    };
    syncLinkInteractionAttributes();
    if (editor.isEditable === editable) return;
    editor.on("transaction", syncLinkInteractionAttributes);
    return () => {
      editor.off("transaction", syncLinkInteractionAttributes);
    };
  }, [editable, editor]);

  useEffect(() => {
    const root = editor.view.dom;
    root.addEventListener("pointerover", handlePointerOver);
    root.addEventListener("pointerout", handlePointerOut);
    root.addEventListener("mousedown", handleMouseDown, true);
    root.addEventListener("click", handleClick);
    root.addEventListener("auxclick", handleAuxClick);
    root.addEventListener("keydown", handleKeyDown, true);
    root.addEventListener("focusin", handleFocusIn);
    root.addEventListener("focusout", handleFocusOut);
    root.addEventListener(ARTIFACT_LINK_CREATE_EVENT, openFromSelection);
    editor.on("selectionUpdate", syncSelection);
    editor.on("transaction", syncTransaction);
    const initialSyncTimer = window.setTimeout(
      () => syncSelection({ transaction: null }),
      0,
    );
    return () => {
      root.removeEventListener("pointerover", handlePointerOver);
      root.removeEventListener("pointerout", handlePointerOut);
      root.removeEventListener("mousedown", handleMouseDown, true);
      root.removeEventListener("click", handleClick);
      root.removeEventListener("auxclick", handleAuxClick);
      root.removeEventListener("keydown", handleKeyDown, true);
      root.removeEventListener("focusin", handleFocusIn);
      root.removeEventListener("focusout", handleFocusOut);
      root.removeEventListener(ARTIFACT_LINK_CREATE_EVENT, openFromSelection);
      editor.off("selectionUpdate", syncSelection);
      editor.off("transaction", syncTransaction);
      window.clearTimeout(initialSyncTimer);
      cancelShow();
      cancelHide();
      setLiveTarget(null);
      onOpenChange(false);
    };
  }, [cancelHide, cancelShow, editor, onOpenChange, setLiveTarget]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (target === null || card === null) return;
    let active = true;
    const middleware =
      scrollContainer === null
        ? [offset(8), flip(), shift({ padding: 8 })]
        : [
            offset(8),
            flip({ boundary: scrollContainer, padding: 8 }),
            shift({ boundary: scrollContainer, padding: 8 }),
            hide({ boundary: scrollContainer, padding: 8 }),
          ];
    const reposition = (): void => {
      if (!active || editor.isDestroyed) return;
      void computePosition(target.anchor, card, {
        strategy: "fixed",
        placement: "top-start",
        middleware,
      })
        .then(({ x, y, middlewareData }) => {
          if (!active || editor.isDestroyed) return;
          card.style.visibility = middlewareData.hide?.referenceHidden
            ? "hidden"
            : "visible";
          card.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
        })
        .catch(() => undefined);
    };
    reposition();
    const stopAutoUpdate = autoUpdate(target.anchor, card, reposition);
    return () => {
      active = false;
      stopAutoUpdate();
    };
  }, [editor, scrollContainer, target]);

  useEffect(() => {
    const card = cardRef.current;
    if (target === null || card === null) return;
    card.addEventListener("pointerenter", cancelHide);
    card.addEventListener("pointerleave", scheduleHoverHide);
    card.addEventListener("keydown", handleCardKeyDown);
    return () => {
      card.removeEventListener("pointerenter", cancelHide);
      card.removeEventListener("pointerleave", scheduleHoverHide);
      card.removeEventListener("keydown", handleCardKeyDown);
    };
  }, [cancelHide, scheduleHoverHide, target]);

  useLayoutEffect(() => {
    if (target?.mode === "create" || focusEditUrlRef.current) {
      focusEditUrlRef.current = false;
      urlInputRef.current?.focus();
    }
  }, [target]);

  const commit = useCallback((): void => {
    const current = targetRef.current;
    if (current === null || !editable) return;
    const nextHref = href.trim();
    const nextText =
      displayText.trim().length === 0 && nextHref.length > 0
        ? nextHref
        : displayText;
    const text = nextText.length > 0 ? nextText : current.text;
    if (nextHref === current.href && text === current.text) {
      dismissAndFocusEditor();
      return;
    }
    setLiveTarget(null);
    onOpenChange(false);
    const transaction = editor.state.tr;
    const linkType = editor.schema.marks.link;
    const nextAttrs = { ...current.attrs, href: nextHref };
    if (text === current.text) {
      transaction.removeMark(current.range.from, current.range.to, linkType);
      if (nextHref.length > 0) {
        transaction.addMark(
          current.range.from,
          current.range.to,
          linkType.create(nextAttrs),
        );
      }
    } else {
      const marks = nextHref.length === 0 ? [] : [linkType.create(nextAttrs)];
      transaction.replaceWith(
        current.range.from,
        current.range.to,
        editor.schema.text(text, marks),
      );
    }
    transaction.setSelection(
      TextSelection.create(transaction.doc, current.range.from + text.length),
    );
    editor.view.dispatch(transaction);
    expectCaretPosition(current.range.from + text.length);
    editor.view.focus();
  }, [
    dismissAndFocusEditor,
    displayText,
    editable,
    editor,
    expectCaretPosition,
    href,
    onOpenChange,
    setLiveTarget,
  ]);

  const remove = useCallback((): void => {
    const current = targetRef.current;
    if (current === null || !editable) return;
    setLiveTarget(null);
    onOpenChange(false);
    if (current.mode === "edit") {
      editor.view.dispatch(
        editor.state.tr.removeMark(
          current.range.from,
          current.range.to,
          editor.schema.marks.link,
        ),
      );
    }
    editor.view.focus();
  }, [editable, editor, onOpenChange, setLiveTarget]);

  if (target === null || typeof document === "undefined") return null;
  const classifiedDraftHref = classifyHref(href);
  const unusualScheme =
    href.trim().length > 0 && classifiedDraftHref.kind === "ignore";
  const compact =
    target.mode === "edit" && (target.trigger === "hover" || !editable);
  const surfaceLabel = compact ? "Link preview" : "Edit link";

  const handleSurfaceBlur = (event: ReactFocusEvent<HTMLFormElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    commit();
  };

  const handlePreviewBlur = (event: ReactFocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    close();
  };

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label={surfaceLabel}
      data-slot="artifact-link-popover"
      className={cn(
        HOVER_PREVIEW_SURFACE_CLASS,
        // Editor floating surfaces stay below modal overlay/content at z-50.
        "fixed top-0 left-0 z-40",
        compact
          ? "flex max-w-[min(88vw,24rem)] items-center gap-0.5 rounded-lg border-border/55 px-1.5 py-1 shadow-md"
          : "flex w-[min(92vw,20rem)] flex-col gap-2.5 rounded-lg border-border/60 p-2.5 shadow-md",
      )}
      onBlur={compact ? handlePreviewBlur : undefined}
    >
      {compact ? (
        <LinkPreview
          classifiedHref={classifiedDraftHref}
          copied={copied}
          editable={editable}
          href={href}
          openLinkPending={openLinkPending}
          onCopy={() => copy(href.trim())}
          onEdit={beginEditing}
          onOpen={() => routeHref(href)}
        />
      ) : (
        <form
          aria-label={surfaceLabel}
          onBlur={handleSurfaceBlur}
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
          className="flex flex-col gap-2.5"
        >
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={urlFieldId}
              className="text-ui-xs font-medium text-muted-foreground"
            >
              Page or URL
            </label>
            <Input
              ref={urlInputRef}
              id={urlFieldId}
              aria-label="Link URL"
              value={href}
              onChange={(event) => {
                hrefDirtyRef.current = true;
                setHref(event.target.value);
              }}
            />
          </div>
          {unusualScheme ? (
            <p role="status" className="text-ui-xs text-warning-foreground">
              This scheme can be saved, but Traycer will not open it.
            </p>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={displayFieldId}
              className="text-ui-xs font-medium text-muted-foreground"
            >
              Link title
            </label>
            <Input
              id={displayFieldId}
              aria-label="Link display text"
              value={displayText}
              onChange={(event) => {
                textDirtyRef.current = true;
                setDisplayText(event.target.value);
              }}
            />
          </div>
          {target.mode === "edit" ? (
            <div className="mt-0.5 border-t border-border/60 pt-1.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="-ml-1.5 text-muted-foreground hover:text-destructive"
                onClick={remove}
              >
                <Link2Off aria-hidden="true" />
                Remove link
              </Button>
            </div>
          ) : null}
        </form>
      )}
    </div>,
    document.body,
  );
}
