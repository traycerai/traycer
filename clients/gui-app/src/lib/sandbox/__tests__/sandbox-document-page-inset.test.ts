import { JSDOM, VirtualConsole, type DOMWindow } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { buildDocument, type ArtifactPageRole } from "../sandbox-document";
import { PAGE_INSET_TOP_VARIABLE } from "../theme-map";

// An artifact page in a tile opens below the app's floating controls, by
// padding on its own root. The padding is the bootstrap's work, so these run
// the document `buildDocument` composes, the way the frame does, in a window
// of its own that is its own parent.

const windows: DOMWindow[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function between(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  const end = text.indexOf(close, start + open.length);
  if (start === -1 || end === -1) throw new Error(`no ${open} in the document`);
  return text.slice(start + open.length, end);
}

/** A full set of theme variables, with the page inset when the app has one. */
function variablesWith(inset: string | null): Record<string, string> {
  const variables: Record<string, string> = {
    "--color-background-primary": "#111111",
    "--color-text-primary": "#eeeeee",
  };
  if (inset !== null) variables[PAGE_INSET_TOP_VARIABLE] = inset;
  return variables;
}

function startPage(options: {
  readonly artifactPage: ArtifactPageRole;
  readonly inset: string | null;
}): DOMWindow {
  const composed = buildDocument({
    html: "",
    csp: null,
    nonce: "n-1",
    theme: {
      appliesToRoot: true,
      colorScheme: "dark",
      background: null,
      variables: Object.entries(variablesWith(options.inset)),
    },
    shortcuts: [],
    artifactPage: options.artifactPage,
  });
  const { window } = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "dangerously",
    url: "traycer-artifact://artifact-a1--m1/site/index.html",
    virtualConsole: new VirtualConsole(),
  });
  windows.push(window);
  // The bootstrap announces itself to its parent, which is this window.
  window.postMessage = () => undefined;
  window.eval(between(composed, "<script>", "</script>"));
  return window;
}

/** What the app sends when its host context changes: only the keys that did. */
function hostContextChanged(
  window: DOMWindow,
  params: Record<string, unknown>,
): void {
  const event = new window.MessageEvent("message", {
    data: {
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params,
    },
  });
  Object.defineProperty(event, "source", { value: window });
  window.dispatchEvent(event);
}

function themeChanged(window: DOMWindow, inset: string | null): void {
  hostContextChanged(window, { styles: { variables: variablesWith(inset) } });
}

function pageRoot(window: DOMWindow): HTMLElement {
  return window.document.documentElement;
}

describe("an artifact page's room for the app's floating controls", () => {
  it("opens with the room as padding on the page's root", () => {
    const window = startPage({ artifactPage: "found", inset: "44px" });

    expect(pageRoot(window).style.paddingTop).toBe("44px");
    expect(window.document.body.style.paddingTop).toBe("");
  });

  it("follows the app when its controls change size", () => {
    const window = startPage({ artifactPage: "found", inset: "44px" });

    themeChanged(window, "62px");

    expect(pageRoot(window).style.paddingTop).toBe("62px");
  });

  it("is added when the controls appear after the page, and cleared with its variable once they go", () => {
    const window = startPage({ artifactPage: "found", inset: null });
    expect(pageRoot(window).style.paddingTop).toBe("");

    themeChanged(window, "62px");
    expect(pageRoot(window).style.paddingTop).toBe("62px");
    expect(
      pageRoot(window).style.getPropertyValue(PAGE_INSET_TOP_VARIABLE),
    ).toBe("62px");

    themeChanged(window, null);
    expect(pageRoot(window).style.paddingTop).toBe("");
    expect(
      pageRoot(window).style.getPropertyValue(PAGE_INSET_TOP_VARIABLE),
    ).toBe("");
  });

  // The app sends only the keys that changed, so a change of display mode
  // arrives with no variables and says nothing about the controls.
  it("keeps the padding through a host context that carries no variables", () => {
    const window = startPage({ artifactPage: "found", inset: "44px" });

    hostContextChanged(window, { displayMode: "fullscreen" });

    expect(pageRoot(window).style.paddingTop).toBe("44px");
  });

  it("never pads a document that is not an artifact page, at boot or later", () => {
    const window = startPage({ artifactPage: null, inset: "44px" });
    expect(pageRoot(window).style.paddingTop).toBe("");

    themeChanged(window, "62px");

    expect(pageRoot(window).style.paddingTop).toBe("");
  });
});
