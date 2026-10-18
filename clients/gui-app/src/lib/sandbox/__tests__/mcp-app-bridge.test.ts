import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ChatMcpAppCallToolRequest,
  ChatMcpAppCallToolResponse,
  ChatMcpAppErrorCode,
  ChatMcpAppReadResourceRequest,
  ChatMcpAppReadResourceResponse,
  ChatMcpAppUpdateModelContextRequest,
  ChatMcpAppUpdateModelContextResponse,
} from "@traycer/protocol/host/chat/mcp-app";
import {
  createMcpAppRequestHandler,
  MAX_EMBEDDED_DOWNLOAD_BYTES,
  type McpAppBlockRef,
  type McpAppBridgeHandlers,
  type McpAppDownload,
  type McpAppUnreachableReason,
} from "../mcp-app-bridge";
import type { McpAppRpc } from "../mcp-app-rpc";

const BLOCK: McpAppBlockRef = {
  epicId: "epic-1",
  chatId: "chat-1",
  blockId: "block-1",
};

const TOOL_RESULT = { content: [{ type: "text", text: "42" }] };

interface FakeRpc extends McpAppRpc {
  readonly callTool: Mock<McpAppRpc["callTool"]>;
  readonly readResource: Mock<McpAppRpc["readResource"]>;
  readonly updateModelContext: Mock<McpAppRpc["updateModelContext"]>;
}

function makeRpc(): FakeRpc {
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

interface Handlers extends McpAppBridgeHandlers {
  readonly beginHostCall: Mock<McpAppBridgeHandlers["beginHostCall"]>;
  readonly onReachability: Mock<McpAppBridgeHandlers["onReachability"]>;
  readonly askApproval: Mock<McpAppBridgeHandlers["askApproval"]>;
  readonly insertDraft: Mock<McpAppBridgeHandlers["insertDraft"]>;
  readonly requestDisplayMode: Mock<McpAppBridgeHandlers["requestDisplayMode"]>;
  readonly confirmDownload: Mock<McpAppBridgeHandlers["confirmDownload"]>;
  readonly saveFile: Mock<McpAppBridgeHandlers["saveFile"]>;
  readonly openLink: Mock<McpAppBridgeHandlers["openLink"]>;
  readonly done: Mock<() => void>;
}

function makeHandlers(): Handlers {
  const done = vi.fn<() => void>();
  return {
    done,
    beginHostCall: vi
      .fn<McpAppBridgeHandlers["beginHostCall"]>()
      .mockReturnValue(done),
    onReachability: vi.fn<McpAppBridgeHandlers["onReachability"]>(),
    askApproval: vi
      .fn<McpAppBridgeHandlers["askApproval"]>()
      .mockResolvedValue(true),
    insertDraft: vi.fn<McpAppBridgeHandlers["insertDraft"]>(),
    requestDisplayMode: vi
      .fn<McpAppBridgeHandlers["requestDisplayMode"]>()
      .mockReturnValue("inline"),
    confirmDownload: vi
      .fn<McpAppBridgeHandlers["confirmDownload"]>()
      .mockResolvedValue(true),
    saveFile: vi
      .fn<McpAppBridgeHandlers["saveFile"]>()
      .mockResolvedValue(undefined),
    openLink: vi.fn<McpAppBridgeHandlers["openLink"]>(),
  };
}

let rpc: FakeRpc;
let handlers: Handlers;
/** The frame document the requests come from; aborted when it goes. */
let appDocument: AbortController;

function request(method: string, params: unknown): Promise<unknown> {
  return createMcpAppRequestHandler(
    rpc,
    BLOCK,
    handlers,
    appDocument.signal,
  )(method, params);
}

/** A promise and the function that settles it, for steps the test orders. */
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  rpc = makeRpc();
  handlers = makeHandlers();
  appDocument = new AbortController();
});

describe("tools/call", () => {
  it("answers a plain result without asking for approval", async () => {
    const answer = await request("tools/call", {
      name: "lookup",
      arguments: { q: "x" },
    });

    expect(answer).toEqual(TOOL_RESULT);
    expect(handlers.askApproval).not.toHaveBeenCalled();
    expect(rpc.callTool).toHaveBeenCalledWith({
      ...BLOCK,
      name: "lookup",
      arguments: { q: "x" },
      approvalToken: null,
    });
    expect(handlers.onReachability).toHaveBeenLastCalledWith(null);
    expect(handlers.done).toHaveBeenCalledTimes(1);
  });

  it("asks the reader, retries once with the token, and never hands the token to the frame", async () => {
    rpc.callTool.mockResolvedValueOnce({
      kind: "needsApproval",
      token: "secret-token",
      title: "Delete the row",
      args: { id: 7 },
    });

    const answer = await request("tools/call", {
      name: "delete",
      arguments: { id: 7 },
    });

    expect(handlers.askApproval).toHaveBeenCalledWith({
      tool: "delete",
      title: "Delete the row",
      args: { id: 7 },
    });
    expect(rpc.callTool).toHaveBeenCalledTimes(2);
    expect(rpc.callTool.mock.calls[1]?.[0].approvalToken).toBe("secret-token");
    expect(answer).toEqual(TOOL_RESULT);
    expect(JSON.stringify(answer)).not.toContain("secret-token");
    // Both host round trips were tracked and closed.
    expect(handlers.beginHostCall).toHaveBeenCalledTimes(2);
    expect(handlers.done).toHaveBeenCalledTimes(2);
  });

  it("rejects when the reader denies, and does not retry", async () => {
    rpc.callTool.mockResolvedValueOnce({
      kind: "needsApproval",
      token: "t",
      title: "Delete",
      args: {},
    });
    handlers.askApproval.mockResolvedValueOnce(false);

    await expect(
      request("tools/call", { name: "delete", arguments: {} }),
    ).rejects.toThrow("declined");
    expect(rpc.callTool).toHaveBeenCalledTimes(1);
  });

  it("rejects when the retry asks for approval again, because the approval expired", async () => {
    rpc.callTool.mockResolvedValue({
      kind: "needsApproval",
      token: "t",
      title: "Delete",
      args: {},
    });

    await expect(
      request("tools/call", { name: "delete", arguments: {} }),
    ).rejects.toThrow("approval expired");
    expect(handlers.askApproval).toHaveBeenCalledTimes(1);
    expect(rpc.callTool).toHaveBeenCalledTimes(2);
  });

  it("surfaces an error answer on the retry the same way as on the first call", async () => {
    rpc.callTool
      .mockResolvedValueOnce({
        kind: "needsApproval",
        token: "t",
        title: "Delete",
        args: {},
      })
      .mockResolvedValueOnce({
        kind: "error",
        code: "session-changed",
        message: null,
      });

    await expect(
      request("tools/call", { name: "delete", arguments: {} }),
    ).rejects.toThrow("session");
    expect(handlers.onReachability).toHaveBeenCalledWith("session-changed");
  });

  it.each([
    [{ arguments: {} }],
    [{ name: "", arguments: {} }],
    [{ name: "x", arguments: [] }],
  ])("rejects malformed params %j without calling the host", async (params) => {
    await expect(request("tools/call", params)).rejects.toThrow();
    expect(rpc.callTool).not.toHaveBeenCalled();
  });
});

describe("tools/call analytics (D31)", () => {
  const NEEDS_APPROVAL: ChatMcpAppCallToolResponse = {
    kind: "needsApproval",
    token: "t",
    title: "Delete",
    args: {},
  };
  const CALL = { name: "delete", arguments: { id: 7 } };

  it("counts a result the host ran without asking as approved, carrying nothing about the call", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");

    await request("tools/call", CALL);

    expect(track.mock.calls).toEqual([
      [AnalyticsEvent.McpAppCall, { outcome: "approved" }],
    ]);
  });

  it("counts a call the reader approved once, not once per host round trip", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    rpc.callTool.mockResolvedValueOnce(NEEDS_APPROVAL);

    await request("tools/call", CALL);

    expect(track.mock.calls).toEqual([
      [AnalyticsEvent.McpAppCall, { outcome: "approved" }],
    ]);
  });

  it("counts a declined approval as denied", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    rpc.callTool.mockResolvedValueOnce(NEEDS_APPROVAL);
    handlers.askApproval.mockResolvedValueOnce(false);

    await expect(request("tools/call", CALL)).rejects.toThrow("declined");

    expect(track.mock.calls).toEqual([
      [AnalyticsEvent.McpAppCall, { outcome: "denied" }],
    ]);
  });

  it("counts an error answer as refused", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    rpc.callTool.mockResolvedValueOnce({
      kind: "error",
      code: "session-changed",
      message: null,
    });

    await expect(request("tools/call", CALL)).rejects.toThrow();

    expect(track.mock.calls).toEqual([
      [AnalyticsEvent.McpAppCall, { outcome: "refused" }],
    ]);
  });

  it("counts an expired approval as refused", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    rpc.callTool.mockResolvedValue(NEEDS_APPROVAL);

    await expect(request("tools/call", CALL)).rejects.toThrow(
      "approval expired",
    );

    expect(track.mock.calls).toEqual([
      [AnalyticsEvent.McpAppCall, { outcome: "refused" }],
    ]);
  });

  it("counts nothing for a call that never reached the host", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");

    await expect(request("tools/call", { arguments: {} })).rejects.toThrow();

    expect(track.mock.calls).toEqual([]);
  });
});

describe("reachability", () => {
  const CASES: readonly (readonly [
    ChatMcpAppErrorCode,
    McpAppUnreachableReason | null,
  ])[] = [
    ["not-owner", "not-owner"],
    ["session-unavailable", "offline"],
    ["session-changed", "session-changed"],
    ["harness-unsupported", "unsupported"],
    ["not-app-block", null],
    ["hidden-from-app", null],
    ["content-unsupported", null],
    ["too-large", null],
    ["call-failed", null],
  ];

  it.each(CASES)(
    "an error answer %s reports %s and rejects the request",
    async (code, reason) => {
      rpc.callTool.mockResolvedValueOnce({
        kind: "error",
        code,
        message: null,
      });

      await expect(
        request("tools/call", { name: "t", arguments: {} }),
      ).rejects.toThrow();

      if (reason === null) {
        expect(handlers.onReachability).not.toHaveBeenCalled();
      } else {
        expect(handlers.onReachability).toHaveBeenCalledExactlyOnceWith(reason);
      }
      expect(handlers.done).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects with the host's own message when it sent one", async () => {
    rpc.callTool.mockResolvedValueOnce({
      kind: "error",
      code: "call-failed",
      message: "server exploded",
    });

    await expect(
      request("tools/call", { name: "t", arguments: {} }),
    ).rejects.toThrow("server exploded");
  });

  it("a served answer clears an earlier notice", async () => {
    await request("resources/read", { uri: "ui://x" });

    expect(handlers.onReachability).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("a host that answers E_HOST_UNSUPPORTED reports unsupported and rejects", async () => {
    rpc.callTool.mockRejectedValueOnce(
      new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message: "chat.mcpApp.callTool is not served",
        requestId: "",
        method: "chat.mcpApp.callTool",
        fatalDetails: null,
      }),
    );

    await expect(
      request("tools/call", { name: "t", arguments: {} }),
    ).rejects.toBeInstanceOf(HostRpcError);
    expect(handlers.onReachability).toHaveBeenCalledExactlyOnceWith(
      "unsupported",
    );
    expect(handlers.done).toHaveBeenCalledTimes(1);
  });

  it("any other transport failure reports offline", async () => {
    rpc.readResource.mockRejectedValueOnce(new Error("socket closed"));

    await expect(request("resources/read", { uri: "ui://x" })).rejects.toThrow(
      "socket closed",
    );
    expect(handlers.onReachability).toHaveBeenCalledExactlyOnceWith("offline");
    expect(handlers.done).toHaveBeenCalledTimes(1);
  });
});

describe("resources/read", () => {
  it("returns the server's result for the named uri", async () => {
    rpc.readResource.mockResolvedValueOnce({
      kind: "result",
      result: { contents: [{ uri: "ui://x", text: "hi" }] },
    });

    const answer = await request("resources/read", { uri: "ui://x" });

    expect(answer).toEqual({ contents: [{ uri: "ui://x", text: "hi" }] });
    expect(rpc.readResource).toHaveBeenCalledWith({ ...BLOCK, uri: "ui://x" });
  });

  it("rejects a request with no uri", async () => {
    await expect(request("resources/read", {})).rejects.toThrow("uri");
    expect(rpc.readResource).not.toHaveBeenCalled();
  });
});

describe("ui/update-model-context", () => {
  it("sends a single block as a one-element array", async () => {
    const answer = await request("ui/update-model-context", {
      content: { type: "text", text: "selected row 3" },
    });

    expect(answer).toEqual({});
    expect(rpc.updateModelContext).toHaveBeenCalledWith({
      ...BLOCK,
      content: [{ type: "text", text: "selected row 3" }],
      structuredContent: null,
    });
  });

  it("sends an array of blocks and structuredContent as given", async () => {
    await request("ui/update-model-context", {
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      structuredContent: { row: 3 },
    });

    expect(rpc.updateModelContext).toHaveBeenCalledWith({
      ...BLOCK,
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      structuredContent: { row: 3 },
    });
  });

  it("sends null for absent content and structuredContent, which clears the context", async () => {
    await request("ui/update-model-context", {});

    expect(rpc.updateModelContext).toHaveBeenCalledWith({
      ...BLOCK,
      content: null,
      structuredContent: null,
    });
  });

  it("rejects a content block that is not an object", async () => {
    await expect(
      request("ui/update-model-context", { content: ["plain string"] }),
    ).rejects.toThrow();
    expect(rpc.updateModelContext).not.toHaveBeenCalled();
  });

  it("surfaces the host's too-large refusal", async () => {
    rpc.updateModelContext.mockResolvedValueOnce({
      kind: "error",
      code: "too-large",
      message: null,
    });

    await expect(
      request("ui/update-model-context", {
        content: { type: "text", text: "x" },
      }),
    ).rejects.toThrow("16 KiB");
  });
});

describe("ui/message", () => {
  it("puts the joined text of the user's text blocks into the composer", async () => {
    const answer = await request("ui/message", {
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });

    expect(answer).toEqual({});
    expect(handlers.insertDraft).toHaveBeenCalledExactlyOnceWith(
      "first\nsecond",
    );
  });

  it("accepts a single block", async () => {
    await request("ui/message", {
      role: "user",
      content: { type: "text", text: "hello" },
    });

    expect(handlers.insertDraft).toHaveBeenCalledExactlyOnceWith("hello");
  });

  it.each([
    [
      "a non-text block",
      { role: "user", content: [{ type: "image", data: "" }] },
    ],
    [
      "a non-user role",
      { role: "assistant", content: { type: "text", text: "x" } },
    ],
    ["blank text", { role: "user", content: { type: "text", text: "  \n " } }],
  ])("rejects %s and writes no draft", async (_name, params) => {
    await expect(request("ui/message", params)).rejects.toThrow();
    expect(handlers.insertDraft).not.toHaveBeenCalled();
  });
});

describe("ui/request-display-mode", () => {
  it("answers the mode the row says is now in force", async () => {
    handlers.requestDisplayMode.mockReturnValueOnce("inline");

    const answer = await request("ui/request-display-mode", {
      mode: "fullscreen",
    });

    expect(handlers.requestDisplayMode).toHaveBeenCalledWith("fullscreen");
    expect(answer).toEqual({ mode: "inline" });
  });

  it("passes a mode we do not offer as null", async () => {
    await request("ui/request-display-mode", { mode: "pip" });

    expect(handlers.requestDisplayMode).toHaveBeenCalledWith(null);
  });
});

describe("ui/download-file", () => {
  const embedded = (uri: string, text: string) => ({
    type: "resource",
    resource: { uri, mimeType: "text/csv", text },
  });

  it("confirms first, then saves each embedded file and opens each https link", async () => {
    const confirm = deferred<boolean>();
    handlers.confirmDownload.mockReturnValueOnce(confirm.promise);
    const pending = request("ui/download-file", {
      contents: [
        embedded("file:///tmp/report.csv", "a,b"),
        {
          type: "resource_link",
          uri: "https://example.com/big.zip",
          name: "big.zip",
          size: 2048,
        },
      ],
    });
    await vi.waitFor(() => {
      expect(handlers.confirmDownload).toHaveBeenCalledTimes(1);
    });
    // Nothing is saved or opened while the reader is still deciding.
    expect(handlers.saveFile).not.toHaveBeenCalled();
    expect(handlers.openLink).not.toHaveBeenCalled();

    confirm.resolve(true);
    const answer = await pending;

    expect(answer).toEqual({});
    const shown: readonly McpAppDownload[] =
      handlers.confirmDownload.mock.calls[0][0];
    expect(shown).toHaveLength(2);
    expect(shown[0]).toMatchObject({
      kind: "file",
      name: "report.csv",
      mimeType: "text/csv",
    });
    expect(shown[1]).toEqual({
      kind: "link",
      name: "big.zip",
      url: "https://example.com/big.zip",
      size: 2048,
    });
    expect(handlers.saveFile).toHaveBeenCalledTimes(1);
    expect(handlers.openLink).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/big.zip",
    );
  });

  it("decoding a blob download gives the original bytes", async () => {
    await request("ui/download-file", {
      contents: [
        {
          type: "resource",
          resource: { uri: "x://a.bin", blob: btoa("\u0001\u0002ok") },
        },
      ],
    });

    const saved = handlers.saveFile.mock.calls[0][0];
    expect(Array.from(saved.bytes)).toEqual([1, 2, 111, 107]);
  });

  it("a declined confirmation answers isError and saves nothing", async () => {
    handlers.confirmDownload.mockResolvedValueOnce(false);

    const answer = await request("ui/download-file", {
      contents: [embedded("file:///a.txt", "x")],
    });

    expect(answer).toEqual({ isError: true });
    expect(handlers.saveFile).not.toHaveBeenCalled();
    expect(handlers.openLink).not.toHaveBeenCalled();
  });

  it("rejects an http link before asking the reader", async () => {
    await expect(
      request("ui/download-file", {
        contents: [{ type: "resource_link", uri: "http://example.com/a.zip" }],
      }),
    ).rejects.toThrow("https");
    expect(handlers.confirmDownload).not.toHaveBeenCalled();
  });

  it("rejects an embedded file over 25 MiB before asking the reader", async () => {
    await expect(
      request("ui/download-file", {
        contents: [
          embedded(
            "file:///big.txt",
            "x".repeat(MAX_EMBEDDED_DOWNLOAD_BYTES + 1),
          ),
        ],
      }),
    ).rejects.toThrow("25 MiB");
    expect(handlers.confirmDownload).not.toHaveBeenCalled();
  });

  it("rejects an empty list and an unknown item kind", async () => {
    await expect(
      request("ui/download-file", { contents: [] }),
    ).rejects.toThrow();
    await expect(
      request("ui/download-file", { contents: [{ type: "image" }] }),
    ).rejects.toThrow();
    expect(handlers.confirmDownload).not.toHaveBeenCalled();
  });

  it("names the saved file by the last uri segment, stripped of path characters", async () => {
    await request("ui/download-file", {
      contents: [embedded("file:///x/..%2F..%2Fevil:name.txt", "x")],
    });

    const saved = handlers.saveFile.mock.calls[0][0];
    expect(saved.name).not.toMatch(/[\\/:]/);
    expect(saved.name.startsWith(".")).toBe(false);
  });
});

describe("unknown methods", () => {
  it("rejects with method-not-found", async () => {
    await expect(request("ui/unheard-of", {})).rejects.toThrow(
      "Method not found",
    );
  });
});

describe("a request whose app document has gone", () => {
  const NEEDS_APPROVAL: ChatMcpAppCallToolResponse = {
    kind: "needsApproval",
    token: "secret-token",
    title: "Delete the row",
    args: { id: 7 },
  };

  it("never asks the reader when the first answer arrives after the document went", async () => {
    const first = deferred<ChatMcpAppCallToolResponse>();
    rpc.callTool.mockReturnValueOnce(first.promise);
    const pending = request("tools/call", { name: "delete", arguments: {} });

    appDocument.abort();
    first.resolve(NEEDS_APPROVAL);

    await expect(pending).rejects.toThrow("closed");
    expect(handlers.askApproval).not.toHaveBeenCalled();
    expect(rpc.callTool).toHaveBeenCalledTimes(1);
  });

  it("never retries with the token when an approval lands after the document went", async () => {
    rpc.callTool.mockResolvedValueOnce(NEEDS_APPROVAL);
    const approval = deferred<boolean>();
    handlers.askApproval.mockReturnValueOnce(approval.promise);
    const pending = request("tools/call", { name: "delete", arguments: {} });
    await vi.waitFor(() => {
      expect(handlers.askApproval).toHaveBeenCalledTimes(1);
    });

    appDocument.abort();
    approval.resolve(true);

    await expect(pending).rejects.toThrow("closed");
    expect(rpc.callTool).toHaveBeenCalledTimes(1);
  });

  it("saves and opens nothing when a download is confirmed after the document went", async () => {
    const confirm = deferred<boolean>();
    handlers.confirmDownload.mockReturnValueOnce(confirm.promise);
    const pending = request("ui/download-file", {
      contents: [
        { type: "resource", resource: { uri: "x://a.txt", text: "x" } },
        { type: "resource_link", uri: "https://example.com/a.zip" },
      ],
    });
    await vi.waitFor(() => {
      expect(handlers.confirmDownload).toHaveBeenCalledTimes(1);
    });

    appDocument.abort();
    confirm.resolve(true);

    await expect(pending).rejects.toThrow("closed");
    expect(handlers.saveFile).not.toHaveBeenCalled();
    expect(handlers.openLink).not.toHaveBeenCalled();
  });

  it("refuses every request outright once the document has gone", async () => {
    appDocument.abort();

    await expect(
      request("ui/message", {
        role: "user",
        content: { type: "text", text: "hi" },
      }),
    ).rejects.toThrow("closed");
    await expect(
      request("ui/request-display-mode", { mode: "fullscreen" }),
    ).rejects.toThrow("closed");
    expect(handlers.insertDraft).not.toHaveBeenCalled();
    expect(handlers.requestDisplayMode).not.toHaveBeenCalled();
    expect(rpc.callTool).not.toHaveBeenCalled();
  });
});
