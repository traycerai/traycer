/**
 * Isolated-world overlay runtime. Bundled into an IIFE by
 * `scripts/bundle-annotation-overlay.cjs` and injected via CDP.
 * Page JS cannot observe this module: it shares the DOM only.
 *
 * `boot()` wires collaborators: the chrome (DOM + stylesheet), the mark store
 * (live marks and their nodes), and the draft stroke (freehand ink).
 */
import type { BrowserAnnotationTheme } from "../../../ipc-contracts/browser-annotation-types";
import {
  commentWithStyleTweaks,
  parseStyleDeclarations,
  type BrowserStyleTweak,
} from "./browser-style-tweaks";
import {
  createMarkStore,
  type LiveMark,
} from "./browser-annotation-mark-store";
import {
  captureOverlayElement,
  overlayElementCssRect,
  selectorPath,
} from "./browser-annotation-overlay-capture";
import {
  OVERLAY_MODES,
  createOverlayChrome,
  type OverlayMode,
} from "./browser-annotation-overlay-chrome";
import {
  createDraftStroke,
  makeInkPath,
  paintStrokePaths,
  type StrokePoint,
} from "./browser-annotation-overlay-ink";
import {
  ANNOTATION_BUNDLE_BYTE_BUDGET,
  ANNOTATION_BUNDLE_ELEMENT_CAP,
  ANNOTATION_STROKE_HALO_SIZE_PX,
  applyByteBudget,
  eraseNewestAtPoint,
  isElementVisuallyPresent,
  isTinyDrag,
  normalizeDragRect,
  placeCommentBox,
  rectsOverlap,
  resolveRegionSelection,
  strokeBoundsFromPoints,
  toMarkSnapshot,
  unionRects,
  validateElementMark,
  type OverlayMarkModel,
  type RegionCandidate,
} from "./browser-annotation-overlay-logic";
import { createAnnotationTargetPicker } from "./browser-annotation-target-picker";

/** The command surface the main process calls by name via `callGuestHook`. */
interface GuestHooks {
  __traycerAnnotationCancel: () => void;
  __traycerAnnotationHideChromeForCapture: () => void;
  __traycerAnnotationResetAfterAttach: () => void;
  __traycerAnnotationCaptureFailed: () => void;
  __traycerAnnotationPrepareAttach: () => Record<string, unknown> | null;
  __traycerAnnotationSetTheme: (theme: BrowserAnnotationTheme) => void;
  __traycerAnnotationSetTargetChatLabel: (
    targets: readonly { readonly chatId: string; readonly label: string }[],
    defaultChatId: string | null,
  ) => void;
}

type GuestWindow = Window &
  Partial<GuestHooks> & {
    __traycerAnnotation?: ((payload: string) => void) | undefined;
  };

function boot(): boolean {
  const W: GuestWindow = window;
  const D = document;

  if (typeof W.__traycerAnnotationCancel === "function") {
    try {
      W.__traycerAnnotationCancel();
    } catch {
      // leftover session
    }
  }
  const leftover = D.querySelector('[data-traycer-annotation="host"]');
  if (leftover) leftover.remove();

  const hostRoot = D.documentElement || D.body;
  if (!hostRoot) return false;

  const targetPicker = createAnnotationTargetPicker({
    document: D,
    onSelect: (chatId) => requestAttach(chatId),
  });
  const chrome = createOverlayChrome({
    document: D,
    targetPickerRoot: targetPicker.root,
  });
  const {
    host,
    layer,
    hover,
    hoverLabel,
    marquee,
    svg,
    pill,
    buttons,
    editor,
    comment,
    tweaks,
    refuseLine,
    refuseBanner,
    errorLine,
  } = chrome;
  hostRoot.appendChild(host);

  let mode: OverlayMode = "select";
  let done = false;
  let chromeHidden = false;
  let refusedCount = 0;
  let persistRefuseCount = 0;
  let attachError = "";
  let attachPending = false;
  const listeners = new AbortController();
  let idSeq = 0;
  const marks = createMarkStore({
    layer,
    paint: paintLiveMark,
    onChanged: onMarksChanged,
  });
  const draft = createDraftStroke({
    document: D,
    svg,
    toViewport: viewportPoints,
  });
  let dragStart: { x: number; y: number } | null = null;
  let hoveredElement: Element | null = null;
  let scrollFrame: number | null = null;

  function emit(event: unknown): void {
    const fn = W.__traycerAnnotation;
    if (typeof fn !== "function") return;
    try {
      fn(JSON.stringify(event));
    } catch {
      // binding may be gone
    }
  }

  function setTheme(theme: BrowserAnnotationTheme): void {
    host.style.setProperty("--annotation-background", theme.background);
    host.style.setProperty("--annotation-foreground", theme.foreground);
    host.style.setProperty("--annotation-popover", theme.popover);
    host.style.setProperty(
      "--annotation-popover-foreground",
      theme.popoverForeground,
    );
    host.style.setProperty(
      "--annotation-muted-foreground",
      theme.mutedForeground,
    );
    host.style.setProperty("--annotation-border", theme.border);
    host.style.setProperty("--annotation-input", theme.input);
    host.style.setProperty("--annotation-ring", theme.ring);
    host.style.setProperty("--annotation-primary", theme.primary);
    host.style.setProperty(
      "--annotation-primary-foreground",
      theme.primaryForeground,
    );
    host.style.setProperty("--annotation-accent", theme.accent);
    host.style.setProperty(
      "--annotation-accent-foreground",
      theme.accentForeground,
    );
    host.style.setProperty("--annotation-destructive", theme.destructive);
    host.style.setProperty("--annotation-warning", theme.warning);
    host.style.setProperty(
      "--annotation-warning-foreground",
      theme.warningForeground,
    );
    host.style.setProperty("--annotation-font", theme.fontFamily);
    host.style.setProperty("--annotation-color-scheme", theme.appearance);
  }

  function emitState(): void {
    emit({ type: "stateChanged", mode, markCount: marks.entries.length });
  }

  function onMarksChanged(): void {
    // The mark set is half of what a tweak applies to, so it has to re-run here
    // and not only on textarea input: typing CSS and THEN marking a second
    // element used to leave that element unstyled and absent from the summary,
    // and unmarking one used to leave this overlay's declaration behind on it.
    syncTweaks();
    emitState();
    layoutChrome();
  }

  function nextId(prefix: string): string {
    idSeq += 1;
    return prefix + "-" + String(idSeq);
  }

  function paintMode(): void {
    for (const name of OVERLAY_MODES) {
      const button = buttons[name];
      if (button === undefined) continue;
      button.setAttribute("aria-pressed", name === mode ? "true" : "false");
    }
  }

  function setMode(next: string): void {
    if (attachPending) return;
    let found: OverlayMode | null = null;
    for (const name of OVERLAY_MODES) {
      if (name === next) found = name;
    }
    if (found === null || found === mode) return;
    mode = found;
    paintMode();
    hideHover();
    emitState();
  }

  function isOverlayNode(node: EventTarget | null): boolean {
    if (node === host || node === pill || node === editor) return true;
    if (node instanceof Node && pill.contains(node)) return true;
    if (node instanceof Node && editor.contains(node)) return true;
    return false;
  }

  function eventTouchesOverlay(e: Event): boolean {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    for (const node of path) {
      if (isOverlayNode(node)) return true;
    }
    return false;
  }

  function isOverlayTextTarget(e: Event): boolean {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    for (const node of path) {
      if (!(node instanceof HTMLElement)) continue;
      const tag = node.tagName.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        tag === "button" ||
        node.isContentEditable
      ) {
        return true;
      }
    }
    return false;
  }

  function swallow(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") {
      e.stopImmediatePropagation();
    }
  }

  function targetAt(x: number, y: number): Element | null {
    let els: Element[] = [];
    try {
      els = D.elementsFromPoint(x, y) || [];
    } catch {
      els = [];
    }
    for (const el of els) {
      if (el === host) continue;
      if (el === D.documentElement || el === D.body) continue;
      return el;
    }
    return null;
  }

  function computedVisual(el: Element): {
    display: string;
    visibility: string;
    opacity: number;
  } {
    try {
      const cs = W.getComputedStyle(el);
      const opacity = Number.parseFloat(cs.opacity || "1");
      return {
        display: cs.display,
        visibility: cs.visibility,
        opacity: Number.isFinite(opacity) ? opacity : 1,
      };
    } catch {
      return { display: "block", visibility: "visible", opacity: 1 };
    }
  }

  function elementIsVisible(el: Element): boolean {
    const box = overlayElementCssRect(el);
    const visual = computedVisual(el);
    return isElementVisuallyPresent({
      connected: el.isConnected,
      width: box.width,
      height: box.height,
      display: visual.display,
      visibility: visual.visibility,
      opacity: visual.opacity,
    });
  }

  function collectRegionScan(region: OverlayMarkModel["bounds"]): {
    readonly candidates: RegionCandidate[];
    readonly byId: Map<string, Element>;
  } {
    const nodes = D.querySelectorAll("body *");
    const ids = new WeakMap<Element, string>();
    const byId = new Map<string, Element>();
    let seq = 0;
    const idOf = (el: Element): string => {
      const existing = ids.get(el);
      if (existing !== undefined) return existing;
      seq += 1;
      const id = "n-" + String(seq);
      ids.set(el, id);
      byId.set(id, el);
      return id;
    };
    const markedEls = new Set<Element>();
    for (const entry of marks.entries) {
      if (entry.element !== null) markedEls.add(entry.element);
    }
    const out: RegionCandidate[] = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const el = nodes[i];
      if (!(el instanceof Element)) continue;
      if (el === host || host.contains(el)) continue;
      if (el === D.body || el === D.documentElement) continue;
      const alreadyMarked = markedEls.has(el);
      const bounds = overlayElementCssRect(el);
      if (!alreadyMarked && !rectsOverlap(bounds, region)) continue;
      const ancestorIds: string[] = [];
      let parent: Element | null = el.parentElement;
      while (
        parent !== null &&
        parent !== D.body &&
        parent !== D.documentElement &&
        parent !== host
      ) {
        ancestorIds.push(idOf(parent));
        parent = parent.parentElement;
      }
      out.push({
        id: idOf(el),
        ancestorIds,
        bounds,
        visible: alreadyMarked ? true : elementIsVisibleFromBounds(el, bounds),
        alreadyMarked,
      });
    }
    return { candidates: out, byId };
  }

  function elementIsVisibleFromBounds(
    el: Element,
    bounds: OverlayMarkModel["bounds"],
  ): boolean {
    const visual = computedVisual(el);
    return isElementVisuallyPresent({
      connected: el.isConnected,
      width: bounds.width,
      height: bounds.height,
      display: visual.display,
      visibility: visual.visibility,
      opacity: visual.opacity,
    });
  }

  function placeBox(node: HTMLElement, rect: OverlayMarkModel["bounds"]): void {
    node.style.display = "block";
    node.style.left = String(rect.x) + "px";
    node.style.top = String(rect.y) + "px";
    node.style.width = String(Math.max(0, rect.width)) + "px";
    node.style.height = String(Math.max(0, rect.height)) + "px";
  }

  function pageRect(
    rect: OverlayMarkModel["bounds"],
  ): OverlayMarkModel["bounds"] {
    return { ...rect, x: rect.x + W.scrollX, y: rect.y + W.scrollY };
  }

  function viewportRect(
    rect: OverlayMarkModel["bounds"],
  ): OverlayMarkModel["bounds"] {
    return { ...rect, x: rect.x - W.scrollX, y: rect.y - W.scrollY };
  }

  function pagePoint(point: StrokePoint): StrokePoint {
    return { x: point.x + W.scrollX, y: point.y + W.scrollY };
  }

  function viewportPoints(points: readonly StrokePoint[]): StrokePoint[] {
    return points.map((point) => ({
      x: point.x - W.scrollX,
      y: point.y - W.scrollY,
    }));
  }

  function viewportBounds(entry: LiveMark): OverlayMarkModel["bounds"] {
    return entry.element !== null && entry.element.isConnected
      ? overlayElementCssRect(entry.element)
      : viewportRect(entry.model.bounds);
  }

  function viewportModel(entry: LiveMark): OverlayMarkModel {
    return { ...entry.model, bounds: viewportBounds(entry) };
  }

  function hideHover(): void {
    hoveredElement = null;
    hover.classList.remove("visible");
    hoverLabel.classList.remove("visible");
  }

  function describeHoverTarget(
    el: Element,
    bounds: OverlayMarkModel["bounds"],
  ): string {
    const tag = String(el.tagName || "element").toLowerCase();
    const id = el.id ? "#" + el.id : "";
    const classes = Array.from(el.classList).slice(0, 3);
    const classLabel = classes.length > 0 ? "." + classes.join(".") : "";
    return (
      tag +
      id +
      classLabel +
      "  " +
      String(Math.round(bounds.width)) +
      "×" +
      String(Math.round(bounds.height))
    ).slice(0, 160);
  }

  function paintHover(el: Element): void {
    hoveredElement = el;
    const bounds = overlayElementCssRect(el);
    placeBox(hover, bounds);
    hover.classList.add("visible");
    hoverLabel.textContent = describeHoverTarget(el, bounds);
    positionBadge(hoverLabel, bounds);
    hoverLabel.classList.add("visible");
  }

  function badgeLabel(mark: OverlayMarkModel, el: Element | null): string {
    if (mark.kind === "region") return "region";
    if (mark.kind === "stroke") return "draw";
    if (el) return String(el.tagName || "el").toLowerCase();
    if (mark.selector) {
      const tag = mark.selector.split(/[\s.#:>[]/)[0];
      return tag || "el";
    }
    return "el";
  }

  function positionBadge(
    badge: HTMLElement,
    bounds: OverlayMarkModel["bounds"],
  ): void {
    let top = bounds.y - 22;
    if (top < 2) top = bounds.y + 4;
    badge.style.left = String(Math.max(0, bounds.x)) + "px";
    badge.style.top = String(top) + "px";
  }

  function paintLiveMark(entry: LiveMark): void {
    const bounds = viewportBounds(entry);
    if (entry.outline) {
      placeBox(entry.outline, bounds);
      entry.outline.classList.toggle("invalid", entry.invalid);
      entry.outline.classList.toggle("region", entry.model.kind === "region");
    }
    if (entry.badge) {
      entry.badge.classList.toggle("invalid", entry.invalid);
      entry.badge.textContent = entry.invalid
        ? "re-mark"
        : badgeLabel(entry.model, entry.element);
      positionBadge(entry.badge, bounds);
    }
    if (
      entry.points !== null &&
      entry.haloPath !== null &&
      entry.haloDarkPath !== null &&
      entry.inkPath !== null
    ) {
      paintStrokePaths(
        viewportPoints(entry.points),
        entry.haloPath,
        entry.haloDarkPath,
        entry.inkPath,
      );
    }
  }

  function addElementMark(el: Element, allowToggle: boolean): boolean {
    if (attachPending) return false;
    const key = marks.keyOf(el);
    const existing = marks.findElement(key);
    if (existing !== null) {
      if (!allowToggle) return false;
      marks.remove(existing);
      return true;
    }
    if (marks.elementCount() >= ANNOTATION_BUNDLE_ELEMENT_CAP) {
      refusedCount += 1;
      layoutChrome();
      return false;
    }
    const added: OverlayMarkModel = {
      id: nextId("el"),
      kind: "element",
      bounds: pageRect(overlayElementCssRect(el)),
      selector: selectorPath(el),
      elementKey: key,
    };
    const outline = D.createElement("div");
    outline.className = "outline";
    const badge = D.createElement("div");
    badge.className = "badge";
    const entry: LiveMark = {
      model: added,
      element: el,
      points: null,
      outline,
      badge,
      haloPath: null,
      haloDarkPath: null,
      inkPath: null,
      invalid: false,
    };
    paintLiveMark(entry);
    marks.push(entry);
    return true;
  }

  function addRegionRect(bounds: OverlayMarkModel["bounds"]): void {
    const outline = D.createElement("div");
    outline.className = "outline region";
    const badge = D.createElement("div");
    badge.className = "badge";
    const model: OverlayMarkModel = {
      id: nextId("region"),
      kind: "region",
      bounds: pageRect(bounds),
      selector: null,
      elementKey: null,
    };
    const entry: LiveMark = {
      model,
      element: null,
      points: null,
      outline,
      badge,
      haloPath: null,
      haloDarkPath: null,
      inkPath: null,
      invalid: false,
    };
    paintLiveMark(entry);
    marks.push(entry);
  }

  function addStrokeMark(points: StrokePoint[]): void {
    const bounds = strokeBoundsFromPoints(
      points,
      ANNOTATION_STROKE_HALO_SIZE_PX,
    );
    if (bounds === null) return;
    const haloLight = makeInkPath(D, "halo-light");
    const haloDark = makeInkPath(D, "halo-dark");
    const ink = makeInkPath(D, "pen");
    svg.appendChild(haloDark);
    svg.appendChild(haloLight);
    svg.appendChild(ink);
    const model: OverlayMarkModel = {
      id: nextId("stroke"),
      kind: "stroke",
      bounds,
      selector: null,
      elementKey: null,
    };
    const entry: LiveMark = {
      model,
      element: null,
      points,
      outline: null,
      badge: null,
      haloPath: haloLight,
      haloDarkPath: haloDark,
      inkPath: ink,
      invalid: false,
    };
    paintLiveMark(entry);
    marks.push(entry);
  }

  function eraseAt(x: number, y: number): void {
    if (attachPending) return;
    const hit = eraseNewestAtPoint(marks.entries.map(viewportModel), x, y);
    if (hit.removed === null) return;
    marks.removeById(hit.removed.id);
  }

  function applyRegion(rect: OverlayMarkModel["bounds"]): void {
    if (attachPending) return;
    const scan = collectRegionScan(rect);
    const resolved = resolveRegionSelection({
      candidates: scan.candidates,
      region: rect,
      existingElementCount: marks.elementCount(),
      elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
    });
    if (resolved.reason === "empty") {
      addRegionRect(rect);
      return;
    }
    let added = 0;
    for (const candidate of resolved.selected) {
      const el = scan.byId.get(candidate.id);
      if (el === undefined) continue;
      if (addElementMark(el, false)) added += 1;
    }
    refusedCount += resolved.refusedCount;
    if (added === 0 && resolved.selected.length === 0) {
      addRegionRect(rect);
    }
    layoutChrome();
  }

  function layoutChrome(): void {
    if (chromeHidden) {
      pill.style.visibility = "hidden";
      editor.style.display = "none";
      refuseBanner.style.display = "none";
      hideHover();
      marquee.style.display = "none";
      return;
    }
    pill.style.visibility = "";
    const hasMarks = marks.entries.length > 0;
    if (!hasMarks) targetPicker.close(false);
    editor.style.display = hasMarks ? "block" : "none";
    const shownRefuse =
      persistRefuseCount > 0 ? persistRefuseCount : refusedCount;
    if (shownRefuse > 0) {
      const copy =
        String(shownRefuse) +
        (shownRefuse === 1
          ? " element not included"
          : " elements not included");
      refuseLine.textContent = copy;
      refuseBanner.textContent = copy;
      refuseLine.style.display = hasMarks ? "block" : "none";
      refuseBanner.style.display = hasMarks ? "none" : "block";
    } else {
      refuseLine.style.display = "none";
      refuseLine.textContent = "";
      refuseBanner.style.display = "none";
      refuseBanner.textContent = "";
    }
    comment.disabled = attachPending;
    tweaks.disabled = attachPending;
    targetPicker.setDisabled(attachPending);
    for (const name of OVERLAY_MODES) {
      const button = buttons[name];
      if (button === undefined) continue;
      button.disabled = attachPending;
    }
    if (attachError) {
      errorLine.style.display = "block";
      errorLine.textContent = attachError;
    } else {
      errorLine.style.display = "none";
      errorLine.textContent = "";
    }
    if (!hasMarks) return;
    const union = unionRects(
      marks.entries.map((entry) => viewportBounds(entry)),
    );
    const box = editor.getBoundingClientRect();
    const pillBox = pill.getBoundingClientRect();
    const placed = placeCommentBox({
      union,
      viewport: { width: W.innerWidth, height: W.innerHeight },
      box: {
        width: box.width || 430,
        height: box.height || 72,
      },
      pillBottom: pillBox.bottom || 54,
    });
    editor.style.left = String(placed.x) + "px";
    editor.style.top = String(placed.y) + "px";
  }

  function hideChromeForCapture(): void {
    targetPicker.close(false);
    chromeHidden = true;
    layoutChrome();
  }

  function resetAfterAttach(): void {
    chromeHidden = false;
    attachPending = false;
    host.removeAttribute("data-traycer-capture-failed");
    revertTweaks();
    marks.clear();
    comment.value = "";
    tweaks.value = "";
    refusedCount = 0;
    attachError = "";
    targetPicker.close(false);
    hideHover();
    marquee.style.display = "none";
    draft.clear();
    emitState();
    layoutChrome();
  }

  function captureFailed(): void {
    chromeHidden = false;
    attachPending = false;
    attachError = "Couldn't capture the annotated area. Try sending again.";
    host.setAttribute("data-traycer-capture-failed", "true");
    layoutChrome();
  }

  function setTargetChatLabel(
    targets: readonly { readonly chatId: string; readonly label: string }[],
    defaultChatId: string | null,
  ): void {
    targetPicker.setTargets(targets, defaultChatId);
    layoutChrome();
  }

  function validateAll(): boolean {
    let ok = true;
    for (const entry of marks.entries) {
      if (entry.model.kind !== "element") {
        entry.invalid = false;
        paintLiveMark(entry);
        continue;
      }
      const el = entry.element;
      const connected = el !== null && el.isConnected;
      const visible = el !== null && elementIsVisible(el);
      const currentBox =
        el !== null && connected
          ? overlayElementCssRect(el)
          : viewportRect(entry.model.bounds);
      const status = validateElementMark({
        connected,
        visible,
        currentBox,
        markBox: viewportRect(entry.model.bounds),
      });
      entry.invalid = status !== "ok";
      if (entry.invalid) ok = false;
      paintLiveMark(entry);
    }
    return ok;
  }

  function prepareAttach(
    targetChatId: string | null,
  ): Record<string, unknown> | null {
    const resolvedTargetChatId =
      targetChatId ?? targetPicker.getDefaultChatId();
    if (
      attachPending ||
      marks.entries.length === 0 ||
      resolvedTargetChatId === null
    ) {
      return null;
    }
    attachError = "";
    if (!validateAll()) {
      attachError = "Some marks need re-marking before sending.";
      layoutChrome();
      return null;
    }
    const snapshots = marks.entries.map((entry) =>
      toMarkSnapshot(viewportModel(entry)),
    );
    const captures: Record<string, unknown>[] = [];
    for (const entry of marks.entries) {
      if (entry.model.kind !== "element" || entry.element === null) continue;
      if (!entry.element.isConnected) continue;
      captures.push(captureOverlayElement(entry.element));
    }
    const budgeted = applyByteBudget({
      items: captures,
      existingBytes: 0,
      budget: ANNOTATION_BUNDLE_BYTE_BUDGET,
    });
    persistRefuseCount = budgeted.refusedCount;
    const union = unionRects(snapshots.map((mark) => mark.bounds));
    if (union === null) return null;
    attachPending = true;
    return {
      targetChatId: resolvedTargetChatId,
      marks: snapshots,
      elements: budgeted.kept,
      // The tweaks ride the comment because it is the only free-form text that
      // reaches a chat; the annotation record is a released wire contract.
      comment: commentWithStyleTweaks(comment.value, collectTweaks()),
      unionRect: union,
    };
  }

  function requestAttach(targetChatId: string | null): void {
    const payload = prepareAttach(targetChatId);
    if (payload === null) return;
    emit({
      type: "attachRequested",
      payload,
    });
  }

  /**
   * What each marked element looked like before any tweak, keyed by element.
   *
   * Recorded on FIRST tweak rather than per keystroke: the point of comparison is
   * the page as the user found it, and re-reading it after a tweak has landed
   * would report the tweak as its own previous value.
   */
  const tweakOriginals = new WeakMap<Element, Map<string, string>>();
  /** Inline properties this overlay set, so it can take them back off. */
  const tweakApplied = new WeakMap<Element, Set<string>>();
  /**
   * The element's OWN inline declaration before this overlay touched it, so a
   * revert can put it back.
   *
   * Deliberately separate from `tweakOriginals`, which holds computed values for
   * the report. The two answer different questions and a revert needs this one:
   * an element carrying `style="color:red"` has a computed colour AND an inline
   * one, and restoring the computed value as inline would invent a declaration
   * the page never had - while dropping the property, which is what
   * `removeProperty` does, silently deletes the author's own.
   */
  const tweakInline = new WeakMap<
    Element,
    Map<string, { value: string; priority: string }>
  >();

  /**
   * The element's inline style, for the elements that have one.
   *
   * `SVGElement` as well as `HTMLElement`: a mark can land on an SVG icon, and
   * `fill` or `stroke` typed against one is exactly the kind of tweak this is
   * for. Both implement `ElementCSSInlineStyle`; neither shares a base class
   * that means "has a style".
   */
  function inlineStyleOf(el: Element): CSSStyleDeclaration | null {
    if (el instanceof HTMLElement) return el.style;
    if (el instanceof SVGElement) return el.style;
    return null;
  }

  function markedElements(): Element[] {
    const out: Element[] = [];
    for (const entry of marks.entries) {
      if (entry.model.kind !== "element" || entry.element === null) continue;
      if (!entry.element.isConnected) continue;
      out.push(entry.element);
    }
    return out;
  }

  function computedValueOf(el: Element, property: string): string {
    try {
      return W.getComputedStyle(el).getPropertyValue(property).trim();
    } catch {
      return "";
    }
  }

  /**
   * Applies the current declarations to every marked element.
   *
   * Re-applied wholesale on each edit rather than diffed: removing what is no
   * longer typed and setting what is keeps the page showing exactly the text in
   * the box, which is the only behaviour a user can predict while typing.
   */
  /**
   * The elements this overlay currently has a tweak on.
   *
   * Needed because `markedElements()` answers "what is marked NOW": an element
   * that just left the set is no longer reachable through it, and it is exactly
   * the element whose tweak has to come off.
   */
  const tweakedElements = new Set<Element>();

  /**
   * Brings the page in line with the current declarations AND the current mark
   * set, in that order of dependence.
   */
  function syncTweaks(): void {
    const marked = new Set<Element>(markedElements());
    for (const el of [...tweakedElements]) {
      if (marked.has(el)) continue;
      revertElement(el);
      tweakedElements.delete(el);
    }
    applyTweaks();
  }

  /** Takes this overlay's declarations off one element. */
  function revertElement(el: Element): void {
    const applied = tweakApplied.get(el);
    if (applied === undefined) return;
    const style = inlineStyleOf(el);
    const inline = tweakInline.get(el);
    if (style !== null) {
      for (const property of applied)
        restoreInline(style, inline ?? null, property);
    }
    applied.clear();
    inline?.clear();
  }

  function applyTweaks(): void {
    const declarations = parseStyleDeclarations(tweaks.value);
    const wanted = new Set(declarations.map((entry) => entry.property));
    for (const el of markedElements()) {
      const style = inlineStyleOf(el);
      if (style === null) continue;
      let originals = tweakOriginals.get(el);
      if (originals === undefined) {
        originals = new Map();
        tweakOriginals.set(el, originals);
      }
      let applied = tweakApplied.get(el);
      if (applied === undefined) {
        applied = new Set();
        tweakApplied.set(el, applied);
      }
      let inline = tweakInline.get(el);
      if (inline === undefined) {
        inline = new Map();
        tweakInline.set(el, inline);
      }
      for (const property of [...applied]) {
        if (wanted.has(property)) continue;
        restoreInline(style, inline, property);
        applied.delete(property);
      }
      for (const declaration of declarations) {
        if (!originals.has(declaration.property)) {
          originals.set(
            declaration.property,
            computedValueOf(el, declaration.property),
          );
        }
        // Read BEFORE the set, and only once: the second edit of the same
        // property would otherwise record this overlay's own value as the
        // page's.
        if (!inline.has(declaration.property)) {
          inline.set(declaration.property, {
            value: style.getPropertyValue(declaration.property),
            priority: style.getPropertyPriority(declaration.property),
          });
        }
        style.setProperty(declaration.property, declaration.value);
        applied.add(declaration.property);
      }
      tweakedElements.add(el);
    }
  }

  /**
   * Takes every applied tweak back off, for a cancelled or sent annotation.
   *
   * Walks the tweaked set rather than the marked one: an element unmarked before
   * the overlay exits is still an element this overlay wrote to.
   */
  function revertTweaks(): void {
    for (const el of tweakedElements) revertElement(el);
    tweakedElements.clear();
  }

  /**
   * Puts one property back the way the page had it.
   *
   * A property the page never declared inline is removed; one it did is written
   * back with its own value AND priority, because dropping an `!important` and
   * restoring it unprioritised are different pages.
   */
  function restoreInline(
    style: CSSStyleDeclaration,
    inline: Map<string, { value: string; priority: string }> | null,
    property: string,
  ): void {
    const previous = inline?.get(property);
    if (previous === undefined || previous.value.length === 0) {
      style.removeProperty(property);
      return;
    }
    style.setProperty(property, previous.value, previous.priority);
  }

  /**
   * The tweaks as records, for the attach payload.
   *
   * Only declarations the browser ACCEPTED are reported: `setProperty` silently
   * ignores a value it cannot parse, so reading the inline style back is what
   * separates "I tried this" from "this is what the page is showing".
   */
  function collectTweaks(): BrowserStyleTweak[] {
    const out: BrowserStyleTweak[] = [];
    for (const entry of marks.entries) {
      if (entry.model.kind !== "element" || entry.element === null) continue;
      const el = entry.element;
      const applied = tweakApplied.get(el);
      const originals = tweakOriginals.get(el);
      if (applied === undefined || originals === undefined) continue;
      const style = inlineStyleOf(el);
      if (style === null) continue;
      for (const property of applied) {
        const value = style.getPropertyValue(property).trim();
        if (value.length === 0) continue;
        out.push({
          selector: entry.model.selector ?? "",
          property,
          previousValue: originals.get(property) ?? "",
          value,
        });
      }
    }
    return out;
  }

  function onPagePointer(e: Event): void {
    if (eventTouchesOverlay(e)) return;
    targetPicker.close(false);
    swallow(e);
  }

  function refreshAfterScroll(): void {
    scrollFrame = null;
    if (done) return;
    for (const entry of marks.entries) {
      paintLiveMark(entry);
    }
    draft.repaint();
    if (hoveredElement !== null && hoveredElement.isConnected) {
      paintHover(hoveredElement);
    } else {
      hideHover();
    }
    layoutChrome();
  }

  function onScroll(): void {
    if (scrollFrame !== null) return;
    scrollFrame = W.requestAnimationFrame(refreshAfterScroll);
  }

  function onPointerMove(e: PointerEvent): void {
    if (eventTouchesOverlay(e)) {
      hideHover();
      return;
    }
    if (attachPending) {
      hideHover();
      return;
    }
    if (mode === "select" && dragStart === null && !draft.isDrawing()) {
      const target = targetAt(e.clientX, e.clientY);
      if (target) paintHover(target);
      else hideHover();
      return;
    }
    hideHover();
    if (mode === "region" && dragStart) {
      placeBox(
        marquee,
        normalizeDragRect(dragStart.x, dragStart.y, e.clientX, e.clientY),
      );
      return;
    }
    if (mode === "draw" && draft.isDrawing()) {
      draft.extend(pagePoint({ x: e.clientX, y: e.clientY }));
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (eventTouchesOverlay(e)) return;
    swallow(e);
    if (e.button !== 0) return;
    if (attachPending) return;
    marks.clearInvalid();
    attachError = "";
    if (mode === "select") {
      const target = targetAt(e.clientX, e.clientY);
      if (target) addElementMark(target, true);
      return;
    }
    if (mode === "erase") {
      eraseAt(e.clientX, e.clientY);
      return;
    }
    dragStart = { x: e.clientX, y: e.clientY };
    if (mode === "draw") draft.begin(pagePoint(dragStart));
  }

  function onPointerUp(e: PointerEvent): void {
    const drawing = draft.isDrawing();
    if (eventTouchesOverlay(e) && dragStart === null && !drawing) return;
    if (dragStart === null && !drawing) return;
    swallow(e);
    if (attachPending) {
      draft.clear();
      dragStart = null;
      marquee.style.display = "none";
      return;
    }
    if (mode === "region" && dragStart) {
      const rect = normalizeDragRect(
        dragStart.x,
        dragStart.y,
        e.clientX,
        e.clientY,
      );
      marquee.style.display = "none";
      if (!isTinyDrag(rect)) applyRegion(rect);
    } else if (mode === "draw") {
      const points = draft.finish();
      if (points.length >= 2) addStrokeMark(points);
    }
    dragStart = null;
    layoutChrome();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      if (targetPicker.isOpen()) return;
      swallow(e);
      finishCancelled();
      return;
    }
    const focusInOverlayText = isOverlayTextTarget(e);
    if (focusInOverlayText) {
      if (
        e.composedPath().includes(comment) &&
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        swallow(e);
        requestAttach(null);
      }
      return;
    }
    if (e.key === "Enter" && marks.entries.length > 0) {
      swallow(e);
      requestAttach(null);
      return;
    }
  }

  function onPillClick(e: Event): void {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const next = t.getAttribute("data-mode");
    if (!next) return;
    swallow(e);
    setMode(next);
  }

  function teardown(): void {
    if (done) return;
    done = true;
    // The page must not keep a tweak the user only tried: an overlay that exits
    // leaving inline styles behind has edited the page rather than described it.
    revertTweaks();
    listeners.abort();
    if (scrollFrame !== null) W.cancelAnimationFrame(scrollFrame);
    targetPicker.dispose();
    host.remove();
    for (const name of Object.keys(HOOKS)) {
      if (!Reflect.deleteProperty(W, name)) Reflect.set(W, name, undefined);
    }
  }

  function finishCancelled(): void {
    if (done) return;
    emit({ type: "cancelled" });
    teardown();
  }

  const HOOKS: GuestHooks = {
    __traycerAnnotationCancel: finishCancelled,
    __traycerAnnotationHideChromeForCapture: hideChromeForCapture,
    __traycerAnnotationResetAfterAttach: resetAfterAttach,
    __traycerAnnotationCaptureFailed: captureFailed,
    __traycerAnnotationPrepareAttach: () => prepareAttach(null),
    __traycerAnnotationSetTheme: setTheme,
    __traycerAnnotationSetTargetChatLabel: setTargetChatLabel,
  };
  Object.assign(W, HOOKS);
  const listen = { capture: true, signal: listeners.signal } as const;
  const listenPassiveFalse = {
    capture: true,
    passive: false,
    signal: listeners.signal,
  } as const;
  W.addEventListener("mousedown", onPagePointer, listen);
  W.addEventListener("mouseup", onPagePointer, listen);
  W.addEventListener("click", onPagePointer, listen);
  W.addEventListener("auxclick", onPagePointer, listen);
  W.addEventListener("pointerdown", onPointerDown, listenPassiveFalse);
  W.addEventListener("pointermove", onPointerMove, listenPassiveFalse);
  D.documentElement.addEventListener("pointerleave", hideHover, listen);
  W.addEventListener("pointerup", onPointerUp, listenPassiveFalse);
  W.addEventListener("pointercancel", onPointerUp, listenPassiveFalse);
  W.addEventListener("scroll", onScroll, listen);
  W.addEventListener("keydown", onKey, listen);
  pill.addEventListener("click", onPillClick, listen);
  tweaks.addEventListener("input", applyTweaks, { signal: listeners.signal });
  emitState();
  return true;
}

boot();
