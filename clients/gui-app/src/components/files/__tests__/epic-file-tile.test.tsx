import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type {
  EpicReadFileRequest,
  EpicReadFileResponse,
  EpicStateFileRecord,
} from "@traycer/protocol/host/epic/files";
import type {
  IFileSaveHost,
  UrlDownloadRequest,
} from "@traycer-clients/shared/platform/runner-host";
import { EpicFileTile } from "@/components/files/epic-file-tile";
import type { HostReachability } from "@/hooks/agent/use-host-reachability";
import {
  EpicFileRpcContext,
  type EpicFileRpc,
} from "@/lib/files/epic-file-rpc";
import { makeEpicFileTileRef } from "@/stores/epics/canvas/tile-schema/epic-file-tile";

const HOST_ID = "host-1";
const OTHER_HOST_ID = "host-2";
const SHA = "a".repeat(64);
const MIB = 1024 * 1024;

const mocks = vi.hoisted(() => {
  const current: HostReachability = {
    status: "reachable",
    hostLabel: "Studio Mac",
    unavailability: null,
    basis: "directory",
    hostKind: "local",
  };
  const fileSave: { current: IFileSaveHost | null } = { current: null };
  const handle: {
    current: {
      readonly hostId: string;
      readonly records: readonly EpicStateFileRecord[];
    } | null;
  } = { current: null };
  return {
    reachability: { current },
    fileSave,
    handle,
    downloadBlobToDevice:
      vi.fn<(blob: Blob, name: string, fileSave: unknown) => Promise<null>>(),
    toastError: vi.fn<(title: string, options: unknown) => void>(),
  };
});

vi.mock(
  "@/components/epic-canvas/hooks/use-tab-host-id",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-canvas/hooks/use-tab-host-id")
    >()),
    useTabHostId: () => HOST_ID,
  }),
);

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => mocks.reachability.current,
}));

vi.mock("@/hooks/files/use-file-save-host", () => ({
  useFileSaveHost: () => mocks.fileSave.current,
}));

// The epic session serves the files lane - and its `localState` - for the
// CANVAS's host, which a test sets apart from the tile's.
vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => {
    const handle = mocks.handle.current;
    if (handle === null) return null;
    const state = { files: { served: true, records: handle.records } };
    return {
      hostId: handle.hostId,
      store: { subscribe: () => () => {}, getState: () => state },
    };
  },
}));

// The device save is the one effect jsdom cannot perform.
vi.mock("@/lib/files/save-blob-to-disk", () => ({
  canDownloadToDevice: () => true,
  canOpenSavedFile: () => false,
  downloadBlobToDevice: mocks.downloadBlobToDevice,
  saveBlobToDisk: mocks.downloadBlobToDevice,
  openSavedFile: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}));

// jsdom runs no frame; a box stands in for the running page.
vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: { readonly html: string }) => (
    <div data-testid="sandbox-frame">{props.html}</div>
  ),
}));

const PAGE: EpicReadFileResponse = {
  kind: "text",
  text: "<h1>Report</h1>",
  mediaType: "text/html",
  networkPolicy: "open",
};

type ReadAnswer = (request: EpicReadFileRequest) => EpicReadFileResponse;

function makeRpc(answer: ReadAnswer): EpicFileRpc {
  return {
    readFile: vi
      .fn<EpicFileRpc["readFile"]>()
      .mockImplementation((request) => Promise.resolve(answer(request))),
    fetchFile: vi
      .fn<EpicFileRpc["fetchFile"]>()
      .mockResolvedValue({ kind: "present" }),
    cancelFetchFile: vi
      .fn<EpicFileRpc["cancelFetchFile"]>()
      .mockResolvedValue({ cancelled: true }),
  };
}

function bytes(text: string, totalBytes: number): EpicReadFileResponse {
  return {
    kind: "bytes",
    bytesBase64: btoa(text),
    offset: 0,
    totalBytes,
    mediaType: "application/octet-stream",
  };
}

function setReachability(status: HostReachability["status"]): void {
  mocks.reachability.current = {
    ...mocks.reachability.current,
    status,
    unavailability: null,
  };
}

function tile(path: string): ReactNode {
  return (
    <EpicFileTile
      node={makeEpicFileTileRef({
        path,
        sha256: SHA,
        name: "Report",
        hostId: HOST_ID,
        via: null,
      })}
      epicId="epic-1"
    />
  );
}

function renderTile(path: string, rpc: EpicFileRpc) {
  const client = new QueryClient();
  const wrap = (children: ReactNode): ReactNode => (
    <QueryClientProvider client={client}>
      <EpicFileRpcContext.Provider value={rpc}>
        {children}
      </EpicFileRpcContext.Provider>
    </QueryClientProvider>
  );
  const view = render(wrap(tile(path)));
  return {
    rerender: (): void => view.rerender(wrap(tile(path))),
  };
}

function rangeReads(rpc: EpicFileRpc): number {
  return vi
    .mocked(rpc.readFile)
    .mock.calls.filter(([request]) => request.want.kind === "range").length;
}

beforeEach(() => {
  mocks.fileSave.current = null;
  mocks.handle.current = null;
  mocks.downloadBlobToDevice.mockReset();
  mocks.downloadBlobToDevice.mockResolvedValue(null);
  mocks.toastError.mockReset();
});

afterEach(() => {
  cleanup();
  setReachability("reachable");
});

describe("<EpicFileTile /> when its host goes away", () => {
  it("keeps the loaded page running under a notice, with the host's actions disabled", async () => {
    const view = renderTile(
      "files/pages/report.html",
      makeRpc(() => PAGE),
    );
    const frame = await screen.findByTestId("sandbox-frame");

    setReachability("unreachable");
    view.rerender();

    expect(screen.getByTestId("sandbox-frame")).toBe(frame);
    expect(screen.getByTestId("epic-file-tile-offline").textContent).toContain(
      "Studio Mac",
    );
    expect(screen.getByRole("button", { name: "Download" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("<EpicFileTile /> Download", () => {
  it("copies a file with no viewer onto the host, then reads and saves it", async () => {
    let copied = false;
    const rpc = makeRpc((request) => {
      if (request.want.kind === "url") {
        return { kind: "unavailable", reason: "upload-pending" };
      }
      return copied
        ? bytes("payload", 7)
        : { kind: "unavailable", reason: "not-downloaded" };
    });
    vi.mocked(rpc.fetchFile).mockImplementation(() => {
      copied = true;
      return Promise.resolve({ kind: "present" });
    });
    renderTile("files/data.bin", rpc);
    expect(screen.getByText("No preview for this file.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(mocks.downloadBlobToDevice).toHaveBeenCalled());
    const [blob, name] = mocks.downloadBlobToDevice.mock.calls[0];
    expect(name).toBe("data.bin");
    expect(await blob.text()).toBe("payload");
    expect(rpc.fetchFile).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("downloads a published video by its signed URL, natively, even when it is not on the host", async () => {
    const downloadUrl = vi
      .fn<(request: UrlDownloadRequest) => Promise<null>>()
      .mockResolvedValue(null);
    mocks.fileSave.current = {
      saveFile: vi.fn(),
      openSavedFile: null,
      downloadFile: null,
      saveRoute: "download",
      downloadUrl,
    };
    const rpc = makeRpc((request) =>
      request.want.kind === "url"
        ? {
            kind: "url",
            url: "https://files.example/demo.mp4?sig=1",
            expiresAt: Date.now() + 3_600_000,
          }
        : { kind: "unavailable", reason: "not-downloaded" },
    );
    renderTile("files/demo.mp4", rpc);
    await screen.findByTestId("epic-file-video");

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(downloadUrl).toHaveBeenCalledTimes(1));
    expect(downloadUrl.mock.calls[0]?.[0]).toEqual({
      url: "https://files.example/demo.mp4?sig=1",
      name: "demo.mp4",
      type: "application/octet-stream",
    });
    expect(rangeReads(rpc)).toBe(0);
    expect(rpc.fetchFile).not.toHaveBeenCalled();
    expect(mocks.downloadBlobToDevice).not.toHaveBeenCalled();
  });

  it("cancels a download still waiting on the host's copy, and stops the copy", async () => {
    const rpc = makeRpc((request) =>
      request.want.kind === "url"
        ? { kind: "unavailable", reason: "upload-pending" }
        : { kind: "unavailable", reason: "not-downloaded" },
    );
    vi.mocked(rpc.fetchFile).mockResolvedValue({ kind: "downloading" });
    renderTile("files/data.bin", rpc);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(rpc.fetchFile).toHaveBeenCalled());
    fireEvent.click(cancel);

    await waitFor(() => expect(rpc.cancelFetchFile).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Download" });
    expect(mocks.downloadBlobToDevice).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("refuses an unpublished file past the in-memory cap until its upload finishes", async () => {
    const rpc = makeRpc((request) =>
      request.want.kind === "url"
        ? { kind: "unavailable", reason: "upload-pending" }
        : bytes("x", 600 * MIB),
    );
    renderTile("files/data.bin", rpc);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError.mock.calls[0]).toEqual([
      "Couldn't download data.bin",
      { description: "Download available once the upload finishes" },
    ]);
    expect(rangeReads(rpc)).toBe(1);
    expect(mocks.downloadBlobToDevice).not.toHaveBeenCalled();
  });
});

describe("<EpicFileTile /> Download of an HTML file", () => {
  const DOCUMENT =
    '<!doctype html><html lang="en"><head><title>Report</title></head>' +
    "<body><h1>Report</h1></body></html>";
  const html = (text: string): EpicReadFileResponse => ({
    kind: "text",
    text,
    mediaType: "text/html",
    networkPolicy: "open",
  });

  async function downloadedText(path: string): Promise<string> {
    renderTile(
      path,
      makeRpc(() => html(DOCUMENT)),
    );
    await screen.findByTestId("sandbox-frame");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(mocks.downloadBlobToDevice).toHaveBeenCalled());
    const [blob] = mocks.downloadBlobToDevice.mock.calls[0];
    return blob.text();
  }

  it("saves an agent page with the reader's live theme first in its head and its body unchanged", async () => {
    document.documentElement.style.setProperty("--background", "rgb(1, 2, 3)");
    onTestFinished(() => {
      document.documentElement.style.removeProperty("--background");
    });

    const text = await downloadedText("files/pages/report.html");

    const head = '<!doctype html><html lang="en"><head>';
    expect(text.startsWith(`${head}<style>:root{color-scheme:`)).toBe(true);
    expect(text).toContain("background:rgb(1, 2, 3);");
    expect(text).toContain("--color-background-primary:rgb(1, 2, 3);");
    expect(text.slice(text.indexOf("</style>"))).toBe(
      `</style>${DOCUMENT.slice(head.length)}`,
    );
  });

  it.each(["files/mcp-apps/weather-1.html", "files/report.html"])(
    "saves %s byte-identical: only an agent page is themed",
    async (path) => {
      expect(await downloadedText(path)).toBe(DOCUMENT);
    },
  );
});

describe("<EpicFileTile /> availability is the tile host's", () => {
  const PATH = "files/shot.png";
  const copyingOnLaneHost: EpicStateFileRecord = {
    path: PATH,
    entry: {
      v: 1,
      kind: "file",
      sha256: SHA,
      byteLength: 100,
      mediaType: "image/png",
      status: "queued",
      createdAt: 1000,
      derivedFrom: null,
      title: null,
      deletedAt: null,
    },
    localState: { kind: "downloading", received: 50, total: 100 },
  };
  const absent = (): EpicFileRpc =>
    makeRpc(() => ({ kind: "unavailable", reason: "not-downloaded" }));

  it("ignores the lane's progress when the canvas is served by another host", async () => {
    mocks.handle.current = {
      hostId: OTHER_HOST_ID,
      records: [copyingOnLaneHost],
    };
    renderTile(PATH, absent());

    await screen.findByTestId("epic-file-not-downloaded");

    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("button", { name: "Download 100 B" })).toBeTruthy();
  });

  it("shows the lane's progress when the lane is the tile's host", async () => {
    mocks.handle.current = { hostId: HOST_ID, records: [copyingOnLaneHost] };
    renderTile(PATH, absent());

    await screen.findByTestId("epic-file-not-downloaded");

    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "50",
    );
  });

  it("shows a copy it started from the tile host's own answer when the lane cannot say", async () => {
    mocks.handle.current = {
      hostId: OTHER_HOST_ID,
      records: [copyingOnLaneHost],
    };
    const rpc = absent();
    vi.mocked(rpc.fetchFile).mockResolvedValue({ kind: "downloading" });
    renderTile(PATH, rpc);

    fireEvent.click(
      await screen.findByRole("button", { name: "Download 100 B" }),
    );

    await screen.findByText(/Downloading to this device/);
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(
      false,
    );
  });

  it("shows Download again when the lane's host stops copying, and it works again", async () => {
    const laneSays = (localState: EpicStateFileRecord["localState"]): void => {
      mocks.handle.current = {
        hostId: HOST_ID,
        records: [{ ...copyingOnLaneHost, localState }],
      };
    };
    laneSays({ kind: "absent" });
    const rpc = absent();
    vi.mocked(rpc.fetchFile).mockResolvedValue({ kind: "downloading" });
    const view = renderTile(PATH, rpc);

    fireEvent.click(
      await screen.findByRole("button", { name: "Download 100 B" }),
    );
    laneSays({ kind: "downloading", received: 50, total: 100 });
    view.rerender();
    await screen.findByRole("progressbar");

    laneSays({ kind: "absent" });
    view.rerender();

    fireEvent.click(
      await screen.findByRole("button", { name: "Download 100 B" }),
    );
    await waitFor(() => expect(rpc.fetchFile).toHaveBeenCalledTimes(2));
    await screen.findByText(/Downloading to this device/);
  });

  it("shows Download again when the lane never saw the copy start", async () => {
    mocks.handle.current = {
      hostId: HOST_ID,
      records: [{ ...copyingOnLaneHost, localState: { kind: "absent" } }],
    };
    const rpc = absent();
    vi.mocked(rpc.fetchFile).mockResolvedValue({ kind: "downloading" });
    renderTile(PATH, rpc);

    fireEvent.click(
      await screen.findByRole("button", { name: "Download 100 B" }),
    );
    await screen.findByText(/Downloading to this device/);

    await screen.findByRole(
      "button",
      { name: "Download 100 B" },
      { timeout: 4_000 },
    );
  });
});
