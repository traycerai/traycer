import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";
import type { ComposerPasteEditorHandle } from "@/hooks/composer/use-composer-paste";
import { useLandingComposerPaste } from "@/hooks/composer/use-landing-composer-paste";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  deleteImage,
  getImageBytes,
  imageHashKeys,
  releaseSession,
  sessionObjectUrl,
} from "@/lib/composer/landing-image-store";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";

vi.mock("@/lib/composer/landing-image-gc", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/composer/landing-image-gc")>();
  return {
    ...actual,
    // A no-op stub, not a call-through: the real scheduler starts a 250ms
    // timer that later calls the real `reconcile()`, which would otherwise
    // escape this test's boundary and run against a later test's IDB mock
    // state. Only call presence is asserted here.
    scheduleLandingImageReconcile: vi.fn(() => undefined),
  };
});

// In-memory stand-in for idb-keyval so `putImage` can persist + read back bytes
// without a real IndexedDB. Mirrors the landing-image-store unit test.
vi.mock("idb-keyval", () => {
  const data = new Map<string, unknown>();
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: string) => Promise.resolve(data.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string) => {
      data.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(data.keys()))),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

let urlCounter = 0;

beforeEach(async () => {
  URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
  URL.revokeObjectURL = vi.fn();
  const hashes = await imageHashKeys();
  await Promise.all(
    hashes.map(async (hash) => {
      await deleteImage(hash);
      releaseSession(hash);
    }),
  );
  vi.mocked(toast.error).mockClear();
  vi.mocked(scheduleLandingImageReconcile).mockClear();
});

afterEach(() => {
  cleanup();
});

// Default fixture for tests that don't care about file-path resolution at
// all (pure image-ingest coverage): every resolve/copy call comes back
// empty, and path spans are discarded.
const NOOP_FILE_DROPS: IFileDropHost = {
  resolveDroppedFilePaths: () => Promise.resolve([]),
  copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
  readNativeClipboardFilePaths: () => Promise.resolve([]),
};
const NO_MENTION_ROOTS: ReadonlyArray<string> = [];

function makeHandle(
  inserted: ImageAttachmentAttrs[][],
  insertedPaths: ReadonlyArray<string>[],
): {
  readonly handle: ComposerPasteEditorHandle;
  readonly focusCalls: { count: number };
} {
  const focusCalls = { count: 0 };
  const handle: ComposerPasteEditorHandle = {
    isReady: () => true,
    insertImageAttachments: (attrs) => inserted.push([...attrs]),
    // Paths commit independently of image insertion (A1: mixed may be 2 undo steps).
    beginPathInsertion: () => (paths) => {
      if (paths.length > 0) {
        insertedPaths.push([...paths]);
        focusCalls.count += 1;
      }
      return true;
    },
    focus: () => {
      focusCalls.count += 1;
    },
  };
  return { handle, focusCalls };
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
    getAsFile: () => File | null;
  }>;
  getData: (type: string) => string;
}

function makeFileTransfer(files: ReadonlyArray<File>): FileTransferLike {
  return {
    files,
    types: files.length > 0 ? ["Files"] : [],
    items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
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

function renderLandingHarness(
  editorRef: { current: ComposerPasteEditorHandle | null },
  fileDrops: IFileDropHost,
  mentionRoots: ReadonlyArray<string>,
) {
  return render(
    <LandingPasteHarness
      editorRef={editorRef}
      fileDrops={fileDrops}
      mentionRoots={mentionRoots}
    />,
  );
}

function LandingPasteHarness(props: {
  readonly editorRef: { current: ComposerPasteEditorHandle | null };
  readonly fileDrops: IFileDropHost;
  readonly mentionRoots: ReadonlyArray<string>;
}) {
  const handlers = useLandingComposerPaste(
    props.editorRef,
    props.fileDrops,
    props.mentionRoots,
  );
  return (
    <div
      data-testid="paste-zone"
      onPaste={handlers.onPaste}
      onDrop={handlers.onDrop}
      onDragOver={handlers.onDragOver}
      onDragEnter={handlers.onDragEnter}
      onDragLeave={handlers.onDragLeave}
    />
  );
}

describe("useLandingComposerPaste", () => {
  it("does not report an attachment when a non-null editor is not ready", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const editorRef = {
      current: {
        isReady: () => false,
        insertImageAttachments: (attrs: ReadonlyArray<ImageAttachmentAttrs>) =>
          inserted.push([...attrs]),
        beginPathInsertion: () => null,
        focus: () => undefined,
      },
    };
    const { result } = renderHook(() =>
      useLandingComposerPaste(editorRef, NOOP_FILE_DROPS, NO_MENTION_ROOTS),
    );

    act(() => {
      result.current.attachImageFiles([
        new File(["hello"], "not-ready.png", { type: "image/png" }),
      ]);
    });
    await waitFor(async () => {
      expect(await imageHashKeys()).toHaveLength(1);
    });

    expect(inserted).toEqual([]);
    expect(track).not.toHaveBeenCalledWith(
      AnalyticsEvent.AttachmentAdded,
      expect.anything(),
    );
  });

  it("ingests an image as a hash-only node with bytes + a session object-URL", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle, focusCalls } = makeHandle(inserted, []);
    const editorRef = { current: handle };
    const { result } = renderHook(() =>
      useLandingComposerPaste(editorRef, NOOP_FILE_DROPS, NO_MENTION_ROOTS),
    );

    const file = new File(["hello"], "shot.png", { type: "image/png" });
    act(() => {
      result.current.attachImageFiles([file]);
    });

    await waitFor(() => {
      expect(inserted).toHaveLength(1);
    });

    const attrs = inserted[0][0];
    expect(attrs.fileName).toBe("shot.png");
    expect(attrs.mimeType).toBe("image/png");
    expect(attrs.size).toBe(5);
    // Hash-only: a content hash, never inline base64.
    expect(attrs.b64content).toBeUndefined();
    const hash = attrs.hash;
    if (hash === undefined) throw new Error("expected a hash-only node");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Bytes are persisted + reachable, and a synchronous object-URL exists so the
    // chip renders instantly (no placeholder frame).
    expect(await getImageBytes(hash)).toEqual(
      new Uint8Array([104, 101, 108, 108, 111]),
    );
    expect(sessionObjectUrl(hash)).not.toBeNull();
    expect(focusCalls.count).toBe(1);
  });

  it("dedupes identical bytes to a single hash across two pastes", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle } = makeHandle(inserted, []);
    const editorRef = { current: handle };
    const { result } = renderHook(() =>
      useLandingComposerPaste(editorRef, NOOP_FILE_DROPS, NO_MENTION_ROOTS),
    );

    const first = new File(["same"], "a.png", { type: "image/png" });
    const second = new File(["same"], "b.png", { type: "image/png" });

    act(() => {
      result.current.attachImageFiles([first]);
    });
    await waitFor(() => expect(inserted).toHaveLength(1));
    act(() => {
      result.current.attachImageFiles([second]);
    });
    await waitFor(() => expect(inserted).toHaveLength(2));

    // Same content → same hash; distinct node ids and file names.
    expect(inserted[0][0].hash).toBe(inserted[1][0].hash);
    expect(inserted[0][0].id).not.toBe(inserted[1][0].id);
    expect(await imageHashKeys()).toHaveLength(1);
  });

  // `attachImageFiles` backs the image-only ingest path used by
  // `landingImageAttrsFromFiles` directly (not `onPaste`/`onDrop`), so a
  // non-image file handed to it is correctly dropped silently rather than
  // turned into a path span; that only happens through the DOM paste/drop
  // handlers, covered below.
  it("drops non-image files and keeps only images", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle } = makeHandle(inserted, []);
    const editorRef = { current: handle };
    const { result } = renderHook(() =>
      useLandingComposerPaste(editorRef, NOOP_FILE_DROPS, NO_MENTION_ROOTS),
    );

    const png = new File(["img"], "shot.png", { type: "image/png" });
    const pdf = new File(["doc"], "doc.pdf", { type: "application/pdf" });

    act(() => {
      result.current.attachImageFiles([png, pdf]);
    });

    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0]).toHaveLength(1);
    expect(inserted[0][0].fileName).toBe("shot.png");
  });

  it("surfaces a toast and inserts nothing when ingest fails", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle } = makeHandle(inserted, []);
    const editorRef = { current: handle };
    const { result } = renderHook(() =>
      useLandingComposerPaste(editorRef, NOOP_FILE_DROPS, NO_MENTION_ROOTS),
    );

    // Force `putImage` (its `sha256Hex`) to reject so the whole ingest rejects —
    // the partial-paste failure path. The `.catch` must surface a toast (and
    // schedule a reclaim) instead of an unhandled rejection.
    const digestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValue(new Error("hash failed"));

    const file = new File(["hello"], "shot.png", { type: "image/png" });
    act(() => {
      result.current.attachImageFiles([file]);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't attach the image.", {
        description: "Please try adding it again.",
      });
    });
    expect(inserted).toHaveLength(0);

    digestSpy.mockRestore();
  });

  it("schedules a reconcile but suppresses the toast when the composer unmounts mid-ingest", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle } = makeHandle(inserted, []);
    const editorRef = { current: handle };

    // Hold `putImage`'s hash step open so bytes can be aborted-away between
    // the (already-persisted) hash write and the node insertion - mirrors
    // unmounting/navigating away while a paste is still in flight.
    let resolveDigest: (() => void) | null = null;
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDigest = () => resolve(new ArrayBuffer(32));
        }),
    );

    const { result, unmount } = renderHook(() =>
      useLandingComposerPaste(editorRef, NOOP_FILE_DROPS, NO_MENTION_ROOTS),
    );
    const file = new File(["hello"], "shot.png", { type: "image/png" });
    act(() => {
      result.current.attachImageFiles([file]);
    });

    await waitFor(() => expect(resolveDigest).not.toBeNull());
    unmount();

    await act(async () => {
      resolveDigest?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(inserted).toHaveLength(0);
    expect(toast.error).not.toHaveBeenCalled();
    expect(scheduleLandingImageReconcile).toHaveBeenCalled();

    digestSpy.mockRestore();
  });

  it("rejects oversized images via a toast and inserts nothing", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const { handle } = makeHandle(inserted, []);
    const editorRef = { current: handle };
    const { result } = renderHook(() =>
      useLandingComposerPaste(editorRef, NOOP_FILE_DROPS, NO_MENTION_ROOTS),
    );

    const oversized = new File(["x"], "big.png", { type: "image/png" });
    Object.defineProperty(oversized, "size", { value: 10 * 1024 * 1024 });

    act(() => {
      result.current.attachImageFiles([oversized]);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inserted).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(await imageHashKeys()).toHaveLength(0);
  });
});

describe("useLandingComposerPaste - onPaste path-span parity", () => {
  it("resolves a pasted non-image file to a relativized path span via the editor handle", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertedPaths: ReadonlyArray<string>[] = [];
    const { handle, focusCalls } = makeHandle(inserted, insertedPaths);
    const editorRef = { current: handle };
    const fileDrops = makeFileDrops({ "notes.txt": ["/repo/notes.txt"] }, {});
    renderLandingHarness(editorRef, fileDrops, ["/repo"]);

    const txt = new File(["notes"], "notes.txt", { type: "text/plain" });
    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, { clipboardData: makeFileTransfer([txt]) });

    await waitFor(() => expect(insertedPaths).toHaveLength(1));
    expect(insertedPaths[0]).toEqual(["notes.txt"]);
    expect(inserted).toHaveLength(0);
    expect(focusCalls.count).toBe(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("mixes a pasted image and non-image file: the image attaches, the file becomes a path, nothing is dropped", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertedPaths: ReadonlyArray<string>[] = [];
    const { handle } = makeHandle(inserted, insertedPaths);
    const editorRef = { current: handle };
    const fileDrops = makeFileDrops(
      { "doc.pdf": ["/repo/external/doc.pdf"] },
      {},
    );
    renderLandingHarness(editorRef, fileDrops, NO_MENTION_ROOTS);

    const png = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const pdf = new File(["pdf-bytes"], "doc.pdf", { type: "application/pdf" });
    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, { clipboardData: makeFileTransfer([png, pdf]) });

    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0][0].fileName).toBe("shot.png");
    await waitFor(() => expect(insertedPaths).toHaveLength(1));
    expect(insertedPaths[0]).toEqual(["/repo/external/doc.pdf"]);
  });

  it("resolves a pasted folder (empty type/size) the same as a regular file", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertedPaths: ReadonlyArray<string>[] = [];
    const { handle } = makeHandle(inserted, insertedPaths);
    const editorRef = { current: handle };
    const fileDrops = makeFileDrops({ "my-folder": ["/repo/my-folder"] }, {});
    renderLandingHarness(editorRef, fileDrops, ["/repo"]);

    const folder = new File([], "my-folder", { type: "" });
    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, { clipboardData: makeFileTransfer([folder]) });

    await waitFor(() => expect(insertedPaths).toHaveLength(1));
    expect(insertedPaths[0]).toEqual(["my-folder"]);
    expect(inserted).toHaveLength(0);
  });

  it("resolves a URI-only clipboard entry (text/uri-list, no File object) via copyDroppedFilePaths", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertedPaths: ReadonlyArray<string>[] = [];
    const { handle } = makeHandle(inserted, insertedPaths);
    const editorRef = { current: handle };
    const fileDrops = makeFileDrops(
      {},
      // `fileUriToPath` strips the `file://` scheme before this is called,
      // so the fake keys off the resolved filesystem path, not the URI.
      { "/repo/external/report.pdf": ["/tmp/traycer-copy/report.pdf"] },
    );
    renderLandingHarness(editorRef, fileDrops, ["/repo"]);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, {
      clipboardData: makeUriListTransfer(["file:///repo/external/report.pdf"]),
    });

    await waitFor(() => expect(insertedPaths).toHaveLength(1));
    // Outside every mention root (copied to an app-managed temp dir) -> absolute.
    expect(insertedPaths[0]).toEqual(["/tmp/traycer-copy/report.pdf"]);
    expect(inserted).toHaveLength(0);
  });

  it("keeps the successfully resolved file when a sibling paste fails, and names only the failure in the toast", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertedPaths: ReadonlyArray<string>[] = [];
    const { handle } = makeHandle(inserted, insertedPaths);
    const editorRef = { current: handle };
    const fileDrops: IFileDropHost = {
      resolveDroppedFilePaths: (files) => {
        const file = files.at(0);
        if (file?.name === "ok.txt") return Promise.resolve(["/repo/ok.txt"]);
        return Promise.reject(new Error("resolve failed"));
      },
      copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      readNativeClipboardFilePaths: () => Promise.resolve([]),
    };
    renderLandingHarness(editorRef, fileDrops, ["/repo"]);

    const ok = new File(["ok"], "ok.txt", { type: "text/plain" });
    const bad = new File(["bad"], "bad.txt", { type: "text/plain" });
    const zone = screen.getByTestId("paste-zone");
    fireEvent.paste(zone, { clipboardData: makeFileTransfer([ok, bad]) });

    await waitFor(() => expect(insertedPaths).toHaveLength(1));
    expect(insertedPaths[0]).toEqual(["ok.txt"]);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't add 1 file",
        expect.objectContaining({ description: "bad.txt" }),
      );
    });
  });

  it("inserts nothing and shows a generic toast when resolution yields no path (web fallback)", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertedPaths: ReadonlyArray<string>[] = [];
    const { handle } = makeHandle(inserted, insertedPaths);
    const editorRef = { current: handle };
    renderLandingHarness(editorRef, NOOP_FILE_DROPS, NO_MENTION_ROOTS);

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
    expect(insertedPaths).toHaveLength(0);
  });
});

describe("useLandingComposerPaste - onDrop path-span parity", () => {
  it("inserts a dropped image and turns the accompanying non-image file into a path span", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertedPaths: ReadonlyArray<string>[] = [];
    const { handle } = makeHandle(inserted, insertedPaths);
    const editorRef = { current: handle };
    const fileDrops = makeFileDrops({ "doc.pdf": ["/repo/doc.pdf"] }, {});
    renderLandingHarness(editorRef, fileDrops, ["/repo"]);

    const png = new File(["dropped"], "drop.png", { type: "image/png" });
    const pdf = new File(["pdf"], "doc.pdf", { type: "application/pdf" });
    const zone = screen.getByTestId("paste-zone");
    fireEvent.drop(zone, { dataTransfer: makeFileTransfer([png, pdf]) });

    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0][0].fileName).toBe("drop.png");
    await waitFor(() => expect(insertedPaths).toHaveLength(1));
    expect(insertedPaths[0]).toEqual(["doc.pdf"]);
  });

  it("resolves a URI-only drop (public.file-url, no File object) via copyDroppedFilePaths", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertedPaths: ReadonlyArray<string>[] = [];
    const { handle } = makeHandle(inserted, insertedPaths);
    const editorRef = { current: handle };
    const fileDrops = makeFileDrops(
      {},
      { "/repo/screenshot.png": ["/tmp/traycer-copy/screenshot.png"] },
    );
    renderLandingHarness(editorRef, fileDrops, ["/repo"]);

    const zone = screen.getByTestId("paste-zone");
    fireEvent.drop(zone, {
      dataTransfer: makePublicFileUrlTransfer("file:///repo/screenshot.png"),
    });

    await waitFor(() => expect(insertedPaths).toHaveLength(1));
    expect(insertedPaths[0]).toEqual(["/tmp/traycer-copy/screenshot.png"]);
    expect(inserted).toHaveLength(0);
  });

  it("inserts every resolved path from a multi-file drop as a single call, relativized per mention root", async () => {
    const inserted: ImageAttachmentAttrs[][] = [];
    const insertedPaths: ReadonlyArray<string>[] = [];
    const { handle } = makeHandle(inserted, insertedPaths);
    const editorRef = { current: handle };
    const fileDrops = makeFileDrops(
      {
        "a.txt": ["/repo/a.txt"],
        "b.txt": ["/repo/nested/b.txt"],
        "c.txt": ["/elsewhere/c.txt"],
      },
      {},
    );
    renderLandingHarness(editorRef, fileDrops, ["/repo"]);

    const files = ["a.txt", "b.txt", "c.txt"].map(
      (name) => new File([name], name, { type: "text/plain" }),
    );
    const zone = screen.getByTestId("paste-zone");
    fireEvent.drop(zone, { dataTransfer: makeFileTransfer(files) });

    await waitFor(() => expect(insertedPaths).toHaveLength(1));
    expect(insertedPaths[0]).toEqual([
      "a.txt",
      "nested/b.txt",
      "/elsewhere/c.txt",
    ]);
  });
});
