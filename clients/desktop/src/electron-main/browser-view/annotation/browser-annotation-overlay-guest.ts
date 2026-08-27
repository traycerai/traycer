/**
 * Isolated-world overlay runtime. Bundled into an IIFE by
 * `scripts/bundle-annotation-overlay.cjs` and injected via CDP.
 * Page JS cannot observe this module: it shares the DOM only.
 */
import { getStroke } from "perfect-freehand";
import {
  captureOverlayElement,
  overlayElementCssRect,
  overlayElementSelector,
} from "./browser-annotation-overlay-capture";
import {
  ANNOTATION_BUNDLE_BYTE_BUDGET,
  ANNOTATION_BUNDLE_ELEMENT_CAP,
  ANNOTATION_STROKE_HALO_SIZE_PX,
  ANNOTATION_STROKE_SIZE_PX,
  applyByteBudget,
  eraseNewestAtPoint,
  isElementVisuallyPresent,
  isTinyDrag,
  normalizeDragRect,
  placeCommentBox,
  rectsOverlap,
  resolveRegionSelection,
  strokeBoundsFromPoints,
  svgPathFromPolygon,
  toMarkSnapshot,
  unionRects,
  validateElementMark,
  type OverlayMarkModel,
  type RegionCandidate,
} from "./browser-annotation-overlay-logic";
import {
  ANNOTATION_TARGET_PICKER_CSS,
  createAnnotationTargetPicker,
} from "./browser-annotation-target-picker";

const STROKE_OPTIONS = {
  size: ANNOTATION_STROKE_SIZE_PX,
  thinning: 0.55,
  smoothing: 0.5,
  streamline: 0.45,
  simulatePressure: true,
};

const HALO_OPTIONS = {
  size: ANNOTATION_STROKE_HALO_SIZE_PX,
  thinning: 0.35,
  smoothing: 0.5,
  streamline: 0.45,
  simulatePressure: true,
};

type GuestWindow = Window & {
  __traycerAnnotation?: ((payload: string) => void) | undefined;
  __traycerAnnotationCancel?: (() => void) | undefined;
  __traycerAnnotationHideChromeForCapture?: (() => void) | undefined;
  __traycerAnnotationResetAfterAttach?: (() => void) | undefined;
  __traycerAnnotationCaptureFailed?: (() => void) | undefined;
  __traycerAnnotationSetTargetChatLabel?:
    | ((
        targets: readonly { readonly chatId: string; readonly label: string }[],
        defaultChatId: string | null,
      ) => void)
    | undefined;
};

interface StrokePoint {
  readonly x: number;
  readonly y: number;
}

interface LiveMark {
  model: OverlayMarkModel;
  element: Element | null;
  points: StrokePoint[] | null;
  outline: HTMLElement | null;
  badge: HTMLElement | null;
  haloPath: SVGPathElement | null;
  haloDarkPath: SVGPathElement | null;
  inkPath: SVGPathElement | null;
  invalid: boolean;
}

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

  const host = D.createElement("div");
  host.setAttribute("data-traycer-annotation", "host");
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = D.createElement("style");
  style.textContent = [
    ":host{all:initial;}",
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    ".pill{position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;gap:2px;background:#2c2c31;border-radius:10px;padding:4px;pointer-events:auto;z-index:4;box-shadow:0 8px 24px rgba(0,0,0,.28);}",
    ".pill button{border:0;background:none;color:#c9c9d1;font-size:13px;padding:6px 14px;border-radius:7px;cursor:pointer;}",
    '.pill button[aria-pressed="true"]{background:#4a4a55;color:#8ab4ff;}',
    ".layer{position:fixed;inset:0;pointer-events:none;z-index:1;}",
    ".outline{position:fixed;pointer-events:none;border:2px solid #635bff;box-shadow:0 0 0 4px rgba(255,255,255,.85),0 0 0 5px rgba(17,17,22,.35);background:rgba(99,91,255,.06);border-radius:3px;}",
    ".outline.region{border-color:#5b7cfa;background:rgba(91,124,250,.06);}",
    ".outline.invalid{border-color:#d4a94e;box-shadow:0 0 0 4px rgba(255,255,255,.9),0 0 0 5px rgba(80,50,0,.35);background:rgba(212,169,78,.12);}",
    ".hover{position:fixed;pointer-events:none;border:2px solid #8ab4ff;box-shadow:0 0 0 3px rgba(255,255,255,.7);background:rgba(138,180,255,.08);border-radius:3px;opacity:0;visibility:hidden;}",
    ".hover-label{position:fixed;pointer-events:none;z-index:2;max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:4px;background:#111827;color:#fff;padding:2px 6px;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 1px 3px rgba(0,0,0,.4);opacity:0;visibility:hidden;}",
    ".hover.visible,.hover-label.visible{opacity:1;visibility:visible;}",
    "@media (prefers-reduced-motion:no-preference){.hover{transition-property:left,top,width,height,opacity;transition-duration:110ms,110ms,110ms,110ms,80ms;transition-timing-function:cubic-bezier(.2,0,0,1);}.hover-label{transition-property:left,top,opacity;transition-duration:110ms,110ms,80ms;transition-timing-function:cubic-bezier(.2,0,0,1);}}",
    ".marquee{position:fixed;pointer-events:none;border:1.5px dashed #5b7cfa;box-shadow:0 0 0 3px rgba(255,255,255,.7);background:rgba(91,124,250,.08);display:none;}",
    ".badge{position:fixed;pointer-events:none;background:#635bff;color:#fff;font-size:11px;padding:2px 7px;border-radius:6px;box-shadow:0 0 0 2px rgba(255,255,255,.9),0 1px 2px rgba(0,0,0,.25);z-index:2;white-space:nowrap;max-width:40vw;overflow:hidden;text-overflow:ellipsis;}",
    ".badge.invalid{background:#d4a94e;color:#1a1204;}",
    ".ink{position:fixed;inset:0;width:100%;height:100%;overflow:visible;}",
    ".ink .halo-light{fill:#fff;opacity:.88;}",
    ".ink .halo-dark{fill:#111218;opacity:.42;}",
    ".ink .pen{fill:#5b7cfa;}",
    ".editor{position:fixed;background:#2c2c31;border-radius:12px;padding:8px 10px;width:min(430px,calc(100vw - 24px));pointer-events:auto;z-index:4;box-shadow:0 10px 28px rgba(0,0,0,.32);display:none;}",
    ".row{display:flex;align-items:flex-end;gap:8px;}",
    ".editor textarea{min-width:0;flex:1;background:none;border:0;color:#e7e7ec;font-size:13px;outline:none;resize:none;min-height:34px;max-height:120px;line-height:1.35;font-family:inherit;}",
    ANNOTATION_TARGET_PICKER_CSS,
    ".refuse{color:#d4a94e;font-size:11px;margin-top:5px;display:none;}",
    ".refuse-banner{position:fixed;top:58px;left:50%;transform:translateX(-50%);background:#2c2c31;color:#d4a94e;font-size:12px;padding:6px 12px;border-radius:8px;pointer-events:none;z-index:4;display:none;box-shadow:0 8px 20px rgba(0,0,0,.28);}",
    ".error{color:#f0b4b4;font-size:11px;margin-top:5px;display:none;}",
  ].join("");

  const layer = D.createElement("div");
  layer.className = "layer";
  const hover = D.createElement("div");
  hover.className = "hover";
  const hoverLabel = D.createElement("div");
  hoverLabel.className = "hover-label";
  hoverLabel.setAttribute("aria-hidden", "true");
  const marquee = D.createElement("div");
  marquee.className = "marquee";
  const svg = D.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ink");
  svg.setAttribute("aria-hidden", "true");

  const pill = D.createElement("div");
  pill.className = "pill";
  pill.setAttribute("role", "toolbar");
  pill.setAttribute("aria-label", "Annotation tools");

  const MODES = ["select", "region", "draw", "erase"] as const;
  const LABELS = {
    select: "Select",
    region: "Region",
    draw: "Draw",
    erase: "Erase",
  };
  const buttons: Record<string, HTMLButtonElement> = {};
  for (const modeName of MODES) {
    const btn = D.createElement("button");
    btn.type = "button";
    btn.textContent = LABELS[modeName];
    btn.setAttribute("data-mode", modeName);
    btn.setAttribute("aria-pressed", modeName === "select" ? "true" : "false");
    pill.appendChild(btn);
    buttons[modeName] = btn;
  }

  const editor = D.createElement("div");
  editor.className = "editor";
  const row = D.createElement("div");
  row.className = "row";
  const comment = D.createElement("textarea");
  comment.rows = 1;
  comment.placeholder = "Describe the change...";
  comment.setAttribute("aria-label", "Annotation comment");
  const targetPicker = createAnnotationTargetPicker({
    document: D,
    onSelect: (chatId) => requestAttach(chatId),
  });
  row.appendChild(comment);
  row.appendChild(targetPicker.root);
  const refuseLine = D.createElement("div");
  refuseLine.className = "refuse";
  const refuseBanner = D.createElement("div");
  refuseBanner.className = "refuse-banner";
  const errorLine = D.createElement("div");
  errorLine.className = "error";
  editor.appendChild(row);
  editor.appendChild(refuseLine);
  editor.appendChild(errorLine);

  shadow.appendChild(style);
  shadow.appendChild(layer);
  layer.appendChild(svg);
  layer.appendChild(hover);
  layer.appendChild(hoverLabel);
  layer.appendChild(marquee);
  shadow.appendChild(pill);
  shadow.appendChild(editor);
  shadow.appendChild(refuseBanner);
  hostRoot.appendChild(host);

  let mode: (typeof MODES)[number] = "select";
  let done = false;
  let chromeHidden = false;
  let refusedCount = 0;
  let persistRefuseCount = 0;
  let attachError = "";
  let attachPending = false;
  const listeners = new AbortController();
  let idSeq = 0;
  const liveMarks: LiveMark[] = [];
  const elementKeys = new WeakMap<Element, string>();
  let keySeq = 0;
  let dragStart: { x: number; y: number } | null = null;
  let drawing = false;
  let draftPoints: StrokePoint[] = [];
  let draftHalo: SVGPathElement | null = null;
  let draftHaloDark: SVGPathElement | null = null;
  let draftInk: SVGPathElement | null = null;
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

  function emitState(): void {
    emit({ type: "stateChanged", mode, markCount: liveMarks.length });
  }

  function nextId(prefix: string): string {
    idSeq += 1;
    return prefix + "-" + String(idSeq);
  }

  function keyOf(el: Element): string {
    const existing = elementKeys.get(el);
    if (existing !== undefined) return existing;
    keySeq += 1;
    const key = "el-" + String(keySeq);
    elementKeys.set(el, key);
    return key;
  }

  function paintMode(): void {
    for (const name of MODES) {
      const button = buttons[name];
      if (button === undefined) continue;
      button.setAttribute("aria-pressed", name === mode ? "true" : "false");
    }
  }

  function setMode(next: string): void {
    if (attachPending) return;
    let found: (typeof MODES)[number] | null = null;
    for (const name of MODES) {
      if (name === next) found = name;
    }
    if (found === null || found === mode) return;
    mode = found;
    paintMode();
    hideHover();
    emitState();
  }

  function syncMarkCountFromStack(): void {
    emitState();
    layoutChrome();
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
    for (const entry of liveMarks) {
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

  function strokePathD(points: readonly StrokePoint[], size: number): string {
    const input = points.map((point) => [point.x, point.y] as [number, number]);
    const outline = getStroke(
      input,
      size === ANNOTATION_STROKE_HALO_SIZE_PX ? HALO_OPTIONS : STROKE_OPTIONS,
    );
    return svgPathFromPolygon(outline);
  }

  function makePath(className: string): SVGPathElement {
    const path = D.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", className);
    path.setAttribute("fill-rule", "nonzero");
    return path;
  }

  function paintStrokePaths(
    points: readonly StrokePoint[],
    haloLight: SVGPathElement,
    haloDark: SVGPathElement,
    ink: SVGPathElement,
  ): void {
    haloLight.setAttribute(
      "d",
      strokePathD(points, ANNOTATION_STROKE_HALO_SIZE_PX),
    );
    haloDark.setAttribute(
      "d",
      strokePathD(points, ANNOTATION_STROKE_HALO_SIZE_PX),
    );
    ink.setAttribute("d", strokePathD(points, ANNOTATION_STROKE_SIZE_PX));
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

  function clearInvalid(): void {
    for (const entry of liveMarks) {
      if (!entry.invalid) continue;
      entry.invalid = false;
      paintLiveMark(entry);
    }
  }

  function pushMark(entry: LiveMark): void {
    liveMarks.push(entry);
    if (entry.outline) layer.appendChild(entry.outline);
    if (entry.badge) layer.appendChild(entry.badge);
    syncMarkCountFromStack();
    layoutChrome();
  }

  function destroyMark(entry: LiveMark): void {
    entry.outline?.remove();
    entry.badge?.remove();
    entry.haloPath?.remove();
    entry.haloDarkPath?.remove();
    entry.inkPath?.remove();
  }

  function findElementMark(key: string): LiveMark | null {
    for (const entry of liveMarks) {
      if (entry.model.kind === "element" && entry.model.elementKey === key) {
        return entry;
      }
    }
    return null;
  }

  function elementMarkCount(): number {
    let count = 0;
    for (const entry of liveMarks) {
      if (entry.model.kind === "element") count += 1;
    }
    return count;
  }

  function addElementMark(el: Element, allowToggle: boolean): boolean {
    if (attachPending) return false;
    const key = keyOf(el);
    const existing = findElementMark(key);
    if (existing !== null) {
      if (!allowToggle) return false;
      destroyMark(existing);
      const idx = liveMarks.indexOf(existing);
      if (idx >= 0) liveMarks.splice(idx, 1);
      syncMarkCountFromStack();
      layoutChrome();
      return true;
    }
    if (elementMarkCount() >= ANNOTATION_BUNDLE_ELEMENT_CAP) {
      refusedCount += 1;
      layoutChrome();
      return false;
    }
    const added: OverlayMarkModel = {
      id: nextId("el"),
      kind: "element",
      bounds: pageRect(overlayElementCssRect(el)),
      selector: overlayElementSelector(el),
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
    pushMark(entry);
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
    pushMark(entry);
  }

  function addStrokeMark(points: StrokePoint[]): void {
    const bounds = strokeBoundsFromPoints(
      points,
      ANNOTATION_STROKE_HALO_SIZE_PX,
    );
    if (bounds === null) return;
    const haloLight = makePath("halo-light");
    const haloDark = makePath("halo-dark");
    const ink = makePath("pen");
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
    pushMark(entry);
  }

  function eraseAt(x: number, y: number): void {
    if (attachPending) return;
    const hit = eraseNewestAtPoint(liveMarks.map(viewportModel), x, y);
    if (hit.removed === null) return;
    const idx = liveMarks.findIndex(
      (entry) => entry.model.id === hit.removed?.id,
    );
    if (idx < 0) return;
    const entry = liveMarks[idx];
    if (entry === undefined) return;
    destroyMark(entry);
    liveMarks.splice(idx, 1);
    syncMarkCountFromStack();
    layoutChrome();
  }

  function applyRegion(rect: OverlayMarkModel["bounds"]): void {
    if (attachPending) return;
    const scan = collectRegionScan(rect);
    const resolved = resolveRegionSelection({
      candidates: scan.candidates,
      region: rect,
      existingElementCount: elementMarkCount(),
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
    const hasMarks = liveMarks.length > 0;
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
    targetPicker.setDisabled(attachPending);
    for (const name of MODES) {
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
    const union = unionRects(liveMarks.map((entry) => viewportBounds(entry)));
    const box = editor.getBoundingClientRect();
    const placed = placeCommentBox({
      union,
      viewport: { width: W.innerWidth, height: W.innerHeight },
      box: {
        width: box.width || 430,
        height: box.height || 72,
      },
      pillBottom: 14 + 40,
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
    for (const entry of liveMarks) destroyMark(entry);
    liveMarks.length = 0;
    comment.value = "";
    refusedCount = 0;
    attachError = "";
    targetPicker.close(false);
    hideHover();
    marquee.style.display = "none";
    clearDraftStroke();
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

  function clearDraftStroke(): void {
    drawing = false;
    draftPoints = [];
    draftHalo?.remove();
    draftHaloDark?.remove();
    draftInk?.remove();
    draftHalo = null;
    draftHaloDark = null;
    draftInk = null;
  }

  function beginDraftStroke(point: StrokePoint): void {
    drawing = true;
    draftPoints = [point];
    draftHaloDark = makePath("halo-dark");
    draftHalo = makePath("halo-light");
    draftInk = makePath("pen");
    svg.appendChild(draftHaloDark);
    svg.appendChild(draftHalo);
    svg.appendChild(draftInk);
    paintStrokePaths(
      viewportPoints(draftPoints),
      draftHalo,
      draftHaloDark,
      draftInk,
    );
  }

  function extendDraftStroke(point: StrokePoint): void {
    draftPoints.push(point);
    if (draftHalo && draftHaloDark && draftInk) {
      paintStrokePaths(
        viewportPoints(draftPoints),
        draftHalo,
        draftHaloDark,
        draftInk,
      );
    }
  }

  function finishDraftStroke(): void {
    const points = draftPoints.slice();
    clearDraftStroke();
    if (points.length < 2) return;
    addStrokeMark(points);
  }

  function validateAll(): boolean {
    let ok = true;
    for (const entry of liveMarks) {
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

  function requestAttach(targetChatId: string | null): void {
    const resolvedTargetChatId =
      targetChatId ?? targetPicker.getDefaultChatId();
    if (
      attachPending ||
      liveMarks.length === 0 ||
      resolvedTargetChatId === null
    ) {
      return;
    }
    attachError = "";
    if (!validateAll()) {
      attachError = "Some marks need re-marking before sending.";
      layoutChrome();
      return;
    }
    const snapshots = liveMarks.map((entry) =>
      toMarkSnapshot(viewportModel(entry)),
    );
    const captures: Record<string, unknown>[] = [];
    for (const entry of liveMarks) {
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
    if (union === null) return;
    attachPending = true;
    emit({
      type: "attachRequested",
      payload: {
        targetChatId: resolvedTargetChatId,
        marks: snapshots,
        elements: budgeted.kept,
        comment: comment.value,
        unionRect: union,
      },
    });
  }

  function onPagePointer(e: Event): void {
    if (eventTouchesOverlay(e)) return;
    targetPicker.close(false);
    swallow(e);
  }

  function refreshAfterScroll(): void {
    scrollFrame = null;
    if (done) return;
    for (const entry of liveMarks) {
      paintLiveMark(entry);
    }
    if (
      drawing &&
      draftHalo !== null &&
      draftHaloDark !== null &&
      draftInk !== null
    ) {
      paintStrokePaths(
        viewportPoints(draftPoints),
        draftHalo,
        draftHaloDark,
        draftInk,
      );
    }
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
    if (mode === "select" && dragStart === null && !drawing) {
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
    if (mode === "draw" && drawing) {
      extendDraftStroke(pagePoint({ x: e.clientX, y: e.clientY }));
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (eventTouchesOverlay(e)) return;
    swallow(e);
    if (e.button !== 0) return;
    if (attachPending) return;
    clearInvalid();
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
    if (mode === "draw") beginDraftStroke(pagePoint(dragStart));
  }

  function onPointerUp(e: PointerEvent): void {
    if (eventTouchesOverlay(e) && dragStart === null && !drawing) return;
    if (dragStart === null && !drawing) return;
    swallow(e);
    if (attachPending) {
      clearDraftStroke();
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
      finishDraftStroke();
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
    if (e.key === "Enter" && liveMarks.length > 0) {
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
    listeners.abort();
    if (scrollFrame !== null) W.cancelAnimationFrame(scrollFrame);
    targetPicker.dispose();
    host.remove();
    try {
      delete W.__traycerAnnotationCancel;
    } catch {
      W.__traycerAnnotationCancel = undefined;
    }
    try {
      delete W.__traycerAnnotationHideChromeForCapture;
    } catch {
      W.__traycerAnnotationHideChromeForCapture = undefined;
    }
    try {
      delete W.__traycerAnnotationResetAfterAttach;
    } catch {
      W.__traycerAnnotationResetAfterAttach = undefined;
    }
    try {
      delete W.__traycerAnnotationCaptureFailed;
    } catch {
      W.__traycerAnnotationCaptureFailed = undefined;
    }
    try {
      delete W.__traycerAnnotationSetTargetChatLabel;
    } catch {
      W.__traycerAnnotationSetTargetChatLabel = undefined;
    }
  }

  function finishCancelled(): void {
    if (done) return;
    emit({ type: "cancelled" });
    teardown();
  }

  W.__traycerAnnotationCancel = finishCancelled;
  W.__traycerAnnotationHideChromeForCapture = hideChromeForCapture;
  W.__traycerAnnotationResetAfterAttach = resetAfterAttach;
  W.__traycerAnnotationCaptureFailed = captureFailed;
  W.__traycerAnnotationSetTargetChatLabel = setTargetChatLabel;
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
  emitState();
  return true;
}

boot();
