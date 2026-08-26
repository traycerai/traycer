import {
  browserCdpValueSchema,
  type BrowserCdpCommand,
  type BrowserCdpFrameInfo,
  type BrowserCdpResult,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserViewDebugger } from "./browser-view-port";

/** Maps the renderer's curated command vocabulary onto validated CDP calls. */
export async function dispatchBrowserCdpCommand(
  browserDebugger: BrowserViewDebugger,
  sessionId: string | undefined,
  command: BrowserCdpCommand,
): Promise<BrowserCdpResult> {
  switch (command.kind) {
    case "cdpNavigate": {
      const response = requireRecord(
        await sendCommand(
          browserDebugger,
          "Page.navigate",
          { url: command.url },
          sessionId,
        ),
        "Page.navigate",
      );
      return {
        kind: command.kind,
        ok: true,
        errorText: nullableString(response.errorText),
      };
    }
    case "cdpCaptureScreenshot": {
      const params: Record<string, unknown> = { format: command.format };
      if (command.quality !== null) params.quality = command.quality;
      const response = requireRecord(
        await sendCommand(
          browserDebugger,
          "Page.captureScreenshot",
          params,
          sessionId,
        ),
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
        await sendCommand(browserDebugger, "Page.getFrameTree", {}, sessionId),
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
        await sendCommand(
          browserDebugger,
          "Page.createIsolatedWorld",
          {
            frameId: command.frameId,
            worldName: command.worldName,
            grantUniversalAccess: command.grantUniversalAccess,
          },
          sessionId,
        ),
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
    case "cdpEvaluate": {
      const params: Record<string, unknown> = {
        expression: command.expression,
        awaitPromise: command.awaitPromise,
        returnByValue: command.returnByValue,
      };
      if (command.contextId !== null) params.contextId = command.contextId;
      return remoteObjectResult(
        command.kind,
        await sendCommand(
          browserDebugger,
          "Runtime.evaluate",
          params,
          sessionId,
        ),
      );
    }
    case "cdpCallFunctionOn": {
      const params: Record<string, unknown> = {
        functionDeclaration: command.functionDeclaration,
        returnByValue: command.returnByValue,
      };
      if (command.target.kind === "object") {
        params.objectId = command.target.objectId;
      } else {
        params.executionContextId = command.target.executionContextId;
      }
      if (command.arguments !== null) params.arguments = command.arguments;
      return remoteObjectResult(
        command.kind,
        await sendCommand(
          browserDebugger,
          "Runtime.callFunctionOn",
          params,
          sessionId,
        ),
      );
    }
    case "cdpReleaseObject":
      await sendCommand(
        browserDebugger,
        "Runtime.releaseObject",
        { objectId: command.objectId },
        sessionId,
      );
      return { kind: command.kind, ok: true };
    case "cdpDispatchMouseEvent": {
      const params: Record<string, unknown> = {
        type: command.type,
        x: command.x,
        y: command.y,
      };
      if (command.button !== null) params.button = command.button;
      if (command.clickCount !== null) params.clickCount = command.clickCount;
      if (command.deltaX !== null) params.deltaX = command.deltaX;
      if (command.deltaY !== null) params.deltaY = command.deltaY;
      await sendCommand(
        browserDebugger,
        "Input.dispatchMouseEvent",
        params,
        sessionId,
      );
      return { kind: command.kind, ok: true };
    }
    case "cdpInsertText":
      await sendCommand(
        browserDebugger,
        "Input.insertText",
        { text: command.text },
        sessionId,
      );
      return { kind: command.kind, ok: true };
    case "cdpDispatchKeyEvent": {
      const params: Record<string, unknown> = { type: command.type };
      if (command.key !== null) params.key = command.key;
      if (command.code !== null) params.code = command.code;
      if (command.text !== null) params.text = command.text;
      if (command.modifiers !== null) params.modifiers = command.modifiers;
      if (command.unmodifiedText !== null) {
        params.unmodifiedText = command.unmodifiedText;
      }
      if (command.windowsVirtualKeyCode !== null) {
        params.windowsVirtualKeyCode = command.windowsVirtualKeyCode;
      }
      if (command.location !== null) params.location = command.location;
      if (command.isKeypad !== null) params.isKeypad = command.isKeypad;
      if (command.autoRepeat !== null) params.autoRepeat = command.autoRepeat;
      if (command.commands !== null) params.commands = command.commands;
      await sendCommand(
        browserDebugger,
        "Input.dispatchKeyEvent",
        params,
        sessionId,
      );
      return { kind: command.kind, ok: true };
    }
    case "cdpSetDeviceMetricsOverride":
      await sendCommand(
        browserDebugger,
        "Emulation.setDeviceMetricsOverride",
        {
          width: command.width,
          height: command.height,
          deviceScaleFactor: command.deviceScaleFactor,
          mobile: command.mobile,
        },
        sessionId,
      );
      return { kind: command.kind, ok: true };
    case "cdpDescribeNode": {
      const params: Record<string, unknown> = {
        objectId: command.objectId,
        pierce: command.pierce,
      };
      if (command.depth !== null) params.depth = command.depth;
      const response = requireRecord(
        await sendCommand(
          browserDebugger,
          "DOM.describeNode",
          params,
          sessionId,
        ),
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
  browserDebugger: BrowserViewDebugger,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<unknown> {
  return browserDebugger.sendCommand(method, params, sessionId);
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
