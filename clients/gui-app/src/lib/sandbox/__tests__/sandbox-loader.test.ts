import { JSDOM, VirtualConsole, type DOMWindow } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDocument, type ArtifactPageRole } from "../sandbox-document";

// The loader is a classic script with no exports (`vite/sandbox-assets.ts`
// inlines it on its own), so it is run for its effect: importing it starts it,
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

/**
 * Runs the written document's bootstrap in a window of its own, closed
 * afterwards, so no listener it registers outlives the test. `posted` holds
 * what the bootstrap sent to its parent, each with its target origin.
 */
async function inBootstrapWindow<T>(
  run: (page: DOMWindow, posted: unknown[]) => T,
): Promise<T> {
  const bootstrap = between(
    await deliver("page", true),
    "<script>",
    "</script>",
  );
  const { window: page } = new JSDOM(
    "<!doctype html><html><body></body></html>",
    { runScripts: "dangerously", virtualConsole: new VirtualConsole() },
  );
  const posted: unknown[] = [];
  page.postMessage = (message: unknown, targetOrigin: unknown) => {
    posted.push([message, targetOrigin]);
  };
  try {
    // The bootstrap runs inside the written document; here it runs in this one.
    page.eval(bootstrap);
    return run(page, posted);
  } finally {
    page.close();
  }
}

describe("sandbox loader wheel", () => {
  it("hands a wheel the page cannot use to the app, and leaves one it can scroll", async () => {
    await inBootstrapWindow((page, posted) => {
      const { document } = page;
      const wheel = (target: Element, init: WheelEventInit): WheelEvent => {
        const event = new page.WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ...init,
        });
        target.dispatchEvent(event);
        return event;
      };
      const unscrollable = document.body.appendChild(
        document.createElement("p"),
      );
      const panel = document.body.appendChild(document.createElement("div"));
      panel.style.overflowY = "auto";
      Object.defineProperty(panel, "scrollHeight", { value: 900 });
      Object.defineProperty(panel, "clientHeight", { value: 300 });
      const inPanel = panel.appendChild(document.createElement("span"));

      const given = wheel(unscrollable, { deltaY: 40, deltaMode: 0 });
      expect(given.defaultPrevented).toBe(true);
      expect(posted).toEqual([
        [
          {
            jsonrpc: "2.0",
            method: "traycer/notifications/wheel",
            params: { deltaX: 0, deltaY: 40, deltaMode: 0 },
          },
          "*",
        ],
      ]);

      posted.length = 0;
      expect(wheel(inPanel, { deltaY: 40 }).defaultPrevented).toBe(false);
      expect(
        wheel(unscrollable, { deltaY: 40, ctrlKey: true }).defaultPrevented,
      ).toBe(false);
      expect(posted).toEqual([]);
    });
  });
});

describe("sandbox loader touch relay", () => {
  // The browser gives a swipe to the scroller that can take its first move,
  // for the whole contact. One the page scrolls never reaches the transcript,
  // so reporting its direction leaves the transcript waiting for a scroll
  // that never comes.
  function swipe(
    target: (page: DOMWindow) => Element,
  ): Promise<readonly unknown[]> {
    return inBootstrapWindow((page, posted) => {
      const element = target(page);
      const touch = (type: string, clientY: number): void => {
        const event = new page.Event(type, { bubbles: true });
        Object.defineProperty(event, "touches", {
          value: {
            item: (index: number) => (index === 0 ? { clientY } : null),
          },
        });
        element.dispatchEvent(event);
      };
      touch("touchstart", 300);
      // Fingers moving up: toward the end of the content.
      touch("touchmove", 280);
      touch("touchmove", 250);
      touch("touchmove", 200);
      return posted;
    });
  }

  it("leaves a swipe over content the page can scroll to the page", async () => {
    const posted = await swipe(({ document }) => {
      const panel = document.body.appendChild(document.createElement("div"));
      panel.style.overflowY = "auto";
      Object.defineProperty(panel, "scrollHeight", { value: 900 });
      Object.defineProperty(panel, "clientHeight", { value: 300 });
      return panel.appendChild(document.createElement("span"));
    });

    expect(posted).toEqual([]);
  });

  it("control: reports each move of a swipe over content nothing can scroll, once", async () => {
    const posted = await swipe(({ document }) =>
      document.body.appendChild(document.createElement("p")),
    );

    const gesture = [
      {
        jsonrpc: "2.0",
        method: "traycer/notifications/scroll-gesture",
        params: { direction: "toward-end" },
      },
      "*",
    ];
    expect(posted).toEqual([gesture, gesture, gesture]);
  });
});

describe("served artifact page links", () => {
  /**
   * Clicks a link in a page running the composed bootstrap, in a window of
   * its own at a served page's address. `true` when the click was left to the
   * browser, so the frame follows the link itself.
   */
  function clickFollows(
    artifactPage: ArtifactPageRole,
    href: string,
    artifactRootPath: string | undefined,
  ): boolean {
    return clickLink({
      artifactPage,
      href,
      artifactRootPath,
      anchorTarget: null,
      baseTarget: null,
    }).followed;
  }

  /** The same click with the anchor's and the document's `target` settable. */
  function clickLink(input: {
    readonly artifactPage: ArtifactPageRole;
    readonly href: string;
    readonly artifactRootPath: string | undefined;
    readonly anchorTarget: string | null;
    readonly baseTarget: string | null;
  }): {
    readonly followed: boolean;
    readonly target: string | null;
    readonly linkRequests: readonly unknown[];
  } {
    const composed = buildDocument({
      html: "",
      csp: null,
      nonce: "n-1",
      theme: {
        appliesToRoot: true,
        colorScheme: "dark",
        background: null,
        variables: [],
      },
      shortcuts: [],
      artifactPage: input.artifactPage,
      ...(input.artifactRootPath === undefined
        ? {}
        : { artifactRootPath: input.artifactRootPath }),
    });
    const { window } = new JSDOM("<!doctype html><html><body></body></html>", {
      runScripts: "dangerously",
      url: "traycer-artifact://artifact-a1--m1/site/index.html",
      // jsdom reports every followed link as an unimplemented navigation.
      virtualConsole: new VirtualConsole(),
    });
    const posted: unknown[] = [];
    window.postMessage = (message: unknown) => {
      posted.push(message);
    };
    window.eval(between(composed, "<script>", "</script>"));
    if (input.baseTarget !== null) {
      const base = window.document.createElement("base");
      base.setAttribute("target", input.baseTarget);
      window.document.head.append(base);
    }
    const anchor = window.document.createElement("a");
    anchor.setAttribute("href", input.href);
    if (input.anchorTarget !== null)
      anchor.setAttribute("target", input.anchorTarget);
    window.document.body.append(anchor);
    const followed = anchor.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    const target = anchor.getAttribute("target");
    window.close();
    // The bootstrap posts other notifications too; only link requests matter here.
    const linkRequests = posted.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "method" in message &&
        message.method === "ui/open-link",
    );
    return { followed, target, linkRequests };
  }

  it.each([
    ["an explicit target=_blank", "_blank", null],
    ["a target=_blank inherited from <base>", null, "_blank"],
  ])(
    "keeps a link to another page of the artifact in its own frame despite %s",
    (_label, anchorTarget, baseTarget) => {
      const clicked = clickLink({
        artifactPage: "found",
        href: "about.html",
        artifactRootPath: "/site/",
        anchorTarget,
        baseTarget,
      });

      // The sandbox has no popup permission, so a blank target would do nothing.
      expect(clicked.followed).toBe(true);
      expect(clicked.target).toBe("_self");
      expect(clicked.linkRequests).toEqual([]);
    },
  );

  it("still hands a link that leaves the artifact to the app, with its blank target untouched", () => {
    const clicked = clickLink({
      artifactPage: "found",
      href: "https://example.com/docs",
      artifactRootPath: "/site/",
      anchorTarget: "_blank",
      baseTarget: null,
    });

    expect(clicked.followed).toBe(false);
    expect(clicked.target).toBe("_blank");
    expect(clicked.linkRequests).toEqual([
      expect.objectContaining({
        method: "ui/open-link",
        params: { url: "https://example.com/docs" },
      }),
    ]);
  });

  it("follows a link to another page of the artifact only on a served artifact page that knows its root", () => {
    expect(clickFollows("found", "about.html", "/site/")).toBe(true);
    expect(clickFollows("found", "logo.png", "/site/")).toBe(false);
    expect(clickFollows(null, "about.html", "/site/")).toBe(false);
    // Without the root there is nothing to confine the link to, so it is
    // handed to the app rather than followed.
    expect(clickFollows("found", "about.html", undefined)).toBe(false);
  });

  it("follows a link to a directory of the artifact, which the server answers with its index page", () => {
    expect(clickFollows("found", "docs/", "/site/")).toBe(true);
    expect(clickFollows("found", "/site/", "/site/")).toBe(true);
    // A directory link is not an html page by its extension, so the trailing
    // slash is what must carry it.
    expect(clickFollows("found", "docs", "/site/")).toBe(false);
  });

  it("refuses a link that leaves the artifact's own folder, including a sibling that shares its name as a prefix", () => {
    expect(clickFollows("found", "../other/page.htm", "/site/")).toBe(false);
    expect(clickFollows("found", "/site-evil/page.html", "/site/")).toBe(false);
    expect(clickFollows("found", "/site-evil/", "/site/")).toBe(false);
  });

  it("refuses a link whose path cannot be decoded instead of following it", () => {
    expect(clickFollows("found", "%E0%A4%A.html", "/site/")).toBe(false);
  });
});
