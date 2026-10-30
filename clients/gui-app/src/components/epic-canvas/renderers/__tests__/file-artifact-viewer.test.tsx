import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  IFileSaveHost,
  IRunnerHost,
  SavedFileLocation,
  UrlDownloadRequest,
} from "@traycer-clients/shared/platform/runner-host";
import type {
  SandboxArtifactBridge,
  SandboxArtifactReply,
  SandboxArtifactRequest,
} from "@traycer-clients/shared/platform/sandbox-artifacts";
import type { EpicReadArtifactObjectResponse } from "@traycer/protocol/host/epic/artifact-objects";
import type { ArtifactObjectRef } from "@traycer/protocol/persistence/epic/artifacts";
import {
  ArtifactServer,
  type ArtifactReadSpan,
} from "@/lib/sandbox/artifact-serving/artifact-server";
import { FileArtifactViewer } from "@/components/epic-canvas/renderers/file-artifact-viewer";

const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const mocks = vi.hoisted(() => ({
  downloadBlobToDevice: vi.fn<(blob: Blob, name: string) => Promise<void>>(),
  saveBlobToDisk:
    vi.fn<(blob: Blob, name: string, host: unknown) => Promise<null>>(),
  fileSave: null as IFileSaveHost | null,
  runnerHost: null as IRunnerHost | null,
  // The viewer renders for "host-1"; a native shell serves its own host's
  // objects itself and streams another host's published ones from the cloud.
  localHostId: "host-1" as string | null,
  // A fixed query result for the tests that watch the renewal timer; `null`
  // lets the adapter below run a real query against `urlResponse`.
  hostQuery: null as {
    data: unknown;
    isPending: boolean;
    refetch: Mock<(...args: unknown[]) => unknown>;
  } | null,
  urlResponse: {
    kind: "unavailable",
    reason: "missing",
  } as EpicReadArtifactObjectResponse,
  urlRequests: [] as unknown[],
  // Replaces `urlResponse` for a URL request that fails.
  urlAnswer: null as (() => Promise<EpicReadArtifactObjectResponse>) | null,
  hostQueryParams: [] as unknown[],
  // What this machine's host answers when the player asks whether it holds
  // the object: a byte means it is on disk, `downloading` means not yet.
  probeResponse: {
    kind: "bytes",
    bytesBase64: "",
    offset: 0,
    totalBytes: 0,
    mediaType: "video/mp4",
  } as EpicReadArtifactObjectResponse,
  probeRequests: [] as unknown[],
  // Replaces `probeResponse` for a probe that fails or never answers.
  probeAnswer: null as (() => Promise<EpicReadArtifactObjectResponse>) | null,
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
// Media never reads the object into a Blob: the native shell streams it through
// a mounted artifact server, and a browser asks the host for a signed URL. The
// real mount and server stay; only where the runner host and host client come
// from is faked.
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => mocks.runnerHost,
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => mocks.localHostId,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
// Backed by a real query, so `options.enabled` and the cache behave as in the
// app; the host's answer is `urlResponse`, and each request is recorded.
vi.mock("@/hooks/host/use-host-query", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    useHostQuery: (input: {
      readonly params: { readonly want: { readonly kind: string } };
      readonly options: {
        readonly enabled: boolean | undefined;
        readonly staleTime: number | undefined;
      };
    }) => {
      // The one-byte probe and the URL read are both this method; the
      // fixed `hostQuery` stands in for the URL read only.
      const isProbe = input.params.want.kind === "range";
      if (!isProbe) mocks.hostQueryParams.push(input.params);
      const real = useQuery({
        queryKey: [isProbe ? "media-probe" : "media-url", input.params],
        queryFn: () => {
          if (isProbe) {
            mocks.probeRequests.push(input.params);
            return mocks.probeAnswer === null
              ? Promise.resolve(mocks.probeResponse)
              : mocks.probeAnswer();
          }
          mocks.urlRequests.push(input.params);
          return mocks.urlAnswer === null
            ? Promise.resolve(mocks.urlResponse)
            : mocks.urlAnswer();
        },
        retry: false,
        enabled:
          (isProbe || mocks.hostQuery === null) &&
          input.options.enabled !== false,
        staleTime: input.options.staleTime,
      });
      return isProbe ? real : (mocks.hostQuery ?? real);
    },
  };
});
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
  mocks.runnerHost = null;
  mocks.localHostId = "host-1";
  mocks.hostQuery = null;
  mocks.urlResponse = { kind: "unavailable", reason: "missing" };
  mocks.urlRequests.length = 0;
  mocks.urlAnswer = null;
  mocks.hostQueryParams.length = 0;
  mocks.probeResponse = {
    kind: "bytes",
    bytesBase64: "",
    offset: 0,
    totalBytes: 0,
    mediaType: "video/mp4",
  };
  mocks.probeRequests.length = 0;
  mocks.probeAnswer = null;
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
  const requests: Array<{ sha256: string; offset: number; length: number }> =
    [];
  const readSpan: ArtifactReadSpan = (sha256, offset, length) => {
    requests.push({ sha256, offset, length });
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

  it("reads only the preview window of a large text file and says the preview is cut", async () => {
    const bytes = new Uint8Array(300_000).fill(97);
    const { readSpan, requests } = servingSpan(bytes);

    renderViewer(
      "big.txt",
      objectOf(bytes, "a".repeat(64), "text/plain"),
      readSpan,
    );

    expect(await screen.findByText(/Preview truncated/)).toBeTruthy();
    // The preview never pulls the whole file: it asks for no more than the
    // window it shows, and nothing past it.
    expect(
      requests.reduce((total, request) => total + request.length, 0),
    ).toBeLessThanOrEqual(100_000);
    expect(requests.every((request) => request.offset < 100_000)).toBe(true);
  });

  it("hands an explicit save of a large text file every byte, not the preview window", async () => {
    const bytes = new Uint8Array(150_000).fill(98);
    const { readSpan } = servingSpan(bytes);
    renderViewer(
      "big.txt",
      objectOf(bytes, "a".repeat(64), "text/plain"),
      readSpan,
    );
    await screen.findByText(/Preview truncated/);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(mocks.downloadBlobToDevice).toHaveBeenCalledTimes(1),
    );
    const [blob, name] = mocks.downloadBlobToDevice.mock.calls[0];
    expect(name).toBe("big.txt");
    expect(blob.size).toBe(150_000);
  });

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

  it("downloads a published file on another machine's host straight from its cloud URL, reading no bytes through that host", async () => {
    mocks.localHostId = "host-2";
    const downloadUrl =
      vi.fn<
        (request: UrlDownloadRequest) => Promise<SavedFileLocation | null>
      >();
    downloadUrl.mockResolvedValue({ name: "data.bin", path: "/dl/data.bin" });
    mocks.fileSave = {
      saveFile: () => Promise.resolve(null),
      openSavedFile: null,
      downloadFile: null,
      saveRoute: "download",
      downloadUrl,
    };
    const signed = "https://cdn.example.test/data.bin?sig=dl";
    mocks.urlResponse = {
      kind: "url",
      url: signed,
      expiresAt: Date.now() + 60_000,
    };
    const bytes = Uint8Array.from([0, 1, 2]);
    const { readSpan, requests } = servingSpan(bytes);

    renderViewer(
      "data.bin",
      objectOf(bytes, "a".repeat(64), "application/octet-stream"),
      readSpan,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(downloadUrl).toHaveBeenCalledWith({
        url: signed,
        name: "data.bin",
        type: "application/octet-stream",
      }),
    );
    // The URL was minted for the press, not when the viewer opened.
    expect(mocks.urlRequests).toEqual([
      { epicId: "epic-1", sha256: "a".repeat(64), want: { kind: "url" } },
    ]);
    expect(mocks.downloadBlobToDevice).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("falls back to reading the bytes through another machine's host when that host cannot mint a URL for the press", async () => {
    mocks.localHostId = "host-2";
    const downloadUrl =
      vi.fn<
        (request: UrlDownloadRequest) => Promise<SavedFileLocation | null>
      >();
    mocks.fileSave = {
      saveFile: () => Promise.resolve(null),
      openSavedFile: null,
      downloadFile: null,
      saveRoute: "download",
      downloadUrl,
    };
    mocks.urlAnswer = () => Promise.reject(new Error("relay down"));
    const bytes = Uint8Array.from([6, 7, 8]);
    const { readSpan } = servingSpan(bytes);

    renderViewer(
      "data.bin",
      objectOf(bytes, "a".repeat(64), "application/octet-stream"),
      readSpan,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(mocks.downloadBlobToDevice).toHaveBeenCalledTimes(1),
    );
    expect(mocks.urlRequests).toHaveLength(1);
    expect(downloadUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a native download that fails after the URL was minted instead of saving the bytes a second time", async () => {
    mocks.localHostId = "host-2";
    const downloadUrl =
      vi.fn<
        (request: UrlDownloadRequest) => Promise<SavedFileLocation | null>
      >();
    downloadUrl.mockRejectedValue(new Error("download interrupted"));
    mocks.fileSave = {
      saveFile: () => Promise.resolve(null),
      openSavedFile: null,
      downloadFile: null,
      saveRoute: "download",
      downloadUrl,
    };
    mocks.urlResponse = {
      kind: "url",
      url: "https://cdn.example.test/data.bin?sig=dl",
      expiresAt: Date.now() + 60_000,
    };
    const bytes = Uint8Array.from([9, 10, 11]);
    const { readSpan } = servingSpan(bytes);

    renderViewer(
      "data.bin",
      objectOf(bytes, "a".repeat(64), "application/octet-stream"),
      readSpan,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await screen.findByRole("alert");
    expect(downloadUrl).toHaveBeenCalledTimes(1);
    expect(mocks.downloadBlobToDevice).not.toHaveBeenCalled();
  });

  it("downloads an unpublished file on another machine's host through that host, since the cloud has no copy yet", async () => {
    mocks.localHostId = "host-2";
    const downloadUrl =
      vi.fn<
        (request: UrlDownloadRequest) => Promise<SavedFileLocation | null>
      >();
    mocks.fileSave = {
      saveFile: () => Promise.resolve(null),
      openSavedFile: null,
      downloadFile: null,
      saveRoute: "download",
      downloadUrl,
    };
    const bytes = Uint8Array.from([3, 4, 5]);
    const { readSpan } = servingSpan(bytes);

    renderViewer(
      "data.bin",
      {
        ...objectOf(bytes, "a".repeat(64), "application/octet-stream"),
        status: "uploading",
      },
      readSpan,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(mocks.downloadBlobToDevice).toHaveBeenCalledTimes(1),
    );
    expect(downloadUrl).not.toHaveBeenCalled();
    expect(mocks.urlRequests).toEqual([]);
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

interface MediaBridge extends SandboxArtifactBridge {
  readonly registered: string[];
  readonly unregistered: string[];
  readonly responses: SandboxArtifactReply[];
  emit(request: SandboxArtifactRequest): void;
  finishRegistration(): void;
}

/** A shell bridge; `holdRegistration` keeps `register` pending until released. */
function mediaBridge(holdRegistration: boolean): MediaBridge {
  const handlers = new Set<(request: SandboxArtifactRequest) => void>();
  const registered: string[] = [];
  const unregistered: string[] = [];
  const responses: SandboxArtifactReply[] = [];
  const gate = Promise.withResolvers<void>();
  if (!holdRegistration) gate.resolve();
  return {
    policySource: "traycer-sandbox:",
    artifactOrigin: ({ artifactId, mountId }) =>
      `traycer-sandbox://artifact-${artifactId}--${mountId}`,
    registered,
    unregistered,
    responses,
    register: (mountId) => {
      registered.push(mountId);
      return gate.promise;
    },
    unregister: (mountId) => {
      unregistered.push(mountId);
      return Promise.resolve();
    },
    onRequest: (handler) => {
      handlers.add(handler);
      return { dispose: () => handlers.delete(handler) };
    },
    onCancel: () => ({ dispose: () => undefined }),
    respond: (reply) => {
      responses.push(reply);
      return Promise.resolve();
    },
    emit: (request) => {
      for (const handler of handlers) handler(request);
    },
    finishRegistration: () => gate.resolve(),
  };
}

/** MockRunnerHost always carries a null bridge; these tests need a real one. */
function nativeHostWith(bridge: SandboxArtifactBridge): IRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const proto = Object.getPrototypeOf(host) as object;
  return Object.assign(Object.create(proto) as IRunnerHost, host, {
    sandboxArtifacts: bridge,
  });
}

const HUGE_MEDIA_BYTES = 5 * 1024 ** 3;
const MEDIA_SHA = "d".repeat(64);

function mediaObject(
  status: ArtifactObjectRef["status"],
  mediaType: string,
): ArtifactObjectRef {
  return {
    sha256: MEDIA_SHA,
    byteLength: HUGE_MEDIA_BYTES,
    mediaType,
    status,
  };
}

/** Serves a recognisable byte for any span, and records each span's size. */
function recordedMediaSpans() {
  const spans: Array<{ sha256: string; offset: number; length: number }> = [];
  const readSpan: ArtifactReadSpan = (sha256, offset, length) => {
    spans.push({ sha256, offset, length });
    return Promise.resolve({
      bytes: new Uint8Array(length).fill(7),
      totalBytes: HUGE_MEDIA_BYTES,
      mediaType: "video/mp4",
    });
  };
  return { readSpan, spans };
}

describe("<FileArtifactViewer /> media in the native shell", () => {
  it.each([
    ["video", "clip.mp4", "video/mp4"],
    ["audio", "song.mp3", "audio/mpeg"],
  ])(
    "streams %s from the shell's own artifact address without reading the object or making a blob URL",
    async (tag, name, mediaType) => {
      const bridge = mediaBridge(false);
      mocks.runnerHost = nativeHostWith(bridge);
      const { readSpan, spans } = recordedMediaSpans();

      const { container } = renderViewer(
        name,
        mediaObject("published", mediaType),
        readSpan,
      );

      await waitFor(() => expect(container.querySelector(tag)).not.toBeNull());
      expect(bridge.registered).toHaveLength(1);
      expect(container.querySelector(tag)?.getAttribute("src")).toBe(
        `traycer-sandbox://artifact-media-${MEDIA_SHA}--${bridge.registered[0]}/media`,
      );
      // This machine's host was asked for one byte, which proved the file
      // is on its disk; a five-gigabyte recording must cost nothing more
      // until the player asks.
      expect(mocks.probeRequests).toEqual([
        {
          epicId: "epic-1",
          sha256: MEDIA_SHA,
          want: { kind: "range", offset: 0, length: 1 },
        },
      ]);
      expect(spans).toEqual([]);
      expect(mocks.createdUrls).toEqual([]);
    },
  );

  it("plays from the cloud while this machine's host is still fetching the file, without waiting for it", async () => {
    const bridge = mediaBridge(false);
    mocks.runnerHost = nativeHostWith(bridge);
    mocks.probeResponse = {
      kind: "downloading",
      receivedBytes: 10,
      totalBytes: HUGE_MEDIA_BYTES,
    };
    const signed = "https://cdn.example.test/clip.mp4?sig=fetching";
    mocks.hostQuery = {
      data: { kind: "url", url: signed, expiresAt: Date.now() + 60_000 },
      isPending: false,
      refetch: vi.fn<(...args: unknown[]) => unknown>(),
    };
    const { readSpan, spans } = recordedMediaSpans();

    const { container } = renderViewer(
      "clip.mp4",
      mediaObject("published", "video/mp4"),
      readSpan,
    );

    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe(
        signed,
      ),
    );
    expect(bridge.registered).toEqual([]);
    expect(spans).toEqual([]);
  });

  it.each([
    [
      "says it cannot serve the object",
      () =>
        Promise.resolve<EpicReadArtifactObjectResponse>({
          kind: "unavailable",
          reason: "missing",
        }),
    ],
    ["fails to answer the probe", () => Promise.reject(new Error("socket"))],
  ])(
    "plays from the cloud when this machine's host %s",
    async (_case, probeAnswer) => {
      const bridge = mediaBridge(false);
      mocks.runnerHost = nativeHostWith(bridge);
      mocks.probeAnswer = probeAnswer;
      const signed = "https://cdn.example.test/clip.mp4?sig=no-byte";
      mocks.hostQuery = {
        data: { kind: "url", url: signed, expiresAt: Date.now() + 60_000 },
        isPending: false,
        refetch: vi.fn<(...args: unknown[]) => unknown>(),
      };
      const { readSpan } = recordedMediaSpans();

      const { container } = renderViewer(
        "clip.mp4",
        mediaObject("published", "video/mp4"),
        readSpan,
      );

      await waitFor(() =>
        expect(container.querySelector("video")?.getAttribute("src")).toBe(
          signed,
        ),
      );
      expect(bridge.registered).toEqual([]);
    },
  );

  // A host asked for a sha it does not hold starts the fetch and holds the
  // reply for up to 3 s; the player must not wait that long on a probe.
  it("plays from the cloud when this machine's host has not answered the probe within a second", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const bridge = mediaBridge(false);
      mocks.runnerHost = nativeHostWith(bridge);
      mocks.probeAnswer = () => new Promise(() => {});
      const signed = "https://cdn.example.test/clip.mp4?sig=slow-probe";
      mocks.hostQuery = {
        data: { kind: "url", url: signed, expiresAt: Date.now() + 60_000 },
        isPending: false,
        refetch: vi.fn<(...args: unknown[]) => unknown>(),
      };
      const { readSpan } = recordedMediaSpans();

      const { container } = renderViewer(
        "clip.mp4",
        mediaObject("published", "video/mp4"),
        readSpan,
      );

      act(() => {
        vi.advanceTimersByTime(900);
      });
      expect(container.querySelector("video")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(container.querySelector("video")?.getAttribute("src")).toBe(
        signed,
      );
      expect(bridge.registered).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the player only after the shell has registered the mount", async () => {
    const bridge = mediaBridge(true);
    mocks.runnerHost = nativeHostWith(bridge);
    const { readSpan } = recordedMediaSpans();

    const { container } = renderViewer(
      "clip.mp4",
      mediaObject("published", "video/mp4"),
      readSpan,
    );

    await waitFor(() => expect(bridge.registered).toHaveLength(1));
    expect(screen.getByText("Loading media…")).toBeTruthy();
    expect(container.querySelector("video")).toBeNull();

    bridge.finishRegistration();

    await waitFor(() =>
      expect(container.querySelector("video")).not.toBeNull(),
    );
  });

  it("answers the player's small range request with a bounded read of the object's own sha", async () => {
    const bridge = mediaBridge(false);
    mocks.runnerHost = nativeHostWith(bridge);
    const { readSpan, spans } = recordedMediaSpans();
    const { container } = renderViewer(
      "clip.mp4",
      mediaObject("published", "video/mp4"),
      readSpan,
    );
    await waitFor(() =>
      expect(container.querySelector("video")).not.toBeNull(),
    );

    bridge.emit({
      requestId: "range-1",
      mountId: bridge.registered[0],
      path: "media",
      offset: 0,
      length: 4,
    });

    await waitFor(() => expect(bridge.responses).toHaveLength(1));
    const reply = bridge.responses[0];
    if (reply.kind !== "bytes") throw new Error("expected a bytes reply");
    expect(reply.bytes).toHaveLength(4);
    expect(reply.totalBytes).toBe(HUGE_MEDIA_BYTES);
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.sha256).toBe(MEDIA_SHA);
      // Never the whole object: a bounded read at the host's range ceiling.
      expect(span.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });

  it.each(["queued", "local-only"] as const)(
    "plays a %s object, since the shell serves it from this host rather than a published URL",
    async (status) => {
      const bridge = mediaBridge(false);
      mocks.runnerHost = nativeHostWith(bridge);
      const { readSpan } = recordedMediaSpans();

      const { container } = renderViewer(
        "clip.mp4",
        mediaObject(status, "video/mp4"),
        readSpan,
      );

      await waitFor(() =>
        expect(container.querySelector("video")).not.toBeNull(),
      );
    },
  );

  it("streams a published object on another machine's host from its signed URL instead of relaying spans", async () => {
    const bridge = mediaBridge(false);
    mocks.runnerHost = nativeHostWith(bridge);
    mocks.localHostId = "host-2";
    const signed = "https://cdn.example.test/clip.mp4?sig=remote";
    mocks.hostQuery = {
      data: { kind: "url", url: signed, expiresAt: Date.now() + 60_000 },
      isPending: false,
      refetch: vi.fn<(...args: unknown[]) => unknown>(),
    };
    const { readSpan, spans } = recordedMediaSpans();

    const { container } = renderViewer(
      "clip.mp4",
      mediaObject("published", "video/mp4"),
      readSpan,
    );

    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe(
        signed,
      ),
    );
    expect(bridge.registered).toEqual([]);
    expect(spans).toEqual([]);
    // Another machine's disk is not the viewer's: no probe, straight to the cloud.
    expect(mocks.probeRequests).toEqual([]);
  });

  it("keeps serving an unpublished object from another machine's host itself, since no URL exists for it yet", async () => {
    const bridge = mediaBridge(false);
    mocks.runnerHost = nativeHostWith(bridge);
    mocks.localHostId = "host-2";
    const { readSpan } = recordedMediaSpans();

    const { container } = renderViewer(
      "clip.mp4",
      mediaObject("queued", "video/mp4"),
      readSpan,
    );

    await waitFor(() =>
      expect(container.querySelector("video")).not.toBeNull(),
    );
    expect(bridge.registered).toHaveLength(1);
    expect(mocks.urlRequests).toEqual([]);
  });

  it("keeps the same mount when only the object's status moves from queued to published", async () => {
    const bridge = mediaBridge(false);
    mocks.runnerHost = nativeHostWith(bridge);
    const { readSpan, spans } = recordedMediaSpans();
    const { container, rerenderWith } = renderViewer(
      "clip.mp4",
      mediaObject("queued", "video/mp4"),
      readSpan,
    );
    await waitFor(() =>
      expect(container.querySelector("video")).not.toBeNull(),
    );

    rerenderWith("clip.mp4", mediaObject("published", "video/mp4"), readSpan);

    expect(container.querySelector("video")).not.toBeNull();
    expect(bridge.registered).toHaveLength(1);
    expect(bridge.unregistered).toEqual([]);
    expect(spans).toEqual([]);
  });

  it("releases the shell's mount on unmount, aborts the read it was waiting on and never answers the request", async () => {
    const bridge = mediaBridge(false);
    mocks.runnerHost = nativeHostWith(bridge);
    const release = Promise.withResolvers<void>();
    // Passes through to the real server; keeps the promise of the request the
    // mount dispatches, which its dispatcher is awaiting.
    const served = vi.spyOn(ArtifactServer.prototype, "serve");
    try {
      // The signal the mount hands every read: it must end with the mount.
      const consumed: { signal: AbortSignal | null } = { signal: null };
      const slowRead: ArtifactReadSpan = async (
        _sha,
        _offset,
        length,
        signal,
      ) => {
        consumed.signal = signal;
        await release.promise;
        return {
          bytes: new Uint8Array(length),
          totalBytes: HUGE_MEDIA_BYTES,
          mediaType: "video/mp4",
        };
      };
      const { container, unmount } = renderViewer(
        "clip.mp4",
        mediaObject("published", "video/mp4"),
        slowRead,
      );
      await waitFor(() =>
        expect(container.querySelector("video")).not.toBeNull(),
      );
      bridge.emit({
        requestId: "in-flight",
        mountId: bridge.registered[0],
        path: "media",
        offset: 0,
        length: 4,
      });

      await waitFor(() => expect(consumed.signal).not.toBeNull());
      expect(consumed.signal?.aborted).toBe(false);

      unmount();
      release.resolve();

      expect(consumed.signal?.aborted).toBe(true);
      await waitFor(() =>
        expect(bridge.unregistered).toEqual([bridge.registered[0]]),
      );
      // The dispatcher was already waiting on this promise, ahead of this wait,
      // so it has read the aborted request's result and decided on a reply by the
      // time it settles.
      await Promise.allSettled(
        served.mock.results.map((call) => {
          if (call.type !== "return")
            throw new Error("serve did not return a promise");
          return call.value;
        }),
      );
      expect(served).toHaveBeenCalledOnce();
      expect(bridge.responses).toEqual([]);
    } finally {
      served.mockRestore();
    }
  });

  it("offers Retry after a playback error and brings back the same player, resuming where it was", async () => {
    const bridge = mediaBridge(false);
    mocks.runnerHost = nativeHostWith(bridge);
    const { readSpan } = recordedMediaSpans();
    const { container } = renderViewer(
      "clip.mp4",
      mediaObject("published", "video/mp4"),
      readSpan,
    );
    await waitFor(() =>
      expect(container.querySelector("video")).not.toBeNull(),
    );
    const failing = container.querySelector("video");
    if (failing === null) throw new Error("expected a video");
    const src = failing.getAttribute("src");
    // jsdom exposes `readyState` read-only; a loaded recording has metadata.
    Object.defineProperty(failing, "readyState", { value: 1 });
    failing.currentTime = 42;
    fireEvent.timeUpdate(failing);

    // A transient host failure ends playback of that URL.
    fireEvent.error(failing);
    expect(container.querySelector("video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(container.querySelector("video")).not.toBeNull(),
    );
    const retried = container.querySelector("video");
    if (retried === null) throw new Error("expected the player back");
    expect(retried).not.toBe(failing);
    expect(retried.getAttribute("src")).toBe(src);
    expect(bridge.registered).toHaveLength(1);
    fireEvent.loadedMetadata(retried);
    expect(retried.currentTime).toBe(42);
  });
});

describe("<FileArtifactViewer /> media in a browser", () => {
  const SIGNED = "https://cdn.example.test/clip.mp4?sig=abc";

  it("plays the host's signed URL for the object without reading its bytes", () => {
    mocks.hostQuery = {
      data: { kind: "url", url: SIGNED, expiresAt: Date.now() + 60_000 },
      isPending: false,
      refetch: vi.fn<(...args: unknown[]) => unknown>(),
    };
    const { readSpan, spans } = recordedMediaSpans();

    const { container } = renderViewer(
      "clip.mp4",
      mediaObject("published", "video/mp4"),
      readSpan,
    );

    expect(container.querySelector("video")?.getAttribute("src")).toBe(SIGNED);
    expect(mocks.hostQueryParams).toContainEqual({
      epicId: "epic-1",
      sha256: MEDIA_SHA,
      want: { kind: "url" },
    });
    expect(spans).toEqual([]);
    expect(mocks.createdUrls).toEqual([]);
  });

  it("renews the signed URL when Retry is pressed after a playback error", async () => {
    const refetch = vi.fn<(...args: unknown[]) => unknown>();
    mocks.hostQuery = {
      data: { kind: "url", url: SIGNED, expiresAt: Date.now() + 60_000 },
      isPending: false,
      refetch,
    };
    const { readSpan } = recordedMediaSpans();
    const { container } = renderViewer(
      "clip.mp4",
      mediaObject("published", "video/mp4"),
      readSpan,
    );
    const player = container.querySelector("video");
    if (player === null) throw new Error("expected a video");

    fireEvent.error(player);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // The failure is surfaced to Retry itself, so it can stay on screen.
    await waitFor(() =>
      expect(refetch).toHaveBeenCalledWith({ throwOnError: true }),
    );
    await waitFor(() =>
      expect(container.querySelector("video")).not.toBeNull(),
    );
  });

  it("asks for no URL while the object is still queued, then plays it once the same sha is published", async () => {
    mocks.urlResponse = {
      kind: "url",
      url: SIGNED,
      expiresAt: Date.now() + 60_000,
    };
    const { readSpan } = recordedMediaSpans();
    const queued = mediaObject("queued", "video/mp4");
    const { container, rerenderWith } = renderViewer(
      "clip.mp4",
      queued,
      readSpan,
    );

    // The viewer has rendered with its URL query disabled, waiting on the publish.
    await screen.findByText("Loading media…");
    // Nothing is published to sign yet, so asking would be answered with an
    // unavailable result that a later publish would not refresh.
    expect(mocks.urlRequests).toEqual([]);
    expect(container.querySelector("video")).toBeNull();

    rerenderWith("clip.mp4", { ...queued, status: "published" }, readSpan);

    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe(
        SIGNED,
      ),
    );
    expect(mocks.urlRequests).toHaveLength(1);
  });

  it("asks the host for a fresh URL before the signed one expires", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const refetch = vi.fn<(...args: unknown[]) => unknown>();
      mocks.hostQuery = {
        data: { kind: "url", url: SIGNED, expiresAt: Date.now() + 10_000 },
        isPending: false,
        refetch,
      };
      const { readSpan } = recordedMediaSpans();
      renderViewer("clip.mp4", mediaObject("published", "video/mp4"), readSpan);

      vi.advanceTimersByTime(7_000);
      expect(refetch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_500);

      expect(refetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
