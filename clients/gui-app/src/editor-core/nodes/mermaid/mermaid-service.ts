import {
  buildMermaidThemeVariables,
  readMermaidPalette,
} from "./mermaid-theme";

/** Lazy mermaid façade. All exports await `ensureReady()` so the import is a singleton. */

type MermaidModule = (typeof import("mermaid"))["default"];

interface ReadyState {
  readonly mermaid: MermaidModule;
  readonly doc: Document;
}

let readyPromise: Promise<ReadyState> | null = null;
let darkObserver: MutationObserver | null = null;
const themeChangeListeners = new Set<() => void>();
let themeVersion = 0;

function notifyThemeChange(): void {
  themeVersion += 1;
  themeChangeListeners.forEach((cb) => {
    try {
      cb();
    } catch {
      // Listeners are best-effort - a crash in one should not take down
      // the rest of the callbacks or the editor that holds them.
    }
  });
}

/**
 * useSyncExternalStore snapshot. Increments on theme flip; stable otherwise.
 */
export function getMermaidThemeVersion(): number {
  return themeVersion;
}

/** Reinitialise mermaid with fresh theme variables sampled from the document root. Safe to call repeatedly; mermaid merges the config on each call. */
function applyTheme(mermaid: MermaidModule, doc: Document): void {
  const palette = readMermaidPalette(doc);
  const themeVariables = buildMermaidThemeVariables(palette);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // mermaid render() leaks a body error-SVG div on throw; suppressErrorRendering
    // removes it so streaming incomplete fences do not pile up.
    suppressErrorRendering: true,
    theme: "base",
    themeVariables,
    fontFamily:
      "var(--font-sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif)",
  });
}

/**
 * One html class observer for next-themes dark toggles; mermaid config is global.
 */
function ensureDarkObserver(mermaid: MermaidModule, doc: Document): void {
  if (darkObserver !== null) return;
  const root = doc.documentElement;
  darkObserver = new MutationObserver(() => {
    applyTheme(mermaid, doc);
    notifyThemeChange();
  });
  darkObserver.observe(root, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });
}

/**
 * Lazy-load mermaid; reuse the cached promise. Failures re-throw.
 */
export function ensureMermaidReady(): Promise<ReadyState> {
  if (readyPromise !== null) return readyPromise;
  readyPromise = (async () => {
    const mod = await import("mermaid");
    const mermaid = mod.default;
    const doc =
      typeof document !== "undefined" ? document : globalThis.document;
    applyTheme(mermaid, doc);
    ensureDarkObserver(mermaid, doc);
    return { mermaid, doc };
  })().catch((err) => {
    // Drop the cached failure so a later retry can re-import.
    readyPromise = null;
    throw err;
  });
  return readyPromise;
}

/** Subscribe to theme-change notifications. The returned function detaches the listener - NodeViews call this in an effect cleanup. */
export function subscribeMermaidTheme(cb: () => void): () => void {
  themeChangeListeners.add(cb);
  return () => {
    themeChangeListeners.delete(cb);
  };
}

/** Syntax-validate mermaid source. Mermaid's `parse` throws on invalid syntax with a `message` on the error - we surface it as-is. */
export async function parseMermaid(code: string): Promise<void> {
  const { mermaid } = await ensureMermaidReady();
  await mermaid.parse(code);
}

export interface MermaidRenderResult {
  readonly svg: string;
}

/** id must be unique per call (SVG root id). Append a counter so split-pane renders do not clash. */
let renderCounter = 0;
export async function renderMermaidSvg(
  code: string,
): Promise<MermaidRenderResult> {
  const { mermaid } = await ensureMermaidReady();
  const id = `tc-mermaid-${Date.now().toString(36)}-${(renderCounter += 1).toString(36)}`;
  try {
    const { svg } = await mermaid.render(id, code);
    return { svg };
  } catch (err) {
    sweepStrandedMermaidContainers(id);
    throw err;
  }
}

/** Sweep leftover mermaid body containers (`d{id}`, sandbox `i{id}`) that suppressErrorRendering does not cover. */
function sweepStrandedMermaidContainers(id: string): void {
  if (typeof document === "undefined") return;
  document.getElementById(`d${id}`)?.remove();
  document.getElementById(`i${id}`)?.remove();
}

export interface SvgIntrinsicSize {
  readonly width: number;
  readonly height: number;
}

/** Pixel width/height override viewBox. Ignore relative units - mermaid emits width="100%" so parseFloat would collapse to 100. Fallback 1024x768. */
export function getSvgIntrinsicSize(svg: string): SvgIntrinsicSize {
  const root = new DOMParser().parseFromString(
    svg,
    "image/svg+xml",
  ).documentElement;
  let width = 1024;
  let height = 768;
  const viewBox = root.getAttribute("viewBox");
  if (viewBox !== null) {
    const parts = viewBox.split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      width = parts[2];
      height = parts[3];
    }
  }
  const widthPx = parsePixelLength(root.getAttribute("width"));
  if (widthPx !== null) width = widthPx;
  const heightPx = parsePixelLength(root.getAttribute("height"));
  if (heightPx !== null) height = heightPx;
  return { width, height };
}

function parsePixelLength(value: string | null): number | null {
  if (value === null) return null;
  const match = /^\s*([\d.]+)(?:px)?\s*$/.exec(value);
  if (match === null) return null;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) ? n : null;
}

/** Mermaid SVG is HTML-lenient (`<br>`); data:image/svg+xml needs closed tags. innerHTML then XMLSerializer, not a hand-rolled tag list. */
function makeSvgXmlSafe(svg: string): string {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = svg;
  const svgEl = wrapper.querySelector("svg");
  if (svgEl === null) return svg;
  return new XMLSerializer().serializeToString(svgEl);
}

export interface SvgToPngParams {
  readonly svg: string;
  readonly backgroundColor: string;
  /** Pixel ratio - 2 for retina output. Default 2. */
  readonly scale?: number;
}

/** Paint background first so dark diagrams do not export transparent. data: URI, not blob: - desktop img-src blocks blob:. */
export async function svgToPngBlob(params: SvgToPngParams): Promise<Blob> {
  const { svg, backgroundColor, scale = 2 } = params;
  const { width, height } = getSvgIntrinsicSize(svg);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("canvas 2d context unavailable");
  }
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // data: URI, not blob: (desktop img-src). XML-safe pass closes void tags
  // so the strict XML parser accepts the URI.
  const safe = makeSvgXmlSafe(svg);
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(safe)}`;
  const image = new Image();
  image.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("failed to rasterise mermaid SVG"));
    image.src = svgUrl;
  });
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("canvas.toBlob returned null"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

export function deriveMermaidAriaLabel(code: string): string {
  const firstLine = code
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine && firstLine.length > 0 ? firstLine : "Mermaid diagram";
}

export function deriveMermaidErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Failed to render diagram";
}
