import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PdfOutlineEntry } from "../pdf-outline-panel";

interface FakePdfDocument {
  readonly numPages: number;
  readonly getOutline: () => Promise<readonly PdfOutlineEntry[] | null>;
  readonly destroy: () => Promise<void>;
}

interface FakeLoadingTask {
  readonly promise: Promise<FakePdfDocument>;
  readonly destroy: () => Promise<void>;
}

interface FakeViewerInstance {
  readonly currentScale: number;
  readonly currentScaleValue: string;
  readonly currentPageNumber: number;
  readonly pagesRotation: number;
}

const state = vi.hoisted(() => ({
  getDocument: vi.fn(),
  viewerInstances: [] as FakeViewerInstance[],
}));

vi.mock("pdfjs-dist", () => ({
  getDocument: state.getDocument,
  GlobalWorkerOptions: { workerSrc: "" },
}));

vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => {
  class EventBus {
    private readonly listeners = new Map<
      string,
      Array<(event: unknown) => void>
    >();

    on(name: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    dispatch(name: string, event: unknown): void {
      for (const listener of this.listeners.get(name) ?? []) listener(event);
    }
  }

  class PDFLinkService {
    setViewer(): void {}
    setDocument(): void {}
    goToDestination(): Promise<void> {
      return Promise.resolve();
    }
  }

  class PDFFindController {
    constructor(_options: unknown) {}
  }

  class PDFViewer {
    private scale = 1;
    private scaleValue = "";
    private page = 1;
    private rotation = 0;
    private readonly eventBus: EventBus;

    constructor(options: { readonly eventBus: EventBus }) {
      this.eventBus = options.eventBus;
      state.viewerInstances.push(this);
    }

    get currentScale(): number {
      return this.scale;
    }

    set currentScale(value: number) {
      this.scale = value;
      this.eventBus.dispatch("scalechanging", { scale: value });
    }

    get currentScaleValue(): string {
      return this.scaleValue;
    }

    set currentScaleValue(value: string) {
      this.scaleValue = value;
      if (value === "page-width") this.currentScale = 1;
    }

    get currentPageNumber(): number {
      return this.page;
    }

    set currentPageNumber(value: number) {
      this.page = value;
      this.eventBus.dispatch("pagechanging", { pageNumber: value });
    }

    get pagesRotation(): number {
      return this.rotation;
    }

    set pagesRotation(value: number) {
      this.rotation = value;
    }

    setDocument(document: FakePdfDocument): void {
      void document;
      queueMicrotask(() => this.eventBus.dispatch("pagesinit", {}));
    }
  }

  return { EventBus, PDFFindController, PDFLinkService, PDFViewer };
});

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

import PdfPreview from "../pdf-preview";
import type { DocumentViewerProps } from "@/components/epic-canvas/document-preview/lazy-document-viewer";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

const OUTLINE: readonly PdfOutlineEntry[] = [
  { title: "Chapter one", dest: "chapter-one", url: null, items: [] },
];

function baseProps(
  overrides: Partial<DocumentViewerProps>,
): DocumentViewerProps {
  return {
    url: "blob:first",
    fileName: "report.pdf",
    compact: false,
    toolbarActions: null,
    onRenderFailure: vi.fn(),
    ...overrides,
  };
}

function makeDocument(
  outlinePromise: Promise<readonly PdfOutlineEntry[] | null>,
  destroy: () => Promise<void>,
): FakePdfDocument {
  return {
    numPages: 2,
    getOutline: () => outlinePromise,
    destroy,
  };
}

function makeTask(
  documentPromise: Promise<FakePdfDocument>,
  destroy: () => Promise<void>,
): FakeLoadingTask {
  return {
    promise: documentPromise,
    destroy,
  };
}

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
      }),
    ),
  );
}

beforeEach(() => {
  installFetch();
  state.getDocument.mockReset();
  state.viewerInstances.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("<PdfPreview /> document lifecycle", () => {
  it("resets page, zoom, search and outline state when the URL changes", async () => {
    const firstOutline = Promise.resolve(OUTLINE);
    const secondOutline = Promise.resolve(OUTLINE);
    const firstDestroy = vi.fn(() => Promise.resolve());
    const secondDestroy = vi.fn(() => Promise.resolve());
    const firstDocument = makeDocument(firstOutline, firstDestroy);
    const secondDocument = makeDocument(secondOutline, secondDestroy);
    state.getDocument
      .mockReturnValueOnce(
        makeTask(
          Promise.resolve(firstDocument),
          vi.fn(() => Promise.resolve()),
        ),
      )
      .mockReturnValueOnce(
        makeTask(
          Promise.resolve(secondDocument),
          vi.fn(() => Promise.resolve()),
        ),
      );
    const onRenderFailure = vi.fn();

    const { rerender } = render(
      <PdfPreview {...baseProps({ onRenderFailure, url: "blob:first" })} />,
    );

    await waitFor(() => expect(screen.getByText("/ 2")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Document outline" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Search document" }));
    fireEvent.change(screen.getByLabelText("Find in document"), {
      target: { value: "old query" },
    });
    expect(screen.getByLabelText<HTMLInputElement>("Page number").value).toBe(
      "2",
    );
    expect(screen.getByLabelText("Zoom level").textContent).toBe("110%");
    expect(screen.getByTestId("pdf-outline-panel")).not.toBeNull();

    rerender(
      <PdfPreview {...baseProps({ onRenderFailure, url: "blob:second" })} />,
    );

    await waitFor(() => expect(screen.getByText("/ 2")).not.toBeNull());
    expect(screen.getByLabelText<HTMLInputElement>("Page number").value).toBe(
      "1",
    );
    expect(screen.getByLabelText("Zoom level").textContent).toBe("100%");
    expect(screen.queryByLabelText("Find in document")).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Document outline" }),
    ).not.toBeNull();
    expect(screen.queryByTestId("pdf-outline-panel")).toBeNull();
    expect(firstDestroy).toHaveBeenCalledTimes(1);
    expect(onRenderFailure).not.toHaveBeenCalled();
  });

  it("destroys and ignores a late old document promise after a URL change", async () => {
    const oldDocumentDestroy = vi.fn(() => Promise.resolve());
    const oldDocument = makeDocument(Promise.resolve(null), oldDocumentDestroy);
    const oldTaskPromise = new Deferred<FakePdfDocument>();
    const oldTaskDestroy = vi.fn(() => Promise.resolve());
    const oldTask = makeTask(oldTaskPromise.promise, oldTaskDestroy);
    const newDocument = makeDocument(
      Promise.resolve(null),
      vi.fn(() => Promise.resolve()),
    );
    const newTask = makeTask(
      Promise.resolve(newDocument),
      vi.fn(() => Promise.resolve()),
    );
    state.getDocument.mockReturnValueOnce(oldTask).mockReturnValueOnce(newTask);
    const onRenderFailure = vi.fn();
    const { rerender } = render(
      <PdfPreview {...baseProps({ onRenderFailure, url: "blob:first" })} />,
    );
    await waitFor(() => expect(state.getDocument).toHaveBeenCalledTimes(1));

    rerender(
      <PdfPreview {...baseProps({ onRenderFailure, url: "blob:second" })} />,
    );
    await waitFor(() => expect(screen.getByText("/ 2")).not.toBeNull());
    expect(oldTaskDestroy).toHaveBeenCalledTimes(1);

    oldTaskPromise.resolve(oldDocument);
    await act(async () => {
      await oldTaskPromise.promise;
    });

    expect(oldDocumentDestroy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("/ 2")).not.toBeNull();
    expect(onRenderFailure).not.toHaveBeenCalled();
  });

  it("sets the viewer's currentScale to 1 when Actual size is clicked", async () => {
    const document = makeDocument(
      Promise.resolve(null),
      vi.fn(() => Promise.resolve()),
    );
    state.getDocument.mockReturnValueOnce(
      makeTask(
        Promise.resolve(document),
        vi.fn(() => Promise.resolve()),
      ),
    );
    const onRenderFailure = vi.fn();

    render(<PdfPreview {...baseProps({ onRenderFailure })} />);

    await waitFor(() => expect(screen.getByText("/ 2")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));

    expect(state.viewerInstances[0]?.currentScale).toBe(1);
    expect(onRenderFailure).not.toHaveBeenCalled();
  });
});
