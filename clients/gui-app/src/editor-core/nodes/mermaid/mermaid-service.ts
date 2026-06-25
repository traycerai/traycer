import {
  buildMermaidThemeVariables,
  readMermaidPalette,
} from "./mermaid-theme";

/**
 * Thin façade over the lazily-imported `mermaid` package. Centralising the
 * loader means (a) only one editor pays the ~400 kB import cost, (b) the
 * dark-mode MutationObserver is wired once per document, and (c) render /
 * export helpers share the same singleton instance.
 *
 * All exported functions are `async` and idempotent: they await
 * `ensureReady()` up front, which kicks off the dynamic import the first
 * time and returns the cached module thereafter.
 */

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
 * Snapshot for `useSyncExternalStore`. Increments on every theme flip so
 * subscribers can re-render when the value changes. Stable across renders
 * when the theme hasn't changed, so concurrent React reads stay consistent.
 */
export function getMermaidThemeVersion(): number {
  return themeVersion;
}

/**
 * Reinitialise mermaid with fresh theme variables sampled from the document
 * root. Safe to call repeatedly; mermaid merges the config on each call.
 */
function applyTheme(mermaid: MermaidModule, doc: Document): void {
  const palette = readMermaidPalette(doc);
  const themeVariables = buildMermaidThemeVariables(palette);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // Without `suppressErrorRendering`, mermaid's `render()` injects an
    // "error diagram" SVG (the one with "Syntax error in text" / "mermaid
    // version X.Y.Z") into a temporary `<div id="d{id}">` on `document.body`
    // BEFORE rethrowing. The temp div is only removed on the success path -
    // on failure it stays in the DOM (mermaid bug, see esm.mjs:1502→1509,
    // never reaches the cleanup at 1533). With streaming markdown the LLM
    // emits one mermaid fence whose body grows token-by-token; each delta
    // triggers a render against syntactically incomplete code, leaks a div,
    // and the page accumulates an infinite scroll of error SVGs.
    // `suppressErrorRendering: true` flips the early-throw branch
    // (esm.mjs:1485-1488) so the temp div is removed and the error
    // propagates cleanly to our caller, which renders its own error UI.
    suppressErrorRendering: true,
    theme: "base",
    themeVariables,
    fontFamily:
      "var(--font-sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif)",
  });
}

/**
 * Attach a single MutationObserver to `html` that reacts to `class`
 * changes (next-themes toggles `dark` here). Because mermaid's config is
 * global, one observer is enough - all mounted NodeViews share the same
 * initialized module.
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
 * Lazy-load mermaid on first request. Subsequent calls return the same
 * cached promise; failures re-throw so callers can render their error
 * fallback.
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

/**
 * Subscribe to theme-change notifications. The returned function detaches
 * the listener - NodeViews call this in an effect cleanup.
 */
export function subscribeMermaidTheme(cb: () => void): () => void {
  themeChangeListeners.add(cb);
  return () => {
    themeChangeListeners.delete(cb);
  };
}

/**
 * Syntax-validate mermaid source. Mermaid's `parse` throws on invalid
 * syntax with a `message` on the error - we surface it as-is.
 */
export async function parseMermaid(code: string): Promise<void> {
  const { mermaid } = await ensureMermaidReady();
  await mermaid.parse(code);
}

export interface MermaidRenderResult {
  readonly svg: string;
}

/**
 * Render the diagram to an SVG string. The `id` must be unique per call
 * (mermaid uses it as the root element id inside the SVG) - we append a
 * monotonic counter so concurrent renders in split-pane views don't clash.
 */
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

/**
 * Defense-in-depth sweep for stranded mermaid render containers. Mermaid's
 * `render(id, text)` injects a `<div id="d{id}">` into `document.body` for
 * measurement; on the success path it removes the div, but historically
 * (and on certain error branches) the cleanup was skipped, leaving the
 * rendered error SVG visible in the page. `suppressErrorRendering: true` in
 * `applyTheme()` covers the canonical syntax-error case - this function
 * handles anything else that escapes (`d{id}`, sandbox iframe `i{id}`).
 */
function sweepStrandedMermaidContainers(id: string): void {
  if (typeof document === "undefined") return;
  document.getElementById(`d${id}`)?.remove();
  document.getElementById(`i${id}`)?.remove();
}

export interface SvgIntrinsicSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Resolve an SVG's natural pixel dimensions from its `viewBox` and root
 * `width`/`height` attributes. Pixel-valued width/height override the
 * viewBox when present. Relative units (`100%`, `50vw`, etc.) are ignored
 * - mermaid emits `width="100%"` so naive `parseFloat` would silently
 * collapse to `100`. Falls back to 1024x768 when nothing is parseable.
 */
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

/**
 * Convert mermaid's lenient-HTML SVG output to strict-XML form so it can
 * be loaded via `data:image/svg+xml`. Mermaid emits HTML void elements
 * unclosed (`<br>`, not `<br/>`) inside `<foreignObject>` labels - the
 * live DOM accepts that under the HTML parser, but the data-URI MIME
 * forces the strict XML parser, which rejects the open tag with
 * `unexpected close tag` and fails the `<img>` load (silent
 * `image.onerror`). Round-tripping through `innerHTML` (HTML mode →
 * builds a proper SVG/XHTML tree) and `XMLSerializer` (emits closed
 * tags) yields parser-clean XML without hand-rolling a tag list.
 */
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

/**
 * Rasterise an SVG string to a PNG Blob via an offscreen `<canvas>`. The
 * background is painted first so dark-mode diagrams don't export with a
 * transparent background that looks broken on light chat clients.
 *
 * The intermediate `<img>` is fed via a `data:` URI rather than a `blob:`
 * URL - Electron / Tauri / strict-CSP shells in the desktop app block
 * `blob:` under `img-src 'self' data:`, so the data-URI form is the only
 * one that consistently works across all targets.
 */
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

  // Inline the SVG via `data:` URI. `blob:` URLs are blocked by the
  // desktop shell's CSP (`img-src 'self' data:`); the data form is
  // CSP-clean and same-origin, so `canvas.toBlob` won't taint either.
  // `encodeURIComponent` covers `#`, `%`, `<`, `>` - the chars that
  // would otherwise break parsing. The XML-safe pass closes mermaid's
  // unclosed HTML void tags so the strict XML parser does not reject
  // the data URI.
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
