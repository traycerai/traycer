import { subscribeResolvedTheme } from "@/lib/theme-applier";
import {
  buildMermaidThemeVariables,
  readMermaidPalette,
} from "./mermaid-theme";

/**
 * Thin façade over the lazily-imported `mermaid` package. Centralising the
 * loader means (a) only one editor pays the ~400 kB import cost, (b) the
 * palette subscription is wired once per document, and (c) render /
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
let unsubscribeTheme: (() => void) | null = null;
const themeChangeListeners = new Set<() => void>();
let themeVersion = 0;

function notifyThemeChange(): void {
  themeVersion += 1;
  renderCache.clear();
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

/** The shared palette signal also covers live edits that keep the same theme id. */
function ensureThemeSubscription(mermaid: MermaidModule, doc: Document): void {
  if (unsubscribeTheme !== null) return;
  unsubscribeTheme = subscribeResolvedTheme(() => {
    applyTheme(mermaid, doc);
    notifyThemeChange();
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
    ensureThemeSubscription(mermaid, doc);
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

export interface MermaidRenderResult {
  readonly svg: string;
}

// Bound both entry count and source/output size; large diagrams still render.
interface MermaidRenderJob {
  promise: Promise<string>;
  consumers: number;
  started: boolean;
  cancel: () => void;
}

const renderCache = new Map<string, string>();
const renderJobs = new Map<string, MermaidRenderJob>();
const MAX_CACHED_DIAGRAM_CHARS = 128_000;
let renderCounter = 0;
let renderTail: Promise<void> = Promise.resolve();

function nextRenderId(): string {
  return `tc-mermaid-${Date.now().toString(36)}-${(renderCounter += 1).toString(36)}`;
}

function uniqueSvgCopy(svg: string): string {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = svg;
  const prefix = nextRenderId();
  const ids = new Map<string, string>();
  for (const element of wrapper.querySelectorAll("[id]")) {
    ids.set(element.id, `${prefix}-${ids.size}`);
  }
  if (ids.size === 0) return svg;
  const escapedIds = Array.from(ids.keys())
    .sort((a, b) => b.length - a.length)
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const ignoredCssToken =
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\//;
  const rewriteUrls = (value: string): string =>
    value.replace(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|(?<![\w-])url\(\s*(?:"(#[^"\\]*)"|'(#[^'\\]*)'|(#[^\s)"'\\]*))\s*\)/gi,
      (
        match,
        double: string | undefined,
        single: string | undefined,
        bare: string | undefined,
      ) => {
        const fragment = double ?? single ?? bare;
        if (fragment === undefined) return match;
        const replacement = ids.get(fragment.slice(1));
        return replacement === undefined
          ? match
          : match.replace(fragment, `#${replacement}`);
      },
    );
  const urlAttributes = new Set([
    "style",
    "fill",
    "stroke",
    "filter",
    "clip-path",
    "mask",
    "marker",
    "marker-start",
    "marker-mid",
    "marker-end",
    "cursor",
  ]);
  const rewriteAttribute = (name: string, value: string): string => {
    if (name === "id") return ids.get(value) ?? value;
    if (name === "aria-labelledby" || name === "aria-describedby") {
      return value
        .split(/\s+/)
        .map((id) => ids.get(id) ?? id)
        .join(" ");
    }
    if (name === "href" || name === "xlink:href") {
      const replacement = value.startsWith("#")
        ? ids.get(value.slice(1))
        : undefined;
      return replacement === undefined ? value : `#${replacement}`;
    }
    return urlAttributes.has(name) ? rewriteUrls(value) : value;
  };
  // Consume attribute predicates before quoted tokens: references inside these
  // values must move with their attributes, while ordinary strings stay intact.
  const selectorPattern = new RegExp(
    `(\\[(?:${ignoredCssToken.source}|[^\\]"'])*\\])|${ignoredCssToken.source}|#(${escapedIds.join("|")})(?![\\w-])`,
    "g",
  );
  const rewriteSelector = (value: string): string =>
    value.replace(
      selectorPattern,
      (match, attribute: string | undefined, id: string | undefined) => {
        if (attribute !== undefined) {
          const predicate =
            /^(\[\s*)((?:\\.|[\w:|-])+?)(\s*[~|^$*]?=\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s\]]+)(\s+[is])?(\s*\])$/i.exec(
              attribute,
            );
          if (predicate === null) return match;
          const [, start, name, operator, token, , end] = predicate;
          const flag = predicate.at(5);
          const quote =
            token.startsWith('"') || token.startsWith("'") ? token[0] : "";
          const original = quote === "" ? token : token.slice(1, -1);
          const rewritten = rewriteAttribute(
            name.replace(/\\:/g, ":").replaceAll("|", ":"),
            original,
          );
          if (rewritten === original) return match;
          return `${start}${name}${operator}${quote}${rewritten}${quote}${flag ?? ""}${end}`;
        }
        const replacement = id === undefined ? undefined : ids.get(id);
        return replacement === undefined ? match : `#${replacement}`;
      },
    );
  const rewriteRule = (rule: CSSRule): void => {
    if ("selectorText" in rule && typeof rule.selectorText === "string") {
      rule.selectorText = rewriteSelector(rule.selectorText);
    }
    if ("style" in rule) {
      const declaration = (rule as CSSStyleRule).style;
      declaration.cssText = rewriteUrls(declaration.cssText);
    }
    if ("cssRules" in rule) {
      for (const child of Array.from((rule as CSSGroupingRule).cssRules)) {
        rewriteRule(child);
      }
    }
  };
  for (const element of wrapper.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      const value = rewriteAttribute(attribute.name, attribute.value);
      if (value !== attribute.value)
        element.setAttribute(attribute.name, value);
    }
    if (element.tagName.toLowerCase() === "style") {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(element.textContent);
      for (const rule of Array.from(sheet.cssRules)) rewriteRule(rule);
      element.textContent = Array.from(
        sheet.cssRules,
        (rule) => rule.cssText,
      ).join("\n");
    }
  }
  return wrapper.innerHTML;
}

function createRenderJob(
  mermaid: MermaidModule,
  code: string,
  key: string,
  version: number,
): MermaidRenderJob {
  const job: MermaidRenderJob = {
    promise: Promise.resolve(""),
    consumers: 0,
    started: false,
    cancel: () => {},
  };
  const drop = (): void => {
    if (renderJobs.get(key) === job) renderJobs.delete(key);
  };
  job.promise = (async () => {
    await new Promise<void>((resolve, reject) => {
      let cancelIdle: () => void;
      if (typeof window.requestIdleCallback === "function") {
        const id = window.requestIdleCallback(() => resolve(), {
          timeout: 500,
        });
        cancelIdle = () => window.cancelIdleCallback(id);
      } else {
        const id = window.setTimeout(resolve, 0);
        cancelIdle = () => window.clearTimeout(id);
      }
      job.cancel = () => {
        cancelIdle();
        drop();
        reject(new DOMException("Diagram render abandoned", "AbortError"));
      };
    });
    // Keep the wait in our queue, where ownership can still be withdrawn,
    // rather than marking a job started inside Mermaid's own serial queue.
    const admitted = renderTail.then(async () => {
      if (job.consumers === 0) {
        throw new DOMException("Diagram render abandoned", "AbortError");
      }
      job.started = true;
      const id = nextRenderId();
      try {
        const { svg } = await mermaid.render(id, code);
        if (
          code.length <= MAX_CACHED_DIAGRAM_CHARS &&
          svg.length <= MAX_CACHED_DIAGRAM_CHARS &&
          version === themeVersion
        ) {
          renderCache.set(key, svg);
          if (renderCache.size > 32) {
            const oldest = renderCache.keys().next().value;
            if (oldest !== undefined) renderCache.delete(oldest);
          }
        }
        return svg;
      } catch (error) {
        sweepStrandedMermaidContainers(id);
        throw error;
      }
    });
    renderTail = admitted.then(
      () => undefined,
      () => undefined,
    );
    return admitted;
  })().finally(drop);
  return job;
}

/** A consumer owns queued layout until its signal aborts or its copy is ready. */
export async function renderMermaidSvg(
  code: string,
  signal: AbortSignal,
): Promise<MermaidRenderResult> {
  signal.throwIfAborted();
  const { mermaid } = await ensureMermaidReady();
  signal.throwIfAborted();
  const key = `${themeVersion}\0${code}`;
  const cached = renderCache.get(key);
  if (cached !== undefined) {
    renderCache.delete(key);
    renderCache.set(key, cached);
    signal.throwIfAborted();
    return { svg: uniqueSvgCopy(cached) };
  }
  let job = renderJobs.get(key);
  if (job === undefined) {
    job = createRenderJob(mermaid, code, key, themeVersion);
    renderJobs.set(key, job);
  }
  const ownedJob = job;
  ownedJob.consumers += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    ownedJob.consumers -= 1;
    if (ownedJob.consumers === 0 && !ownedJob.started) ownedJob.cancel();
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    const svg = await ownedJob.promise;
    signal.throwIfAborted();
    return { svg: uniqueSvgCopy(svg) };
  } finally {
    signal.removeEventListener("abort", release);
    release();
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
