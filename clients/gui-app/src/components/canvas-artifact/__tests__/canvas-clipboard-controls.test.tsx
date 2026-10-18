import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import type { CanvasBoardDocument } from "../canvas-board-document";
import {
  CanvasClipboardBoundary,
  CanvasClipboardMenuItems,
  CanvasImageControls,
} from "../canvas-clipboard-controls";
import { CANVAS_IMAGE_MAX_BYTES } from "../canvas-image-transfer";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "../canvas-selection-store";
import {
  ARTIFACT_ID,
  BOARD_PATH,
  boardDocument,
  canvasElement,
  disposeBridges,
  pendingSaves,
  realBridge,
  REFUSED,
  registryServing,
  SAVED,
  settleSave,
  textSelection,
} from "./canvas-edit-test-support";

vi.mock("../use-artboard-edit", async () =>
  (await import("./canvas-edit-test-support")).artboardEditModule(),
);

vi.mock("@/components/ui/agent-spinning-dots", () => ({
  AgentSpinningDots: () => <span data-testid="saving-spinner" />,
}));

const SERVED = "sha-served";
const PNG_BYTES = new Uint8Array([1, 2, 3]);
const PNG_BASE64 = "AQID";

/** What `new ClipboardItem(...)` was given; jsdom has no such class. */
class FakeClipboardItem {
  constructor(readonly parts: Readonly<Record<string, Blob>>) {}
}
interface FakeReadItem {
  readonly types: readonly string[];
  readonly getType: (type: string) => Promise<Blob>;
}

const clipboard = {
  read: vi.fn<() => Promise<FakeReadItem[]>>(),
  write: vi.fn<(items: FakeClipboardItem[]) => Promise<void>>(),
};

function readItem(parts: Readonly<Record<string, BlobPart>>): FakeReadItem {
  return {
    types: Object.keys(parts),
    getType: (type) => Promise.resolve(new Blob([parts[type]], { type })),
  };
}

function imageFileOf(name: string, type: string, bytes: Uint8Array): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function imageFile(name: string, type: string): File {
  return imageFileOf(name, type, PNG_BYTES);
}

function selectElement(overrides: Partial<CanvasElement>): CanvasSelection {
  const selection = textSelection(null, overrides);
  act(() => {
    useCanvasSelectionStore.getState().select(selection);
  });
  return selection;
}

/** Blob and FileReader answers arrive on a later task than a microtask. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  pendingSaves.length = 0;
  clipboard.read.mockReset();
  clipboard.write.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  useCanvasSelectionStore.getState().clear();
});

afterEach(() => {
  cleanup();
  disposeBridges();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useCanvasSelectionStore.getState().clear();
});

describe("CanvasImageControls", () => {
  function mount(selection: CanvasSelection) {
    render(
      <CanvasImageControls
        selection={selection}
        registry={registryServing(null, SERVED)}
      />,
    );
  }
  function fileInput(): HTMLInputElement {
    const found = screen.getByLabelText("Replacement image");
    if (!(found instanceof HTMLInputElement)) throw new Error("not an input");
    return found;
  }
  function choose(file: File): void {
    fireEvent.change(fileInput(), { target: { files: [file] } });
  }

  it.each([
    ["an element that is not an image", { tagName: "p" }],
    ["an image the page generated", { tagName: "img", generated: true }],
  ])("shows nothing for %s", (_label, overrides) => {
    mount(selectElement(overrides));
    expect(screen.queryByRole("region", { name: "Selected image" })).toBeNull();
  });

  it("offers to replace or paste for a selected image", () => {
    mount(selectElement({ tagName: "img" }));
    expect(
      screen.getByRole("region", { name: "Selected image" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Replace image" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Paste image" })).toBeDefined();
  });

  it("only accepts the supported image types in the picker", () => {
    mount(selectElement({ tagName: "img" }));
    expect(fileInput().accept).toBe(
      "image/png,image/jpeg,image/gif,image/webp,image/avif",
    );
  });

  it("uploads the chosen image as a new asset for the selected element", async () => {
    const selection = selectElement({ tagName: "img" });
    mount(selection);
    choose(imageFile("photo.png", "image/png"));
    await waitForSave();

    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.selection).toBe(selection);
    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "write-asset",
      fileName: "photo.png",
      mediaType: "image/png",
      bytesBase64: PNG_BASE64,
      replace: false,
    });
    await settleSave(0, SAVED);
  });

  const waitForSave = flush;

  it.each([
    ["image/png"],
    ["image/jpeg"],
    ["image/gif"],
    ["image/webp"],
    ["image/avif"],
  ])("accepts %s", async (type) => {
    mount(selectElement({ tagName: "img" }));
    choose(imageFile("pic", type));
    await waitForSave();
    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.edit).toMatchObject({ mediaType: type });
  });

  it.each([
    ["an SVG, which can carry script", "image/svg+xml"],
    ["a text file", "text/plain"],
    ["a file with no type", ""],
    ["a PDF", "application/pdf"],
  ])("refuses %s before reading or uploading it", async (_label, type) => {
    const reads = vi.spyOn(FileReader.prototype, "readAsDataURL");
    mount(selectElement({ tagName: "img" }));
    choose(imageFile("file", type));
    await waitForSave();

    expect(pendingSaves).toHaveLength(0);
    expect(reads).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(
      "Choose a PNG, JPEG, GIF, WebP or AVIF image.",
    );
  });

  it("refuses an empty file", async () => {
    mount(selectElement({ tagName: "img" }));
    choose(imageFileOf("empty.png", "image/png", new Uint8Array(0)));
    await waitForSave();
    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("This image is empty.");
  });

  it("refuses an image over 15 MiB before reading it, and takes one of exactly 15 MiB", async () => {
    const reads = vi.spyOn(FileReader.prototype, "readAsDataURL");
    mount(selectElement({ tagName: "img" }));

    const tooBig = imageFile("big.png", "image/png");
    Object.defineProperty(tooBig, "size", {
      value: CANVAS_IMAGE_MAX_BYTES + 1,
    });
    choose(tooBig);
    await waitForSave();
    expect(pendingSaves).toHaveLength(0);
    expect(reads).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(
      "Choose an image smaller than 15 MiB.",
    );

    const exact = imageFile("exact.png", "image/png");
    Object.defineProperty(exact, "size", { value: CANVAS_IMAGE_MAX_BYTES });
    choose(exact);
    await waitForSave();
    expect(pendingSaves).toHaveLength(1);
  });

  it("uploads nothing if the selection moved on while the file was being read", async () => {
    mount(selectElement({ tagName: "img" }));
    choose(imageFile("photo.png", "image/png"));
    act(() => {
      useCanvasSelectionStore.getState().clear();
    });
    await waitForSave();
    expect(pendingSaves).toHaveLength(0);
  });

  it("shows the host's reason when it refuses the upload", async () => {
    mount(selectElement({ tagName: "img" }));
    choose(imageFile("photo.png", "image/png"));
    await waitForSave();
    await settleSave(0, REFUSED);
    expect(screen.getByRole("status").textContent).toBe(
      REFUSED.ok ? "" : REFUSED.detail,
    );
  });

  it("disables the buttons and shows progress while uploading", async () => {
    mount(selectElement({ tagName: "img" }));
    choose(imageFile("photo.png", "image/png"));
    await waitForSave();

    expect(
      screen.getByRole("button", { name: "Replace image" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Paste image" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByTestId("saving-spinner")).toBeDefined();
    await settleSave(0, SAVED);
  });

  it("ignores markup on the clipboard when asked to paste an image", async () => {
    mount(selectElement({ tagName: "img" }));
    clipboard.read.mockResolvedValue([
      readItem({ "text/html": "<p>copied</p>" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Paste image" }));
    await waitForSave();

    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe(
      "Copy an element or image first.",
    );
  });

  it("finds an image on any clipboard item, not only the first", async () => {
    mount(selectElement({ tagName: "img" }));
    clipboard.read.mockResolvedValue([
      readItem({ "text/html": "<p>copied</p>" }),
      readItem({ "image/png": PNG_BYTES }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Paste image" }));
    await waitForSave();

    expect(pendingSaves[0].variables.edit).toMatchObject({
      kind: "write-asset",
      mediaType: "image/png",
    });
  });

  it("pastes an image from the clipboard as a replacement", async () => {
    mount(selectElement({ tagName: "img" }));
    clipboard.read.mockResolvedValue([readItem({ "image/png": PNG_BYTES })]);
    fireEvent.click(screen.getByRole("button", { name: "Paste image" }));
    await waitForSave();

    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "write-asset",
      fileName: "pasted-image.png",
      mediaType: "image/png",
      bytesBase64: PNG_BASE64,
      replace: false,
    });
  });
});

describe("CanvasClipboardBoundary pasting", () => {
  function mount() {
    render(
      <CanvasClipboardBoundary
        artifactId={ARTIFACT_ID}
        registry={registryServing(null, SERVED)}
      >
        <button type="button">board</button>
        <textarea aria-label="Note" />
      </CanvasClipboardBoundary>,
    );
  }
  function paste(
    target: Element,
    data: { readonly files?: File[]; readonly html?: string },
  ): boolean {
    return fireEvent.paste(target, {
      clipboardData: {
        files: data.files ?? [],
        getData: (type: string) =>
          type === "text/html" ? (data.html ?? "") : "",
      },
    });
  }
  const board = (): HTMLElement =>
    screen.getByRole("button", { name: "board" });
  const waitForRead = flush;

  it("replaces the selected image with a pasted image and keeps the browser from pasting it", async () => {
    mount();
    selectElement({ tagName: "img" });
    const notPrevented = paste(board(), {
      files: [imageFile("shot.png", "image/png")],
    });
    await waitForRead();

    expect(notPrevented).toBe(false);
    expect(pendingSaves[0].variables.edit).toMatchObject({
      kind: "write-asset",
      fileName: "shot.png",
      mediaType: "image/png",
      bytesBase64: PNG_BASE64,
    });
  });

  it("says so, and uploads nothing, when an image is pasted with no image selected", async () => {
    mount();
    paste(board(), { files: [imageFile("shot.png", "image/png")] });
    await waitForRead();
    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toContain(
      "Select an image to replace.",
    );
  });

  it("says so when an image is pasted while some other kind of element is selected", async () => {
    mount();
    selectElement({ tagName: "p" });
    paste(board(), { files: [imageFile("shot.png", "image/png")] });
    await waitForRead();
    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toContain(
      "Select an image to replace.",
    );
  });

  it("refuses a pasted file that is not a supported image without uploading it", async () => {
    mount();
    selectElement({ tagName: "img" });
    paste(board(), { files: [imageFile("shot.svg", "image/svg+xml")] });
    await waitForRead();
    expect(pendingSaves).toHaveLength(0);
  });

  it("inserts pasted element markup after the selected element", () => {
    mount();
    selectElement({ tagName: "p" });
    const notPrevented = paste(board(), { html: "<p>copied</p>" });

    expect(notPrevented).toBe(false);
    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "insert-html-after",
      html: "<p>copied</p>",
    });
  });

  it("prefers a pasted image over pasted markup", async () => {
    mount();
    selectElement({ tagName: "img" });
    paste(board(), {
      files: [imageFile("shot.png", "image/png")],
      html: '<img src="x">',
    });
    await waitForRead();
    expect(pendingSaves[0].variables.edit).toMatchObject({
      kind: "write-asset",
    });
    expect(pendingSaves).toHaveLength(1);
  });

  it("asks for an element to paste after when none is selected", () => {
    mount();
    paste(board(), { html: "<p>copied</p>" });
    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toContain(
      "Select an element to paste after.",
    );
  });

  it("refuses markup over 65536 bytes", () => {
    mount();
    selectElement({ tagName: "p" });
    paste(board(), { html: `<p>${"a".repeat(65_536)}</p>` });
    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toContain(
      "This element is too large to paste here.",
    );
  });

  it("counts bytes, not characters, against that limit", () => {
    mount();
    selectElement({ tagName: "p" });
    paste(board(), { html: `<p>${"€".repeat(30_000)}</p>` });
    expect(pendingSaves).toHaveLength(0);
  });

  it("leaves a paste into a text field alone", () => {
    mount();
    selectElement({ tagName: "p" });
    const notPrevented = paste(screen.getByLabelText("Note"), {
      html: "<p>copied</p>",
      files: [imageFile("shot.png", "image/png")],
    });
    expect(notPrevented).toBe(true);
    expect(pendingSaves).toHaveLength(0);
  });

  it("leaves a plain-text paste to the browser", () => {
    mount();
    selectElement({ tagName: "p" });
    expect(paste(board(), {})).toBe(true);
    expect(pendingSaves).toHaveLength(0);
  });

  it("lets the person dismiss a message", () => {
    mount();
    paste(board(), { html: "<p>copied</p>" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("CanvasClipboardMenuItems", () => {
  const SOURCE = `<main><p data-tid="t">Hello <b>big</b></p></main>`;
  const MARKUP = `<p data-tid="t">Hello <b>big</b></p>`;

  function mount(options: {
    readonly selection: CanvasSelection;
    readonly document: CanvasBoardDocument | null;
    readonly outerHtml: string | null | undefined;
  }) {
    const bridge = realBridge();
    const described = vi
      .spyOn(bridge, "describeElement")
      .mockImplementation(() =>
        Promise.resolve(
          options.outerHtml === undefined
            ? options.selection.element
            : { ...options.selection.element, outerHtml: options.outerHtml },
        ),
      );
    const registry = registryServing(bridge, SERVED);
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <CanvasClipboardMenuItems
            selection={options.selection}
            registry={registry}
            document={options.document}
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    return { bridge, described, registry };
  }
  const item = (name: string): HTMLElement =>
    screen.getByRole("menuitem", { name });
  async function written(index: number): Promise<Record<string, string>> {
    const [first] = clipboard.write.mock.calls[index][0];
    const entries = await Promise.all(
      Object.entries(first.parts).map(
        async ([type, blob]) => [type, await blob.text()] as const,
      ),
    );
    return Object.fromEntries(entries);
  }
  const sourceDocument = (sha256: string): CanvasBoardDocument => ({
    ...boardDocument(SOURCE),
    sha256,
  });

  it("copies the markup the page reports, as HTML and as text", async () => {
    mount({
      selection: selectElement({ tid: "t" }),
      document: sourceDocument(SERVED),
      outerHtml: '<p data-tid="t">live</p>',
    });
    fireEvent.click(item("Copy element"));
    await flush();

    expect(clipboard.write).toHaveBeenCalledOnce();
    expect(await written(0)).toEqual({
      "text/html": '<p data-tid="t">live</p>',
      "text/plain": '<p data-tid="t">live</p>',
    });
  });

  it("asks the page for the element by tid, or by marker when it has none", async () => {
    const byTid = mount({
      selection: selectElement({ tid: "t", marker: 5 }),
      document: null,
      outerHtml: MARKUP,
    });
    fireEvent.click(item("Copy element"));
    await flush();
    expect(byTid.described).toHaveBeenCalledWith({ tid: "t" });
    cleanup();

    const byMarker = mount({
      selection: selectElement({ tid: null, marker: 5 }),
      document: null,
      outerHtml: MARKUP,
    });
    fireEvent.click(item("Copy element"));
    await flush();
    expect(byMarker.described).toHaveBeenCalledWith({ marker: 5 });
  });

  it("falls back to the board's source when the page sent no markup", async () => {
    mount({
      selection: selectElement({ tid: "t" }),
      document: sourceDocument(SERVED),
      outerHtml: null,
    });
    fireEvent.click(item("Copy element"));
    await flush();
    expect((await written(0))["text/html"]).toBe(MARKUP);
  });

  it("does not use source that is a different revision from the one shown", async () => {
    mount({
      selection: selectElement({ tid: "t" }),
      document: sourceDocument("sha-older"),
      outerHtml: null,
    });
    fireEvent.click(item("Copy element"));
    await flush();

    expect(clipboard.write).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(
      "This element is too large or unavailable to copy.",
    );
  });

  it("says so when there is no markup and no source", async () => {
    mount({
      selection: selectElement({ tid: "t" }),
      document: null,
      outerHtml: undefined,
    });
    fireEvent.click(item("Copy element"));
    await flush();
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(
      "This element is too large or unavailable to copy.",
    );
  });

  it("copies nothing if the selection moved while the page was answering", async () => {
    const view = mount({
      selection: selectElement({ tid: "t" }),
      document: null,
      outerHtml: MARKUP,
    });
    let answer: (value: CanvasElement | null) => void = () => undefined;
    view.described.mockImplementation(
      () =>
        new Promise<CanvasElement | null>((resolve) => {
          answer = resolve;
        }),
    );
    fireEvent.click(item("Copy element"));
    act(() => {
      useCanvasSelectionStore.getState().clear();
    });
    await act(async () => {
      answer({ ...canvasElement({}), outerHtml: MARKUP });
      await Promise.resolve();
    });
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it("copies nothing if the frame was replaced while the page was answering", async () => {
    const view = mount({
      selection: selectElement({ tid: "t" }),
      document: null,
      outerHtml: MARKUP,
    });
    view.described.mockImplementation(() => {
      view.registry.update(BOARD_PATH, { bridge: realBridge() });
      return Promise.resolve({ ...canvasElement({}), outerHtml: MARKUP });
    });
    fireEvent.click(item("Copy element"));
    await flush();
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it("says so when the browser will not write to the clipboard", async () => {
    clipboard.write.mockRejectedValue(new Error("denied"));
    mount({
      selection: selectElement({ tid: "t" }),
      document: null,
      outerHtml: MARKUP,
    });
    fireEvent.click(item("Copy element"));
    await flush();
    expect(screen.getByRole("status").textContent).toBe(
      "The element could not be copied. Try again.",
    );
  });

  it("will not copy or paste an element the page generated", () => {
    mount({
      selection: selectElement({ marker: null, generated: true }),
      document: null,
      outerHtml: MARKUP,
    });
    expect(item("Copy element").getAttribute("aria-disabled")).toBe("true");
    expect(item("Paste after").getAttribute("aria-disabled")).toBe("true");
  });

  it("pastes clipboard markup after the selected element", async () => {
    mount({
      selection: selectElement({ tid: "t" }),
      document: null,
      outerHtml: MARKUP,
    });
    clipboard.read.mockResolvedValue([
      readItem({ "text/html": "<p>copied</p>" }),
    ]);
    fireEvent.click(item("Paste after"));
    await flush();
    await flush();

    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "insert-html-after",
      html: "<p>copied</p>",
    });
  });

  it("pastes an image as a replacement when the clipboard has one first", async () => {
    mount({
      selection: selectElement({ tagName: "img", tid: "t" }),
      document: null,
      outerHtml: MARKUP,
    });
    clipboard.read.mockResolvedValue([
      readItem({ "image/png": PNG_BYTES, "text/html": "<img>" }),
    ]);
    fireEvent.click(item("Paste after"));
    await flush();

    expect(pendingSaves[0].variables.edit).toMatchObject({
      kind: "write-asset",
      fileName: "pasted-image.png",
      mediaType: "image/png",
    });
  });

  it("says so when the clipboard holds nothing it can use", async () => {
    mount({
      selection: selectElement({ tid: "t" }),
      document: null,
      outerHtml: MARKUP,
    });
    clipboard.read.mockResolvedValue([readItem({ "text/plain": "just text" })]);
    fireEvent.click(item("Paste after"));
    await flush();
    await flush();
    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe(
      "Copy an element or image first.",
    );
  });

  it("points to the keyboard shortcut when the browser will not let the clipboard be read", async () => {
    mount({
      selection: selectElement({ tid: "t" }),
      document: null,
      outerHtml: MARKUP,
    });
    clipboard.read.mockRejectedValue(new Error("denied"));
    fireEvent.click(item("Paste after"));
    await flush();
    expect(screen.getByRole("status").textContent).toBe(
      "The clipboard could not be read. Use the Paste keyboard shortcut.",
    );
  });
  describe("while the clipboard is still being read", () => {
    function deferred<T>() {
      let resolve: (value: T) => void = () => undefined;
      const promise = new Promise<T>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }
    const moveSelection = (): void => {
      act(() => {
        useCanvasSelectionStore
          .getState()
          .select(textSelection(null, { tid: "other", tagName: "img" }));
      });
    };

    it("does not paste markup after an element chosen after Paste was pressed", async () => {
      mount({
        selection: selectElement({ tid: "t" }),
        document: null,
        outerHtml: MARKUP,
      });
      const read = deferred<FakeReadItem[]>();
      clipboard.read.mockReturnValue(read.promise);
      fireEvent.click(item("Paste after"));
      moveSelection();
      read.resolve([readItem({ "text/html": "<p>copied</p>" })]);
      await flush();
      await flush();
      expect(pendingSaves).toHaveLength(0);
    });

    it("does not paste markup after a different element when only the contents are still pending", async () => {
      mount({
        selection: selectElement({ tid: "t" }),
        document: null,
        outerHtml: MARKUP,
      });
      const contents = deferred<Blob>();
      clipboard.read.mockResolvedValue([
        { types: ["text/html"], getType: () => contents.promise },
      ]);
      fireEvent.click(item("Paste after"));
      await flush();
      moveSelection();
      contents.resolve(new Blob(["<p>copied</p>"], { type: "text/html" }));
      await flush();
      expect(pendingSaves).toHaveLength(0);
    });

    it("does not replace the image that is selected now with an image pasted for an earlier selection", async () => {
      mount({
        selection: selectElement({ tid: "t", tagName: "img" }),
        document: null,
        outerHtml: MARKUP,
      });
      const contents = deferred<Blob>();
      clipboard.read.mockResolvedValue([
        { types: ["image/png"], getType: () => contents.promise },
      ]);
      fireEvent.click(item("Paste after"));
      await flush();
      moveSelection();
      contents.resolve(new Blob([PNG_BYTES], { type: "image/png" }));
      await flush();
      expect(pendingSaves).toHaveLength(0);
    });

    it("prefers an image on a later clipboard item over markup on the first", async () => {
      mount({
        selection: selectElement({ tid: "t", tagName: "img" }),
        document: null,
        outerHtml: MARKUP,
      });
      clipboard.read.mockResolvedValue([
        readItem({ "text/html": "<img>" }),
        readItem({ "image/png": PNG_BYTES }),
      ]);
      fireEvent.click(item("Paste after"));
      await flush();
      await flush();

      expect(pendingSaves).toHaveLength(1);
      expect(pendingSaves[0].variables.edit).toMatchObject({
        kind: "write-asset",
        mediaType: "image/png",
      });
    });
  });
});
