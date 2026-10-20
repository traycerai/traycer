import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IFileSaveHost } from "@traycer-clients/shared/platform/runner-host";
import type { ArtifactObjectRef } from "@traycer/protocol/persistence/epic/artifacts";
import type { ArtifactReadSpan } from "@/lib/sandbox/artifact-serving/artifact-server";
import { FileArtifactViewer } from "@/components/epic-canvas/renderers/file-artifact-viewer";

const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const mocks = vi.hoisted(() => ({
  downloadBlobToDevice: vi.fn<(blob: Blob, name: string) => Promise<void>>(),
  saveBlobToDisk:
    vi.fn<(blob: Blob, name: string, host: unknown) => Promise<null>>(),
  fileSave: null as IFileSaveHost | null,
  createdUrls: [] as string[],
  revokedUrls: [] as string[],
}));

// The three previews have their own tests; what the viewer owns is which one
// it mounts and what blob URL it hands them.
vi.mock("@/components/epic-canvas/image-preview/image-preview", () => ({
  DEFAULT_ANIMATION_MS: 1,
  ImagePreview: (props: { readonly url: string }) => (
    <div data-testid="image-preview" data-url={props.url} />
  ),
}));
vi.mock("@/components/epic-canvas/pdf-preview/pdf-preview-lazy", () => ({
  PdfPreviewLazy: (props: { readonly url: string }) => (
    <div data-testid="pdf-preview" data-url={props.url} />
  ),
}));
vi.mock("@/components/epic-canvas/docx-preview/docx-preview-lazy", () => ({
  DocxPreviewLazy: (props: { readonly url: string }) => (
    <div data-testid="docx-preview" data-url={props.url} />
  ),
}));
vi.mock("@/hooks/files/use-file-save-host", () => ({
  useFileSaveHost: () => mocks.fileSave,
}));
// The capability predicates stay real: which buttons a shell gets is decided
// by them, and the viewer only has to honour that.
vi.mock("@/lib/files/save-blob-to-disk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/files/save-blob-to-disk")>()),
  downloadBlobToDevice: mocks.downloadBlobToDevice,
  saveBlobToDisk: mocks.saveBlobToDisk,
}));

beforeEach(() => {
  mocks.downloadBlobToDevice.mockResolvedValue(undefined);
  mocks.saveBlobToDisk.mockResolvedValue(null);
  // jsdom implements neither; numbering the URLs lets a test tell which blob
  // a preview was handed and which were released.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => {
      const url = `blob:test/${mocks.createdUrls.length}`;
      mocks.createdUrls.push(url);
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => {
      mocks.revokedUrls.push(url);
    },
  });
});

afterEach(() => {
  cleanup();
  mocks.downloadBlobToDevice.mockReset();
  mocks.saveBlobToDisk.mockReset();
  mocks.fileSave = null;
  mocks.createdUrls.length = 0;
  mocks.revokedUrls.length = 0;
});

function objectOf(
  bytes: Uint8Array,
  sha256: string,
  mediaType: string,
): ArtifactObjectRef {
  return { sha256, byteLength: bytes.length, mediaType, status: "published" };
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Serves `bytes` whole and records every span it was asked for. */
function servingSpan(bytes: Uint8Array) {
  const requests: Array<{ sha256: string; offset: number }> = [];
  const readSpan: ArtifactReadSpan = (sha256, offset, length) => {
    requests.push({ sha256, offset });
    return Promise.resolve({
      bytes: bytes.slice(offset, offset + length),
      totalBytes: bytes.length,
      mediaType: "application/octet-stream",
    });
  };
  return { readSpan, requests };
}

function viewer(
  name: string,
  object: ArtifactObjectRef,
  readSpan: ArtifactReadSpan,
) {
  return (
    <FileArtifactViewer
      epicId="epic-1"
      hostId="host-1"
      name={name}
      object={object}
      readSpan={readSpan}
    />
  );
}

function renderViewer(
  name: string,
  object: ArtifactObjectRef,
  readSpan: ArtifactReadSpan,
) {
  const queryClient = new QueryClient();
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = render(wrap(viewer(name, object, readSpan)));
  return {
    ...view,
    rerenderWith: (
      nextName: string,
      nextObject: ArtifactObjectRef,
      nextReadSpan: ArtifactReadSpan,
    ) => view.rerender(wrap(viewer(nextName, nextObject, nextReadSpan))),
  };
}

describe("<FileArtifactViewer />", () => {
  it.each([
    ["an image", "photo.png", "image/png", "image-preview"],
    ["a PDF", "report.pdf", "application/pdf", "pdf-preview"],
    ["a Word document", "notes.docx", DOCX_MEDIA_TYPE, "docx-preview"],
  ])(
    "hands %s to its preview with the downloaded blob's URL",
    async (_label, name, mediaType, testId) => {
      const bytes = textBytes("payload");
      const { readSpan } = servingSpan(bytes);

      renderViewer(name, objectOf(bytes, "a".repeat(64), mediaType), readSpan);

      const preview = await screen.findByTestId(testId);
      expect(preview.getAttribute("data-url")).toBe(mocks.createdUrls.at(-1));
    },
  );

  it.each([
    ["video", "clip.mp4", "video/mp4", "video"],
    ["audio", "song.mp3", "audio/mpeg", "audio"],
  ])(
    "plays %s natively from the blob URL",
    async (_label, name, mediaType, tag) => {
      const bytes = textBytes("payload");
      const { readSpan } = servingSpan(bytes);

      const { container } = renderViewer(
        name,
        objectOf(bytes, "a".repeat(64), mediaType),
        readSpan,
      );

      await waitFor(() =>
        expect(container.querySelector(tag)?.getAttribute("src")).toBe(
          mocks.createdUrls.at(-1),
        ),
      );
    },
  );

  it("shows a text file's content", async () => {
    const bytes = textBytes("hello from the file");
    const { readSpan } = servingSpan(bytes);

    renderViewer(
      "notes.txt",
      objectOf(bytes, "a".repeat(64), "text/plain"),
      readSpan,
    );

    expect(await screen.findByText("hello from the file")).toBeTruthy();
  });

  it("downloads nothing for a format it cannot preview until the reader asks, then saves the exact bytes under the file's name", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251]);
    const { readSpan, requests } = servingSpan(bytes);

    renderViewer(
      "data.bin",
      objectOf(bytes, "a".repeat(64), "application/octet-stream"),
      readSpan,
    );

    expect(
      screen.getByText("No preview is available. Save the file to open it."),
    ).toBeTruthy();
    expect(requests).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(mocks.downloadBlobToDevice).toHaveBeenCalledTimes(1),
    );
    const [blob, name] = mocks.downloadBlobToDevice.mock.calls[0];
    expect(name).toBe("data.bin");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([...bytes]);
    expect(requests).toHaveLength(1);
  });

  it("offers only Share on a shell whose save is a chooser with no direct download, and Share hands the bytes to the existing share route", async () => {
    const shareOnly: IFileSaveHost = {
      saveFile: () => Promise.resolve(null),
      openSavedFile: null,
      downloadFile: null,
      saveRoute: "share",
      downloadUrl: null,
    };
    mocks.fileSave = shareOnly;
    const bytes = Uint8Array.from([7, 8, 9]);
    const { readSpan } = servingSpan(bytes);

    renderViewer(
      "data.bin",
      objectOf(bytes, "a".repeat(64), "application/octet-stream"),
      readSpan,
    );

    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    await waitFor(() => expect(mocks.saveBlobToDisk).toHaveBeenCalledTimes(1));
    const [blob, name, host] = mocks.saveBlobToDisk.mock.calls[0];
    expect(name).toBe("data.bin");
    expect(host).toBe(shareOnly);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([...bytes]);
    expect(mocks.downloadBlobToDevice).not.toHaveBeenCalled();
  });

  it("keeps the previous file off the screen while the next sha is still being read", async () => {
    const oldBytes = textBytes("the old file");
    const newBytes = textBytes("the new file");
    const oldRead = servingSpan(oldBytes);
    const { rerenderWith } = renderViewer(
      "notes.txt",
      objectOf(oldBytes, "a".repeat(64), "text/plain"),
      oldRead.readSpan,
    );
    await screen.findByText("the old file");

    const release: { resolve: (() => void) | null } = { resolve: null };
    const newRequests: string[] = [];
    const slowRead: ArtifactReadSpan = (sha256, offset, length) => {
      newRequests.push(sha256);
      return new Promise((resolve) => {
        release.resolve = () =>
          resolve({
            bytes: newBytes.slice(offset, offset + length),
            totalBytes: newBytes.length,
            mediaType: "text/plain",
          });
      });
    };
    rerenderWith(
      "notes.txt",
      objectOf(newBytes, "b".repeat(64), "text/plain"),
      slowRead,
    );

    expect(screen.queryByText("the old file")).toBeNull();
    expect(screen.getByText("Loading file…")).toBeTruthy();
    await waitFor(() => expect(newRequests).toEqual(["b".repeat(64)]));

    release.resolve?.();

    expect(await screen.findByText("the new file")).toBeTruthy();
  });

  it("keeps the painted file and reads nothing more when only the object's status moves from queued to published", async () => {
    const bytes = textBytes("steady file");
    const { readSpan, requests } = servingSpan(bytes);
    const queued = objectOf(bytes, "a".repeat(64), "text/plain");
    const { rerenderWith } = renderViewer(
      "notes.txt",
      { ...queued, status: "queued" },
      readSpan,
    );
    await screen.findByText("steady file");
    const readsBefore = requests.length;

    rerenderWith("notes.txt", { ...queued, status: "published" }, readSpan);

    // Synchronously after the update: a refetch would blank the file first.
    expect(screen.getByText("steady file")).toBeTruthy();
    expect(requests).toHaveLength(readsBefore);
  });

  it("aborts an in-flight read when the viewer goes away", async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const hangingRead: ArtifactReadSpan = (_sha, _offset, _length, signal) => {
      seen.signal = signal;
      return new Promise(() => undefined);
    };

    const { unmount } = renderViewer(
      "notes.txt",
      objectOf(textBytes("abc"), "a".repeat(64), "text/plain"),
      hangingRead,
    );
    await waitFor(() => expect(seen.signal).not.toBeNull());

    unmount();

    expect(seen.signal?.aborted).toBe(true);
  });

  it("revokes the blob URL it made when the viewer goes away", async () => {
    const bytes = textBytes("payload");
    const { readSpan } = servingSpan(bytes);
    const { unmount } = renderViewer(
      "photo.png",
      objectOf(bytes, "a".repeat(64), "image/png"),
      readSpan,
    );
    await screen.findByTestId("image-preview");

    unmount();

    expect(mocks.revokedUrls).toEqual(mocks.createdUrls);
    expect(mocks.revokedUrls.length).toBeGreaterThan(0);
  });
});
