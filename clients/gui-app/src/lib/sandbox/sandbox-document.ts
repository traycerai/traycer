// Shared by the app and the standalone loader bundle. Keep runtime imports
// limited to assets: the loader must not pull in app code.
import FIGTREE_FONT_URL from "@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2?inline";

const INITIAL_DOCTYPE = /^\s*<!doctype(?:\s+[^>]*)?>/i;

export interface LoaderShortcut {
  readonly code: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export interface LoaderTheme {
  readonly appliesToRoot: boolean;
  readonly colorScheme: "light" | "dark";
  readonly background: string | null;
  readonly variables: readonly (readonly [string, string])[];
}

/**
 * A served plain-html artifact is a folder of pages: `"found"` lets a link to
 * a sibling page navigate the frame and reports which page is showing, and
 * `"missing"` is the stand-in the artifact server composes for a page the
 * folder lacks, which also says so. `null` for loader documents and canvas
 * boards, whose links the app handles itself.
 */
export type ArtifactPageRole = "found" | "missing" | null;

export interface LoaderResource {
  readonly canvas?: boolean;
  /** Trusted served-document extension; the standalone loader supplies none. */
  readonly extraScript?: string;
  readonly html: string;
  readonly csp: string | null;
  readonly nonce: string;
  readonly theme: LoaderTheme;
  readonly shortcuts: readonly LoaderShortcut[];
  readonly artifactPage: ArtifactPageRole;
  readonly artifactRootPath?: string;
}

interface BootstrapConfig {
  readonly canvas: boolean;
  readonly nonce: string;
  readonly shortcuts: readonly LoaderShortcut[];
  readonly paintBackground: boolean;
  /** False for an MCP App, which applies the host context's theme itself. */
  readonly applyTheme: boolean;
  readonly artifactPage: ArtifactPageRole;
  readonly artifactRootPath: string | null;
}

/**
 * Runs FIRST inside the written document, before any of the page's own
 * markup. It owns what the app needs from every page: size, links, the
 * forwarded app shortcuts, live theme changes, a liveness answer, and the
 * ready signal carrying the nonce the app armed its trust guard with.
 * Serialized into the document with `Function.prototype.toString`, so it may
 * not close over anything outside its own body.
 */
function bootstrapMain(config: BootstrapConfig): void {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  const script = document.currentScript;
  if (script !== null) script.remove();
  const host = window.parent;
  const send = (message: Record<string, unknown>): void => {
    host.postMessage(message, "*");
  };
  const notify = (method: string, params: Record<string, unknown>): void => {
    send({ jsonrpc: "2.0", method, params });
  };
  let loaded = false;
  let lastWidth = -1;
  let lastHeight = -1;
  let linkRequestId = 0;
  // While the app holds the window's fullscreen, bare Escape is the host's:
  // it is how the reader (and the phone's back button) leaves.
  let fullscreen = false;

  const measureHeight = (): number => {
    // `document.body` is typed non-null but is absent in a frameset.
    const body = document.querySelector("body");
    const root = document.documentElement;
    let bodyHeight = 0;
    if (body !== null) {
      const style = window.getComputedStyle(body);
      const margins =
        (Number.parseFloat(style.marginTop) || 0) +
        (Number.parseFloat(style.marginBottom) || 0);
      bodyHeight =
        Math.max(body.offsetHeight, body.getBoundingClientRect().height) +
        margins;
    }
    const overflowHeight =
      root.scrollHeight > root.clientHeight ? root.scrollHeight : 0;
    return Math.ceil(Math.max(bodyHeight, overflowHeight));
  };

  const reportSize = (): void => {
    const height = measureHeight();
    const width = Math.ceil(document.documentElement.scrollWidth);
    if (height === lastHeight && width === lastWidth) return;
    lastHeight = height;
    lastWidth = width;
    notify("ui/notifications/size-changed", { width, height });
  };

  // A later theme change restyles the page without a reload: the same
  // variables the first paint took from the loader, applied to :root.
  const applyHostContext = (context: Record<string, unknown>): void => {
    const root = document.documentElement;
    if (
      context.displayMode === "inline" ||
      context.displayMode === "fullscreen"
    ) {
      fullscreen = context.displayMode === "fullscreen";
    }
    if (!config.applyTheme) return;
    if (context.theme === "light" || context.theme === "dark") {
      root.style.colorScheme = context.theme;
    }
    const styles = context.styles;
    if (!isObject(styles) || !isObject(styles.variables)) return;
    for (const [name, value] of Object.entries(styles.variables)) {
      if (/^--[a-z0-9-]+$/.test(name) && typeof value === "string") {
        root.style.setProperty(name, value);
      }
    }
    const background = styles.variables["--color-background-primary"];
    if (config.paintBackground && typeof background === "string") {
      root.style.background = background;
    }
  };

  window.addEventListener("error", (event) => {
    if (loaded) return;
    notify("traycer/notifications/early-error", {
      message: String(event.message).slice(0, 500),
    });
  });

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== host) return;
    const data = event.data;
    if (!isObject(data)) return;
    if (data.method === "ui/notifications/host-context-changed") {
      if (isObject(data.params)) applyHostContext(data.params);
      return;
    }
    if (data.method !== "ping") return;
    if (typeof data.id !== "string" && typeof data.id !== "number") return;
    send({ jsonrpc: "2.0", id: data.id, result: {} });
  });

  // Capture phase, registered before any page script: a forwarded app chord
  // (and bare Escape while fullscreen) never reaches the page. Every other
  // key stays the page's.
  window.addEventListener(
    "keydown",
    (event) => {
      const match = config.shortcuts.some(
        (chord) =>
          event.code === chord.code &&
          event.ctrlKey === chord.ctrl &&
          event.metaKey === chord.meta &&
          event.altKey === chord.alt &&
          event.shiftKey === chord.shift,
      );
      const exitFullscreen =
        fullscreen &&
        event.code === "Escape" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey;
      if (!match && !exitFullscreen) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      notify("traycer/notifications/shortcut", {
        key: event.key,
        code: event.code,
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      });
    },
    true,
  );

  // A wheel or swipe the page cannot use chains to the transcript that holds
  // the frame, but the transcript cannot see input in another document and
  // would take that move for layout and pull back to the latest message.
  // A wheel nothing in the page can scroll by is cancelled and handed to the
  // app, which notes the reader's gesture before it scrolls: a relayed note
  // alone can lose the race to the chained scroll. A page that handled the
  // wheel itself (`preventDefault`) keeps it.
  const canScrollInside = (
    target: EventTarget | null,
    vertical: boolean,
    delta: number,
  ): boolean => {
    let element = target instanceof Element ? target : null;
    while (element !== null) {
      const style = window.getComputedStyle(element);
      const overflow = vertical ? style.overflowY : style.overflowX;
      if (
        element === document.scrollingElement ||
        /auto|scroll|overlay/.test(overflow)
      ) {
        const position = vertical ? element.scrollTop : element.scrollLeft;
        const room = vertical
          ? element.scrollHeight - element.clientHeight
          : element.scrollWidth - element.clientWidth;
        if (delta < 0 ? position > 0 : position < room - 1) return true;
      }
      element = element.parentElement;
    }
    return false;
  };
  window.addEventListener(
    "wheel",
    (event) => {
      if (event.defaultPrevented || event.ctrlKey) return;
      const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
      const delta = vertical ? event.deltaY : event.deltaX;
      if (delta === 0 || canScrollInside(event.target, vertical, delta)) {
        return;
      }
      event.preventDefault();
      notify("traycer/notifications/wheel", {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
      });
    },
    { passive: false },
  );
  // A swipe cannot be handed over without losing its momentum, so it chains
  // natively and only its direction is reported.
  let touchY: number | null = null;
  window.addEventListener(
    "touchstart",
    (event) => {
      touchY = event.touches.item(0)?.clientY ?? null;
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    "touchmove",
    (event) => {
      const clientY = event.touches.item(0)?.clientY;
      const previous = touchY;
      if (clientY === undefined || previous === null) return;
      touchY = clientY;
      if (clientY === previous) return;
      notify("traycer/notifications/scroll-gesture", {
        direction: clientY < previous ? "toward-end" : "away-from-end",
      });
    },
    { capture: true, passive: true },
  );
  const clearTouch = (): void => {
    touchY = null;
  };
  window.addEventListener("touchend", clearTouch, {
    capture: true,
    passive: true,
  });
  window.addEventListener("touchcancel", clearTouch, {
    capture: true,
    passive: true,
  });

  // Links the frame follows itself: an anchor within this page, and on a
  // served artifact page another `.html` page of the same folder, which loads
  // through the same server and prelude. Any other file would load without
  // the prelude and never prove itself to the app.
  const followsInFrame = (url: URL): boolean => {
    if (url.protocol !== location.protocol || url.host !== location.host) {
      return false;
    }
    if (url.pathname === location.pathname) return url.hash !== "";
    if (config.artifactPage === null || config.artifactRootPath === null)
      return false;
    let targetPath: string;
    try {
      targetPath = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    return (
      targetPath.startsWith(config.artifactRootPath) &&
      (/\.html?$/i.test(targetPath) || targetPath.endsWith("/"))
    );
  };

  // Bubble phase on window, so a page that handles its own clicks (and calls
  // preventDefault) keeps them.
  window.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const target = event.target;
    const anchor = target instanceof Element ? target.closest("a[href]") : null;
    if (anchor === null) return;
    let url: URL;
    try {
      url = new URL(anchor.getAttribute("href") ?? "", document.baseURI);
    } catch {
      return;
    }
    if (followsInFrame(url)) {
      // The sandbox has no popup permission. Override explicit and inherited
      // targets so a page inside this artifact always stays in its frame.
      anchor.setAttribute("target", "_self");
      return;
    }
    event.preventDefault();
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    linkRequestId += 1;
    send({
      jsonrpc: "2.0",
      id: `traycer-link-${linkRequestId}`,
      method: "ui/open-link",
      params: { url: url.href },
    });
  });

  document.addEventListener(
    "DOMContentLoaded",
    () => {
      const observer = new ResizeObserver(reportSize);
      observer.observe(document.documentElement);
      const body = document.querySelector("body");
      if (body !== null) observer.observe(body);
      reportSize();
    },
    { once: true },
  );

  window.addEventListener(
    "load",
    () => {
      loaded = true;
      // A served artifact page names itself, so the app can follow the
      // reader's moves between the folder's pages.
      notify(
        "traycer/notifications/document-ready",
        config.artifactPage === null && !config.canvas
          ? { nonce: config.nonce, height: lastHeight }
          : { nonce: config.nonce, height: lastHeight, url: location.href },
      );
      if (config.artifactPage === "missing") {
        notify("traycer/notifications/page-missing", { nonce: config.nonce });
      }
      // Served frames drop size reports until the nonce proves this document.
      lastWidth = lastHeight = -1;
      reportSize();
    },
    { once: true },
  );
}

const escapeAttribute = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// `<` is the only character that can end a <style> element early.
const escapeStyleText = (text: string): string => text.replace(/</g, "\\3c ");

const escapeScriptJson = (json: string): string =>
  json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

const themeStyle = (theme: LoaderTheme): string => {
  const font =
    "@font-face{font-family:'Figtree Variable';font-style:normal;" +
    "font-display:swap;font-weight:300 900;" +
    `src:url("${FIGTREE_FONT_URL}") format("woff2-variations")}`;
  // An app that applies no theme gets the canvas of the scheme it is in,
  // light unless it says otherwise, never the transcript showing through
  // behind text it colored for white. `:where` keeps any app rule ahead.
  if (!theme.appliesToRoot) {
    return escapeStyleText(`:where(:root){background-color:Canvas}${font}`);
  }
  const declarations = [`color-scheme:${theme.colorScheme}`];
  if (theme.background !== null) {
    declarations.push(`background:${theme.background}`);
  }
  for (const [name, value] of theme.variables) {
    declarations.push(`${name}:${value}`);
  }
  return escapeStyleText(`:root{${declarations.join(";")}}${font}`);
};

// Both paths share this prelude; compiled bundles may format the serialized bootstrap differently.
export const buildDocument = (resource: LoaderResource): string => {
  // Always standards mode, as a srcdoc frame is: the page's own doctype
  // would land after the bootstrap and be ignored, so it is lifted out.
  const doctype = INITIAL_DOCTYPE.exec(resource.html);
  const body =
    doctype === null ? resource.html : resource.html.slice(doctype[0].length);
  const policy =
    resource.csp === null
      ? ""
      : `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(resource.csp)}">`;
  const config: BootstrapConfig = {
    canvas: resource.canvas === true,
    nonce: resource.nonce,
    shortcuts: resource.shortcuts,
    paintBackground:
      resource.theme.appliesToRoot && resource.theme.background !== null,
    applyTheme: resource.theme.appliesToRoot,
    artifactPage: resource.artifactPage,
    artifactRootPath: resource.artifactRootPath ?? null,
  };
  return (
    "<!doctype html>" +
    policy +
    `<style>${themeStyle(resource.theme)}</style>` +
    `<script>(${bootstrapMain.toString()})(${escapeScriptJson(JSON.stringify(config))});</` +
    "script>" +
    (resource.extraScript ?? "") +
    body
  );
};
