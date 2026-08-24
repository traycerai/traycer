/**
 * The enumerated CDP surface shared by native browser runtimes.
 *
 * Addressing is intentionally absent here: callers pair these commands with
 * either a borrowed canvas-tile key or a host-owned Electron-tab key.
 */
export type BrowserCdpCommand =
  | { readonly kind: "cdpNavigate"; readonly url: string }
  | {
      readonly kind: "cdpCaptureScreenshot";
      readonly format: "png" | "jpeg";
      readonly quality: number | null;
    }
  | { readonly kind: "cdpGetFrameTree" }
  | {
      readonly kind: "cdpCreateIsolatedWorld";
      readonly frameId: string;
      readonly worldName: string;
      readonly grantUniversalAccess: boolean;
    }
  | {
      readonly kind: "cdpEvaluate";
      readonly expression: string;
      readonly awaitPromise: boolean;
      readonly returnByValue: boolean;
      readonly contextId: number | null;
    }
  | {
      readonly kind: "cdpCallFunctionOn";
      readonly objectId: string | null;
      readonly executionContextId: number | null;
      readonly functionDeclaration: string;
      readonly argumentsJson: unknown;
      readonly returnByValue: boolean;
    }
  | { readonly kind: "cdpReleaseObject"; readonly objectId: string }
  | {
      readonly kind: "cdpDispatchMouseEvent";
      readonly type:
        | "mousePressed"
        | "mouseReleased"
        | "mouseMoved"
        | "mouseWheel";
      readonly x: number;
      readonly y: number;
      readonly button: "left" | "right" | "middle" | "none" | null;
      readonly clickCount: number | null;
      readonly deltaX: number | null;
      readonly deltaY: number | null;
    }
  | { readonly kind: "cdpInsertText"; readonly text: string }
  | {
      readonly kind: "cdpDispatchKeyEvent";
      readonly type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
      readonly key: string | null;
      readonly code: string | null;
      readonly text: string | null;
      readonly modifiers: number | null;
      readonly unmodifiedText: string | null;
      readonly windowsVirtualKeyCode: number | null;
      readonly location: number | null;
      readonly isKeypad: boolean | null;
      readonly autoRepeat: boolean | null;
      readonly commands: readonly string[] | null;
    }
  | {
      readonly kind: "cdpSetDeviceMetricsOverride";
      readonly width: number;
      readonly height: number;
      readonly deviceScaleFactor: number;
      readonly mobile: boolean;
    }
  | {
      readonly kind: "cdpSetAutoAttach";
      readonly autoAttach: boolean;
      readonly waitForDebuggerOnStart: boolean;
    }
  | {
      readonly kind: "cdpDescribeNode";
      readonly objectId: string;
      readonly depth: number | null;
      readonly pierce: boolean;
    }
  | {
      readonly kind: "cdpGetFullAXTree";
      readonly depth: number | null;
    };

export interface BrowserCdpFrameInfo {
  readonly frameId: string;
  readonly parentFrameId: string | null;
  readonly url: string;
  readonly securityOrigin: string | null;
}

export interface BrowserCdpErrorInfo {
  readonly kind:
    | "not_attached"
    | "tab_not_found"
    | "tile_not_found"
    | "cdp_error";
  readonly message: string;
  readonly code: number | null;
}

export type BrowserCdpResult =
  | {
      readonly kind: "cdpNavigate";
      readonly ok: true;
      readonly frameId: string | null;
      readonly loaderId: string | null;
      readonly errorText: string | null;
    }
  | {
      readonly kind: "cdpCaptureScreenshot";
      readonly ok: true;
      readonly dataBase64: string;
    }
  | {
      readonly kind: "cdpGetFrameTree";
      readonly ok: true;
      readonly frames: readonly BrowserCdpFrameInfo[];
    }
  | {
      readonly kind: "cdpCreateIsolatedWorld";
      readonly ok: true;
      readonly executionContextId: number | null;
    }
  | {
      readonly kind: "cdpEvaluate";
      readonly ok: true;
      readonly resultJson: unknown;
      readonly objectId: string | null;
      readonly exceptionDescription: string | null;
    }
  | {
      readonly kind: "cdpCallFunctionOn";
      readonly ok: true;
      readonly resultJson: unknown;
      readonly objectId: string | null;
      readonly exceptionDescription: string | null;
    }
  | { readonly kind: "cdpReleaseObject"; readonly ok: true }
  | { readonly kind: "cdpDispatchMouseEvent"; readonly ok: true }
  | { readonly kind: "cdpInsertText"; readonly ok: true }
  | { readonly kind: "cdpDispatchKeyEvent"; readonly ok: true }
  | { readonly kind: "cdpSetDeviceMetricsOverride"; readonly ok: true }
  | { readonly kind: "cdpSetAutoAttach"; readonly ok: true }
  | {
      readonly kind: "cdpDescribeNode";
      readonly ok: true;
      readonly nodeId: number | null;
      readonly backendNodeId: number | null;
      readonly nodeName: string | null;
      readonly frameId: string | null;
    }
  | {
      readonly kind: "cdpGetFullAXTree";
      readonly ok: true;
      readonly nodesJson: unknown;
    }
  | {
      readonly kind: BrowserCdpCommand["kind"];
      readonly ok: false;
      readonly error: BrowserCdpErrorInfo;
    };
