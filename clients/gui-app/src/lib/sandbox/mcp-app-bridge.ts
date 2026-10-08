import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  isJsonObject,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";
import type { ChatMcpAppErrorCode } from "@traycer/protocol/host/chat/mcp-app";
import type {
  SandboxAppRequestHandler,
  SandboxDisplayMode,
} from "@/lib/sandbox/bridge-host";
import type { McpAppRpc } from "@/lib/sandbox/mcp-app-rpc";

/**
 * The requests only an MCP App may make, served for one stamped block on top
 * of the sandbox bridge host (`bridge-host.ts`, its `appRequests` seam). No
 * DOM and no React: the row supplies the prompts and effects as handlers.
 *
 * - `tools/call` → `chat.mcpApp.callTool`. A `needsApproval` answer asks the
 *   reader through the row's approval card and retries once with the token;
 *   the token never reaches the frame.
 * - `resources/read` → `chat.mcpApp.readResource`.
 * - `ui/update-model-context` → `chat.mcpApp.updateModelContext`, sent as the
 *   standard `{content, structuredContent}` request. The host normalizes the
 *   text (§2.5); here only the shape is: one block or an array, absent → null.
 * - `ui/message` → a composer draft (D29), text blocks only.
 * - `ui/request-display-mode` → the row's overlay claim.
 * - `ui/download-file` → always confirmed. An embedded resource up to 25 MiB
 *   is saved; a `resource_link` must be https and opens as a link.
 *
 * A refusal rejects, and the bridge host answers it as a JSON-RPC error.
 */

/** The stamped block every app request names. */
export interface McpAppBlockRef {
  readonly epicId: string;
  readonly chatId: string;
  readonly blockId: string;
}

/**
 * Why app requests cannot be served right now, for the row's notice
 * (McpApp state 5). `null` from {@link unreachableReason} for a refusal that
 * says nothing about reachability.
 */
export type McpAppUnreachableReason =
  | "offline"
  | "not-owner"
  | "session-changed"
  | "unsupported";

/** The refusal arm every `chat.mcpApp.*` answer shares. */
interface McpAppErrorResponse {
  readonly kind: "error";
  readonly code: ChatMcpAppErrorCode;
  readonly message: string | null;
}

export interface McpAppApprovalRequest {
  /** The tool the app called. */
  readonly tool: string;
  /** The host's title for the call. */
  readonly title: string;
  readonly args: JsonObject;
}

export type McpAppDownload =
  | {
      readonly kind: "file";
      readonly name: string;
      readonly mimeType: string;
      readonly bytes: Uint8Array<ArrayBuffer>;
    }
  | {
      readonly kind: "link";
      readonly name: string;
      readonly url: string;
      /** As the app declared it; `null` when it declared none. */
      readonly size: number | null;
    };

export interface McpAppBridgeHandlers {
  /** Marks one host call in flight; the returned function marks it done. */
  readonly beginHostCall: () => () => void;
  /** Each host answer: why apps cannot be served, or `null` when one was. */
  readonly onReachability: (reason: McpAppUnreachableReason | null) => void;
  readonly askApproval: (request: McpAppApprovalRequest) => Promise<boolean>;
  readonly insertDraft: (text: string) => void;
  /** `null` asks for a mode we do not offer; answers the mode now in force. */
  readonly requestDisplayMode: (
    mode: SandboxDisplayMode | null,
  ) => SandboxDisplayMode;
  readonly confirmDownload: (
    downloads: readonly McpAppDownload[],
  ) => Promise<boolean>;
  readonly saveFile: (
    download: Extract<McpAppDownload, { kind: "file" }>,
  ) => Promise<void>;
  readonly openLink: (url: string) => void;
}

/** An embedded download larger than this is refused (plan §2.7). */
export const MAX_EMBEDDED_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_FILE_NAME_CHARS = 200;

const ERROR_TEXT: Record<ChatMcpAppErrorCode, string> = {
  "not-app-block": "This tool call has no app",
  "not-owner": "Only the chat's owner can use this app",
  "harness-unsupported": "This agent cannot serve apps",
  "session-unavailable": "The agent session cannot be reached",
  "session-changed": "The agent session that made this app has changed",
  "hidden-from-app": "The tool is not available to the app",
  "content-unsupported": "Only text can be shared with the model",
  "too-large": "The context is larger than 16 KiB",
  "call-failed": "The request failed",
};

export function unreachableReason(
  code: ChatMcpAppErrorCode,
): McpAppUnreachableReason | null {
  switch (code) {
    case "not-owner":
      return "not-owner";
    case "session-unavailable":
      return "offline";
    case "session-changed":
      return "session-changed";
    case "harness-unsupported":
      return "unsupported";
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One block or an array of them (the SDK and the spec text disagree). */
function blockList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** The joined text of `ui/message` content: user role, text blocks only. */
export function appMessageText(params: unknown): string {
  if (!isRecord(params) || params.role !== "user") {
    throw new Error("Only user messages are supported");
  }
  const parts = blockList(params.content).map((block) => {
    if (!isRecord(block) || block.type !== "text") {
      throw new Error("Only text messages are supported");
    }
    if (typeof block.text !== "string")
      throw new Error("Text block has no text");
    return block.text;
  });
  const text = parts.join("\n").trim();
  if (text.length === 0) throw new Error("The message is empty");
  return text;
}

/** The standard `ui/update-model-context` request, in the contract's shape. */
export function modelContextRequest(params: unknown): {
  readonly content: JsonObject[] | null;
  readonly structuredContent: JsonObject | null;
} {
  const raw = isRecord(params) ? params : {};
  let content: JsonObject[] | null = null;
  if (raw.content !== undefined && raw.content !== null) {
    content = blockList(raw.content).map((block) => {
      if (!isJsonObject(block)) throw new Error("Content blocks are objects");
      return block;
    });
  }
  let structuredContent: JsonObject | null = null;
  if (raw.structuredContent !== undefined && raw.structuredContent !== null) {
    if (!isJsonObject(raw.structuredContent)) {
      throw new Error("structuredContent is an object");
    }
    structuredContent = raw.structuredContent;
  }
  return { content, structuredContent };
}

/** A name safe to suggest to a save dialog. */
export function downloadFileName(raw: string): string {
  const cleaned = Array.from(raw.replace(/[\\/:*?"<>|]/g, "_"))
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .replace(/^\.+/, "");
  return cleaned.length === 0
    ? "download"
    : cleaned.slice(0, MAX_FILE_NAME_CHARS);
}

function lastUriSegment(uri: string): string {
  const path = uri.split(/[?#]/)[0] ?? "";
  const segment = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("The file is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function parseEmbedded(resource: Record<string, unknown>): McpAppDownload {
  const { uri, mimeType, text, blob } = resource;
  if (typeof uri !== "string") throw new Error("Download has no uri");
  let bytes: Uint8Array<ArrayBuffer>;
  if (typeof text === "string") bytes = new TextEncoder().encode(text);
  else if (typeof blob === "string") bytes = base64Bytes(blob);
  else throw new Error("Download has no contents");
  if (bytes.byteLength > MAX_EMBEDDED_DOWNLOAD_BYTES) {
    throw new Error("The file is larger than 25 MiB");
  }
  return {
    kind: "file",
    name: downloadFileName(lastUriSegment(uri)),
    mimeType: typeof mimeType === "string" ? mimeType : "",
    bytes,
  };
}

function parseLink(item: Record<string, unknown>): McpAppDownload {
  if (typeof item.uri !== "string") throw new Error("Download has no uri");
  let url: URL;
  try {
    url = new URL(item.uri);
  } catch {
    throw new Error("Download link is not a URL");
  }
  if (url.protocol !== "https:")
    throw new Error("Only https download links open");
  const name =
    typeof item.name === "string" ? item.name : lastUriSegment(url.pathname);
  const size =
    typeof item.size === "number" &&
    Number.isFinite(item.size) &&
    item.size >= 0
      ? item.size
      : null;
  return { kind: "link", name: downloadFileName(name), url: url.href, size };
}

function parseDownload(item: unknown): McpAppDownload {
  if (isRecord(item) && item.type === "resource" && isRecord(item.resource)) {
    return parseEmbedded(item.resource);
  }
  if (isRecord(item) && item.type === "resource_link") return parseLink(item);
  throw new Error("Unknown download");
}

function toolCallParams(params: unknown): {
  readonly name: string;
  readonly args: JsonObject;
} {
  if (!isRecord(params) || typeof params.name !== "string") {
    throw new Error("tools/call needs a tool name");
  }
  if (params.name.length === 0) throw new Error("tools/call needs a tool name");
  const args = params.arguments ?? {};
  if (!isJsonObject(args)) throw new Error("Tool arguments are an object");
  return { name: params.name, args };
}

function displayMode(params: unknown): SandboxDisplayMode | null {
  if (!isRecord(params)) return null;
  return params.mode === "inline" || params.mode === "fullscreen"
    ? params.mode
    : null;
}

/**
 * `signal` belongs to the frame document the request came from, and aborts
 * when that document goes (teardown, reload, crash, disposal, unmount). Every
 * step after an await re-checks it, so a late answer can never prompt the
 * reader, retry with an approval token, save, open or draft for a document
 * that is gone.
 */
export function createMcpAppRequestHandler(
  rpc: McpAppRpc,
  block: McpAppBlockRef,
  handlers: McpAppBridgeHandlers,
  signal: AbortSignal,
): SandboxAppRequestHandler {
  const ensureLive = (): void => {
    if (signal.aborted) throw new Error("The app was closed");
  };
  /** One host round trip, tracked for the waking line. */
  const hostCall = async <T extends { readonly kind: string }>(
    call: () => Promise<T>,
  ): Promise<T> => {
    ensureLive();
    const done = handlers.beginHostCall();
    try {
      const response = await call();
      ensureLive();
      if (response.kind !== "error") handlers.onReachability(null);
      return response;
    } catch (error) {
      ensureLive();
      handlers.onReachability(
        error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED"
          ? "unsupported"
          : "offline",
      );
      throw error instanceof Error ? error : new Error("Request failed");
    } finally {
      done();
    }
  };
  const refuse = (response: McpAppErrorResponse): never => {
    const reason = unreachableReason(response.code);
    if (reason !== null) handlers.onReachability(reason);
    throw new Error(response.message ?? ERROR_TEXT[response.code]);
  };

  const callTool = async (params: unknown): Promise<unknown> => {
    const { name, args } = toolCallParams(params);
    const first = await hostCall(() =>
      rpc.callTool({ ...block, name, arguments: args, approvalToken: null }),
    );
    if (first.kind === "error") return refuse(first);
    if (first.kind === "result") return first.result;
    const approved = await handlers.askApproval({
      tool: name,
      title: first.title,
      args: first.args,
    });
    if (!approved) throw new Error("The user declined this tool call");
    ensureLive();
    const second = await hostCall(() =>
      rpc.callTool({
        ...block,
        name,
        arguments: args,
        approvalToken: first.token,
      }),
    );
    if (second.kind === "error") return refuse(second);
    if (second.kind === "result") return second.result;
    throw new Error("The approval expired");
  };

  const download = async (params: unknown): Promise<unknown> => {
    if (!isRecord(params) || !Array.isArray(params.contents)) {
      throw new Error("Nothing to download");
    }
    if (params.contents.length === 0) throw new Error("Nothing to download");
    const downloads = params.contents.map(parseDownload);
    ensureLive();
    const confirmed = await handlers.confirmDownload(downloads);
    ensureLive();
    if (!confirmed) return { isError: true };
    for (const item of downloads) {
      ensureLive();
      if (item.kind === "file") await handlers.saveFile(item);
      else handlers.openLink(item.url);
    }
    return {};
  };

  return async (method, params) => {
    ensureLive();
    switch (method) {
      case "tools/call":
        return callTool(params);
      case "resources/read": {
        if (!isRecord(params) || typeof params.uri !== "string") {
          throw new Error("resources/read needs a uri");
        }
        const uri = params.uri;
        const response = await hostCall(() =>
          rpc.readResource({ ...block, uri }),
        );
        if (response.kind === "error") return refuse(response);
        return response.result;
      }
      case "ui/update-model-context": {
        const request = modelContextRequest(params);
        const response = await hostCall(() =>
          rpc.updateModelContext({ ...block, ...request }),
        );
        if (response.kind === "error") return refuse(response);
        return {};
      }
      case "ui/message":
        handlers.insertDraft(appMessageText(params));
        return {};
      case "ui/request-display-mode":
        return { mode: handlers.requestDisplayMode(displayMode(params)) };
      case "ui/download-file":
        return download(params);
      default:
        throw new Error(`Method not found: ${method}`);
    }
  };
}
