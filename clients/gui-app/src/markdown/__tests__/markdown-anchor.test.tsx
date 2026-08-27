import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { ExternalToast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { TraycerMarkdown } from "@/markdown";
import { classifyHref } from "@/markdown/links/classify-href";
import { markdownUrlTransform } from "@/markdown/links/markdown-url-transform";
import { MarkdownLinkContext } from "@/markdown/links/markdown-link-context";
import { BrowserLinkRoutingProvider } from "@/lib/browser-view/link-routing/browser-link-routing";
import {
  BrowserSessionsContext,
  type BrowserSessionsState,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import { createSingleTileCanvas } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  isBrowserSessionTileRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

const VIEW_TAB_ID = "markdown-view-tab";
const SOURCE_TILE: EpicCanvasTileRef = {
  id: "ticket-markdown",
  instanceId: "ticket-markdown-instance",
  type: "ticket",
  name: "Ticket",
  hostId: "host-markdown",
};

const neutralToast = vi.hoisted(() =>
  vi.fn<(message: ReactNode, options: ExternalToast | undefined) => string>(
    () => "toast-id",
  ),
);
const openTab = vi.fn<BrowserSessionsState["openTab"]>(() =>
  Promise.resolve({ sessionId: "session-markdown", tabId: "tab-markdown" }),
);

vi.mock("sonner", () => ({ toast: neutralToast }));

afterEach(() => {
  cleanup();
  neutralToast.mockClear();
  openTab.mockClear();
  useEpicCanvasStore.setState({ canvasByTabId: {}, tabsById: {} });
  useSettingsStore.setState({
    browserLinkDefaultMode: "in-app",
    terminalBrowserLinkOpenMode: "in-app",
    markdownBrowserLinkOpenMode: "in-app",
    browserDevOrigins: [],
  });
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
  });
});

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.example/sign-in",
    authnBaseUrl: "https://auth.example",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function renderMarkdown(markdown: string, host: MockRunnerHost) {
  return render(
    <RunnerHostContext.Provider value={host}>
      <TraycerMarkdown
        className={null}
        proseSize="normal"
        components={null}
        remarkPlugins={null}
        rehypePlugins={null}
        quotable={false}
        isStreaming={false}
      >
        {markdown}
      </TraycerMarkdown>
    </RunnerHostContext.Provider>,
  );
}

function renderMarkdownWithBrowserRouting(
  markdown: string,
  host: MockRunnerHost,
) {
  const canvas = createSingleTileCanvas(SOURCE_TILE);
  const pane = collectPanes(canvas.root).at(0);
  if (pane === undefined) throw new Error("expected source pane");
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: {
        tabId: VIEW_TAB_ID,
        epicId: "epic-markdown",
        name: "Markdown",
      },
    },
    canvasByTabId: {
      [VIEW_TAB_ID]: canvas,
    },
  });
  return render(
    <RunnerHostContext.Provider value={host}>
      <BrowserSessionsContext.Provider
        value={{
          hostId: SOURCE_TILE.hostId,
          lifecycle: "live",
          inventoryReady: true,
          items: [],
          errorMessage: null,
          retry: () => undefined,
          openTab,
          closeTab: () => Promise.resolve(),
        }}
      >
        <BrowserLinkRoutingProvider
          source={{
            viewTabId: VIEW_TAB_ID,
            paneId: pane.id,
            hostId: SOURCE_TILE.hostId,
          }}
        >
          <TraycerMarkdown
            className={null}
            proseSize="normal"
            components={null}
            remarkPlugins={null}
            rehypePlugins={null}
            quotable={false}
            isStreaming={false}
          >
            {markdown}
          </TraycerMarkdown>
        </BrowserLinkRoutingProvider>
      </BrowserSessionsContext.Provider>
    </RunnerHostContext.Provider>,
  );
}

describe("MarkdownAnchor", () => {
  it("routes web-safe links through the runner host", () => {
    const host = createRunnerHost();
    renderMarkdown("[Docs](https://example.com/docs)", host);

    fireEvent.click(screen.getByRole("link", { name: "Docs" }));

    expect(host.openedExternalLinks).toEqual(["https://example.com/docs"]);
  });

  it("opens markdown http links through the host and places its session pointer", async () => {
    const host = createRunnerHost();
    renderMarkdownWithBrowserRouting("[Docs](https://example.com/docs)", host);

    fireEvent.click(screen.getByRole("link", { name: "Docs" }));

    expect(openTab).toHaveBeenCalledWith(null, "https://example.com/docs");
    expect(host.openedExternalLinks).toEqual([]);
    await waitFor(() => {
      const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
      expect(
        Object.values(canvas?.tilesByInstanceId ?? {}).filter(
          (tile) => tile !== undefined && isBrowserSessionTileRef(tile),
        ),
      ).toMatchObject([
        {
          type: "browser-session",
          hostId: SOURCE_TILE.hostId,
          sessionId: "session-markdown",
          tabId: "tab-markdown",
        },
      ]);
    });
  });

  it("lets in-page anchors keep browser default navigation", () => {
    const host = createRunnerHost();
    renderMarkdown("[Usage](#usage)", host);

    expect(fireEvent.click(screen.getByRole("link", { name: "Usage" }))).toBe(
      true,
    );

    expect(host.openedExternalLinks).toEqual([]);
  });

  it("does not send local file links through the web-only external opener", () => {
    const host = createRunnerHost();
    renderMarkdown("[App](src/app.ts)", host);

    fireEvent.click(screen.getByRole("link", { name: "App" }));

    expect(host.openedExternalLinks).toEqual([]);
  });

  it("routes local file links through the surface policy when present", () => {
    const host = createRunnerHost();
    const openFileLink = vi.fn(() => true);
    render(
      <RunnerHostContext.Provider value={host}>
        <MarkdownLinkContext.Provider
          value={{ openFileLink, supersedePendingFileLink: () => undefined }}
        >
          <TraycerMarkdown
            className={null}
            proseSize="normal"
            components={null}
            remarkPlugins={null}
            rehypePlugins={null}
            quotable={false}
            isStreaming={false}
          >
            {"[App](src/app.ts)"}
          </TraycerMarkdown>
        </MarkdownLinkContext.Provider>
      </RunnerHostContext.Provider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "App" }));

    expect(openFileLink).toHaveBeenCalledWith({
      path: "src/app.ts",
      line: null,
      col: null,
      isDirectory: false,
    });
    expect(host.openedExternalLinks).toEqual([]);
  });

  it("keeps an unresolved-link toast neutral and reports only fixed context", () => {
    const host = createRunnerHost();
    const openFileLink = vi.fn(() => false);
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    render(
      <RunnerHostContext.Provider value={host}>
        <MarkdownLinkContext.Provider
          value={{ openFileLink, supersedePendingFileLink: () => undefined }}
        >
          <TraycerMarkdown
            className={null}
            proseSize="normal"
            components={null}
            remarkPlugins={null}
            rehypePlugins={null}
            quotable={false}
            isStreaming={false}
          >
            {"[Private file](/Users/me/private/api-key.txt)"}
          </TraycerMarkdown>
        </MarkdownLinkContext.Provider>
      </RunnerHostContext.Provider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Private file" }));

    const options = readNeutralToastOptions();
    const cancel = options.cancel;
    if (
      typeof cancel !== "object" ||
      cancel === null ||
      !("onClick" in cancel)
    ) {
      throw new Error("Expected a report issue action.");
    }
    const action = render(
      <button type="button" onClick={cancel.onClick}>
        Trigger report issue
      </button>,
    );

    useDesktopDialogStore.setState({ reportIssueAvailable: false });
    fireEvent.click(
      action.getByRole("button", { name: "Trigger report issue" }),
    );
    expect(useDesktopDialogStore.getState().reportIssueContext).toBeNull();

    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    fireEvent.click(
      action.getByRole("button", { name: "Trigger report issue" }),
    );
    action.unmount();

    expect(neutralToast).toHaveBeenCalledTimes(1);
    expect(neutralToast.mock.lastCall?.[0]).toBe("Couldn't open link");
    expect(cancel.label).toBe("Report issue");
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Markdown link could not be opened",
      message: "The requested markdown link could not be opened.",
      code: null,
      source: "Markdown link",
    });
    expect(JSON.stringify(neutralToast.mock.lastCall)).not.toContain(
      "/Users/me/private/api-key.txt",
    );
  });

  it("decodes file URLs before routing them through the surface policy", () => {
    const host = createRunnerHost();
    const openFileLink = vi.fn(() => true);
    render(
      <RunnerHostContext.Provider value={host}>
        <MarkdownLinkContext.Provider
          value={{ openFileLink, supersedePendingFileLink: () => undefined }}
        >
          <TraycerMarkdown
            className={null}
            proseSize="normal"
            components={null}
            remarkPlugins={null}
            rehypePlugins={null}
            quotable={false}
            isStreaming={false}
          >
            {"[App](file:///Users/me/My%20Project/src/app.ts)"}
          </TraycerMarkdown>
        </MarkdownLinkContext.Provider>
      </RunnerHostContext.Provider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "App" }));

    expect(openFileLink).toHaveBeenCalledWith({
      path: "/Users/me/My Project/src/app.ts",
      line: null,
      col: null,
      isDirectory: false,
    });
  });

  it("parses a trailing line off a rooted file link", () => {
    const host = createRunnerHost();
    const openFileLink = vi.fn(() => true);
    render(
      <RunnerHostContext.Provider value={host}>
        <MarkdownLinkContext.Provider
          value={{ openFileLink, supersedePendingFileLink: () => undefined }}
        >
          <TraycerMarkdown
            className={null}
            proseSize="normal"
            components={null}
            remarkPlugins={null}
            rehypePlugins={null}
            quotable={false}
            isStreaming={false}
          >
            {"[App](/a/b.ts:1177)"}
          </TraycerMarkdown>
        </MarkdownLinkContext.Provider>
      </RunnerHostContext.Provider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "App" }));

    expect(openFileLink).toHaveBeenCalledWith({
      path: "/a/b.ts",
      line: 1177,
      col: null,
      isDirectory: false,
    });
  });

  it("routes a Windows drive link through the surface policy end to end", () => {
    // Full render path: `markdownUrlTransform` normalizes the drive href to a
    // `file:` URL, `rehype-sanitize` keeps it via the `file` allow-list, and the
    // rendered anchor's click classifies it back to a native drive path with the
    // trailing location intact. Guards CL-4 against the sanitize layer silently
    // emptying the href (the click would otherwise be a no-op).
    const host = createRunnerHost();
    const openFileLink = vi.fn(() => true);
    render(
      <RunnerHostContext.Provider value={host}>
        <MarkdownLinkContext.Provider
          value={{ openFileLink, supersedePendingFileLink: () => undefined }}
        >
          <TraycerMarkdown
            className={null}
            proseSize="normal"
            components={null}
            remarkPlugins={null}
            rehypePlugins={null}
            quotable={false}
            isStreaming={false}
          >
            {"[App](C:/Users/x/app.ts:1177)"}
          </TraycerMarkdown>
        </MarkdownLinkContext.Provider>
      </RunnerHostContext.Provider>,
    );

    const link = screen.getByRole("link", { name: "App" });
    // The drive href survived the sanitize allow-list as the raw drive path, not
    // an empty string (which is what made the click a no-op before CL-4).
    expect(link.getAttribute("href")).toBe("C:/Users/x/app.ts:1177");

    fireEvent.click(link);

    expect(openFileLink).toHaveBeenCalledWith({
      path: "C:/Users/x/app.ts",
      line: 1177,
      col: null,
      isDirectory: false,
    });
    expect(host.openedExternalLinks).toEqual([]);
  });

  it("routes a NATIVE backslash Windows link through the surface policy end to end", () => {
    // The shape a Windows agent actually writes: backslash separators, and the
    // destination wrapped in `<>` because the home directory has a space in it.
    // This must go through the real markdown parser, not `markdownUrlTransform`
    // alone - remark percent-encodes the destination (`\` -> `%5C`, ` ` ->
    // `%20`) BEFORE the transform runs, so the drive-letter bypass has to match
    // the encoded separator and the anchor has to decode it back to a native
    // path. Feeding a raw backslash href straight to the transform (see
    // `classifyRenderedHref` below) skips that encoding entirely and hides this.
    const host = createRunnerHost();
    const openFileLink = vi.fn(() => true);
    const { container } = render(
      <RunnerHostContext.Provider value={host}>
        <MarkdownLinkContext.Provider
          value={{ openFileLink, supersedePendingFileLink: () => undefined }}
        >
          <TraycerMarkdown
            className={null}
            proseSize="normal"
            components={null}
            remarkPlugins={null}
            rehypePlugins={null}
            quotable={false}
            isStreaming={false}
          >
            {String.raw`[App](<C:\Users\Traycer Dev\repo\app.ts>)`}
          </TraycerMarkdown>
        </MarkdownLinkContext.Provider>
      </RunnerHostContext.Provider>,
    );

    // Queried as an element, not by role: a dropped href strips the anchor of
    // its `link` role, and this assertion is about the href itself.
    const link = requireAnchor(container);
    // A blank href is the crash: it resolves to the current document, so the
    // click performs a real navigation and unloads the SPA. Asserted against
    // the drive prefix - "not empty" alone would pass on the dropped-attribute
    // form the anchor falls back to when the transform empties an href.
    expect(link.getAttribute("href")).toMatch(/^C:(%5C|\\)Users/i);

    // `fireEvent.click` returns false when the handler called `preventDefault`.
    // A true here means the browser owns the click - the renderer reload.
    expect(fireEvent.click(link)).toBe(false);

    expect(openFileLink).toHaveBeenCalledWith({
      path: String.raw`C:\Users\Traycer Dev\repo\app.ts`,
      line: null,
      col: null,
      isDirectory: false,
    });
    expect(host.openedExternalLinks).toEqual([]);
  });

  it("never renders an emptied href the browser could navigate", () => {
    // `defaultUrlTransform` empties any href it deems unsafe, and an empty href
    // is not inert: it points at the current document, so a click navigates for
    // real and the whole renderer reloads. The anchor must drop the attribute
    // rather than render a navigable blank. This is the general guard behind
    // the Windows-path case above.
    //
    // `z:notapath` is emptied because the two layers disagree: the sanitize
    // schema allows every single-letter scheme (drive letters), but the drive
    // bypass in `markdownUrlTransform` only applies to an actual path, so this
    // falls through to `defaultUrlTransform` and is emptied there.
    const host = createRunnerHost();
    const openFileLink = vi.fn(() => true);
    const { container } = render(
      <RunnerHostContext.Provider value={host}>
        <MarkdownLinkContext.Provider
          value={{ openFileLink, supersedePendingFileLink: () => undefined }}
        >
          <TraycerMarkdown
            className={null}
            proseSize="normal"
            components={null}
            remarkPlugins={null}
            rehypePlugins={null}
            quotable={false}
            isStreaming={false}
          >
            {"[Blocked](z:notapath)"}
          </TraycerMarkdown>
        </MarkdownLinkContext.Provider>
      </RunnerHostContext.Provider>,
    );

    const link = requireAnchor(container);
    expect(link.getAttribute("href")).toBeNull();
    fireEvent.click(link);
    expect(openFileLink).not.toHaveBeenCalled();
    expect(host.openedExternalLinks).toEqual([]);
  });
});

/**
 * The rendered anchor, addressed as an element. `getByRole("link")` is the
 * usual query, but an anchor whose href the transform emptied loses its `link`
 * role - and that anchor is exactly what the reload cases assert against.
 */
function requireAnchor(container: HTMLElement): HTMLAnchorElement {
  const anchor = container.querySelector("a");
  if (anchor === null) throw new Error("Expected a rendered anchor.");
  return anchor;
}

function readNeutralToastOptions(): ExternalToast {
  const call = neutralToast.mock.lastCall;
  if (call === undefined || call[1] === undefined) {
    throw new Error("Expected neutral toast options.");
  }
  return call[1];
}

// The real render order: react-markdown runs `markdownUrlTransform` on the
// href first, then the anchor classifies the result. Driving the drive-letter
// cases through this composition (not `classifyHref` alone) keeps the Windows
// branch honest: `defaultUrlTransform` would empty `C:` as an unsafe scheme, so
// a regression in the transform bypass surfaces here instead of passing green.
function classifyRenderedHref(rawHref: string) {
  return classifyHref(markdownUrlTransform(rawHref, "href"));
}

describe("classifyHref", () => {
  it("parses a trailing line off a file path", () => {
    expect(classifyHref("/a/b.ts:1177")).toEqual({
      kind: "file",
      path: "/a/b.ts",
      line: 1177,
      col: null,
    });
  });

  it("parses a trailing line and column off a file path", () => {
    expect(classifyHref("/a/b.ts:1177:5")).toEqual({
      kind: "file",
      path: "/a/b.ts",
      line: 1177,
      col: 5,
    });
  });

  it("leaves a file path without a trailing location unchanged", () => {
    expect(classifyHref("/a/b.ts")).toEqual({
      kind: "file",
      path: "/a/b.ts",
      line: null,
      col: null,
    });
  });

  it("survives the url transform for a backslash Windows drive path", () => {
    // The transform passes the drive href through unchanged; `classifyHref`
    // routes the single-letter scheme as a native file path (backslashes kept).
    expect(classifyRenderedHref("C:\\Users\\x\\f.ts")).toEqual({
      kind: "file",
      path: "C:\\Users\\x\\f.ts",
      line: null,
      col: null,
    });
  });

  it("survives the url transform for a forward-slash Windows drive path", () => {
    expect(classifyRenderedHref("C:/Users/x/f.ts")).toEqual({
      kind: "file",
      path: "C:/Users/x/f.ts",
      line: null,
      col: null,
    });
  });

  it("preserves a trailing line:col on a Windows drive path through the transform", () => {
    expect(classifyRenderedHref("C:\\Users\\x\\f.ts:1177:5")).toEqual({
      kind: "file",
      path: "C:\\Users\\x\\f.ts",
      line: 1177,
      col: 5,
    });
  });

  it("still resolves a file:// drive URL through the transform unchanged", () => {
    expect(classifyRenderedHref("file:///C:/x/f.ts")).toEqual({
      kind: "file",
      path: "C:/x/f.ts",
      line: null,
      col: null,
    });
  });

  it("still parses a trailing line off a POSIX path through the transform", () => {
    expect(classifyRenderedHref("/abs/path/f.ts:1177")).toEqual({
      kind: "file",
      path: "/abs/path/f.ts",
      line: 1177,
      col: null,
    });
  });

  it("keeps an http host:port external and untouched", () => {
    expect(classifyHref("http://x:8080")).toEqual({
      kind: "external",
      url: "http://x:8080",
    });
  });

  it("only strips a trailing location, never a mid-path colon", () => {
    expect(classifyHref("/a/b:c/d.ts")).toEqual({
      kind: "file",
      path: "/a/b:c/d.ts",
      line: null,
      col: null,
    });
  });

  it("decodes percent-encoded separators and spaces out of a rendered path", () => {
    // remark percent-encodes the link destination before the anchor sees it, so
    // a native Windows path arrives as `C:%5C…%20…`. The surface policy resolves
    // against a real filesystem and needs the decoded form.
    expect(classifyRenderedHref("C:%5CUsers%5CTraycer%20Dev%5Capp.ts")).toEqual(
      {
        kind: "file",
        path: String.raw`C:\Users\Traycer Dev\app.ts`,
        line: null,
        col: null,
      },
    );
    expect(classifyRenderedHref("/Users/them%20dev/app.ts:12")).toEqual({
      kind: "file",
      path: "/Users/them dev/app.ts",
      line: 12,
      col: null,
    });
  });

  it("decodes reserved characters in a filename without reading them as syntax", () => {
    // `#` and `:` are reserved, so `decodeURI` would leave them encoded and hand
    // the surface policy a path no filesystem has. Splitting the fragment and
    // the `:line[:col]` suffix off the ENCODED href is what keeps the decoded
    // `%23` from being taken as a fragment and the decoded `%3A` as a location.
    expect(classifyHref("/notes/release%231%3A2.md")).toEqual({
      kind: "file",
      path: "/notes/release#1:2.md",
      line: null,
      col: null,
    });
    expect(classifyHref("/notes/release%231%3A2.md:12:3")).toEqual({
      kind: "file",
      path: "/notes/release#1:2.md",
      line: 12,
      col: 3,
    });
  });

  it("rejects a degenerate location-only href with no file path", () => {
    // `:99` has a trailing line but no file in front of it. Reject at the
    // source as `ignore` (the click is still `preventDefault`ed) rather than
    // emitting an empty-path file link.
    expect(classifyHref(":99")).toEqual({ kind: "ignore" });
  });

  it("rejects a degenerate zero-line location-only href", () => {
    expect(classifyHref(":0")).toEqual({ kind: "ignore" });
  });

  it("drops a non-positive line target but still opens the file", () => {
    // A `:0` suffix on a real path is not a valid 1-based location: open the
    // file without a target instead of passing line 0 to a downstream clamp.
    expect(classifyHref("/a/b.ts:0")).toEqual({
      kind: "file",
      path: "/a/b.ts",
      line: null,
      col: null,
    });
  });
});
