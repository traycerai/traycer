// The sandbox loader: the one document the app ever frames for agent pages,
// wireframes and MCP Apps. It runs in an opaque-origin frame, waits for the
// app to hand it a resource, then rewrites itself with that resource in the
// same frame (`document.open/write/close`). There is no inner frame: the
// policy container survives the rewrite, so the base policy of
// `sandbox/index.html` and the page policy added here both keep holding.
//
// `vite/sandbox-assets.ts` bundles this entry and its pure document builder
// into one inline classic script. There are no runtime imports: a module
// script would need CORS from an opaque origin, and WebKit blocks a script
// file under iOS's `capacitor:` scheme. The protocol is in `bridge-host.ts`.

import {
  buildDocument,
  type LoaderResource,
  type LoaderShortcut,
  type LoaderTheme,
} from "./sandbox-document";

function runLoader(): void {
  const RESOURCE_READY = "ui/notifications/sandbox-resource-ready";
  const PROXY_READY = "ui/notifications/sandbox-proxy-ready";
  const CSS_VARIABLE_NAME = /^--[a-z0-9-]+$/;
  const KINDS: readonly unknown[] = ["page", "wireframe", "app"];
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const parseTheme = (value: unknown): LoaderTheme | null => {
    if (!isRecord(value)) return null;
    const { appliesToRoot, colorScheme, background, variables } = value;
    if (typeof appliesToRoot !== "boolean") return null;
    if (colorScheme !== "light" && colorScheme !== "dark") return null;
    if (background !== null && typeof background !== "string") return null;
    if (!isRecord(variables)) return null;
    const entries: [string, string][] = [];
    for (const [name, cssValue] of Object.entries(variables)) {
      if (!CSS_VARIABLE_NAME.test(name) || typeof cssValue !== "string") {
        return null;
      }
      entries.push([name, cssValue]);
    }
    return { appliesToRoot, colorScheme, background, variables: entries };
  };

  const parseShortcuts = (value: unknown): LoaderShortcut[] | null => {
    if (!Array.isArray(value)) return null;
    const shortcuts: LoaderShortcut[] = [];
    for (const item of value) {
      if (!isRecord(item)) return null;
      const { code, ctrl, meta, alt, shift } = item;
      if (
        typeof code !== "string" ||
        typeof ctrl !== "boolean" ||
        typeof meta !== "boolean" ||
        typeof alt !== "boolean" ||
        typeof shift !== "boolean"
      ) {
        return null;
      }
      shortcuts.push({ code, ctrl, meta, alt, shift });
    }
    return shortcuts;
  };

  const parseResource = (params: unknown): LoaderResource | null => {
    if (!isRecord(params)) return null;
    const { html, kind, csp, nonce, bootstrap } = params;
    if (typeof html !== "string" || !KINDS.includes(kind)) return null;
    if (csp !== null && typeof csp !== "string") return null;
    if (typeof nonce !== "string" || nonce.length === 0) return null;
    if (!isRecord(bootstrap)) return null;
    const theme = parseTheme(bootstrap.theme);
    const shortcuts = parseShortcuts(bootstrap.forwardedShortcuts);
    if (theme === null || shortcuts === null) return null;
    return { html, csp, nonce, theme, shortcuts, artifactPage: null };
  };

  let delivered = false;
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (delivered || event.source !== window.parent) return;
    const data = event.data;
    if (!isRecord(data) || data.jsonrpc !== "2.0") return;
    if (data.method !== RESOURCE_READY) return;
    const resource = parseResource(data.params);
    if (resource === null) return;
    delivered = true;
    // Paint the theme's background before the rewrite so nothing flashes.
    const root = document.documentElement;
    if (resource.theme.appliesToRoot) {
      root.style.colorScheme = resource.theme.colorScheme;
      if (resource.theme.background !== null) {
        root.style.background = resource.theme.background;
      }
    }
    // `document.write` is deprecated for a parser that is still running; here
    // it is the in-place rewrite of a finished document, which keeps the
    // frame, its window and its policy container (probe W0-2). Reached by
    // name because the DOM lib marks the member itself deprecated.
    const write: unknown = Reflect.get(document, "write");
    if (typeof write !== "function") return;
    document.open();
    Reflect.apply(write, document, [buildDocument(resource)]);
    document.close();
  });

  window.parent.postMessage(
    { jsonrpc: "2.0", method: PROXY_READY, params: {} },
    "*",
  );
}

runLoader();
