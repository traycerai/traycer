import type {
  BrowserCdpTarget,
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserCdpCommand,
  BrowserCdpErrorInfo,
  BrowserCdpResult,
} from "./browser-cdp-contract";

type BrowserCdpResultJsonValue = Extract<
  BrowserSessionsClientFrame,
  { readonly kind: "cdpEvaluateResult" }
>["resultJson"];

export interface BrowserCdpDispatchRequest {
  readonly requestId: string;
  readonly target: BrowserCdpTarget;
  readonly registrationId: string | null;
  readonly cdpSessionId: string | null;
  readonly command: BrowserCdpCommand;
}

/** Converts only CDP request frames; every other browser.sessions frame is null. */
export function browserCdpRequestFromFrame(
  frame: BrowserSessionsServerFrame,
): BrowserCdpDispatchRequest | null {
  const envelope = cdpRequestEnvelope(frame);
  if (envelope === null) return null;
  switch (frame.kind) {
    case "cdpNavigate":
      return { ...envelope, command: { kind: "cdpNavigate", url: frame.url } };
    case "cdpCaptureScreenshot":
      return {
        ...envelope,
        command: {
          kind: "cdpCaptureScreenshot",
          format: frame.format,
          quality: frame.quality,
        },
      };
    case "cdpGetFrameTree":
      return { ...envelope, command: { kind: "cdpGetFrameTree" } };
    case "cdpCreateIsolatedWorld":
      return {
        ...envelope,
        command: {
          kind: "cdpCreateIsolatedWorld",
          frameId: frame.frameId,
          worldName: frame.worldName,
          grantUniversalAccess: frame.grantUniversalAccess,
        },
      };
    case "cdpEvaluate":
      return {
        ...envelope,
        command: {
          kind: "cdpEvaluate",
          expression: frame.expression,
          awaitPromise: frame.awaitPromise,
          returnByValue: frame.returnByValue,
          contextId: frame.contextId,
        },
      };
    case "cdpCallFunctionOn":
      return {
        ...envelope,
        command: {
          kind: "cdpCallFunctionOn",
          objectId: frame.objectId,
          executionContextId: frame.executionContextId,
          functionDeclaration: frame.functionDeclaration,
          argumentsJson: frame.argumentsJson,
          returnByValue: frame.returnByValue,
        },
      };
    case "cdpReleaseObject":
      return {
        ...envelope,
        command: { kind: "cdpReleaseObject", objectId: frame.objectId },
      };
    case "cdpDispatchMouseEvent":
      return {
        ...envelope,
        command: {
          kind: "cdpDispatchMouseEvent",
          type: frame.type,
          x: frame.x,
          y: frame.y,
          button: frame.button,
          clickCount: frame.clickCount,
          deltaX: frame.deltaX,
          deltaY: frame.deltaY,
        },
      };
    case "cdpInsertText":
      return { ...envelope, command: { kind: "cdpInsertText", text: frame.text } };
    case "cdpDispatchKeyEvent":
      return {
        ...envelope,
        command: {
          kind: "cdpDispatchKeyEvent",
          type: frame.type,
          key: frame.key,
          code: frame.code,
          text: frame.text,
          modifiers: frame.modifiers,
          unmodifiedText: frame.unmodifiedText,
          windowsVirtualKeyCode: frame.windowsVirtualKeyCode,
          location: frame.location,
          isKeypad: frame.isKeypad,
          autoRepeat: frame.autoRepeat,
          commands: frame.commands,
        },
      };
    case "cdpSetDeviceMetricsOverride":
      return {
        ...envelope,
        command: {
          kind: "cdpSetDeviceMetricsOverride",
          width: frame.width,
          height: frame.height,
          deviceScaleFactor: frame.deviceScaleFactor,
          mobile: frame.mobile,
        },
      };
    case "cdpSetAutoAttach":
      return {
        ...envelope,
        command: {
          kind: "cdpSetAutoAttach",
          autoAttach: frame.autoAttach,
          waitForDebuggerOnStart: frame.waitForDebuggerOnStart,
        },
      };
    case "cdpDescribeNode":
      return {
        ...envelope,
        command: {
          kind: "cdpDescribeNode",
          objectId: frame.objectId,
          depth: frame.depth,
          pierce: frame.pierce,
        },
      };
    case "cdpGetFullAXTree":
      return {
        ...envelope,
        command: { kind: "cdpGetFullAXTree", depth: frame.depth },
      };
    default:
      return null;
  }
}

function cdpRequestEnvelope(frame: BrowserSessionsServerFrame): Omit<
  BrowserCdpDispatchRequest,
  "command"
> | null {
  if (
    !("target" in frame) ||
    !("registrationId" in frame) ||
    !("cdpSessionId" in frame)
  ) {
    return null;
  }
  return {
    requestId: frame.requestId,
    target: frame.target,
    registrationId: frame.registrationId,
    cdpSessionId: frame.cdpSessionId,
  };
}

type CdpResultFrameEnvelope = {
  readonly hasBinaryPayload: false;
  readonly requestId: string;
  readonly target: BrowserCdpTarget;
  readonly registrationId: string | null;
  readonly ok: boolean;
  readonly error: BrowserCdpErrorInfo | null;
};

export function buildCdpResultFrame(
  requestId: string,
  target: BrowserCdpTarget,
  registrationId: string | null,
  result: BrowserCdpResult,
): BrowserSessionsClientFrame {
  const envelope: CdpResultFrameEnvelope = {
    hasBinaryPayload: false,
    requestId,
    target,
    registrationId,
    ok: result.ok,
    error: result.ok ? null : result.error,
  };
  return result.ok
    ? buildCdpSuccessResultFrame(envelope, result)
    : buildCdpFailureResultFrame(envelope, result.kind);
}

function buildCdpFailureResultFrame(
  envelope: CdpResultFrameEnvelope,
  commandKind: BrowserCdpCommand["kind"],
): BrowserSessionsClientFrame {
  switch (commandKind) {
    case "cdpNavigate":
      return { kind: "cdpNavigateResult", ...envelope, frameId: null, loaderId: null, errorText: null };
    case "cdpCaptureScreenshot":
      return { kind: "cdpCaptureScreenshotResult", ...envelope, dataBase64: null };
    case "cdpGetFrameTree":
      return { kind: "cdpGetFrameTreeResult", ...envelope, frames: null };
    case "cdpCreateIsolatedWorld":
      return { kind: "cdpCreateIsolatedWorldResult", ...envelope, executionContextId: null };
    case "cdpEvaluate":
      return { kind: "cdpEvaluateResult", ...envelope, resultJson: null, objectId: null, exceptionDescription: null };
    case "cdpCallFunctionOn":
      return { kind: "cdpCallFunctionOnResult", ...envelope, resultJson: null, objectId: null, exceptionDescription: null };
    case "cdpReleaseObject":
      return { kind: "cdpReleaseObjectResult", ...envelope };
    case "cdpDispatchMouseEvent":
      return { kind: "cdpDispatchMouseEventResult", ...envelope };
    case "cdpInsertText":
      return { kind: "cdpInsertTextResult", ...envelope };
    case "cdpDispatchKeyEvent":
      return { kind: "cdpDispatchKeyEventResult", ...envelope };
    case "cdpSetDeviceMetricsOverride":
      return { kind: "cdpSetDeviceMetricsOverrideResult", ...envelope };
    case "cdpSetAutoAttach":
      return { kind: "cdpSetAutoAttachResult", ...envelope };
    case "cdpDescribeNode":
      return { kind: "cdpDescribeNodeResult", ...envelope, nodeId: null, backendNodeId: null, nodeName: null, frameId: null };
    case "cdpGetFullAXTree":
      return { kind: "cdpGetFullAXTreeResult", ...envelope, nodesJson: null };
    default: {
      const exhaustive: never = commandKind;
      throw new Error(`Unhandled CDP command kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function buildCdpSuccessResultFrame(
  envelope: CdpResultFrameEnvelope,
  result: Extract<BrowserCdpResult, { readonly ok: true }>,
): BrowserSessionsClientFrame {
  switch (result.kind) {
    case "cdpNavigate":
      return { kind: "cdpNavigateResult", ...envelope, frameId: result.frameId, loaderId: result.loaderId, errorText: result.errorText };
    case "cdpCaptureScreenshot":
      return { kind: "cdpCaptureScreenshotResult", ...envelope, dataBase64: result.dataBase64 };
    case "cdpGetFrameTree":
      return { kind: "cdpGetFrameTreeResult", ...envelope, frames: [...result.frames] };
    case "cdpCreateIsolatedWorld":
      return { kind: "cdpCreateIsolatedWorldResult", ...envelope, executionContextId: result.executionContextId };
    case "cdpEvaluate":
      return { kind: "cdpEvaluateResult", ...envelope, resultJson: result.resultJson as BrowserCdpResultJsonValue, objectId: result.objectId, exceptionDescription: result.exceptionDescription };
    case "cdpCallFunctionOn":
      return { kind: "cdpCallFunctionOnResult", ...envelope, resultJson: result.resultJson as BrowserCdpResultJsonValue, objectId: result.objectId, exceptionDescription: result.exceptionDescription };
    case "cdpReleaseObject":
      return { kind: "cdpReleaseObjectResult", ...envelope };
    case "cdpDispatchMouseEvent":
      return { kind: "cdpDispatchMouseEventResult", ...envelope };
    case "cdpInsertText":
      return { kind: "cdpInsertTextResult", ...envelope };
    case "cdpDispatchKeyEvent":
      return { kind: "cdpDispatchKeyEventResult", ...envelope };
    case "cdpSetDeviceMetricsOverride":
      return { kind: "cdpSetDeviceMetricsOverrideResult", ...envelope };
    case "cdpSetAutoAttach":
      return { kind: "cdpSetAutoAttachResult", ...envelope };
    case "cdpDescribeNode":
      return { kind: "cdpDescribeNodeResult", ...envelope, nodeId: result.nodeId, backendNodeId: result.backendNodeId, nodeName: result.nodeName, frameId: result.frameId };
    case "cdpGetFullAXTree":
      return { kind: "cdpGetFullAXTreeResult", ...envelope, nodesJson: result.nodesJson as BrowserCdpResultJsonValue };
    default: {
      const exhaustive: never = result;
      throw new Error(`Unhandled CDP result: ${JSON.stringify(exhaustive)}`);
    }
  }
}
