/**
 * The curated CDP vocabulary's encode/decode table: one `BrowserCdpCommand`
 * becomes one raw CDP method call, and that call's unvalidated reply becomes
 * one `BrowserCdpResult`.
 *
 * Pure over `send`, so both runtimes that reach a real CDP endpoint - the
 * host's in-process Playwright session and the desktop shell's
 * `webContents.debugger` behind the host-to-renderer-to-IPC bridge - drive the
 * same decode. The method each kind sends comes from `contracts.ts`'s
 * `CURATED_CDP_METHOD_BY_KIND`, so the enumerated method set has one home.
 */
import {
  browserCdpValueSchema,
  CURATED_CDP_METHOD_BY_KIND,
  type BrowserCdpCommand,
  type BrowserCdpFrameInfo,
  type BrowserCdpResult,
} from "@traycer/protocol/host/browser/contracts";

/** One raw CDP call: method, params, and the transport's unvalidated reply. */
export type CuratedCdpSend = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Rejects (never resolves `ok: false`) when the transport rejects or the reply
 * is malformed; each runtime classifies that rejection into its own transport
 * error vocabulary.
 */
export async function dispatchCuratedCdp(
  send: CuratedCdpSend,
  command: BrowserCdpCommand,
): Promise<BrowserCdpResult> {
  switch (command.kind) {
    case "cdpNavigate": {
      const response = requireRecord(
        await sendCommand(send, command),
        "Page.navigate",
      );
      return {
        kind: command.kind,
        ok: true,
        errorText: nullableString(response.errorText),
      };
    }
    case "cdpCaptureScreenshot": {
      const response = requireRecord(
        await sendCommand(send, command),
        "Page.captureScreenshot",
      );
      return {
        kind: command.kind,
        ok: true,
        dataBase64: requireString(response.data, "Page.captureScreenshot.data"),
      };
    }
    case "cdpGetFrameTree": {
      const response = requireRecord(
        await sendCommand(send, command),
        "Page.getFrameTree",
      );
      return {
        kind: command.kind,
        ok: true,
        frames: flattenFrameTree(
          requireRecord(response.frameTree, "Page.getFrameTree.frameTree"),
        ),
      };
    }
    case "cdpCreateIsolatedWorld": {
      const response = requireRecord(
        await sendCommand(send, command),
        "Page.createIsolatedWorld",
      );
      return {
        kind: command.kind,
        ok: true,
        executionContextId: requireNumber(
          response.executionContextId,
          "Page.createIsolatedWorld.executionContextId",
        ),
      };
    }
    case "cdpEvaluate":
    case "cdpCallFunctionOn":
      return remoteObjectResult(command.kind, await sendCommand(send, command));
    case "cdpReleaseObject":
    case "cdpDispatchMouseEvent":
    case "cdpInsertText":
    case "cdpDispatchKeyEvent":
    case "cdpSetDeviceMetricsOverride":
      await sendCommand(send, command);
      return { kind: command.kind, ok: true };
    case "cdpDescribeNode": {
      const response = requireRecord(
        await sendCommand(send, command),
        "DOM.describeNode",
      );
      const node = requireRecord(response.node, "DOM.describeNode.node");
      return {
        kind: command.kind,
        ok: true,
        frameId: nullableString(node.frameId),
      };
    }
    default: {
      const exhaustive: never = command;
      throw new Error(
        `Unhandled browser CDP command: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function sendCommand(
  send: CuratedCdpSend,
  command: BrowserCdpCommand,
): Promise<unknown> {
  return send(
    CURATED_CDP_METHOD_BY_KIND[command.kind],
    encodeCdpParams(command),
  );
}

/**
 * Null is absence throughout the curated vocabulary, so a null-valued field is
 * omitted rather than sent as a literal null - an omitted param is exactly what
 * makes CDP apply its own default (`Runtime.evaluate` without `contextId`
 * evaluates in the main world). `target` is the one curated-only field: it is
 * addressing rather than a CDP param, and flattens into the two mutually
 * exclusive raw fields `Runtime.callFunctionOn` accepts.
 */
function encodeCdpParams(command: BrowserCdpCommand): Record<string, unknown> {
  const fields: Readonly<Record<string, unknown>> = command;
  const params: Record<string, unknown> = {};
  for (const field of Object.keys(fields)) {
    const value = fields[field];
    if (field === "kind" || field === "target" || value === null) continue;
    params[field] = value;
  }
  if (command.kind === "cdpCallFunctionOn") {
    if (command.target.kind === "object") {
      params.objectId = command.target.objectId;
    } else {
      params.executionContextId = command.target.executionContextId;
    }
  }
  return params;
}

function remoteObjectResult(
  kind: "cdpEvaluate" | "cdpCallFunctionOn",
  value: unknown,
): BrowserCdpResult {
  const response = requireRecord(value, kind);
  const result = requireRecord(response.result, `${kind}.result`);
  const exceptionDetails = isRecord(response.exceptionDetails)
    ? response.exceptionDetails
    : null;
  return {
    kind,
    ok: true,
    value: browserCdpValueSchema.parse(
      result.value === undefined
        ? { kind: "undefined" }
        : { kind: "json", value: result.value },
    ),
    objectId: nullableString(result.objectId),
    exceptionDescription:
      exceptionDetails === null ? null : describeException(exceptionDetails),
  };
}

/**
 * `exceptionDetails.text` alone is a generic CDP placeholder ("Uncaught" /
 * "Uncaught (in promise)") whenever the thrown/rejected value isn't itself an
 * `Error` with a message baked into that placeholder - a syntax error's real
 * reason lives only in `exceptionDetails.exception.description`, and a
 * rejected primitive (`Promise.reject("boom")`) has no `description` at all
 * and would otherwise vanish entirely behind the bare placeholder. Enriching
 * only when `text` is one of the known-generic placeholders leaves the
 * already-informative case (a thrown `Error`, whose `text` already includes
 * its message) untouched. `browser-cell-runner-page.ts` keeps a separate
 * first-line-only variant for cell output; the two are intentionally not
 * shared.
 */
const GENERIC_EXCEPTION_TEXT = new Set(["Uncaught", "Uncaught (in promise)"]);

function describeException(exceptionDetails: Record<string, unknown>): string {
  const text = nullableString(exceptionDetails.text) ?? "Uncaught exception";
  if (!GENERIC_EXCEPTION_TEXT.has(text)) return text;
  const exception = isRecord(exceptionDetails.exception)
    ? exceptionDetails.exception
    : null;
  if (exception === null) return text;
  const description = nullableString(exception.description);
  if (description !== null) return `${text}: ${description}`;
  if ("value" in exception)
    return `${text}: ${JSON.stringify(exception.value)}`;
  return text;
}

function flattenFrameTree(
  root: Record<string, unknown>,
): BrowserCdpFrameInfo[] {
  const frames: BrowserCdpFrameInfo[] = [];
  collectFrameTreeNode(root, frames);
  return frames;
}

function collectFrameTreeNode(
  node: Record<string, unknown>,
  frames: BrowserCdpFrameInfo[],
): void {
  const frame = requireRecord(node.frame, "Page.getFrameTree.frame");
  frames.push({
    frameId: requireString(frame.id, "Page.getFrameTree.frame.id"),
    parentFrameId: nullableString(frame.parentId),
    url: requireString(frame.url, "Page.getFrameTree.frame.url"),
  });
  if (node.childFrames === undefined) return;
  if (!Array.isArray(node.childFrames)) {
    throw invalidResponse("Page.getFrameTree.childFrames");
  }
  for (const child of node.childFrames) {
    collectFrameTreeNode(
      requireRecord(child, "Page.getFrameTree.childFrame"),
      frames,
    );
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse(field);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw invalidResponse(field);
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidResponse(field);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function invalidResponse(field: string): Error {
  return new Error(`Malformed CDP response: ${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
