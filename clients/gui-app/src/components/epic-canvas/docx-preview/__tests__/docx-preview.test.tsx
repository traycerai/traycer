/**
 * `DocxPreview`'s render, zoom, failure, search and re-render contracts
 * (docx-preview.tsx): it fetches the URL to a Blob, renders it through the
 * (mocked) `docx-preview` package into a SHADOW ROOT, measures the widest
 * page against the scroll container to fit-to-width, and runs the Word find
 * engine on a 250ms debounce while its search bar is open. `docx-preview`,
 * `fetch`, `ResizeObserver` and the CSS Custom Highlight API are all fakes
 * here - jsdom implements none of the layout, custom-element or highlight
 * machinery this component depends on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { DocumentViewerProps } from "@/components/epic-canvas/document-preview/lazy-document-viewer";

type RenderAsyncMock = (
  data: Blob,
  bodyContainer: HTMLElement,
  styleContainer: HTMLElement,
  options: unknown,
) => Promise<unknown>;

const state = vi.hoisted(() => ({
  renderAsync: vi.fn<RenderAsyncMock>(),
  warn: vi.fn<
    (message: string, fields: Readonly<Record<string, unknown>>) => void
  >(),
}));

vi.mock("docx-preview", () => ({
  renderAsync: state.renderAsync,
}));

vi.mock("@/lib/logger", () => ({
  appLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: state.warn,
    error: vi.fn(),
    errorSummary: vi.fn(),
  },
}));

import DocxPreview from "../docx-preview";

/** One rendered "page": a docx-preview `section.docx` with its runs. */
interface FixturePage {
  readonly widthPx: number;
  /** Each entry is one paragraph, made of one `<span>` run per string. */
  readonly paragraphs: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * Builds a `.docx-wrapper` the way docx-preview would, with `offsetWidth`
 * pinned on each page - jsdom always reports 0, and fit-to-width is exactly
 * the computation under test.
 */
function buildDocxWrapper(pages: readonly FixturePage[]): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "docx-wrapper";
  for (const page of pages) {
    const section = document.createElement("section");
    section.className = "docx";
    Object.defineProperty(section, "offsetWidth", {
      configurable: true,
      value: page.widthPx,
    });
    for (const runs of page.paragraphs) {
      const paragraph = document.createElement("p");
      for (const run of runs) {
        const span = document.createElement("span");
        span.textContent = run;
        paragraph.append(span);
      }
      section.append(paragraph);
    }
    wrapper.append(section);
  }
  return wrapper;
}

function mockRenderAsyncWith(pages: readonly FixturePage[]): void {
  state.renderAsync.mockImplementation((_data, body) => {
    body.append(buildDocxWrapper(pages));
    return Promise.resolve();
  });
}

function installFetchStub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        blob: () => Promise.resolve(new Blob(["docx-bytes"])),
      }),
    ),
  );
}

const resizeObservers: ControllableResizeObserver[] = [];

class ControllableResizeObserver implements ResizeObserver {
  private target: Element | null = null;

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    this.target = target;
    resizeObservers.push(this);
  }

  unobserve(): void {
    this.target = null;
  }

  disconnect(): void {
    this.target = null;
  }

  trigger(): void {
    const target = this.target;
    if (target === null) return;
    this.callback(
      [
        {
          target,
          contentRect: new DOMRect(),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
}

function baseProps(
  overrides: Partial<DocumentViewerProps>,
): DocumentViewerProps {
  return {
    url: "blob:docx-bytes",
    fileName: "report.docx",
    compact: false,
    toolbarActions: null,
    onRenderFailure: vi.fn(),
    ...overrides,
  };
}

function setScrollContainerWidth(width: number): void {
  const scrollContainer = screen.getByTestId("docx-preview-container");
  Object.defineProperty(scrollContainer, "clientWidth", {
    configurable: true,
    value: width,
  });
}

/**
 * Waits for the toolbar's page field to come up ready - the "N pages" text
 * the toolbar used to render is gone now that the shared
 * `DocumentPreviewToolbar` owns page display; the page field ("1", enabled)
 * and the "/ N" count are what replace it as the ready signal.
 */
async function waitForReady(pageCount: number): Promise<HTMLInputElement> {
  await screen.findByText(`/ ${pageCount}`);
  const field = screen.getByLabelText<HTMLInputElement>("Page number");
  await waitFor(() => expect(field.value).toBe("1"));
  return field;
}

beforeEach(() => {
  resizeObservers.length = 0;
  vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
  // The CSS Custom Highlight API, stubbed the same way docx-find.test.ts
  // stubs it - a real Map satisfies the engine's set/delete registry shape.
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal(
    "Highlight",
    class {
      readonly ranges: readonly Range[];
      constructor(...ranges: readonly Range[]) {
        this.ranges = ranges;
      }
    },
  );
  installFetchStub();
  state.renderAsync.mockReset();
  state.warn.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("<DocxPreview />", () => {
  it("renders pages into the shadow root and reports the page count and fit-to-width percent", async () => {
    mockRenderAsyncWith([
      { widthPx: 400, paragraphs: [["Page one"]] },
      { widthPx: 400, paragraphs: [["Page two"]] },
    ]);
    const onRenderFailure = vi.fn();

    render(<DocxPreview {...baseProps({ onRenderFailure })} />);
    setScrollContainerWidth(832);

    await waitForReady(2);
    // available = 832 - 16*2 = 800; scale = 800 / 400 = 2 -> 200%.
    expect(screen.getByLabelText("Zoom level").textContent).toBe("200%");

    const host = screen.getByTestId("docx-preview-host");
    expect(host.shadowRoot?.querySelectorAll("section.docx").length).toBe(2);
    // Encapsulation: the rendered document lives entirely behind the shadow
    // boundary, invisible to a light-DOM query on the same host element.
    expect(host.querySelector("section.docx")).toBeNull();
    expect(onRenderFailure).not.toHaveBeenCalled();
  });

  it("scrolls the container to the target page's computed offset on Next page", async () => {
    mockRenderAsyncWith([
      { widthPx: 400, paragraphs: [["Page one"]] },
      { widthPx: 400, paragraphs: [["Page two"]] },
    ]);

    render(<DocxPreview {...baseProps({})} />);
    setScrollContainerWidth(832);

    const pageField = await waitForReady(2);
    expect(
      screen
        .getByRole("button", { name: "Previous page" })
        .hasAttribute("disabled"),
    ).toBe(true);

    // jsdom's getBoundingClientRect always returns a zeroed rect - stub the
    // scroll container and the target page section so scrollTopForPage has
    // real geometry to compute from.
    const scrollContainer = screen.getByTestId("docx-preview-container");
    vi.spyOn(scrollContainer, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 832, 600),
    );
    const host = screen.getByTestId("docx-preview-host");
    const sections =
      host.shadowRoot?.querySelectorAll<HTMLElement>("section.docx");
    const secondPage = sections?.[1];
    if (secondPage === undefined)
      throw new Error("second page section missing");
    vi.spyOn(secondPage, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 532, 400, 68),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    // scrollTopForPage: page.top(532) - container.top(0) +
    // containerScrollTop(0) - gutter(PAGE_GUTTER_PX 16 * scale 2 = 32) = 500.
    expect(scrollContainer.scrollTop).toBe(500);
    expect(pageField.value).toBe("2");
  });

  it("zooms in by 1.1x and clears fit mode so a later resize does not re-fit; Fit to width restores it", async () => {
    mockRenderAsyncWith([
      { widthPx: 400, paragraphs: [["Page one"]] },
      { widthPx: 400, paragraphs: [["Page two"]] },
    ]);

    render(<DocxPreview {...baseProps({})} />);
    setScrollContainerWidth(832);

    await waitForReady(2);
    expect(screen.getByLabelText("Zoom level").textContent).toBe("200%");

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByLabelText("Zoom level").textContent).toBe("220%");

    expect(resizeObservers).toHaveLength(1);
    act(() => {
      resizeObservers[0]?.trigger();
    });
    // A manual zoom cleared the automatic fit mode - the resize must not
    // silently snap the zoom back to fit-to-width.
    expect(screen.getByLabelText("Zoom level").textContent).toBe("220%");

    fireEvent.click(screen.getByRole("button", { name: "Fit to width" }));
    expect(screen.getByLabelText("Zoom level").textContent).toBe("200%");
  });

  it("calls onRenderFailure and logs a warning when renderAsync rejects", async () => {
    state.renderAsync.mockRejectedValueOnce(new Error("docx-preview blew up"));
    const onRenderFailure = vi.fn();

    render(<DocxPreview {...baseProps({ onRenderFailure })} />);

    await waitFor(() => expect(onRenderFailure).toHaveBeenCalledTimes(1));

    expect(state.warn).toHaveBeenCalledWith(
      "docx-preview: document failed to open",
      { error: "docx-preview blew up" },
    );
    expect(onRenderFailure).toHaveBeenCalledTimes(1);
  });

  it("calls onRenderFailure and logs a warning when docx-preview renders no wrapper", async () => {
    state.renderAsync.mockImplementationOnce(() => Promise.resolve(undefined));
    const onRenderFailure = vi.fn();

    render(<DocxPreview {...baseProps({ onRenderFailure })} />);

    await waitFor(() => expect(onRenderFailure).toHaveBeenCalledTimes(1));

    expect(state.warn).toHaveBeenCalledWith(
      "docx-preview: document failed to open",
      { error: "docx-preview rendered no document wrapper" },
    );
    expect(onRenderFailure).toHaveBeenCalledTimes(1);
  });

  describe("search", () => {
    it("finds a match spanning two runs after the debounce and shows the live counter", async () => {
      mockRenderAsyncWith([
        { widthPx: 400, paragraphs: [["Hel", "lo world"]] },
      ]);

      render(<DocxPreview {...baseProps({})} />);
      setScrollContainerWidth(832);

      const searchButton = await screen.findByRole("button", {
        name: "Search document",
      });
      fireEvent.click(searchButton);
      const input = screen.getByLabelText<HTMLInputElement>("Find in document");

      vi.useFakeTimers();
      fireEvent.change(input, { target: { value: "hello world" } });
      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(screen.getByText("1 / 1")).toBeTruthy();
    });

    it("shows 0 results for a query with no match", async () => {
      mockRenderAsyncWith([
        { widthPx: 400, paragraphs: [["Hel", "lo world"]] },
      ]);

      render(<DocxPreview {...baseProps({})} />);
      setScrollContainerWidth(832);

      fireEvent.click(
        await screen.findByRole("button", { name: "Search document" }),
      );
      const input = screen.getByLabelText<HTMLInputElement>("Find in document");

      vi.useFakeTimers();
      fireEvent.change(input, { target: { value: "not present" } });
      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(screen.getByText("0 results")).toBeTruthy();
    });

    it("clears the query when the search bar is closed", async () => {
      mockRenderAsyncWith([
        { widthPx: 400, paragraphs: [["Hel", "lo world"]] },
      ]);

      render(<DocxPreview {...baseProps({})} />);
      setScrollContainerWidth(832);

      fireEvent.click(
        await screen.findByRole("button", { name: "Search document" }),
      );
      fireEvent.change(
        screen.getByLabelText<HTMLInputElement>("Find in document"),
        { target: { value: "hello world" } },
      );

      fireEvent.click(screen.getByRole("button", { name: "Close search" }));
      expect(screen.queryByLabelText("Find in document")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Search document" }));
      expect(
        screen.getByLabelText<HTMLInputElement>("Find in document").value,
      ).toBe("");
    });
  });

  it("re-renders on a url change, replacing the shadow contents and closing search", async () => {
    mockRenderAsyncWith([{ widthPx: 400, paragraphs: [["Hel", "lo world"]] }]);
    const onRenderFailure = vi.fn();

    const { rerender } = render(
      <DocxPreview {...baseProps({ onRenderFailure, url: "blob:one" })} />,
    );
    setScrollContainerWidth(832);

    await waitForReady(1);
    expect(state.renderAsync).toHaveBeenCalledTimes(1);

    fireEvent.click(
      await screen.findByRole("button", { name: "Search document" }),
    );
    expect(screen.getByLabelText("Find in document")).toBeTruthy();

    mockRenderAsyncWith([{ widthPx: 400, paragraphs: [["Different text"]] }]);
    rerender(
      <DocxPreview {...baseProps({ onRenderFailure, url: "blob:two" })} />,
    );

    await waitFor(() => expect(state.renderAsync).toHaveBeenCalledTimes(2));
    // A new document resets search state - the old query/results must not
    // survive onto content that was never searched.
    expect(screen.queryByLabelText("Find in document")).toBeNull();

    const host = screen.getByTestId("docx-preview-host");
    expect(host.shadowRoot?.querySelectorAll(".docx-wrapper").length).toBe(1);
    expect(host.shadowRoot?.textContent).toContain("Different text");
    expect(onRenderFailure).not.toHaveBeenCalled();
  });
});
