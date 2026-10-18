import { CANVAS_STYLE_PROPERTIES } from "./canvas-bridge";
import type {
  CanvasBox,
  CanvasElement,
  CanvasMode,
  CanvasPageError,
} from "./canvas-bridge";

export interface CanvasBootstrapConfig {
  readonly nonce: string;
  readonly styleProperties: readonly string[];
}
/** Serialized into canvas documents only. Keep every runtime helper inside. */
export function canvasBootstrap(config: CanvasBootstrapConfig): void {
  document.currentScript?.remove();
  const host = window.parent;
  let ready = false;
  let mode: CanvasMode = "edit";
  let textTarget: Element | null = null;
  let hasTextTarget = false;
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const notify = (method: string, params: Record<string, unknown>): void => {
    if (ready)
      host.postMessage(
        { jsonrpc: "2.0", method, params: { ...params, nonce: config.nonce } },
        "*",
      );
  };
  const boxOf = (box: DOMRect): CanvasBox => ({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  });
  const normalize = (value: string): string =>
    value.replace(/\s+/g, " ").trim();
  const selectorOf = (element: Element): string => {
    const parts: string[] = [];
    let node: Element | null = element;
    for (let depth = 0; node !== null && depth < 8; depth += 1) {
      if (node.id) {
        const selector = `#${CSS.escape(node.id)}`;
        if (document.querySelectorAll(selector).length === 1) {
          parts.unshift(selector);
          break;
        }
      }
      let part = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent !== null) {
        const same = Array.from(parent.children).filter(
          (child) => child.tagName === node?.tagName,
        );
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (parent === document.documentElement) break;
      node = parent;
    }
    return parts.join(" > ").slice(0, 1000);
  };
  const roleOf = (element: Element): string | null => {
    const explicit = element.getAttribute("role");
    if (explicit !== null) return explicit.slice(0, 64);
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "img") return "img";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = element.getAttribute("type") ?? "text";
      if (["button", "submit", "reset", "image"].includes(type))
        return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    return null;
  };
  const capture = (element: Element): CanvasElement => {
    const rawMarker = element.getAttribute("data-traycer-pos");
    const number =
      rawMarker === null || !/^\d+$/.test(rawMarker) ? NaN : Number(rawMarker);
    const marker = Number.isSafeInteger(number) && number >= 0 ? number : null;
    const styles = getComputedStyle(element);
    const labels = (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    const name =
      element.getAttribute("aria-label") ||
      labels ||
      element.getAttribute("alt") ||
      element.getAttribute("title");
    return {
      marker,
      tid: element.getAttribute("data-tid")?.slice(0, 300) ?? null,
      tagName: element.tagName.toLowerCase().slice(0, 40),
      selector: selectorOf(element),
      elementId: element.id ? element.id.slice(0, 300) : null,
      classNames: Array.from(element.classList)
        .slice(0, 30)
        .map((name) => name.slice(0, 120)),
      textPreview: normalize(element.textContent).slice(0, 200),
      inlineStyle: (element.getAttribute("style") ?? "").slice(0, 16_000),
      ariaRole: roleOf(element),
      accessibleName: name ? normalize(name).slice(0, 300) : null,
      box: boxOf(element.getBoundingClientRect()),
      computedStyles: config.styleProperties.map((property) => ({
        property,
        value: styles.getPropertyValue(property).trim().slice(0, 300),
      })),
      generated: marker === null,
    };
  };
  const locate = (params: Record<string, unknown>): Element | null => {
    let selector: string;
    if (
      typeof params.marker === "number" &&
      Number.isSafeInteger(params.marker) &&
      params.marker >= 0
    ) {
      selector = `[data-traycer-pos="${params.marker}"]`;
    } else if (typeof params.tid === "string" && params.tid.length <= 300) {
      selector = `[data-tid="${CSS.escape(params.tid)}"]`;
    } else return null;
    const elements = document.querySelectorAll(selector);
    return elements.length === 1 ? elements.item(0) : null;
  };
  const hitTest = (
    params: Record<string, unknown>,
  ): { element: CanvasElement | null } | null => {
    if (
      typeof params.x !== "number" ||
      !Number.isFinite(params.x) ||
      typeof params.y !== "number" ||
      !Number.isFinite(params.y)
    )
      return null;
    const element = document.elementFromPoint(params.x, params.y);
    return { element: element === null ? null : capture(element) };
  };
  const answer = (
    method: unknown,
    params: Record<string, unknown>,
  ): Record<string, unknown> | null => {
    switch (method) {
      case "traycer/canvas/hit-test":
        return hitTest(params);
      case "traycer/canvas/set-text-selection-target": {
        if (params.target !== null && !record(params.target)) return null;
        hasTextTarget = params.target !== null;
        textTarget = params.target === null ? null : locate(params.target);
        reportSelection();
        return {};
      }
      case "traycer/canvas/describe-element": {
        const element = locate(params);
        return { element: element === null ? null : capture(element) };
      }
      case "traycer/canvas/element-box": {
        const element = locate(params);
        return {
          box: element === null ? null : boxOf(element.getBoundingClientRect()),
        };
      }
      case "traycer/canvas/set-mode":
        if (params.mode !== "edit" && params.mode !== "play") return null;
        mode = params.mode;
        return {};
      default:
        return null;
    }
  };
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== host || !ready) return;
    const data = event.data;
    if (
      !record(data) ||
      data.jsonrpc !== "2.0" ||
      !record(data.params) ||
      data.params.nonce !== config.nonce ||
      (typeof data.id !== "string" && typeof data.id !== "number")
    )
      return;
    const result = answer(data.method, data.params);
    if (result !== null)
      host.postMessage(
        {
          jsonrpc: "2.0",
          id: data.id,
          result: { ...result, nonce: config.nonce },
        },
        "*",
      );
  });
  // Native text selection stays available through the editor's selected-element
  // hole. Click/submit activation never reaches authored handlers in Edit.
  const blockEdit = (event: Event): void => {
    if (mode !== "edit") return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener("click", blockEdit, true);
  window.addEventListener("auxclick", blockEdit, true);
  window.addEventListener("submit", blockEdit, true);
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        mode !== "edit" ||
        event.code !== "Escape" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      notify("traycer/notifications/shortcut", {
        key: event.key,
        code: event.code,
        ctrl: false,
        meta: false,
        alt: false,
        shift: false,
      });
    },
    true,
  );
  // Before the ordinary bootstrap's window-bubble link handler drops custom
  // schemes. Page target handlers still get their normal turn in Play.
  document.addEventListener("click", (event) => {
    if (mode !== "play" || event.defaultPrevented || event.button !== 0) return;
    const anchor =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (anchor === null) return;
    const href = anchor.getAttribute("href") ?? "";
    let url: URL;
    try {
      url = new URL(href, document.baseURI);
    } catch {
      return;
    }
    if (url.protocol !== location.protocol || url.host !== location.host)
      return;
    if (url.pathname === location.pathname && url.hash !== "") return;
    event.preventDefault();
    notify("traycer/canvas/relative-link", { href: href.slice(0, 8192) });
  });
  const selectionElement = (range: Range): Element | null => {
    if (hasTextTarget) {
      return textTarget !== null &&
        textTarget.isConnected &&
        textTarget.contains(range.startContainer) &&
        textTarget.contains(range.endContainer)
        ? textTarget
        : null;
    }
    const ancestor = range.commonAncestorContainer;
    const element =
      ancestor instanceof Element ? ancestor : ancestor.parentElement;
    return element === document.body || element === document.documentElement
      ? null
      : element;
  };
  let selectionQueued = false;
  let selectedElement: Element | null = null;
  const reportSelection = (): void => {
    if (selectionQueued) return;
    selectionQueued = true;
    requestAnimationFrame(() => {
      selectionQueued = false;
      const selection = window.getSelection();
      if (
        selection === null ||
        selection.isCollapsed ||
        selection.rangeCount !== 1
      ) {
        if (hasTextTarget)
          notify("traycer/canvas/text-selection", { selection: null });
        return;
      }
      const range = selection.getRangeAt(0);
      const element = selectionElement(range);
      if (element === null) {
        if (hasTextTarget)
          notify("traycer/canvas/text-selection", { selection: null });
        return;
      }
      if (selectedElement !== element) {
        if (selectedElement !== null)
          selectionObserver.unobserve(selectedElement);
        selectedElement = element;
        selectionObserver.observe(element);
      }
      const quote = range.toString();
      if (quote.length > 16_000) return;
      const prefix = document.createRange();
      prefix.selectNodeContents(element);
      prefix.setEnd(range.startContainer, range.startOffset);
      const start = prefix.toString().length;
      notify("traycer/canvas/text-selection", {
        element: capture(element),
        start,
        end: start + quote.length,
        quote,
        rects: Array.from(range.getClientRects()).slice(0, 256).map(boxOf),
      });
    });
  };
  const selectionObserver = new ResizeObserver(reportSelection);
  document.addEventListener("selectionchange", reportSelection);
  window.addEventListener("scroll", reportSelection, true);
  window.addEventListener("resize", reportSelection);
  const startupErrors: CanvasPageError[] = [];
  const reportError = (message: string, stack: string | null): void => {
    const error = {
      message: message.slice(0, 2000),
      stack: stack?.slice(0, 8000) ?? null,
    };
    if (!ready) {
      if (startupErrors.length < 8) startupErrors.push(error);
      return;
    }
    notify("traycer/canvas/page-error", error);
  };
  window.addEventListener("error", (event) => {
    const error: unknown = event.error;
    reportError(
      String(event.message),
      error instanceof Error ? (error.stack ?? null) : null,
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    const error: unknown = event.reason;
    reportError(
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? (error.stack ?? null) : null,
    );
  });
  window.addEventListener(
    "load",
    () => {
      ready = true;
      // The ordinary bootstrap registered its load listener first, so its
      // nonce proof precedes these diagnostics on the same message channel.
      for (const error of startupErrors.splice(0))
        notify("traycer/canvas/page-error", { ...error });
      selectionObserver.observe(document.documentElement);
    },
    { once: true },
  );
}

/** Only the artifact composer imports this; the ordinary loader stays small. */
export function buildCanvasPrelude(nonce: string): string {
  const config: CanvasBootstrapConfig = {
    nonce,
    styleProperties: CANVAS_STYLE_PROPERTIES,
  };
  const json = JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script>(${canvasBootstrap.toString()})(${json});</script>`;
}
