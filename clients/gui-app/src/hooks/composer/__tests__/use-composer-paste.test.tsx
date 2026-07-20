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
  isAttachmentIngestPending,
  IMAGE_READ_TIMEOUT_MS,
  FILE_PATH_RESOLUTION_TIMEOUT_MS,
  type ComposerFilePathIngestArgs,
  type UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";
import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

// Default fixture for tests that don't care about file-path resolution at
// all (pure image-ingest coverage): every resolve/copy call comes back
// empty, and inserted paths are discarded.
const NOOP_FILE_PATHS: ComposerFilePathIngestArgs = {
  fileDrops: {
    resolveDroppedFilePaths: () => Promise.resolve([]),
    copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
    readNativeClipboardFilePaths: () => Promise.resolve([]),
  },
  mentionRoots: [],
  beginPathInsertion: () => null,
};

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
    const { result } = renderHook(() =>
      useComposerPasteAdapter(insert, NOOP_FILE_PATHS),
    );

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
    const { result } = renderHook(() =>
      useComposerPasteAdapter(insert, NOOP_FILE_PATHS),
    );

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
    const { result } = renderHook(() =>
      useComposerPasteAdapter(insert, NOOP_FILE_PATHS),
    );

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
      useComposerPasteAdapter(insert, NOOP_FILE_PATHS),
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
      }, NOOP_FILE_PATHS),
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

  // `attachImageFiles` backs the image-only picker button (see
  // `onAttachImages` in chat-composer.tsx), not the shared paste/drop path -
  // it only ever calls the image ingest (`onFiles`), never
  // `attachFilePaths`. A non-image file handed to it is therefore correctly
  // dropped silently rather than turned into a path span; that only happens
  // via `onPaste`/`onDrop`, covered below.
  it("drops non-image files and keeps only images from a mixed list", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { result } = renderHook(() =>
      useComposerPasteAdapter((attrs) => {
        inserted.push([...attrs]);
        return attrs.length;
      }, NOOP_FILE_PATHS),
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
      }, NOOP_FILE_PATHS),
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
      }, NOOP_FILE_PATHS),
    );

    attachImageFiles(result.current, []);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inserted).toHaveLength(0);
  });

  it("returns a stable attachImageFiles reference across renders", () => {
    const onInsert = (_attrs: ReadonlyArray<ImageAttachmentAttrs>): number => 0;
    const { result, rerender } = renderHook(() =>
      useComposerPasteAdapter(onInsert, NOOP_FILE_PATHS),
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
    const { result } = renderHook(() =>
      useComposerPasteAdapter(insert, NOOP_FILE_PATHS),
    );
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
        beginPathInsertion: () => null;
        isReady: () => boolean;
        focus: () => void;
      } | null;
    } = {
      current: {
        insertImageAttachments,
        beginPathInsertion: () => null,
        isReady: () => true,
        focus: vi.fn(),
      },
    };
    const { result } = renderHook(() =>
      useComposerPaste(editorRef, NOOP_FILE_PATHS.fileDrops, []),
    );
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
        beginPathInsertion: () => null,
        isReady: () => false,
        focus: vi.fn(),
      },
    };
    const { result } = renderHook(() =>
      useComposerPaste(editorRef, NOOP_FILE_PATHS.fileDrops, []),
    );

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
    renderHarness(inserted, NOOP_FILE_PATHS);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, {
      clipboardData: makeFileTransfer([png]),
    });

    await waitFor(() => {
      expect(inserted).toHaveLength(1);
    });
    expect(inserted[0][0].fileName).toBe("from-clipboard.png");
  });

  it("ignores clipboard events that contain only non-file items", () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    renderHarness(inserted, NOOP_FILE_PATHS);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, {
      clipboardData: makeStringOnlyTransfer(),
    });

    expect(inserted).toHaveLength(0);
  });

  it("resolves a pasted non-image file to a relativized path span", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: makeFileDrops({ "notes.txt": ["/repo/notes.txt"] }, {}),
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness(inserted, filePaths);
    const txt = new File(["notes"], "notes.txt", { type: "text/plain" });

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, { clipboardData: makeFileTransfer([txt]) });

    await waitFor(() => expect(insertPaths).toHaveBeenCalledOnce());
    expect(insertPaths).toHaveBeenCalledWith(["notes.txt"]);
    expect(inserted).toHaveLength(0);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("mixes a pasted image and non-image file: the image attaches, the file becomes a path, nothing is dropped", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: makeFileDrops({ "doc.pdf": ["/repo/external/doc.pdf"] }, {}),
      mentionRoots: [],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness(inserted, filePaths);
    const png = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const pdf = new File(["pdf-bytes"], "doc.pdf", { type: "application/pdf" });

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, { clipboardData: makeFileTransfer([png, pdf]) });

    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0]).toHaveLength(1);
    expect(inserted[0][0].fileName).toBe("shot.png");
    await waitFor(() => expect(insertPaths).toHaveBeenCalledOnce());
    expect(insertPaths).toHaveBeenCalledWith(["/repo/external/doc.pdf"]);
  });

  it("resolves a pasted folder (empty type/size) the same as a regular file", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: makeFileDrops({ "my-folder": ["/repo/my-folder"] }, {}),
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness(inserted, filePaths);
    const folder = new File([], "my-folder", { type: "" });

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, { clipboardData: makeFileTransfer([folder]) });

    await waitFor(() => expect(insertPaths).toHaveBeenCalledOnce());
    expect(insertPaths).toHaveBeenCalledWith(["my-folder"]);
    expect(inserted).toHaveLength(0);
  });

  it("resolves a URI-only clipboard entry (text/uri-list, no File object) via copyDroppedFilePaths", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: makeFileDrops(
        {},
        // `fileUriToPath` strips the `file://` scheme before this is called,
        // so the fake keys off the resolved filesystem path, not the URI.
        { "/repo/external/report.pdf": ["/tmp/traycer-copy/report.pdf"] },
      ),
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness(inserted, filePaths);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, {
      clipboardData: makeUriListTransfer(["file:///repo/external/report.pdf"]),
    });

    await waitFor(() => expect(insertPaths).toHaveBeenCalledOnce());
    // Outside every mention root (copied to an app-managed temp dir) -> absolute.
    expect(insertPaths).toHaveBeenCalledWith(["/tmp/traycer-copy/report.pdf"]);
    expect(inserted).toHaveLength(0);
  });

  it("keeps the successfully resolved file when a sibling paste fails, and names only the failure in the toast", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const fileDrops: IFileDropHost = {
      resolveDroppedFilePaths: (files) => {
        const file = files.at(0);
        if (file?.name === "ok.txt") return Promise.resolve(["/repo/ok.txt"]);
        return Promise.reject(new Error("resolve failed"));
      },
      copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      readNativeClipboardFilePaths: () => Promise.resolve([]),
    };
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops,
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness(inserted, filePaths);
    const ok = new File(["ok"], "ok.txt", { type: "text/plain" });
    const bad = new File(["bad"], "bad.txt", { type: "text/plain" });

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, { clipboardData: makeFileTransfer([ok, bad]) });

    await waitFor(() => expect(insertPaths).toHaveBeenCalledOnce());
    expect(insertPaths).toHaveBeenCalledWith(["ok.txt"]);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't add 1 file",
        expect.objectContaining({ description: "bad.txt" }),
      );
    });
  });

  it("inserts nothing and shows a generic toast when resolution yields no path (web fallback)", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const filePaths: ComposerFilePathIngestArgs = {
      // Mirrors the non-Electron surface: resolveDroppedFilePaths always [].
      fileDrops: makeFileDrops({}, {}),
      mentionRoots: [],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness(inserted, filePaths);
    const txt = new File(["notes"], "notes.txt", { type: "text/plain" });

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, { clipboardData: makeFileTransfer([txt]) });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't resolve file path",
        expect.objectContaining({
          description:
            "This surface can't read a real file path from the paste.",
        }),
      );
    });
    expect(insertPaths).not.toHaveBeenCalled();
  });

  it("inserts every resolved path from a multi-file paste as a single call", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: makeFileDrops(
        {
          "a.txt": ["/repo/a.txt"],
          "b.txt": ["/repo/nested/b.txt"],
          "c.txt": ["/elsewhere/c.txt"],
        },
        {},
      ),
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness(inserted, filePaths);
    const files = ["a.txt", "b.txt", "c.txt"].map(
      (name) => new File([name], name, { type: "text/plain" }),
    );

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, { clipboardData: makeFileTransfer(files) });

    await waitFor(() => expect(insertPaths).toHaveBeenCalledOnce());
    // Two under the mention root relativize to POSIX paths; the third, outside
    // every root, keeps its absolute form - a single batched insertion call.
    expect(insertPaths).toHaveBeenCalledWith([
      "a.txt",
      "nested/b.txt",
      "/elsewhere/c.txt",
    ]);
  });

  // Finding 5: collect via DataTransfer.files even when .items is empty.
  it("picks up a pasted file from clipboardData.files when items is empty", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: makeFileDrops({ "notes.txt": ["/repo/notes.txt"] }, {}),
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness(inserted, filePaths);
    const txt = new File(["notes"], "notes.txt", { type: "text/plain" });

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, {
      clipboardData: makeFilesOnlyNoItemsTransfer([txt]),
    });

    await waitFor(() => expect(insertPaths).toHaveBeenCalledOnce());
    expect(insertPaths).toHaveBeenCalledWith(["notes.txt"]);
  });

  // Prefer-File: when any real File is present, URI flavors are ignored entirely
  // (terminal rule; no alias correlation).
  it("prefers the File-derived path over its own aliasing uri-list entry and inserts once", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const copyDroppedFilePaths = vi.fn((paths: readonly string[]) =>
      Promise.resolve([...paths]),
    );
    const resolveDroppedFilePaths = vi.fn(() =>
      Promise.resolve(["/repo/notes.txt"]),
    );
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: {
        resolveDroppedFilePaths,
        copyDroppedFilePaths,
        readNativeClipboardFilePaths: () => Promise.resolve([]),
      },
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness(inserted, filePaths);
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, {
      clipboardData: makeFileAndUriListTransfer(file, "file:///repo/notes.txt"),
    });

    await waitFor(() => expect(insertPaths).toHaveBeenCalledOnce());
    expect(insertPaths).toHaveBeenCalledWith(["notes.txt"]);
    expect(resolveDroppedFilePaths).toHaveBeenCalledOnce();
    expect(copyDroppedFilePaths).not.toHaveBeenCalled();
  });

  // Prefer-File + image MIME: image File attaches as image only; URI flavor
  // is ignored (no path resolve/copy for a pure image paste).
  it("keeps image File+file:// as image attachment only (no path span)", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const resolveDroppedFilePaths = vi.fn(() =>
      Promise.resolve(["/repo/shot.png"]),
    );
    const copyDroppedFilePaths = vi.fn((_paths: readonly string[]) =>
      Promise.resolve(["/tmp/traycer-copy/shot-xyz.png"]),
    );
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: {
        resolveDroppedFilePaths,
        copyDroppedFilePaths,
        readNativeClipboardFilePaths: () => Promise.resolve([]),
      },
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness(inserted, filePaths);
    const png = new File(["png-bytes"], "shot.png", { type: "image/png" });

    fireEvent.paste(screen.getByTestId("paste-zone"), {
      clipboardData: makeFileAndUriListTransfer(png, "file:///repo/shot.png"),
    });

    await waitFor(() => {
      expect(inserted).toHaveLength(1);
    });
    expect(inserted[0]).toHaveLength(1);
    expect(inserted[0][0].fileName).toBe("shot.png");
    expect(insertPaths).not.toHaveBeenCalled();
    // Pure image paste never starts path resolution; prefer-File also
    // suppresses URI materialization.
    expect(resolveDroppedFilePaths).not.toHaveBeenCalled();
    expect(copyDroppedFilePaths).not.toHaveBeenCalled();
  });
});

describe("useComposerPasteAdapter - isResolvingFilePaths / attachment pending", () => {
  // Finding 3: pure-path resolution must gate submit via isResolvingFilePaths.
  it("reports isResolvingFilePaths while a non-image file path is still resolving", async () => {
    let resolvePaths: ((paths: readonly string[]) => void) | null = null;
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: {
        resolveDroppedFilePaths: () =>
          new Promise((resolve) => {
            resolvePaths = resolve;
          }),
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
        readNativeClipboardFilePaths: () => Promise.resolve([]),
      },
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    render(<PasteStateHarness inserted={inserted} filePaths={filePaths} />);

    const txt = new File(["notes"], "notes.txt", { type: "text/plain" });
    fireEvent.paste(screen.getByTestId("paste-zone"), {
      clipboardData: makeFileTransfer([txt]),
    });

    const zone = screen.getByTestId("paste-zone");
    expect(zone.getAttribute("data-resolving")).toBe("true");
    expect(
      isAttachmentIngestPending({
        isIngestingImages: zone.getAttribute("data-ingesting") === "true",
        isResolvingFilePaths: zone.getAttribute("data-resolving") === "true",
      }),
    ).toBe(true);
    expect(insertPaths).not.toHaveBeenCalled();
    expect(zone.getAttribute("data-ingesting")).toBe("false");
    expect(zone.getAttribute("data-resolving")).toBe("true");
    expect(
      isAttachmentIngestPending({
        isIngestingImages: false,
        isResolvingFilePaths: true,
      }),
    ).toBe(true);

    await act(async () => {
      resolvePaths?.(["/repo/notes.txt"]);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(zone.getAttribute("data-resolving")).toBe("false");
    });
    expect(
      isAttachmentIngestPending({
        isIngestingImages: zone.getAttribute("data-ingesting") === "true",
        isResolvingFilePaths: zone.getAttribute("data-resolving") === "true",
      }),
    ).toBe(false);
    expect(insertPaths).toHaveBeenCalledWith(["notes.txt"]);
  });

  // Round-2 finding 5: a stalled `fileDrops` call must not permanently gate
  // submit or leak the resolution - `withResolutionTimeout` races it and
  // falls back to `[]` (treated the same as any other unresolved failure).
  it("clears isResolvingFilePaths and reports the standard failure once a stalled resolveDroppedFilePaths call times out", async () => {
    vi.useFakeTimers();
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: {
        resolveDroppedFilePaths: () => new Promise(() => undefined),
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
        readNativeClipboardFilePaths: () => Promise.resolve([]),
      },
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    const inserted: ImageAttachmentAttrs[][] = [];
    render(<PasteStateHarness inserted={inserted} filePaths={filePaths} />);

    const stuck = new File(["stuck"], "stuck.txt", { type: "text/plain" });
    fireEvent.paste(screen.getByTestId("paste-zone"), {
      clipboardData: makeFileTransfer([stuck]),
    });

    const zone = screen.getByTestId("paste-zone");
    expect(zone.getAttribute("data-resolving")).toBe("true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        FILE_PATH_RESOLUTION_TIMEOUT_MS + 5_000,
      );
    });

    expect(zone.getAttribute("data-resolving")).toBe("false");
    expect(insertPaths).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't resolve file path",
      expect.objectContaining({
        description: "This surface can't read a real file path from the paste.",
      }),
    );
  });

  it("isAttachmentIngestPending is true for either pipeline independently", () => {
    expect(
      isAttachmentIngestPending({
        isIngestingImages: true,
        isResolvingFilePaths: false,
      }),
    ).toBe(true);
    expect(
      isAttachmentIngestPending({
        isIngestingImages: false,
        isResolvingFilePaths: true,
      }),
    ).toBe(true);
    expect(
      isAttachmentIngestPending({
        isIngestingImages: false,
        isResolvingFilePaths: false,
      }),
    ).toBe(false);
  });
});

describe("useComposerPasteAdapter - drag-and-drop", () => {
  it("ignores drop events that don't carry files", () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    renderHarness(inserted, NOOP_FILE_PATHS);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.drop(zone, {
      dataTransfer: makeEmptyTransfer(["text/plain"]),
    });

    expect(inserted).toHaveLength(0);
  });

  it("inserts a dropped image and turns the accompanying non-image file into a path span", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: makeFileDrops({ "doc.pdf": ["/repo/doc.pdf"] }, {}),
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness(inserted, filePaths);

    const png = new File(["dropped"], "drop.png", { type: "image/png" });
    const pdf = new File(["pdf"], "doc.pdf", { type: "application/pdf" });
    const zone = screen.getByTestId("paste-zone");
    fireEvent.drop(zone, {
      dataTransfer: makeFileTransfer([png, pdf]),
    });

    await waitFor(() => {
      expect(inserted).toHaveLength(1);
    });
    expect(inserted[0]).toHaveLength(1);
    expect(inserted[0][0].fileName).toBe("drop.png");
    await waitFor(() => expect(insertPaths).toHaveBeenCalledOnce());
    expect(insertPaths).toHaveBeenCalledWith(["doc.pdf"]);
  });

  it("resolves a dropped folder (empty type/size) the same as a regular file", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: makeFileDrops(
        { "dropped-folder": ["/repo/dropped-folder"] },
        {},
      ),
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness(inserted, filePaths);
    const folder = new File([], "dropped-folder", { type: "" });

    const zone = screen.getByTestId("paste-zone");
    fireEvent.drop(zone, { dataTransfer: makeFileTransfer([folder]) });

    await waitFor(() => expect(insertPaths).toHaveBeenCalledOnce());
    expect(insertPaths).toHaveBeenCalledWith(["dropped-folder"]);
  });

  it("copies an ephemeral URI-only drop (public.file-url, no File object) to a durable path", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: makeFileDrops(
        {},
        {
          "/var/folders/x/TemporaryItems/screencaptureui_1/Screenshot.png": [
            "/tmp/traycer-copy/screenshot.png",
          ],
        },
      ),
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness(inserted, filePaths);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.drop(zone, {
      dataTransfer: makePublicFileUrlTransfer(
        "file:///var/folders/x/TemporaryItems/screencaptureui_1/Screenshot.png",
      ),
    });

    await waitFor(() => expect(insertPaths).toHaveBeenCalledOnce());
    expect(insertPaths).toHaveBeenCalledWith([
      "/tmp/traycer-copy/screenshot.png",
    ]);
    expect(inserted).toHaveLength(0);
  });

  it("tracks drag depth so the zone stays active across nested enters/leaves", () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    renderHarness(inserted, NOOP_FILE_PATHS);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.dragEnter(zone, {
      dataTransfer: makeEmptyTransfer(["Files"]),
    });
    expect(zone.getAttribute("data-dragging")).toBe("true");
    expect(zone.getAttribute("data-drag-variant")).toBe("paths");

    fireEvent.dragEnter(zone, {
      dataTransfer: makeEmptyTransfer(["Files"]),
    });
    fireEvent.dragLeave(zone, {
      dataTransfer: makeEmptyTransfer(["Files"]),
    });
    expect(zone.getAttribute("data-dragging")).toBe("true");

    fireEvent.dragLeave(zone, {
      dataTransfer: makeEmptyTransfer(["Files"]),
    });
    expect(zone.getAttribute("data-dragging")).toBe("false");
  });

  it("refreshes the drag overlay variant from metadata on enter and over", () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    renderHarness(inserted, NOOP_FILE_PATHS);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.dragEnter(zone, {
      dataTransfer: makeDragMetadataTransfer("application/pdf"),
    });
    expect(zone.getAttribute("data-drag-variant")).toBe("paths");

    fireEvent.dragOver(zone, {
      dataTransfer: makeDragMetadataTransfer("image/png"),
    });
    expect(zone.getAttribute("data-drag-variant")).toBe("images");
  });

  it("does not raise drag depth for non-file drags", () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    renderHarness(inserted, NOOP_FILE_PATHS);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.dragEnter(zone, {
      dataTransfer: makeEmptyTransfer(["text/plain"]),
    });
    expect(zone.getAttribute("data-dragging")).toBe("false");
  });

  it("does not claim a non-file drag leave", () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    renderHarness(inserted, NOOP_FILE_PATHS);

    const zone = screen.getByTestId("paste-zone");
    expect(
      fireEvent.dragLeave(zone, {
        dataTransfer: makeEmptyTransfer(["text/plain"]),
      }),
    ).toBe(true);
  });

  // Round-3: drag-enter can only see type names, so an ordinary HTTPS URI
  // lights the overlay; drop must clear it and refuse both resolvers.
  it("clears the drag overlay on an https uri-list drop without calling either resolver", async () => {
    const resolveDroppedFilePaths = vi.fn(() => Promise.resolve([]));
    const copyDroppedFilePaths = vi.fn((paths: readonly string[]) =>
      Promise.resolve([...paths]),
    );
    const insertPaths = vi.fn((_paths: ReadonlyArray<string>) => undefined);
    const filePaths: ComposerFilePathIngestArgs = {
      fileDrops: {
        resolveDroppedFilePaths,
        copyDroppedFilePaths,
        readNativeClipboardFilePaths: () => Promise.resolve([]),
      },
      mentionRoots: ["/repo"],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) insertPaths(paths);
        return true;
      },
    };
    renderHarness([], filePaths);
    const zone = screen.getByTestId("paste-zone");

    fireEvent.dragEnter(zone, {
      dataTransfer: makeEmptyTransfer(["text/uri-list"]),
    });
    expect(zone.getAttribute("data-dragging")).toBe("true");

    fireEvent.drop(zone, {
      dataTransfer: makeUriListTransfer(["https://example.com/doc"]),
    });

    expect(zone.getAttribute("data-dragging")).toBe("false");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resolveDroppedFilePaths).not.toHaveBeenCalled();
    expect(copyDroppedFilePaths).not.toHaveBeenCalled();
    expect(insertPaths).not.toHaveBeenCalled();
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

function renderHarness(
  inserted: ImageAttachmentAttrs[][],
  filePaths: ComposerFilePathIngestArgs,
) {
  return render(<PasteHarness inserted={inserted} filePaths={filePaths} />);
}

function PasteHarness(props: {
  readonly inserted: ImageAttachmentAttrs[][];
  readonly filePaths: ComposerFilePathIngestArgs;
}) {
  const handlers = useComposerPasteAdapter((attrs) => {
    props.inserted.push([...attrs]);
    return attrs.length;
  }, props.filePaths);
  return (
    <div
      data-testid="paste-zone"
      data-dragging={handlers.isDraggingFiles ? "true" : "false"}
      data-drag-variant={handlers.dragOverlayVariant ?? ""}
      onPaste={handlers.onPaste}
      onDrop={handlers.onDrop}
      onDragOver={handlers.onDragOver}
      onDragEnter={handlers.onDragEnter}
      onDragLeave={handlers.onDragLeave}
    />
  );
}

/** Like PasteHarness, but surfaces pending flags as data-attrs for assertions. */
function PasteStateHarness({
  inserted,
  filePaths,
}: {
  readonly inserted: ImageAttachmentAttrs[][];
  readonly filePaths: ComposerFilePathIngestArgs;
}) {
  const handlers = useComposerPasteAdapter((attrs) => {
    inserted.push([...attrs]);
    return attrs.length;
  }, filePaths);
  return (
    <div
      data-testid="paste-zone"
      data-dragging={handlers.isDraggingFiles ? "true" : "false"}
      data-ingesting={handlers.isIngestingImages ? "true" : "false"}
      data-resolving={handlers.isResolvingFilePaths ? "true" : "false"}
      onPaste={handlers.onPaste}
      onDrop={handlers.onDrop}
      onDragOver={handlers.onDragOver}
      onDragEnter={handlers.onDragEnter}
      onDragLeave={handlers.onDragLeave}
    />
  );
}

/**
 * A fake `IFileDropHost` that resolves per single-file / single-url calls
 * (mirroring how `resolveFileToPath`/`resolveUrlPathToPath` invoke it) by
 * looking up the file name / url in the given maps. A name/url absent from
 * its map resolves to `[]` (matches the real "couldn't resolve" contract).
 */
function makeFileDrops(
  resolveByFileName: Readonly<Record<string, readonly string[]>>,
  copyByUrlPath: Readonly<Record<string, readonly string[]>>,
): IFileDropHost {
  return {
    resolveDroppedFilePaths: (files) => {
      const file = files.at(0);
      if (file === undefined) return Promise.resolve([]);
      return Promise.resolve(resolveByFileName[file.name] ?? []);
    },
    copyDroppedFilePaths: (paths) => {
      const urlPath = paths.at(0);
      if (urlPath === undefined) return Promise.resolve([]);
      return Promise.resolve(copyByUrlPath[urlPath] ?? []);
    },
    readNativeClipboardFilePaths: () => Promise.resolve([]),
  };
}

interface FileTransferLike {
  readonly files: ReadonlyArray<File>;
  readonly types: ReadonlyArray<string>;
  readonly items: ReadonlyArray<{
    readonly kind: string;
    readonly type: string;
    getAsFile: () => File | null;
  }>;
  getData: (type: string) => string;
}

function makeFileTransfer(files: ReadonlyArray<File>): FileTransferLike {
  return {
    files,
    types: files.length > 0 ? ["Files"] : [],
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    })),
    getData: () => "",
  };
}

function makeUriListTransfer(uris: ReadonlyArray<string>): FileTransferLike {
  return {
    files: [],
    types: ["text/uri-list"],
    items: [],
    getData: (type) => (type === "text/uri-list" ? uris.join("\n") : ""),
  };
}

function makePublicFileUrlTransfer(url: string): FileTransferLike {
  return {
    files: [],
    types: ["public.file-url"],
    items: [],
    getData: (type) => (type === "public.file-url" ? url : ""),
  };
}

function makeStringOnlyTransfer(): FileTransferLike {
  return {
    files: [],
    types: [],
    items: [
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "string", type: "text/plain", getAsFile: () => null },
    ],
    getData: () => "",
  };
}

function makeEmptyTransfer(types: ReadonlyArray<string>): FileTransferLike {
  return { files: [], types, items: [], getData: () => "" };
}

function makeDragMetadataTransfer(type: string): FileTransferLike {
  return {
    files: [],
    types: ["Files"],
    items: [{ kind: "file", type, getAsFile: () => null }],
    getData: () => "",
  };
}

/** Files list populated, items empty - exercises collectDroppedFiles' files-first path. */
function makeFilesOnlyNoItemsTransfer(
  files: ReadonlyArray<File>,
): FileTransferLike {
  return {
    files,
    types: files.length > 0 ? ["Files"] : [],
    items: [],
    getData: () => "",
  };
}

/** File object + uri-list + public.file-url for the same source (finding 8). */
function makeFileAndUriListTransfer(file: File, uri: string): FileTransferLike {
  return {
    files: [file],
    types: ["Files", "text/uri-list", "public.file-url"],
    items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    getData: (type) => {
      if (type === "text/uri-list" || type === "public.file-url") return uri;
      return "";
    },
  };
}

function makeOversizedImage(name: string): File {
  const file = new File(["x"], name, { type: "image/png" });
  Object.defineProperty(file, "size", { value: 10 * 1024 * 1024 });
  return file;
}
