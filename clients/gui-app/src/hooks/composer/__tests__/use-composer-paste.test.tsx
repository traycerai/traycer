import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import {
  useComposerPaste,
  useComposerPasteAdapter,
  IMAGE_READ_TIMEOUT_MS,
  type UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";
import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.mocked(toast.error).mockClear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useComposerPasteAdapter - attachImageFiles", () => {
  it("exposes ingestion as pending until the FileReader settles", async () => {
    const delayedReader = installDelayedFileReader();
    const insert = vi.fn(
      (_attrs: ReadonlyArray<ImageAttachmentAttrs>): number => 1,
    );
    const { result } = renderHook(() => useComposerPasteAdapter(insert));

    attachImageFiles(result.current, [
      new File(["pending"], "pending.png", { type: "image/png" }),
    ]);

    expect(result.current.isIngestingImages).toBe(true);
    expect(insert).not.toHaveBeenCalled();
    delayedReader.resolveNext("data:image/png;base64,cGVuZGluZw==");
    await waitFor(() => {
      expect(result.current.isIngestingImages).toBe(false);
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("releases the gate and reports a FileReader rejection", async () => {
    const delayedReader = installDelayedFileReader();
    const insert = vi.fn(
      (_attrs: ReadonlyArray<ImageAttachmentAttrs>): number => 1,
    );
    const { result } = renderHook(() => useComposerPasteAdapter(insert));

    attachImageFiles(result.current, [
      new File(["broken"], "broken.png", { type: "image/png" }),
    ]);
    delayedReader.rejectNext();

    await waitFor(() => {
      expect(result.current.isIngestingImages).toBe(false);
    });
    expect(insert).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't attach the image.",
      expect.objectContaining({ description: "Please try adding it again." }),
    );
  });

  it("times out a non-settling FileReader and releases the gate", async () => {
    vi.useFakeTimers();
    installDelayedFileReader();
    const insert = vi.fn(
      (_attrs: ReadonlyArray<ImageAttachmentAttrs>): number => 1,
    );
    const { result } = renderHook(() => useComposerPasteAdapter(insert));

    attachImageFiles(result.current, [
      new File(["stuck"], "stuck.png", { type: "image/png" }),
    ]);
    expect(result.current.isIngestingImages).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IMAGE_READ_TIMEOUT_MS);
    });

    expect(result.current.isIngestingImages).toBe(false);
    expect(insert).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't attach the image.",
      expect.objectContaining({ description: "Please try adding it again." }),
    );
  });

  it("aborts an in-flight FileReader on unmount without showing a toast", async () => {
    installDelayedFileReader();
    const abort = vi
      .spyOn(FileReader.prototype, "abort")
      .mockImplementation(() => undefined);
    const insert = vi.fn(
      (_attrs: ReadonlyArray<ImageAttachmentAttrs>): number => 1,
    );
    const { result, unmount } = renderHook(() =>
      useComposerPasteAdapter(insert),
    );

    attachImageFiles(result.current, [
      new File(["pending"], "pending.png", { type: "image/png" }),
    ]);
    expect(result.current.isIngestingImages).toBe(true);
    unmount();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("converts picker-selected image files into image attachment attrs", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { result } = renderHook(() =>
      useComposerPasteAdapter((attrs) => {
        inserted.push([...attrs]);
        return attrs.length;
      }),
    );
    const imageFile = new File(["hello"], "sample.png", {
      type: "image/png",
    });

    attachImageFiles(result.current, [imageFile]);

    await waitFor(() => {
      expect(inserted).toHaveLength(1);
    });

    const attrs = inserted[0];
    expect(attrs).toBeDefined();
    const image = attrs[0];
    expect(image).toBeDefined();
    expect(image.id.length).toBeGreaterThan(0);
    expect(image.fileName).toBe("sample.png");
    expect(image.b64content).toBe("aGVsbG8=");
    expect(image.mimeType).toBe("image/png");
    expect(image.size).toBe(5);
  });

  it("drops non-image files and keeps only images from a mixed list", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { result } = renderHook(() =>
      useComposerPasteAdapter((attrs) => {
        inserted.push([...attrs]);
        return attrs.length;
      }),
    );
    const png = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const pdf = new File(["pdf-bytes"], "doc.pdf", { type: "application/pdf" });

    attachImageFiles(result.current, [png, pdf]);

    await waitFor(() => {
      expect(inserted).toHaveLength(1);
    });
    const attrs = inserted[0];
    expect(attrs).toHaveLength(1);
    expect(attrs[0].fileName).toBe("shot.png");
    expect(attrs[0].mimeType).toBe("image/png");
  });

  it("rejects oversized images via a toast and does not insert them", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { result } = renderHook(() =>
      useComposerPasteAdapter((attrs) => {
        inserted.push([...attrs]);
        return attrs.length;
      }),
    );
    const oversized = makeOversizedImage("big.png");

    attachImageFiles(result.current, [oversized]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inserted).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledTimes(1);
    const call = vi.mocked(toast.error).mock.calls[0];
    expect(call[0]).toBe("Image too large");
    const opts = call[1];
    if (
      typeof opts !== "object" ||
      !("description" in opts) ||
      typeof opts.description !== "string"
    ) {
      throw new Error("expected toast options with description string");
    }
    expect(opts.description).toContain("5MB");
  });

  it("does not insert when the file list is empty", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { result } = renderHook(() =>
      useComposerPasteAdapter((attrs) => {
        inserted.push([...attrs]);
        return attrs.length;
      }),
    );

    attachImageFiles(result.current, []);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inserted).toHaveLength(0);
  });

  it("returns a stable attachImageFiles reference across renders", () => {
    const onInsert = (_attrs: ReadonlyArray<ImageAttachmentAttrs>): number => 0;
    const { result, rerender } = renderHook(() =>
      useComposerPasteAdapter(onInsert),
    );
    const first = result.current.attachImageFiles;
    rerender();
    expect(result.current.attachImageFiles).toBe(first);
  });

  it("does not report an attachment when the live editor rejects insertion", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const insert = vi.fn(
      (_attrs: ReadonlyArray<ImageAttachmentAttrs>): number => 0,
    );
    const { result } = renderHook(() => useComposerPasteAdapter(insert));
    const imageFile = new File(["hello"], "sample.png", {
      type: "image/png",
    });

    attachImageFiles(result.current, [imageFile]);

    await waitFor(() => expect(insert).toHaveBeenCalledOnce());
    expect(track).not.toHaveBeenCalledWith(
      AnalyticsEvent.AttachmentAdded,
      expect.anything(),
    );
  });

  it("does not report an attachment when the editor ref disappears during conversion", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const insertImageAttachments = vi.fn();
    const editorRef: {
      current: {
        insertImageAttachments: typeof insertImageAttachments;
        isReady: () => boolean;
        focus: () => void;
      } | null;
    } = {
      current: { insertImageAttachments, isReady: () => true, focus: vi.fn() },
    };
    const { result } = renderHook(() => useComposerPaste(editorRef));
    const imageFile = new File(["hello"], "sample.png", {
      type: "image/png",
    });

    attachImageFiles(result.current, [imageFile]);
    editorRef.current = null;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(insertImageAttachments).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalledWith(
      AnalyticsEvent.AttachmentAdded,
      expect.anything(),
    );
  });

  it("does not report an attachment when a non-null editor is not ready", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const insertImageAttachments = vi.fn();
    const editorRef = {
      current: {
        insertImageAttachments,
        isReady: () => false,
        focus: vi.fn(),
      },
    };
    const { result } = renderHook(() => useComposerPaste(editorRef));

    attachImageFiles(result.current, [
      new File(["hello"], "sample.png", { type: "image/png" }),
    ]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(insertImageAttachments).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalledWith(
      AnalyticsEvent.AttachmentAdded,
      expect.anything(),
    );
  });
});

describe("useComposerPasteAdapter - onPaste", () => {
  it("collects image files from the clipboard and inserts them", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const png = new File(["pasted"], "from-clipboard.png", {
      type: "image/png",
    });
    renderHarness(inserted);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, {
      clipboardData: makeClipboardData([{ kind: "file", file: png }]),
    });

    await waitFor(() => {
      expect(inserted).toHaveLength(1);
    });
    expect(inserted[0][0].fileName).toBe("from-clipboard.png");
  });

  it("ignores clipboard events that contain only non-file items", () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    renderHarness(inserted);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, {
      clipboardData: makeClipboardData([
        { kind: "string", file: null },
        { kind: "string", file: null },
      ]),
    });

    expect(inserted).toHaveLength(0);
  });
});

describe("useComposerPasteAdapter - drag-and-drop", () => {
  it("ignores drop events that don't carry files", () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    renderHarness(inserted);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.drop(zone, {
      dataTransfer: makeDataTransfer([], ["text/plain"]),
    });

    expect(inserted).toHaveLength(0);
  });

  it("inserts dropped image files and filters out non-images", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    renderHarness(inserted);

    const png = new File(["dropped"], "drop.png", { type: "image/png" });
    const pdf = new File(["pdf"], "doc.pdf", { type: "application/pdf" });
    const zone = screen.getByTestId("paste-zone");
    fireEvent.drop(zone, {
      dataTransfer: makeDataTransfer([png, pdf], ["Files"]),
    });

    await waitFor(() => {
      expect(inserted).toHaveLength(1);
    });
    expect(inserted[0]).toHaveLength(1);
    expect(inserted[0][0].fileName).toBe("drop.png");
  });

  it("tracks drag depth so the zone stays active across nested enters/leaves", () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    renderHarness(inserted);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.dragEnter(zone, {
      dataTransfer: makeDataTransfer([], ["Files"]),
    });
    expect(zone.getAttribute("data-dragging")).toBe("true");

    fireEvent.dragEnter(zone, {
      dataTransfer: makeDataTransfer([], ["Files"]),
    });
    fireEvent.dragLeave(zone, {
      dataTransfer: makeDataTransfer([], ["Files"]),
    });
    expect(zone.getAttribute("data-dragging")).toBe("true");

    fireEvent.dragLeave(zone, {
      dataTransfer: makeDataTransfer([], ["Files"]),
    });
    expect(zone.getAttribute("data-dragging")).toBe("false");
  });

  it("does not raise drag depth for non-file drags", () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    renderHarness(inserted);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.dragEnter(zone, {
      dataTransfer: makeDataTransfer([], ["text/plain"]),
    });
    expect(zone.getAttribute("data-dragging")).toBe("false");
  });
});

function attachImageFiles(
  result: UseComposerPasteResult,
  files: ReadonlyArray<File>,
): void {
  act(() => {
    result.attachImageFiles(files);
  });
}

interface DelayedFileReaderControl {
  readonly resolveNext: (dataUrl: string) => void;
  readonly rejectNext: () => void;
}

function installDelayedFileReader(): DelayedFileReaderControl {
  const pending: FileReader[] = [];
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (
    this: FileReader,
    _blob: Blob,
  ) {
    pending.push(this);
  });
  return {
    resolveNext: (dataUrl) => {
      const reader = pending.shift();
      if (reader === undefined) throw new Error("expected pending file read");
      Object.defineProperty(reader, "result", {
        configurable: true,
        value: dataUrl,
      });
      reader.dispatchEvent(new ProgressEvent("load"));
    },
    rejectNext: () => {
      const reader = pending.shift();
      if (reader === undefined) throw new Error("expected pending file read");
      reader.dispatchEvent(new ProgressEvent("error"));
    },
  };
}

function renderHarness(inserted: ImageAttachmentAttrs[][]) {
  return render(<PasteHarness inserted={inserted} />);
}

function PasteHarness(props: { readonly inserted: ImageAttachmentAttrs[][] }) {
  const handlers = useComposerPasteAdapter((attrs) => {
    props.inserted.push([...attrs]);
    return attrs.length;
  });
  return (
    <div
      data-testid="paste-zone"
      data-dragging={handlers.isDraggingFiles ? "true" : "false"}
      onPaste={handlers.onPaste}
      onDrop={handlers.onDrop}
      onDragOver={handlers.onDragOver}
      onDragEnter={handlers.onDragEnter}
      onDragLeave={handlers.onDragLeave}
    />
  );
}

interface ClipboardItemSpec {
  readonly kind: "file" | "string";
  readonly file: File | null;
}

function makeClipboardData(specs: ReadonlyArray<ClipboardItemSpec>) {
  const items = specs.map((spec) => ({
    kind: spec.kind,
    getAsFile: (): File | null => spec.file,
  }));
  return {
    items: Object.assign(items, { length: items.length }),
    files: [],
    types: [],
  };
}

function makeDataTransfer(
  files: ReadonlyArray<File>,
  types: ReadonlyArray<string>,
) {
  return { files, types, items: [] };
}

function makeOversizedImage(name: string): File {
  const file = new File(["x"], name, { type: "image/png" });
  Object.defineProperty(file, "size", { value: 10 * 1024 * 1024 });
  return file;
}
