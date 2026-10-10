import { afterEach, describe, expect, it, vi } from "vitest";

// The loader is a classic script with no exports (`vite/sandbox-assets.ts`
// ships it on its own), so it is run for its effect: importing it starts it,
// and it then waits, in a jsdom window that is its own parent, for the app to
// post it a resource. A variable specifier keeps the type-checker from
// treating the script as a module.
const LOADER = "../sandbox-loader";

function resourceMessage(kind: "page" | "app", appliesToRoot: boolean) {
  return {
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-resource-ready",
    params: {
      html: "<p>hi</p>",
      kind,
      csp: null,
      nonce: "n-1",
      bootstrap: {
        theme: {
          appliesToRoot,
          colorScheme: "dark",
          background: "rgb(1, 2, 3)",
          variables: { "--color-text-primary": "red" },
        },
        forwardedShortcuts: [],
      },
    },
  };
}

/** The document the loader writes for a resource, as one string. */
function writtenDocument(message: unknown): string {
  const written: string[] = [];
  vi.spyOn(document, "open").mockImplementation(() => window);
  vi.spyOn(document, "close").mockImplementation(() => undefined);
  vi.spyOn(document, "write").mockImplementation((...chunks: string[]) => {
    written.push(...chunks);
  });
  window.dispatchEvent(
    new MessageEvent("message", { data: message, source: window.parent }),
  );
  return written.join("");
}

function between(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  const end = text.indexOf(close, start + open.length);
  if (start === -1 || end === -1) throw new Error(`no ${open} in the document`);
  return text.slice(start + open.length, end);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Each loader accepts one resource, so each test loads a fresh copy.
async function deliver(kind: "page" | "app", appliesToRoot: boolean) {
  vi.resetModules();
  vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
  await import(LOADER);
  return writtenDocument(resourceMessage(kind, appliesToRoot));
}

describe("sandbox loader theme", () => {
  it("writes a page's color scheme, background and variables onto the root", async () => {
    const style = between(await deliver("page", true), "<style>", "</style>");
    expect(style).toContain(
      ":root{color-scheme:dark;background:rgb(1, 2, 3);--color-text-primary:red}",
    );
  });

  it("gives an app only the Canvas floor, leaving its color scheme to the app", async () => {
    const style = between(await deliver("app", false), "<style>", "</style>");
    expect(style).not.toContain("color-scheme");
    expect(style).not.toContain("--color-text-primary");
    expect(style).toContain(":where(:root){background-color:Canvas}");
  });
});

describe("sandbox loader wheel", () => {
  it("hands a wheel the page cannot use to the app, and leaves one it can scroll", async () => {
    const html = await deliver("page", true);
    const bootstrap = between(html, "<script>", "</script>");
    const post = vi
      .spyOn(window, "postMessage")
      .mockImplementation(() => undefined);
    // The bootstrap runs inside the written document; here it runs in this one.
    window.eval(bootstrap);

    const wheel = (target: Element, init: WheelEventInit): WheelEvent => {
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      target.dispatchEvent(event);
      return event;
    };
    const unscrollable = document.body.appendChild(document.createElement("p"));
    const panel = document.body.appendChild(document.createElement("div"));
    panel.style.overflowY = "auto";
    Object.defineProperty(panel, "scrollHeight", { value: 900 });
    Object.defineProperty(panel, "clientHeight", { value: 300 });
    const inPanel = panel.appendChild(document.createElement("span"));

    const given = wheel(unscrollable, { deltaY: 40, deltaMode: 0 });
    expect(given.defaultPrevented).toBe(true);
    expect(post).toHaveBeenCalledWith(
      {
        jsonrpc: "2.0",
        method: "traycer/notifications/wheel",
        params: { deltaX: 0, deltaY: 40, deltaMode: 0 },
      },
      "*",
    );

    post.mockClear();
    expect(wheel(inPanel, { deltaY: 40 }).defaultPrevented).toBe(false);
    expect(
      wheel(unscrollable, { deltaY: 40, ctrlKey: true }).defaultPrevented,
    ).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});
