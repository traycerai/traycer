import { CANVAS_STYLE_PROPERTIES } from "./canvas-bridge";
import type {
  CanvasLayoutNode,
  CanvasSiblingLayout,
} from "./canvas-layout-bridge";
import type {
  CanvasBox,
  CanvasElement,
  CanvasMode,
  CanvasPageError,
  CanvasTextSnapshot,
} from "./canvas-bridge";

export interface CanvasBootstrapConfig {
  readonly nonce: string;
  readonly styleProperties: readonly string[];
  readonly canvasLinks?: "native";
}
/** Serialized into canvas documents only. Keep every runtime helper inside. */
export function canvasBootstrap(config: CanvasBootstrapConfig): void {
  document.currentScript?.remove();
  const host = window.parent;
  let ready = false;
  let mode: CanvasMode = config.canvasLinks === "native" ? "play" : "edit";
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
  const px = (value: string): number | null =>
    /^-?(?:\d+\.?\d*|\.\d+)px$/.test(value) ? Number.parseFloat(value) : null;
  const transformed = (element: Element): boolean => {
    for (
      let node: Element | null = element;
      node !== null;
      node = node.parentElement
    ) {
      const style = getComputedStyle(node);
      if (style.transform !== "none" && style.transform !== "") return true;
      if (
        [style.translate, style.rotate, style.scale].some(
          (value) => value !== "none" && value !== "",
        )
      )
        return true;
      if (style.zoom !== "1" && style.zoom !== "normal" && style.zoom !== "")
        return true;
    }
    return false;
  };
  const insetOffset = (
    style: CSSStyleDeclaration,
    start: string,
    end: string,
  ): number | null =>
    px(style.getPropertyValue(start)) ??
    (style.position === "relative"
      ? -(px(style.getPropertyValue(end)) ?? 0)
      : null);
  const layoutOffsets = (
    element: Element,
    style: CSSStyleDeclaration,
  ): { left: number | null; top: number | null } => {
    // Resolved pixel sizes hide auto sizing: changing an inset can stretch the
    // box. Typed computed values retain that distinction before layout.
    const computed =
      typeof element.computedStyleMap === "function"
        ? element.computedStyleMap()
        : null;
    const fixedSize = (property: string): boolean => {
      const value = computed?.get(property)?.toString();
      return (
        value !== undefined &&
        value !== "auto" &&
        value !== "stretch" &&
        !value.startsWith("fit-content")
      );
    };
    const absolute = style.position === "absolute";
    const containingBlock =
      element instanceof HTMLElement ? element.offsetParent : null;
    const direction = absolute
      ? getComputedStyle(containingBlock ?? document.documentElement).direction
      : style.direction;
    // An RTL containing block can make right win when writing left. Auto
    // margins redistribute the free space instead of moving by the inset delta.
    const rightControls =
      direction === "rtl" && computed?.get("right")?.toString() !== "auto";
    const fixedMargins = (start: string, end: string): boolean =>
      [start, end].every((property) => {
        const value = computed?.get(property)?.toString();
        return value !== undefined && value !== "auto";
      });
    const horizontal =
      !rightControls &&
      (!absolute ||
        (fixedSize("width") && fixedMargins("margin-left", "margin-right")));
    const vertical =
      !absolute ||
      (fixedSize("height") && fixedMargins("margin-top", "margin-bottom"));
    return {
      left: horizontal ? insetOffset(style, "left", "right") : null,
      top: vertical ? insetOffset(style, "top", "bottom") : null,
    };
  };
  const layoutNode = (element: Element): CanvasLayoutNode => {
    const raw = element.getAttribute("data-traycer-pos");
    const marker = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN;
    const style = getComputedStyle(element);
    return {
      marker: Number.isSafeInteger(marker) ? marker : null,
      tid: element.getAttribute("data-tid")?.slice(0, 300) ?? null,
      tagName: element.tagName.toLowerCase().slice(0, 40),
      box: boxOf(element.getBoundingClientRect()),
      position: style.position,
      ...layoutOffsets(element, style),
      cssWidth: px(style.width),
      cssHeight: px(style.height),
      transformed: transformed(element),
      order: Number(style.order),
      gridPlacement: [
        style.gridRowStart,
        style.gridRowEnd,
        style.gridColumnStart,
        style.gridColumnEnd,
      ].some((value) => value !== "auto"),
    };
  };
  const siblingLayout = (
    params: Record<string, unknown>,
  ): CanvasSiblingLayout | null => {
    const element = locate(params);
    const parent = element?.parentElement;
    if (parent === null || parent === undefined) return null;
    const style = getComputedStyle(parent);
    const row =
      style.display.includes("flex") && style.flexDirection.startsWith("row");
    const nodes = Array.from(parent.children).slice(0, 256).map(layoutNode);
    const first = nodes.at(0)?.box;
    const second = nodes.at(1)?.box;
    const gridRow =
      style.display.includes("grid") &&
      first !== undefined &&
      second !== undefined &&
      Math.abs(second.x - first.x) > Math.abs(second.y - first.y);
    const horizontal = row || gridRow;
    const layout: CanvasSiblingLayout = {
      parent: layoutNode(parent),
      siblings: nodes,
      axis: horizontal ? "x" : "y",
      reverse:
        style.flexDirection.endsWith("reverse") !==
        (horizontal && style.direction === "rtl"),
      truncated: parent.children.length > 256,
    };
    return new TextEncoder().encode(JSON.stringify(layout)).length <= 240_000
      ? layout
      : null;
  };
  const textSnapshot = (element: Element): CanvasTextSnapshot | null => {
    const content = element.textContent;
    if (content.length > 65_536) return null;
    let bytes = new TextEncoder().encode(content).length;
    const nodes: string[] = [];
    let textOnly = true;
    for (const child of element.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE) {
        textOnly = false;
        continue;
      }
      const value = child.textContent ?? "";
      if (value.length > 65_536 || nodes.length >= 1024) return null;
      bytes += new TextEncoder().encode(value).length;
      if (bytes > 65_536) return null;
      nodes.push(value);
    }
    return bytes <= 65_536 ? { content, nodes, textOnly } : null;
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
  const literalAncestor = (
    params: Record<string, unknown>,
  ): { element: CanvasElement | null } => {
    let element = locate(params);
    if (
      element === null &&
      typeof params.selector === "string" &&
      params.selector.length <= 1000
    ) {
      try {
        const matches = document.querySelectorAll(params.selector);
        if (matches.length === 1) element = matches.item(0);
      } catch {
        return { element: null };
      }
    }
    element = element?.parentElement ?? null;
    while (element !== null) {
      const captured = capture(element);
      if (captured.marker !== null || captured.tid !== null)
        return { element: captured };
      element = element.parentElement;
    }
    return { element: null };
  };
  const commentRangeOffsets = (
    element: Element,
    params: Record<string, unknown>,
  ): { start: number; end: number } | null => {
    const { start, end } = params;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start
    )
      return null;
    if (
      typeof params.quotedText !== "string" ||
      params.quotedText.length > 16_000
    )
      return { start, end };
    const quote = normalize(params.quotedText);
    const text = normalize(element.textContent);
    if (quote.length === 0) return null;
    const found =
      text.slice(start, end) === quote ? start : text.indexOf(quote);
    return found < 0 ? null : { start: found, end: found + quote.length };
  };
  const commentTextRange = (
    element: Element,
    start: number,
    end: number,
  ): Range | null => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let index = 0;
    let seenText = false;
    let whitespace = false;
    let first: { node: Node; offset: number } | null = null;
    let last: { node: Node; offset: number } | null = null;
    let node = walker.nextNode();
    while (node !== null && index < end) {
      const text = node.textContent ?? "";
      for (let i = 0; i < text.length && index < end; i++) {
        if (/\s/.test(text[i])) {
          whitespace = seenText;
          continue;
        }
        if (whitespace) {
          index++;
          whitespace = false;
        }
        if (index === start) first = { node, offset: i };
        index++;
        if (index === end) last = { node, offset: i + 1 };
        seenText = true;
      }
      node = walker.nextNode();
    }
    if (first === null || last === null) return null;
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    return range;
  };
  const textRangeRect = (
    params: Record<string, unknown>,
  ): { box: CanvasBox | null } => {
    const element = locate(params);
    if (element === null) return { box: null };
    const offsets = commentRangeOffsets(element, params);
    const range =
      offsets === null
        ? null
        : commentTextRange(element, offsets.start, offsets.end);
    return {
      box: boxOf(
        range?.getBoundingClientRect() ?? element.getBoundingClientRect(),
      ),
    };
  };
  const describeElement = (
    params: Record<string, unknown>,
  ): { element: CanvasElement | null } => {
    const element = locate(params);
    if (element === null) return { element: null };
    const html = element.outerHTML;
    return {
      element: {
        ...capture(element),
        textSnapshot: textSnapshot(element),
        outerHtml:
          html.length <= 65_536 &&
          new TextEncoder().encode(html).length <= 65_536
            ? html
            : null,
      },
    };
  };
  const retypeTarget = (target: Element | null): Element | null => {
    let element = target;
    while (
      element !== null &&
      element !== document.body &&
      element !== document.documentElement
    ) {
      const literal = element.hasAttribute("data-traycer-pos");
      const block =
        /^(P|H[1-6]|LI|TD|TH|LABEL|BUTTON|PRE|BLOCKQUOTE)$/.test(
          element.tagName,
        ) ||
        (element.tagName === "DIV" &&
          getComputedStyle(element).display !== "inline");
      if (literal && block && element.textContent.trim().length > 0)
        return element;
      element = element.parentElement;
    }
    return target;
  };
  const beginRetype = (target: Element | null): void => {
    if (mode !== "edit") return;
    const element = retypeTarget(target);
    if (
      element === null ||
      element === document.body ||
      element === document.documentElement
    )
      return;
    notify("traycer/canvas/double-click", {
      element: { ...capture(element), textSnapshot: textSnapshot(element) },
    });
  };
  const point = (value: unknown): value is { x: number; y: number } =>
    record(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y);
  const caretAt = (value: {
    x: number;
    y: number;
  }): { node: Node; offset: number } | null => {
    if (typeof document.caretPositionFromPoint !== "function") return null;
    const caret = document.caretPositionFromPoint(value.x, value.y);
    return caret === null
      ? null
      : { node: caret.offsetNode, offset: caret.offset };
  };
  const selectTextRange = (params: Record<string, unknown>): void => {
    if (
      mode !== "edit" ||
      textTarget === null ||
      !textTarget.isConnected ||
      !point(params.start) ||
      !point(params.end)
    )
      return;
    const start = caretAt(params.start);
    const end = caretAt(params.end);
    if (
      start === null ||
      end === null ||
      !textTarget.contains(start.node) ||
      !textTarget.contains(end.node)
    )
      return;
    window
      .getSelection()
      ?.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    reportSelection();
  };
  const setTextSelectionTarget = (
    params: Record<string, unknown>,
  ): Record<string, unknown> | null => {
    if (params.target !== null && !record(params.target)) return null;
    hasTextTarget = params.target !== null;
    textTarget = params.target === null ? null : locate(params.target);
    if (params.target === null) window.getSelection()?.removeAllRanges();
    reportSelection();
    return {};
  };
  const retypeAt = (
    params: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (point(params))
      beginRetype(document.elementFromPoint(params.x, params.y));
    return {};
  };
  const revealElement = (params: Record<string, unknown>) => {
    const element = locate(params);
    element?.scrollIntoView({ block: "center", inline: "nearest" });
    return { revealed: element !== null };
  };
  // Adopts a source-side tid insertion into the live document, so a first
  // comment resolves its pin here without reloading the board.
  const validStampParams = (
    params: Record<string, unknown>,
  ): params is Record<string, unknown> & { tid: string; tagName: string } =>
    typeof params.tid === "string" &&
    params.tid.length > 0 &&
    params.tid.length <= 300 &&
    typeof params.tagName === "string";
  // Keeps the live markers aligned with the adopted source: every element
  // whose start tag sits after the splice moves by the splice's length delta.
  const shiftMarkers = (params: Record<string, unknown>) => {
    if (
      typeof params.at !== "number" ||
      typeof params.delta !== "number" ||
      !Number.isSafeInteger(params.at) ||
      !Number.isSafeInteger(params.delta)
    )
      return { shifted: false };
    for (const element of document.querySelectorAll("[data-traycer-pos]")) {
      const raw = element.getAttribute("data-traycer-pos");
      const marker = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(marker) || marker <= params.at) continue;
      element.setAttribute("data-traycer-pos", String(marker + params.delta));
    }
    return { shifted: true };
  };
  const stampTid = (params: Record<string, unknown>) => {
    if (!validStampParams(params)) return { stamped: false };
    const element = locate(params);
    const current = element?.getAttribute("data-tid") ?? null;
    if (
      element === null ||
      element.tagName.toLowerCase() !== params.tagName.toLowerCase() ||
      (current !== null && current !== params.tid)
    )
      return { stamped: false };
    element.setAttribute("data-tid", params.tid);
    return { stamped: true };
  };
  const navigate = (
    params: Record<string, unknown>,
  ): Record<string, unknown> | null => {
    if (
      typeof params.search !== "string" ||
      typeof params.hash !== "string" ||
      (params.search !== "" && !params.search.startsWith("?")) ||
      (params.hash !== "" && !params.hash.startsWith("#")) ||
      params.search.includes("#") ||
      params.search.length + params.hash.length > 8192
    )
      return null;
    // Only suffixes of this already-proven document may change. Queries
    // need a load so authored startup code sees location.search; hashes
    // stay in the same document and deliver the ordinary hashchange event.
    if (location.search !== params.search) {
      const destination = new URL(location.href);
      destination.search = params.search;
      destination.hash = params.hash;
      window.setTimeout(() => location.replace(destination.href), 0);
    } else if (location.hash !== params.hash) {
      location.hash = params.hash;
    }
    return {};
  };

  const handlers: Record<
    string,
    (params: Record<string, unknown>) => Record<string, unknown> | null
  > = {
    "traycer/canvas/sibling-layout": (params) => ({
      layout: siblingLayout(params),
    }),
    "traycer/canvas/hit-test": hitTest,
    "traycer/canvas/select-text-range": (params) => {
      selectTextRange(params);
      return {};
    },
    "traycer/canvas/retype-at": retypeAt,
    "traycer/canvas/set-text-selection-target": setTextSelectionTarget,
    "traycer/canvas/describe-element": describeElement,
    "traycer/canvas/literal-ancestor": literalAncestor,
    "traycer/canvas/text-range-rect": textRangeRect,
    "traycer/canvas/element-box": (params) => {
      const element = locate(params);
      return {
        box: element === null ? null : boxOf(element.getBoundingClientRect()),
      };
    },
    "traycer/canvas/reveal-element": revealElement,
    "traycer/canvas/stamp-tid": stampTid,
    "traycer/canvas/shift-markers": shiftMarkers,
    "traycer/canvas/navigate": navigate,
    "traycer/canvas/set-mode": (params) => {
      if (params.mode !== "edit" && params.mode !== "play") return null;
      mode = params.mode;
      return {};
    },
  };
  const answer = (
    method: unknown,
    params: Record<string, unknown>,
  ): Record<string, unknown> | null =>
    typeof method === "string" && Object.hasOwn(handlers, method)
      ? handlers[method](params)
      : null;
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
  // Click/submit activation never reaches authored handlers in Edit.
  const blockEdit = (event: Event): void => {
    if (mode !== "edit") return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener(
    "dblclick",
    (event) => {
      if (
        mode !== "edit" ||
        textTarget === null ||
        !textTarget.isConnected ||
        !(event.target instanceof Element) ||
        !textTarget.contains(event.target)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      beginRetype(event.target);
    },
    true,
  );
  window.addEventListener("click", blockEdit, true);
  window.addEventListener("auxclick", blockEdit, true);
  window.addEventListener("submit", blockEdit, true);
  // A bare Escape is the app's in both modes: it steps selection out while
  // editing and leaves Play, so the page never keeps it.
  window.addEventListener(
    "keydown",
    (event) => {
      if (
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
  // Pinch/modified-wheel belongs to the canvas; ordinary wheel scrolling
  // remains inside the prototype. Coordinates are local CSS pixels.
  document.addEventListener(
    "wheel",
    (event) => {
      if (
        config.canvasLinks === "native" ||
        !event.ctrlKey ||
        event.defaultPrevented
      )
        return;
      event.preventDefault();
      notify("traycer/canvas/zoom", {
        delta: event.deltaY * ([1, 16, innerHeight][event.deltaMode] ?? 1),
        x: event.clientX,
        y: event.clientY,
      });
    },
    { passive: false },
  );
  // Before the ordinary bootstrap's window-bubble link handler drops custom
  // schemes. Page target handlers still get their normal turn in Play.
  document.addEventListener("click", (event) => {
    if (config.canvasLinks === "native") return;
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
    // Native navigation is only the same document's own fragment: a changed
    // query needs the bridge's authorized reload, never a raw load.
    if (
      url.pathname === location.pathname &&
      url.search === location.search &&
      url.hash !== ""
    )
      return;
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
  return renderCanvasPrelude({
    nonce,
    styleProperties: CANVAS_STYLE_PROPERTIES,
  });
}

export function buildHtmlSelectionPrelude(nonce: string): string {
  return renderCanvasPrelude({
    nonce,
    styleProperties: CANVAS_STYLE_PROPERTIES,
    canvasLinks: "native",
  });
}

function renderCanvasPrelude(config: CanvasBootstrapConfig): string {
  const json = JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script>(${canvasBootstrap.toString()})(${json});</script>`;
}
