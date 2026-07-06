import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { TraycerMarkdown } from "@/markdown";
import { classifyHref } from "@/markdown/links/classify-href";
import { markdownUrlTransform } from "@/markdown/links/markdown-url-transform";
import { MarkdownLinkContext } from "@/markdown/links/markdown-link-context";

afterEach(cleanup);

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

describe("MarkdownAnchor", () => {
  it("routes web-safe links through the runner host", () => {
    const host = createRunnerHost();
    renderMarkdown("[Docs](https://example.com/docs)", host);

    fireEvent.click(screen.getByRole("link", { name: "Docs" }));

    expect(host.openedExternalLinks).toEqual(["https://example.com/docs"]);
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
        <MarkdownLinkContext.Provider value={{ openFileLink }}>
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

  it("decodes file URLs before routing them through the surface policy", () => {
    const host = createRunnerHost();
    const openFileLink = vi.fn(() => true);
    render(
      <RunnerHostContext.Provider value={host}>
        <MarkdownLinkContext.Provider value={{ openFileLink }}>
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
        <MarkdownLinkContext.Provider value={{ openFileLink }}>
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
        <MarkdownLinkContext.Provider value={{ openFileLink }}>
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
});

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
