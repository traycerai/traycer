import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import type { EpicReadFileResponse } from "@traycer/protocol/host/epic/files";
import type {
  ToolCallPageStamp,
  ToolInputDetail,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  ChatAttachmentScopeContext,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import { ChatScrollToPageContext } from "@/components/chat/chat-scroll-to-block";
import { PageRow } from "@/components/chat/segments/page-row";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import {
  EpicFileRpcContext,
  type EpicFileRpc,
} from "@/lib/files/epic-file-rpc";
import type { SandboxStatus } from "@/lib/sandbox/bridge-host";
import type { SandboxNetworkPolicy } from "@/lib/sandbox/mcp-csp";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import { TILE_KIND_EPIC_FILE } from "@/stores/epics/canvas/tile-kinds";

const mocks = vi.hoisted(() => ({
  openTile: vi.fn<(intent: TileOpenIntent) => null>(),
  openLinkIn: vi.fn<(url: string, destination: string) => void>(),
  downloadBlobToDevice:
    vi.fn<(blob: Blob, name: string, fileSave: unknown) => Promise<null>>(),
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: mocks.openTile }),
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLinkIn: () => ({
    openLinkIn: mocks.openLinkIn,
    canOpenInApp: true,
  }),
}));

// The device save is the one effect jsdom cannot perform.
vi.mock("@/lib/files/save-blob-to-disk", () => ({
  canDownloadToDevice: () => true,
  downloadBlobToDevice: mocks.downloadBlobToDevice,
  saveBlobToDisk: mocks.downloadBlobToDevice,
}));

// jsdom has no iframe document to run a page in; the frame is stood in by a
// box that shows what the viewer hands it and can report a crash.
vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: {
    readonly html: string;
    readonly kind: string;
    readonly networkPolicy: SandboxNetworkPolicy;
    readonly height: number | null;
    readonly onStatus: (status: SandboxStatus) => void;
  }) => (
    <div
      data-testid="sandbox-frame"
      data-kind={props.kind}
      data-network-policy={props.networkPolicy}
      data-height={props.height === null ? "fill" : String(props.height)}
    >
      {props.html}
      <button type="button" onClick={() => props.onStatus("crashed")}>
        crash the page
      </button>
    </div>
  ),
}));

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const HOST_ID = "host-1";
const BLOCK_ID = "block-1";
const PAGE_HTML = "<h1>Quarterly report</h1>";
const ROW_WIDTH_PX = 700;

const SCOPE: ChatAttachmentScopeValue = {
  epicId: EPIC_ID,
  chatId: CHAT_ID,
  hostId: HOST_ID,
  hostVersion: null,
  client: null,
};

const STAMP: ToolCallPageStamp = {
  path: "files/pages/report-1.html",
  sha256: "a".repeat(64),
  title: "Quarterly report",
  height: 320,
  heights: [
    { width: 400, height: 300 },
    { width: 800, height: 520 },
  ],
  derivedFrom: null,
  originChatId: CHAT_ID,
};

const textResponse = (
  networkPolicy: SandboxNetworkPolicy,
): EpicReadFileResponse => ({
  kind: "text",
  text: PAGE_HTML,
  mediaType: "text/html",
  networkPolicy,
});

type ReadFile = EpicFileRpc["readFile"];
type OpenFileInBrowser = EpicFileRpc["openFileInBrowser"];
type FetchFile = EpicFileRpc["fetchFile"];
type CancelFetchFile = EpicFileRpc["cancelFetchFile"];

interface FakeRpc extends EpicFileRpc {
  readonly readFile: Mock<ReadFile>;
  readonly openFileInBrowser: Mock<OpenFileInBrowser>;
  readonly fetchFile: Mock<FetchFile>;
  readonly cancelFetchFile: Mock<CancelFetchFile>;
}

function makeRpc(
  read: EpicReadFileResponse | Promise<EpicReadFileResponse>,
): FakeRpc {
  const readFile = vi
    .fn<ReadFile>()
    .mockImplementation(() => Promise.resolve(read));
  const openFileInBrowser = vi.fn<OpenFileInBrowser>().mockResolvedValue({
    kind: "url",
    url: "http://127.0.0.1:4000/page/t",
  });
  const fetchFile = vi
    .fn<FetchFile>()
    .mockResolvedValue({ kind: "downloading" });
  const cancelFetchFile = vi
    .fn<CancelFetchFile>()
    .mockResolvedValue({ cancelled: true });
  return { readFile, openFileInBrowser, fetchFile, cancelFetchFile };
}

interface RowOverrides {
  readonly page: ToolCallPageStamp | null;
  readonly isStreaming: boolean;
  readonly stopped: boolean;
  readonly error: string | null;
  readonly inputSummary: string | null;
  readonly inputDetail: ToolInputDetail | null;
}

const SHOWN: RowOverrides = {
  page: STAMP,
  isStreaming: false,
  stopped: false,
  error: null,
  inputSummary: null,
  inputDetail: null,
};

function renderRow(
  rpc: EpicFileRpc,
  row: RowOverrides,
  scrollToPage: ((pageRef: string) => boolean) | null,
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });
  const wrap = (children: ReactNode): ReactNode => (
    <QueryClientProvider client={client}>
      <ResolvedThemeContext.Provider
        value={{ resolvedTheme: "light", themePreset: "traycer-green" }}
      >
        <ChatAttachmentScopeContext.Provider value={SCOPE}>
          <ChatScrollToPageContext.Provider value={scrollToPage}>
            <EpicFileRpcContext.Provider value={rpc}>
              {children}
            </EpicFileRpcContext.Provider>
          </ChatScrollToPageContext.Provider>
        </ChatAttachmentScopeContext.Provider>
      </ResolvedThemeContext.Provider>
    </QueryClientProvider>
  );
  render(
    wrap(
      <PageRow
        id={BLOCK_ID}
        page={row.page}
        inputSummary={row.inputSummary}
        inputDetail={row.inputDetail}
        error={row.error}
        isStreaming={row.isStreaming}
        stopped={row.stopped}
        startedAt={Date.now()}
        fallback={<div data-testid="ordinary-tool-row" />}
      />,
    ),
  );
}

beforeEach(() => {
  // jsdom lays nothing out; the row measures its width to pick a stamped height.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(
    ROW_WIDTH_PX,
  );
  mocks.downloadBlobToDevice.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.openTile.mockReset();
  mocks.openLinkIn.mockReset();
  mocks.downloadBlobToDevice.mockReset();
});

describe("<PageRow /> while the agent writes the page", () => {
  it("shows Building page with the title the agent passed", () => {
    renderRow(
      makeRpc(textResponse("open")),
      {
        ...SHOWN,
        page: null,
        isStreaming: true,
        inputDetail: {
          kind: "fields",
          entries: [{ key: "title", label: "Title", value: "Q3 numbers" }],
        },
      },
      null,
    );

    expect(screen.getByTestId("page-row-building").textContent).toContain(
      "Building page: Q3 numbers",
    );
    expect(screen.queryByTestId("page-row")).toBeNull();
  });
});

describe("<PageRow /> when the call failed", () => {
  it("shows the error the agent saw", () => {
    renderRow(
      makeRpc(textResponse("open")),
      { ...SHOWN, page: null, error: "html is empty" },
      null,
    );

    expect(screen.getByTestId("page-row-failed").textContent).toContain(
      "html is empty",
    );
  });

  it("leaves a stopped call to the ordinary tool row", () => {
    renderRow(
      makeRpc(textResponse("open")),
      { ...SHOWN, page: null, stopped: true, error: "interrupted" },
      null,
    );

    expect(screen.getByTestId("ordinary-tool-row")).toBeTruthy();
    expect(screen.queryByTestId("page-row-failed")).toBeNull();
  });
});

describe("<PageRow /> showing the page", () => {
  it("renders the page in the frame with the host's network policy and asks for it via the row", async () => {
    const rpc = makeRpc(textResponse("https-only"));
    renderRow(rpc, SHOWN, null);

    const frame = await screen.findByTestId("sandbox-frame");
    expect(frame.getAttribute("data-kind")).toBe("page");
    expect(frame.getAttribute("data-network-policy")).toBe("https-only");
    expect(frame.textContent).toContain(PAGE_HTML);
    expect(rpc.readFile).toHaveBeenCalledWith(
      {
        epicId: EPIC_ID,
        path: STAMP.path,
        sha256: STAMP.sha256,
        via: { chatId: CHAT_ID, blockId: BLOCK_ID },
        want: { kind: "text" },
      },
      expect.any(AbortSignal),
    );
  });

  it("holds a skeleton at the stamped height nearest the row's width until the page loads", async () => {
    let resolveRead: (response: EpicReadFileResponse) => void = () => undefined;
    const pending = new Promise<EpicReadFileResponse>((resolve) => {
      resolveRead = resolve;
    });
    renderRow(makeRpc(pending), SHOWN, null);

    // 700px is nearer the 800px measurement (520) than the 400px one (300).
    const skeleton = await screen.findByTestId("page-skeleton");
    expect(skeleton.style.height).toBe("520px");

    resolveRead(textResponse("open"));
    const frame = await screen.findByTestId("sandbox-frame");
    expect(frame.getAttribute("data-height")).toBe("520");
    expect(screen.queryByTestId("page-skeleton")).toBeNull();
  });

  it("falls back to the agent's own height when nothing was measured", async () => {
    renderRow(
      makeRpc(textResponse("open")),
      { ...SHOWN, page: { ...STAMP, heights: [] } },
      null,
    );

    const frame = await screen.findByTestId("sandbox-frame");
    expect(frame.getAttribute("data-height")).toBe("320");
  });

  it("captions an edited page and scrolls to the one it replaced", async () => {
    const scrollToPage = vi
      .fn<(pageRef: string) => boolean>()
      .mockReturnValue(true);
    const derivedFrom = `files/pages/report-0.html@${"b".repeat(64)}`;
    renderRow(
      makeRpc(textResponse("open")),
      { ...SHOWN, page: { ...STAMP, derivedFrom } },
      scrollToPage,
    );

    const caption = await screen.findByText(/Updated from/);
    expect(caption.textContent).toContain("an earlier page");
    fireEvent.click(screen.getByRole("button", { name: "an earlier page" }));
    expect(scrollToPage).toHaveBeenCalledWith(derivedFrom);
    expect(mocks.openTile).not.toHaveBeenCalled();
  });

  it.each([
    ["its row is not loaded", vi.fn<(pageRef: string) => boolean>(() => false)],
    ["there is no transcript to scroll", null],
  ])(
    "opens the earlier version in the file tile when %s",
    async (_case, scrollToPage) => {
      const sha = "b".repeat(64);
      renderRow(
        makeRpc(textResponse("open")),
        {
          ...SHOWN,
          page: { ...STAMP, derivedFrom: `files/pages/report-0.html@${sha}` },
        },
        scrollToPage,
      );

      fireEvent.click(
        await screen.findByRole("button", { name: "an earlier page" }),
      );

      const intent = mocks.openTile.mock.calls.at(0)?.[0];
      expect(intent?.node).toMatchObject({
        type: TILE_KIND_EPIC_FILE,
        path: "files/pages/report-0.html",
        sha256: sha,
        hostId: HOST_ID,
        via: null,
      });
    },
  );

  it("captions an edited page as plain text when its reference does not parse", async () => {
    renderRow(
      makeRpc(textResponse("open")),
      { ...SHOWN, page: { ...STAMP, derivedFrom: "files/pages/a.html@x" } },
      null,
    );

    expect((await screen.findByText(/Updated from/)).textContent).toContain(
      "an earlier page",
    );
    expect(
      screen.queryByRole("button", { name: "an earlier page" }),
    ).toBeNull();
  });

  it("has no caption for an original page", async () => {
    renderRow(makeRpc(textResponse("open")), SHOWN, null);
    await screen.findByTestId("sandbox-frame");

    expect(screen.queryByText(/Updated from/)).toBeNull();
  });
});

describe("<PageRow /> when the page cannot be read", () => {
  it("says it is still uploading, and Retry asks the host again", async () => {
    const rpc = makeRpc(textResponse("open"));
    rpc.readFile.mockResolvedValueOnce({
      kind: "unavailable",
      reason: "upload-pending",
    });
    renderRow(rpc, SHOWN, null);

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("Still uploading");
    expect(screen.queryByTestId("sandbox-frame")).toBeNull();

    fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId("sandbox-frame")).toBeTruthy();
    expect(rpc.readFile).toHaveBeenCalledTimes(2);
    expect(rpc.fetchFile).not.toHaveBeenCalled();
  });

  it("offers Download for a page too big to mirror, which copies it over and reads it again", async () => {
    const rpc = makeRpc(textResponse("open"));
    rpc.readFile.mockResolvedValueOnce({
      kind: "unavailable",
      reason: "not-downloaded",
    });
    rpc.fetchFile.mockResolvedValueOnce({ kind: "present" });
    renderRow(rpc, SHOWN, null);

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("Not on this device yet");
    expect(within(notice).queryByRole("button", { name: "Retry" })).toBeNull();

    fireEvent.click(within(notice).getByRole("button", { name: "Download" }));

    expect(await screen.findByTestId("sandbox-frame")).toBeTruthy();
    expect(rpc.fetchFile).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      path: STAMP.path,
      sha256: STAMP.sha256,
    });
    expect(rpc.readFile).toHaveBeenCalledTimes(2);
  });

  it("says the copy is running while the host is still downloading it", async () => {
    const rpc = makeRpc({ kind: "unavailable", reason: "not-downloaded" });
    renderRow(rpc, SHOWN, null);

    const notice = await screen.findByRole("status");
    fireEvent.click(within(notice).getByRole("button", { name: "Download" }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "Copying it to this device",
      );
    });
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });
});

describe("<PageRow /> when the page crashes", () => {
  it("offers Reload, which mounts the page again", async () => {
    const rpc = makeRpc(textResponse("open"));
    renderRow(rpc, SHOWN, null);

    fireEvent.click(
      await screen.findByRole("button", { name: "crash the page" }),
    );

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("This page stopped responding");
    expect(screen.queryByTestId("sandbox-frame")).toBeNull();

    fireEvent.click(within(notice).getByRole("button", { name: "Reload" }));

    expect(await screen.findByTestId("sandbox-frame")).toBeTruthy();
    // The bytes are content-addressed; Reload remounts the frame, it does not
    // fetch them again.
    expect(rpc.readFile).toHaveBeenCalledTimes(1);
  });

  it("offers Open in browser, which opens the page on the host's loopback in-app", async () => {
    const rpc = makeRpc(textResponse("open"));
    renderRow(rpc, SHOWN, null);

    fireEvent.click(
      await screen.findByRole("button", { name: "crash the page" }),
    );
    const notice = await screen.findByRole("status");
    fireEvent.click(
      within(notice).getByRole("button", { name: /Open in browser/ }),
    );

    await waitFor(() => {
      expect(mocks.openLinkIn).toHaveBeenCalledWith(
        "http://127.0.0.1:4000/page/t",
        "in-app",
      );
    });
  });
});

describe("<PageRow /> hover bar", () => {
  it("Open in browser asks the host for a page URL and opens it in-app", async () => {
    const rpc = makeRpc(textResponse("open"));
    renderRow(rpc, SHOWN, null);
    await screen.findByTestId("sandbox-frame");

    const toolbar = screen.getByRole("toolbar", { name: "Page actions" });
    fireEvent.click(
      within(toolbar).getByRole("button", { name: "Open in browser" }),
    );

    await waitFor(() => {
      expect(mocks.openLinkIn).toHaveBeenCalledWith(
        "http://127.0.0.1:4000/page/t",
        "in-app",
      );
    });
    expect(rpc.openFileInBrowser).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      path: STAMP.path,
      sha256: STAMP.sha256,
      via: { chatId: CHAT_ID, blockId: BLOCK_ID },
    });
  });

  it("Download HTML saves the page it already read, named after the file", async () => {
    const rpc = makeRpc(textResponse("open"));
    renderRow(rpc, SHOWN, null);
    await screen.findByTestId("sandbox-frame");

    const toolbar = screen.getByRole("toolbar", { name: "Page actions" });
    fireEvent.click(
      within(toolbar).getByRole("button", { name: "Download HTML" }),
    );

    await waitFor(() => {
      expect(mocks.downloadBlobToDevice).toHaveBeenCalledTimes(1);
    });
    const [blob, name] = mocks.downloadBlobToDevice.mock.calls[0] ?? [];
    expect(name).toBe("report-1.html");
    expect(await readBlobText(blob)).toBe(PAGE_HTML);
    expect(rpc.readFile).toHaveBeenCalledTimes(1);
  });

  it("Expand opens the epic-file tile, carrying the row it was opened from", async () => {
    renderRow(makeRpc(textResponse("open")), SHOWN, null);
    await screen.findByTestId("sandbox-frame");

    const toolbar = screen.getByRole("toolbar", { name: "Page actions" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Expand" }));

    expect(mocks.openTile).toHaveBeenCalledTimes(1);
    const call = mocks.openTile.mock.calls.at(0);
    if (call === undefined) throw new Error("no tile was opened");
    const [intent] = call;
    expect(intent.target).toEqual({ epicId: EPIC_ID });
    expect(intent.node).toMatchObject({
      type: TILE_KIND_EPIC_FILE,
      path: STAMP.path,
      sha256: STAMP.sha256,
      name: STAMP.title,
      hostId: HOST_ID,
      via: { chatId: CHAT_ID, blockId: BLOCK_ID },
    });
  });
});

describe("<PageRow /> on a coarse pointer", () => {
  it("opens an actions sheet from the … button and runs the chosen action", async () => {
    renderRow(makeRpc(textResponse("open")), SHOWN, null);
    await screen.findByTestId("sandbox-frame");
    expect(screen.queryByTestId("page-actions-sheet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Page actions" }));
    const sheet = await screen.findByTestId("page-actions-sheet");
    expect(sheet.textContent).toContain("Quarterly report");

    fireEvent.click(
      within(sheet).getByRole("button", { name: "Open full screen" }),
    );

    expect(mocks.openTile).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByTestId("page-actions-sheet")).toBeNull();
    });
    // Expand moved on to the tile; the … button does not pull focus back.
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "Page actions" }),
    );
  });

  it("moves focus into the sheet, and back to the … button when it is dismissed", async () => {
    renderRow(makeRpc(textResponse("open")), SHOWN, null);
    await screen.findByTestId("sandbox-frame");
    const opener = screen.getByRole("button", { name: "Page actions" });

    fireEvent.click(opener);
    const sheet = await screen.findByTestId("page-actions-sheet");
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(sheet).getByRole("button", { name: "Open full screen" }),
      );
    });

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    await waitFor(() => {
      expect(screen.queryByTestId("page-actions-sheet")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });
});

function readBlobText(blob: Blob | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    if (blob === undefined) {
      reject(new Error("no blob was saved"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("blob did not read as text"));
    };
    reader.onerror = () => reject(new Error("blob could not be read"));
    reader.readAsText(blob);
  });
}
