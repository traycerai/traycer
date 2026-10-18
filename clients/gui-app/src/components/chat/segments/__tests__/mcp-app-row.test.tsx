import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, type ReactNode } from "react";
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
  ChatMcpAppCallToolRequest,
  ChatMcpAppCallToolResponse,
  ChatMcpAppReadResourceRequest,
  ChatMcpAppReadResourceResponse,
  ChatMcpAppUpdateModelContextRequest,
  ChatMcpAppUpdateModelContextResponse,
} from "@traycer/protocol/host/chat/mcp-app";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  McpUiCspNormalized,
  ToolCallMcpAppStamp,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  ChatAttachmentScopeContext,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import { AppMessageDraftPill } from "@/components/chat/composer/app-message-draft-pill";
import { McpAppRow } from "@/components/chat/segments/mcp-app-row";
import { blockingLayerClaimed } from "@/components/layout/shell/blocking-layer-claim";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import {
  EpicFileRpcContext,
  type EpicFileRpc,
} from "@/lib/files/epic-file-rpc";
import {
  SandboxBridgeHost,
  type SandboxAppRequestHandler,
  type SandboxSize,
  type SandboxStatus,
} from "@/lib/sandbox/bridge-host";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { McpAppRpcContext, type McpAppRpc } from "@/lib/sandbox/mcp-app-rpc";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import {
  ResolvedThemeContext,
  type ResolvedThemeContextValue,
} from "@/providers/use-resolved-theme";

interface FrameProps {
  readonly html: string;
  readonly kind: string;
  readonly title: string;
  readonly networkPolicy: string;
  readonly appCsp: unknown;
  readonly appRequests: SandboxAppRequestHandler | null;
  readonly height: number | null;
  readonly onSize: (size: SandboxSize) => void;
  readonly onStatus: (status: SandboxStatus) => void;
  readonly onRequestTeardown: () => void;
  readonly onBridge: ((bridge: SandboxBridgeHost | null) => void) | null;
}

const mocks = vi.hoisted(() => {
  const frame: { props: FrameProps | null; mounts: number } = {
    props: null,
    mounts: 0,
  };
  return {
    openLink:
      vi.fn<(url: string, kind: string, event: null) => Promise<void>>(),
    frame,
  };
});

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => mocks.openLink,
}));

// jsdom has no iframe document to run an app in; the frame is stood in by a
// box that shows what the row hands it and keeps the request handler the
// sandbox bridge would call for the app.
function ignore(): void {}

/** A real bridge with nothing behind it, as a new frame document hands over. */
function detachedBridge(): SandboxBridgeHost {
  return new SandboxBridgeHost({
    resource: {
      html: "",
      kind: "app",
      networkPolicy: "https-only",
      csp: null,
      permissions: [],
      theme: {
        appliesToRoot: false,
        colorScheme: "dark",
        background: null,
        variables: {},
      },
      forwardedShortcuts: [],
    },
    nonce: "nonce",
    hostContext: {
      theme: "dark",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
      platform: "desktop",
    },
    hostVersion: "test",
    post: ignore,
    events: {
      onStatus: ignore,
      onSize: ignore,
      onOpenLink: () => Promise.resolve(false),
      onShortcut: ignore,
      onRequestTeardown: ignore,
      onScrollGesture: ignore,
      onWheel: ignore,
    },
    appRequests: null,
  });
}

// jsdom has no iframe document; a mounted stand-in counts as one frame
// document. Like the real frame, it hands the row a bridge when it mounts and
// `null` when it goes, once per mount and with the latest props.
function FrameDocument(props: FrameProps) {
  useLayoutEffect(() => {
    mocks.frame.props = props;
  });
  useEffect(() => {
    mocks.frame.mounts += 1;
    const bridge = detachedBridge();
    mocks.frame.props?.onBridge?.(bridge);
    return () => {
      bridge.dispose();
      mocks.frame.props?.onBridge?.(null);
    };
  }, []);
  return (
    <div data-testid="sandbox-frame" data-kind={props.kind}>
      {props.html}
    </div>
  );
}

vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: FrameDocument,
}));

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const HOST_ID = "host-1";
const BLOCK_ID = "block-1";
const SERVER = "Sheets";
const APP_HTML = "<main>budget</main>";

const SCOPE: ChatAttachmentScopeValue = {
  epicId: EPIC_ID,
  chatId: CHAT_ID,
  hostId: HOST_ID,
  hostVersion: null,
  client: null,
};

const CSP: McpUiCspNormalized = {
  connectDomains: ["https://api.example.com"],
  resourceDomains: [],
  frameDomains: [],
  baseUriDomains: [],
};

const STAMP: ToolCallMcpAppStamp = {
  server: SERVER,
  tool: "open_budget",
  resourceUri: "ui://sheets/budget",
  snapshot: { path: "files/mcp-apps/budget.html", sha256: "a".repeat(64) },
  csp: CSP,
  permissions: [],
  prefersBorder: false,
  toolInput: { year: 2026 },
  toolResult: { content: [{ type: "text", text: "ok" }] },
  source: {
    originChatId: CHAT_ID,
    harnessId: "claude",
    nativeSessionId: "session-1",
    serverKey: "b".repeat(64),
  },
  modelContext: null,
};

const TOOL_RESULT = { content: [{ type: "text", text: "42" }] };

const HTML_RESPONSE: EpicReadFileResponse = {
  kind: "text",
  text: APP_HTML,
  mediaType: "text/html",
  networkPolicy: "https-only",
};

interface FakeFileRpc extends EpicFileRpc {
  readonly readFile: Mock<EpicFileRpc["readFile"]>;
}

function makeFileRpc(
  read: EpicReadFileResponse | Promise<EpicReadFileResponse>,
): FakeFileRpc {
  return {
    readFile: vi
      .fn<EpicFileRpc["readFile"]>()
      .mockImplementation(() => Promise.resolve(read)),
    fetchFile: vi
      .fn<EpicFileRpc["fetchFile"]>()
      .mockResolvedValue({ kind: "downloading" }),
    cancelFetchFile: vi
      .fn<EpicFileRpc["cancelFetchFile"]>()
      .mockResolvedValue({ cancelled: true }),
  };
}

interface FakeMcpRpc extends McpAppRpc {
  readonly callTool: Mock<McpAppRpc["callTool"]>;
  readonly readResource: Mock<McpAppRpc["readResource"]>;
}

function makeMcpRpc(): FakeMcpRpc {
  return {
    callTool: vi
      .fn<
        (
          params: ChatMcpAppCallToolRequest,
        ) => Promise<ChatMcpAppCallToolResponse>
      >()
      .mockResolvedValue({ kind: "result", result: TOOL_RESULT }),
    readResource: vi
      .fn<
        (
          params: ChatMcpAppReadResourceRequest,
        ) => Promise<ChatMcpAppReadResourceResponse>
      >()
      .mockResolvedValue({ kind: "result", result: { contents: [] } }),
    updateModelContext: vi
      .fn<
        (
          params: ChatMcpAppUpdateModelContextRequest,
        ) => Promise<ChatMcpAppUpdateModelContextResponse>
      >()
      .mockResolvedValue({ kind: "updated" }),
  };
}

/** The touch actions sheet re-asserts the theme where it portals. */
const THEME: ResolvedThemeContextValue = {
  resolvedTheme: "light",
  themePreset: "traycer-green",
};

function renderRow(
  fileRpc: EpicFileRpc,
  mcpRpc: McpAppRpc,
  scope: ChatAttachmentScopeValue | null,
  app: ToolCallMcpAppStamp,
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });
  const wrap = (children: ReactNode): ReactNode => (
    <QueryClientProvider client={client}>
      <ResolvedThemeContext.Provider value={THEME}>
        <ChatAttachmentScopeContext.Provider value={scope}>
          <EpicFileRpcContext.Provider value={fileRpc}>
            <McpAppRpcContext.Provider value={mcpRpc}>
              {children}
            </McpAppRpcContext.Provider>
          </EpicFileRpcContext.Provider>
        </ChatAttachmentScopeContext.Provider>
      </ResolvedThemeContext.Provider>
    </QueryClientProvider>
  );
  render(
    wrap(
      <>
        <McpAppRow
          id={BLOCK_ID}
          app={app}
          fallback={<div data-testid="ordinary-tool-row" />}
        />
        <AppMessageDraftPill chatId={CHAT_ID} />
      </>,
    ),
  );
}

/** What the app inside the frame does: one JSON-RPC request to the host. */
function askAsApp(method: string, params: unknown): Promise<unknown> {
  const handler = mocks.frame.props?.appRequests ?? null;
  if (handler === null) throw new Error("the row gave the frame no handler");
  return handler(method, params);
}

async function renderRunningApp(
  mcpRpc: McpAppRpc,
  app: ToolCallMcpAppStamp,
): Promise<FakeFileRpc> {
  const fileRpc = makeFileRpc(HTML_RESPONSE);
  renderRow(fileRpc, mcpRpc, SCOPE, app);
  await screen.findByTestId("sandbox-frame");
  return fileRpc;
}

function paragraph(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** The frame props the row gave its current document. */
function frameProps(): FrameProps {
  const props = mocks.frame.props;
  if (props === null) throw new Error("no frame is mounted");
  return props;
}

beforeEach(() => {
  mocks.frame.props = null;
  mocks.frame.mounts = 0;
  mocks.openLink.mockResolvedValue(undefined);
  useComposerDraftStore.setState({ drafts: {} });
});

afterEach(() => {
  cleanup();
  setPhoneLayoutOnly(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.openLink.mockReset();
  useComposerDraftStore.setState({ drafts: {} });
});

describe("<McpAppRow /> running the app", () => {
  it("reads the stamped snapshot for this block and runs it in an app frame", async () => {
    const fileRpc = await renderRunningApp(makeMcpRpc(), STAMP);

    const frame = screen.getByTestId("sandbox-frame");
    expect(frame.getAttribute("data-kind")).toBe("app");
    expect(frame.textContent).toBe(APP_HTML);
    expect(mocks.frame.props).toMatchObject({
      networkPolicy: "https-only",
      appCsp: CSP,
    });
    expect(fileRpc.readFile).toHaveBeenCalledWith(
      {
        epicId: EPIC_ID,
        path: STAMP.snapshot.path,
        sha256: STAMP.snapshot.sha256,
        via: { chatId: CHAT_ID, blockId: BLOCK_ID },
        want: { kind: "text" },
      },
      expect.any(AbortSignal),
    );
    const row = screen.getByTestId("mcp-app-row");
    expect(row.textContent).toContain(SERVER);
    expect(row.textContent).toContain("open_budget");
  });

  it("draws a border around the app only when the app prefers one", async () => {
    await renderRunningApp(makeMcpRpc(), STAMP);
    expect(
      screen.getByTestId("sandbox-frame").parentElement?.className,
    ).not.toMatch(/\bborder\b/);
    cleanup();

    await renderRunningApp(makeMcpRpc(), { ...STAMP, prefersBorder: true });
    expect(
      screen.getByTestId("sandbox-frame").parentElement?.className,
    ).toMatch(/\bborder\b/);
  });
});

// jsdom has no popover; the row's fullscreen surface is one, so the calls are
// stood in for and the tests read the row's own state instead.
function stubPopover(): void {
  Object.defineProperty(HTMLElement.prototype, "showPopover", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "hidePopover", {
    configurable: true,
    value: () => undefined,
  });
}

/**
 * The … button, found past jsdom's `display: none` for a popover that is not
 * open: the row's surface is a manual popover that jsdom never shows.
 */
function appActionsButton(): HTMLElement {
  return screen.getByRole("button", { name: "App actions", hidden: true });
}

describe("<McpAppRow /> on a phone", () => {
  const INLINE_HEIGHT_PX = 160;
  const PHONE_HEIGHT_PX = 420;

  it("holds the app to a fixed 420 px box whatever height it reports", async () => {
    setPhoneLayoutOnly(true);
    await renderRunningApp(makeMcpRpc(), STAMP);
    expect(frameProps().height).toBe(PHONE_HEIGHT_PX);

    act(() => {
      frameProps().onSize({ width: null, height: 900 });
    });

    expect(frameProps().height).toBe(PHONE_HEIGHT_PX);
  });

  it("sizes the app to what it reports on a wide screen", async () => {
    await renderRunningApp(makeMcpRpc(), STAMP);
    expect(frameProps().height).toBe(INLINE_HEIGHT_PX);

    act(() => {
      frameProps().onSize({ width: null, height: 900 });
    });

    expect(frameProps().height).toBe(900);
  });

  it("offers the hover bar's actions in an App actions sheet, and Open full screen enters fullscreen", async () => {
    stubPopover();
    setPhoneLayoutOnly(true);
    await renderRunningApp(makeMcpRpc(), STAMP);
    expect(blockingLayerClaimed()).toBe(false);

    fireEvent.click(appActionsButton());
    const sheet = await screen.findByTestId("app-actions-sheet");
    expect(
      within(sheet)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Open full screen", "Reload app", "Show original tool call"]);

    fireEvent.click(
      within(sheet).getByRole("button", { name: "Open full screen" }),
    );

    await waitFor(() => {
      expect(frameProps().height).toBeNull();
    });
    expect(blockingLayerClaimed()).toBe(true);
  });

  it("leaves fullscreen on Escape and gives the back gesture back", async () => {
    stubPopover();
    setPhoneLayoutOnly(true);
    await renderRunningApp(makeMcpRpc(), STAMP);
    fireEvent.click(appActionsButton());
    fireEvent.click(
      within(await screen.findByTestId("app-actions-sheet")).getByRole(
        "button",
        { name: "Open full screen" },
      ),
    );
    await waitFor(() => {
      expect(blockingLayerClaimed()).toBe(true);
    });

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(blockingLayerClaimed()).toBe(false);
    });
    expect(frameProps().height).toBe(PHONE_HEIGHT_PX);
  });

  it("claims no blocking layer for an app that stays inline", async () => {
    await renderRunningApp(makeMcpRpc(), STAMP);

    expect(blockingLayerClaimed()).toBe(false);
  });
});

describe("<McpAppRow /> full screen from the keyboard", () => {
  it("moves focus to Exit, keeps Tab inside, leaves on one Escape over a tooltip, and gives focus back to Expand", async () => {
    stubPopover();
    await renderRunningApp(makeMcpRpc(), STAMP);
    // jsdom loads no stylesheet, so its UA rule hides the surface that the
    // row's own `block` class shows in a browser; nothing hidden takes focus.
    screen.getByLabelText("Sheets app").removeAttribute("popover");

    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    const exit = await screen.findByRole("button", {
      name: "Exit full screen",
    });
    expect(document.activeElement).toBe(exit);

    // Tab past either end of the surface lands on the page behind it, and is
    // sent round instead. (The stand-in frame has no iframe, so both ends of
    // the surface are Exit here.)
    const before = document.createElement("button");
    const after = document.createElement("button");
    document.body.prepend(before);
    document.body.append(after);
    for (const behind of [after, before]) {
      act(() => {
        behind.focus();
      });
      expect(document.activeElement).toBe(exit);
    }
    before.remove();
    after.remove();

    // A tooltip's layer answers Escape at the document and marks it handled;
    // the surface still leaves on that first press.
    const tooltipTakesEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", tooltipTakesEscape, true);
    fireEvent.keyDown(exit, { key: "Escape" });
    document.removeEventListener("keydown", tooltipTakesEscape, true);

    await waitFor(() => {
      expect(frameProps().height).not.toBeNull();
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Expand" }),
    );
  });
});

describe("<McpAppRow /> when the app cannot run here", () => {
  it("shows the ordinary tool row to a reader with no chat scope", () => {
    renderRow(makeFileRpc(HTML_RESPONSE), makeMcpRpc(), null, STAMP);

    expect(screen.getByTestId("ordinary-tool-row")).toBeTruthy();
    expect(screen.queryByTestId("mcp-app-row")).toBeNull();
  });

  it.each([
    [
      "the snapshot is not on this host",
      { kind: "unavailable", reason: "upload-pending" } as const,
    ],
    [
      "the snapshot is not text",
      {
        kind: "bytes",
        bytesBase64: "AAAA",
        offset: 0,
        totalBytes: 3,
        mediaType: "image/png",
      } as const,
    ],
  ])("shows the ordinary tool row when %s", async (_name, response) => {
    renderRow(makeFileRpc(response), makeMcpRpc(), SCOPE, STAMP);

    expect(await screen.findByTestId("ordinary-tool-row")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-frame")).toBeNull();
  });

  it("shows the ordinary tool row when reading the snapshot fails", async () => {
    const fileRpc = makeFileRpc(HTML_RESPONSE);
    fileRpc.readFile.mockRejectedValue(new Error("host went away"));
    renderRow(fileRpc, makeMcpRpc(), SCOPE, STAMP);

    expect(await screen.findByTestId("ordinary-tool-row")).toBeTruthy();
  });
});

describe("<McpAppRow /> waking the agent session", () => {
  it("shows the waking line only once a host call has been in flight for 700 ms, and drops it when the call ends", async () => {
    let answer: (response: ChatMcpAppReadResourceResponse) => void = () =>
      undefined;
    const mcpRpc = makeMcpRpc();
    mcpRpc.readResource.mockImplementation(
      () =>
        new Promise<ChatMcpAppReadResourceResponse>((resolve) => {
          answer = resolve;
        }),
    );
    await renderRunningApp(mcpRpc, STAMP);
    vi.useFakeTimers();

    let request: Promise<unknown> = Promise.resolve();
    act(() => {
      request = askAsApp("resources/read", { uri: "ui://sheets/budget" });
    });
    act(() => {
      vi.advanceTimersByTime(699);
    });
    expect(screen.queryByTestId("mcp-app-waking")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("mcp-app-waking").textContent).toContain(
      "Waking the agent session",
    );

    await act(async () => {
      answer({ kind: "result", result: { contents: [] } });
      await request;
    });
    expect(screen.queryByTestId("mcp-app-waking")).toBeNull();
  });

  it("never shows it for a call that answers at once", async () => {
    await renderRunningApp(makeMcpRpc(), STAMP);
    vi.useFakeTimers();

    await act(async () => {
      await askAsApp("resources/read", { uri: "ui://sheets/budget" });
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByTestId("mcp-app-waking")).toBeNull();
  });
});

describe("<McpAppRow /> approving a tool call", () => {
  const NEEDS_APPROVAL: ChatMcpAppCallToolResponse = {
    kind: "needsApproval",
    token: "secret-token",
    title: "Delete the row",
    args: { id: 7 },
  };

  it("holds the app's call behind an approval card, and Approve runs it with the token", async () => {
    const mcpRpc = makeMcpRpc();
    mcpRpc.callTool.mockResolvedValueOnce(NEEDS_APPROVAL);
    await renderRunningApp(mcpRpc, STAMP);

    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = askAsApp("tools/call", {
        name: "delete_row",
        arguments: { id: 7 },
      });
    });

    const card = await screen.findByTestId("mcp-app-approval");
    expect(card.textContent).toContain("delete_row");
    expect(card.textContent).toContain(SERVER);
    expect(mcpRpc.callTool).toHaveBeenCalledTimes(1);

    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));

    await expect(answer).resolves.toEqual(TOOL_RESULT);
    expect(mcpRpc.callTool).toHaveBeenCalledTimes(2);
    expect(mcpRpc.callTool.mock.calls[1]?.[0]).toMatchObject({
      blockId: BLOCK_ID,
      name: "delete_row",
      approvalToken: "secret-token",
    });
    await waitFor(() => {
      expect(screen.queryByTestId("mcp-app-approval")).toBeNull();
    });
  });

  it("Deny rejects the app's call and does not retry", async () => {
    const mcpRpc = makeMcpRpc();
    mcpRpc.callTool.mockResolvedValueOnce(NEEDS_APPROVAL);
    await renderRunningApp(mcpRpc, STAMP);

    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = askAsApp("tools/call", {
        name: "delete_row",
        arguments: { id: 7 },
      });
    });
    const rejected = expect(answer).rejects.toThrow("declined");
    fireEvent.click(
      within(await screen.findByTestId("mcp-app-approval")).getByRole(
        "button",
        {
          name: "Deny",
        },
      ),
    );

    await rejected;
    expect(mcpRpc.callTool).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("mcp-app-approval")).toBeNull();
  });

  it("denies a second call that needs approval while the first card is still open", async () => {
    const mcpRpc = makeMcpRpc();
    mcpRpc.callTool.mockResolvedValue(NEEDS_APPROVAL);
    await renderRunningApp(mcpRpc, STAMP);

    act(() => {
      void askAsApp("tools/call", { name: "first", arguments: {} }).catch(
        () => undefined,
      );
    });
    await screen.findByTestId("mcp-app-approval");

    let second: Promise<unknown> = Promise.resolve();
    act(() => {
      second = askAsApp("tools/call", { name: "second", arguments: {} });
    });

    await expect(second).rejects.toThrow("declined");
    expect(screen.getAllByTestId("mcp-app-approval")).toHaveLength(1);
  });

  it("answers a question still open when the row goes away as denied", async () => {
    const mcpRpc = makeMcpRpc();
    mcpRpc.callTool.mockResolvedValueOnce(NEEDS_APPROVAL);
    await renderRunningApp(mcpRpc, STAMP);

    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = askAsApp("tools/call", { name: "delete_row", arguments: {} });
    });
    await screen.findByTestId("mcp-app-approval");
    const rejected = expect(answer).rejects.toThrow("declined");

    cleanup();

    await rejected;
  });
});

describe("<McpAppRow /> showing what an approval would run", () => {
  async function openApproval(
    args: ChatMcpAppCallToolResponse & { readonly kind: "needsApproval" },
  ): Promise<HTMLElement> {
    const mcpRpc = makeMcpRpc();
    mcpRpc.callTool.mockResolvedValueOnce(args);
    await renderRunningApp(mcpRpc, STAMP);
    act(() => {
      void askAsApp("tools/call", {
        name: "delete_row",
        arguments: args.args,
      }).catch(() => undefined);
    });
    return screen.findByTestId("mcp-app-approval");
  }

  it("shows the host's title, the exact tool, and an id-only argument the summary would drop", async () => {
    const card = await openApproval({
      kind: "needsApproval",
      token: "t",
      title: "Delete the row",
      args: { id: 7 },
    });

    expect(within(card).getByTestId("mcp-app-approval-tool").textContent).toBe(
      `${SERVER} · delete_row`,
    );
    expect(within(card).getByTestId("mcp-app-approval-title").textContent).toBe(
      "Delete the row",
    );
    const args = within(card).getByTestId("mcp-app-approval-args");
    expect(JSON.parse(args.textContent)).toEqual({ id: 7 });
  });

  it("shows nested arguments in full, never cut", async () => {
    const nested = {
      target: { table: "budget", ids: [1, 2, 3] },
      note: "x".repeat(500),
    };
    const card = await openApproval({
      kind: "needsApproval",
      token: "t",
      title: "Delete rows",
      args: nested,
    });

    const args = within(card).getByTestId("mcp-app-approval-args");
    expect(JSON.parse(args.textContent)).toEqual(nested);
  });

  it("tells apart two calls whose one-line summaries are the same", async () => {
    const first = await openApproval({
      kind: "needsApproval",
      token: "t",
      title: "Delete",
      args: { title: "Q3", id: 1 },
    });
    const firstArgs = within(first).getByTestId(
      "mcp-app-approval-args",
    ).textContent;
    cleanup();

    const second = await openApproval({
      kind: "needsApproval",
      token: "t",
      title: "Delete",
      args: { title: "Q3", id: 2 },
    });
    const secondArgs = within(second).getByTestId(
      "mcp-app-approval-args",
    ).textContent;

    expect(firstArgs).toContain('"id": 1');
    expect(secondArgs).toContain('"id": 2');
    expect(firstArgs).not.toEqual(secondArgs);
  });
});

describe("<McpAppRow /> when the app's document goes", () => {
  const NEEDS_APPROVAL: ChatMcpAppCallToolResponse = {
    kind: "needsApproval",
    token: "secret-token",
    title: "Delete the row",
    args: { id: 7 },
  };

  it("denies an open approval when the app closes itself, and never retries", async () => {
    const mcpRpc = makeMcpRpc();
    mcpRpc.callTool.mockResolvedValueOnce(NEEDS_APPROVAL);
    await renderRunningApp(mcpRpc, STAMP);
    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = askAsApp("tools/call", { name: "delete_row", arguments: {} });
    });
    await screen.findByTestId("mcp-app-approval");
    const rejected = expect(answer).rejects.toThrow();

    act(() => {
      frameProps().onRequestTeardown();
    });

    await rejected;
    expect(screen.queryByTestId("mcp-app-approval")).toBeNull();
    expect(mcpRpc.callTool).toHaveBeenCalledTimes(1);
  });

  it("never asks the reader when the first answer arrives after the app closed", async () => {
    let answerFirst: (response: ChatMcpAppCallToolResponse) => void = () =>
      undefined;
    const mcpRpc = makeMcpRpc();
    mcpRpc.callTool.mockImplementationOnce(
      () =>
        new Promise<ChatMcpAppCallToolResponse>((resolve) => {
          answerFirst = resolve;
        }),
    );
    await renderRunningApp(mcpRpc, STAMP);
    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = askAsApp("tools/call", { name: "delete_row", arguments: {} });
    });

    act(() => {
      frameProps().onRequestTeardown();
    });
    await act(async () => {
      answerFirst(NEEDS_APPROVAL);
      await answer.catch(() => undefined);
    });

    await expect(answer).rejects.toThrow("closed");
    expect(screen.queryByTestId("mcp-app-approval")).toBeNull();
    expect(mcpRpc.callTool).toHaveBeenCalledTimes(1);
  });

  it("denies an open approval when the app crashes, and Reload starts a new document", async () => {
    const mcpRpc = makeMcpRpc();
    mcpRpc.callTool.mockResolvedValueOnce(NEEDS_APPROVAL);
    await renderRunningApp(mcpRpc, STAMP);
    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = askAsApp("tools/call", { name: "delete_row", arguments: {} });
    });
    await screen.findByTestId("mcp-app-approval");
    const rejected = expect(answer).rejects.toThrow();

    act(() => {
      frameProps().onStatus("crashed");
    });
    await rejected;
    expect(screen.queryByTestId("mcp-app-approval")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await screen.findByTestId("sandbox-frame");
    expect(mocks.frame.mounts).toBe(2);
    // The new document is served; the old request stayed denied.
    await expect(
      askAsApp("tools/call", { name: "lookup", arguments: {} }),
    ).resolves.toEqual(TOOL_RESULT);
    expect(mcpRpc.callTool).toHaveBeenCalledTimes(2);
    expect(mcpRpc.callTool.mock.calls[1]?.[0].approvalToken).toBeNull();
  });

  it("refuses requests from a document that was disposed", async () => {
    const mcpRpc = makeMcpRpc();
    await renderRunningApp(mcpRpc, STAMP);
    const staleHandler = frameProps().appRequests;
    if (staleHandler === null) throw new Error("no handler");

    act(() => {
      frameProps().onStatus("disposed");
    });

    await expect(
      staleHandler("tools/call", { name: "lookup", arguments: {} }),
    ).rejects.toThrow("closed");
    expect(mcpRpc.callTool).not.toHaveBeenCalled();
  });
});

describe("<McpAppRow /> confirming a download", () => {
  it("shows the full address a link opens, not just the name the app gave it", async () => {
    await renderRunningApp(makeMcpRpc(), STAMP);
    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = askAsApp("ui/download-file", {
        contents: [
          {
            type: "resource_link",
            uri: "https://evil.example/collect?session=1",
            name: "report.pdf",
          },
        ],
      });
    });

    const url = await screen.findByTestId("mcp-app-download-url");
    expect(url.textContent).toBe("https://evil.example/collect?session=1");
    const item = screen.getByTestId("mcp-app-download-item");
    expect(item.textContent).toContain("report.pdf");
    expect(item.textContent).toContain("Size unknown");
    expect(mocks.openLink).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await expect(answer).resolves.toEqual({});
    expect(mocks.openLink).toHaveBeenCalledWith(
      "https://evil.example/collect?session=1",
      "markdown",
      null,
    );
  });

  it("labels a link's size as the app's claim", async () => {
    await renderRunningApp(makeMcpRpc(), STAMP);
    act(() => {
      void askAsApp("ui/download-file", {
        contents: [
          {
            type: "resource_link",
            uri: "https://example.com/a.zip",
            name: "a.zip",
            size: 2048,
          },
        ],
      }).catch(() => undefined);
    });

    const item = await screen.findByTestId("mcp-app-download-item");
    expect(item.textContent).toContain("as reported by the app");
  });
});

describe("<McpAppRow /> when the agent session cannot be reached", () => {
  it("tells the reader why, and clears the notice once a call is served again", async () => {
    const mcpRpc = makeMcpRpc();
    mcpRpc.callTool.mockResolvedValueOnce({
      kind: "error",
      code: "session-unavailable",
      message: null,
    });
    await renderRunningApp(mcpRpc, STAMP);
    expect(screen.queryByTestId("mcp-app-unreachable")).toBeNull();

    await act(async () => {
      await askAsApp("tools/call", { name: "t", arguments: {} }).catch(
        () => undefined,
      );
    });

    const notice = screen.getByTestId("mcp-app-unreachable");
    expect(notice.textContent).toContain(`can't reach ${SERVER}`);
    // The app is still on screen, showing its last result.
    expect(screen.getByTestId("sandbox-frame")).toBeTruthy();

    await act(async () => {
      await askAsApp("tools/call", { name: "t", arguments: {} });
    });
    expect(screen.queryByTestId("mcp-app-unreachable")).toBeNull();
  });

  it("says so when the host does not serve apps at all", async () => {
    // A host without the methods answers every one E_HOST_UNSUPPORTED.
    const unsupported = (method: string) =>
      Promise.reject(
        new HostRpcError({
          code: "E_HOST_UNSUPPORTED",
          message: `${method} is not served by this host`,
          requestId: "",
          method,
          fatalDetails: null,
        }),
      );
    const unserved: McpAppRpc = {
      callTool: () => unsupported("chat.mcpApp.callTool"),
      readResource: () => unsupported("chat.mcpApp.readResource"),
      updateModelContext: () => unsupported("chat.mcpApp.updateModelContext"),
    };
    renderRow(makeFileRpc(HTML_RESPONSE), unserved, SCOPE, STAMP);
    await screen.findByTestId("sandbox-frame");

    await act(async () => {
      await askAsApp("tools/call", { name: "t", arguments: {} }).catch(
        () => undefined,
      );
    });

    expect(screen.getByTestId("mcp-app-unreachable").textContent).toContain(
      "can't run tools here",
    );
  });
});

describe("<McpAppRow /> when the app asks to send a message", () => {
  it("puts the text in the composer under a chip, and Discard puts the previous draft back", async () => {
    await renderRunningApp(makeMcpRpc(), STAMP);
    const previous = paragraph("my own draft");
    act(() => {
      useComposerDraftStore.getState().replaceDraft(CHAT_ID, previous, null);
    });
    expect(screen.queryByTestId("app-message-draft-pill")).toBeNull();

    await act(async () => {
      await askAsApp("ui/message", {
        role: "user",
        content: { type: "text", text: "Summarise Q3" },
      });
    });

    const pill = screen.getByTestId("app-message-draft-pill");
    expect(pill.textContent).toContain(`From the ${SERVER} app`);
    const during = JSON.stringify(readComposerDraftSnapshot(CHAT_ID).content);
    expect(during).toContain("my own draft");
    expect(during).toContain("Summarise Q3");

    fireEvent.click(within(pill).getByRole("button", { name: /Discard/ }));

    expect(screen.queryByTestId("app-message-draft-pill")).toBeNull();
    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(previous);
  });

  it("keeps what the reader typed after an app message when another message arrives", async () => {
    await renderRunningApp(makeMcpRpc(), STAMP);
    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(CHAT_ID, paragraph("draft A"), null);
    });
    await act(async () => {
      await askAsApp("ui/message", {
        role: "user",
        content: { type: "text", text: "app text X" },
      });
    });
    // The reader edits the draft after the app's text landed.
    act(() => {
      const draft = readComposerDraftSnapshot(CHAT_ID);
      useComposerDraftStore.getState().setSnapshot(
        CHAT_ID,
        {
          ...draft.content,
          content: [
            ...(draft.content.content ?? []),
            {
              type: "paragraph",
              content: [{ type: "text", text: "my edit B" }],
            },
          ],
        },
        null,
      );
    });
    // Edited: the app's text is the reader's now, so Discard is gone.
    expect(screen.queryByTestId("app-message-draft-pill")).toBeNull();

    await act(async () => {
      await askAsApp("ui/message", {
        role: "user",
        content: { type: "text", text: "app text Y" },
      });
    });

    const after = JSON.stringify(readComposerDraftSnapshot(CHAT_ID).content);
    for (const part of ["draft A", "app text X", "my edit B", "app text Y"]) {
      expect(after).toContain(part);
    }
    // Discard now takes back only Y.
    fireEvent.click(
      within(screen.getByTestId("app-message-draft-pill")).getByRole("button", {
        name: /Discard/,
      }),
    );
    const discarded = JSON.stringify(
      readComposerDraftSnapshot(CHAT_ID).content,
    );
    expect(discarded).toContain("my edit B");
    expect(discarded).not.toContain("app text Y");
  });

  it("appends a message from another app instead of replacing the first app's text", async () => {
    await renderRunningApp(makeMcpRpc(), STAMP);
    await act(async () => {
      await askAsApp("ui/message", {
        role: "user",
        content: { type: "text", text: "from sheets" },
      });
    });
    cleanup();
    await renderRunningApp(makeMcpRpc(), { ...STAMP, server: "Docs" });

    await act(async () => {
      await askAsApp("ui/message", {
        role: "user",
        content: { type: "text", text: "from docs" },
      });
    });

    const after = JSON.stringify(readComposerDraftSnapshot(CHAT_ID).content);
    expect(after).toContain("from sheets");
    expect(after).toContain("from docs");
    expect(screen.getByTestId("app-message-draft-pill").textContent).toContain(
      "From the Docs app",
    );
  });

  it("replaces the same app's untouched message with its newer one", async () => {
    await renderRunningApp(makeMcpRpc(), STAMP);
    for (const text of ["first", "second"]) {
      await act(async () => {
        await askAsApp("ui/message", {
          role: "user",
          content: { type: "text", text },
        });
      });
    }

    const after = JSON.stringify(readComposerDraftSnapshot(CHAT_ID).content);
    expect(after).not.toContain("first");
    expect(after).toContain("second");
  });

  it("refuses a message that is not plain user text and leaves the composer alone", async () => {
    await renderRunningApp(makeMcpRpc(), STAMP);

    await expect(
      askAsApp("ui/message", {
        role: "user",
        content: { type: "image", data: "", mimeType: "image/png" },
      }),
    ).rejects.toThrow();

    expect(screen.queryByTestId("app-message-draft-pill")).toBeNull();
  });
});
