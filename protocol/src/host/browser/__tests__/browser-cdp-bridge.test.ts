import { describe, expect, it } from "vitest";
import {
  browserSessionsServerFrameSchema,
  browserSessionsClientFrameSchema,
  browserSessionsV1,
} from "@traycer/protocol/host/browser/contracts";

const ENVELOPE = {
  hasBinaryPayload: false as const,
  requestId: "request-1",
  target: { kind: "electron-tab" as const, tabId: "tab-1" },
  registrationId: "registration-1",
  cdpSessionId: null,
};

const RESULT_ENVELOPE = {
  hasBinaryPayload: false as const,
  requestId: "request-1",
  target: { kind: "electron-tab" as const, tabId: "tab-1" },
  registrationId: "registration-1",
  ok: true,
  error: null,
};

const BORROWED_TARGET = {
  kind: "borrowed-tile" as const,
  tileInstanceId: "tile-1",
};

describe("browser.sessions@1.0 typed CDP bridge frames", () => {
  it("parses every enumerated request frame kind (real parsing, not type-checking)", () => {
    const frames = [
      { kind: "cdpNavigate", ...ENVELOPE, url: "https://example.com" },
      {
        kind: "cdpCaptureScreenshot",
        ...ENVELOPE,
        format: "png",
        quality: null,
      },
      { kind: "cdpGetFrameTree", ...ENVELOPE },
      {
        kind: "cdpCreateIsolatedWorld",
        ...ENVELOPE,
        frameId: "frame-1",
        worldName: "__aside_utility",
        grantUniversalAccess: true,
      },
      {
        kind: "cdpEvaluate",
        ...ENVELOPE,
        expression: "1 + 1",
        awaitPromise: false,
        returnByValue: true,
        contextId: null,
      },
      {
        kind: "cdpCallFunctionOn",
        ...ENVELOPE,
        objectId: null,
        executionContextId: 7,
        functionDeclaration: "function() { return 1; }",
        argumentsJson: null,
        returnByValue: true,
      },
      { kind: "cdpReleaseObject", ...ENVELOPE, objectId: "object-1" },
      {
        kind: "cdpDispatchMouseEvent",
        ...ENVELOPE,
        type: "mouseMoved",
        x: 1,
        y: 1,
        button: null,
        clickCount: null,
        deltaX: null,
        deltaY: null,
      },
      { kind: "cdpInsertText", ...ENVELOPE, text: "hello" },
      {
        kind: "cdpDispatchKeyEvent",
        ...ENVELOPE,
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        text: null,
        modifiers: 0,
        unmodifiedText: "\r",
        windowsVirtualKeyCode: 13,
        location: 0,
        isKeypad: false,
        autoRepeat: false,
        commands: [],
      },
      {
        kind: "cdpSetDeviceMetricsOverride",
        ...ENVELOPE,
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      },
      {
        kind: "cdpSetAutoAttach",
        ...ENVELOPE,
        autoAttach: true,
        waitForDebuggerOnStart: false,
      },
      {
        kind: "cdpDescribeNode",
        ...ENVELOPE,
        objectId: "object-1",
        depth: null,
        pierce: false,
      },
      { kind: "cdpGetFullAXTree", ...ENVELOPE, depth: null },
    ];

    for (const frame of frames) {
      const parsed = browserSessionsServerFrameSchema.safeParse(frame);
      expect(parsed.success, `expected ${frame.kind} to parse`).toBe(true);
    }
  });

  it("parses every enumerated result frame kind plus both push notifications", () => {
    const frames = [
      {
        kind: "cdpNavigateResult",
        ...RESULT_ENVELOPE,
        frameId: "frame-1",
        loaderId: "loader-1",
        errorText: null,
      },
      {
        kind: "cdpCaptureScreenshotResult",
        ...RESULT_ENVELOPE,
        dataBase64: "aGVsbG8=",
      },
      { kind: "cdpGetFrameTreeResult", ...RESULT_ENVELOPE, frames: [] },
      {
        kind: "cdpGetFrameTreeResult",
        ...RESULT_ENVELOPE,
        ok: false,
        error: {
          kind: "tab_not_found",
          message: "Native tab is not active.",
          code: null,
        },
        frames: null,
      },
      {
        kind: "cdpCreateIsolatedWorldResult",
        ...RESULT_ENVELOPE,
        executionContextId: 7,
      },
      {
        kind: "cdpEvaluateResult",
        ...RESULT_ENVELOPE,
        resultJson: 2,
        objectId: null,
        exceptionDescription: null,
      },
      {
        kind: "cdpCallFunctionOnResult",
        ...RESULT_ENVELOPE,
        resultJson: null,
        objectId: "object-2",
        exceptionDescription: null,
      },
      { kind: "cdpReleaseObjectResult", ...RESULT_ENVELOPE },
      { kind: "cdpDispatchMouseEventResult", ...RESULT_ENVELOPE },
      { kind: "cdpInsertTextResult", ...RESULT_ENVELOPE },
      { kind: "cdpDispatchKeyEventResult", ...RESULT_ENVELOPE },
      { kind: "cdpSetDeviceMetricsOverrideResult", ...RESULT_ENVELOPE },
      { kind: "cdpSetAutoAttachResult", ...RESULT_ENVELOPE },
      {
        kind: "cdpDescribeNodeResult",
        ...RESULT_ENVELOPE,
        nodeId: 1,
        backendNodeId: 2,
        nodeName: "IFRAME",
        frameId: "child-frame-1",
      },
      {
        kind: "cdpGetFullAXTreeResult",
        ...RESULT_ENVELOPE,
        nodesJson: [],
      },
      {
        kind: "cdpSessionEnded",
        hasBinaryPayload: false,
        requestId: "notif-1",
        target: BORROWED_TARGET,
        registrationId: null,
        reason: "debugger detached",
      },
      {
        kind: "cdpTargetAttached",
        hasBinaryPayload: false,
        requestId: "notif-2",
        target: ENVELOPE.target,
        registrationId: "registration-1",
        cdpSessionId: "child-session-1",
        targetId: "target-1",
        targetType: "iframe",
        url: "https://example.com/child",
        waitingForDebugger: false,
      },
    ];

    for (const frame of frames) {
      const parsed = browserSessionsClientFrameSchema.safeParse(frame);
      expect(parsed.success, `expected ${frame.kind} to parse`).toBe(true);
    }
  });

  it("addresses agent and borrowed CDP traffic without tile/session ambiguity", () => {
    const electronRequest = {
      kind: "cdpGetFrameTree",
      ...ENVELOPE,
    };
    const borrowedRequest = {
      ...electronRequest,
      target: BORROWED_TARGET,
      registrationId: null,
    };
    const parsedElectron =
      browserSessionsServerFrameSchema.safeParse(electronRequest);
    const parsedBorrowed =
      browserSessionsServerFrameSchema.safeParse(borrowedRequest);
    expect(parsedElectron.success).toBe(true);
    expect(parsedBorrowed.success).toBe(true);
    if (parsedElectron.success) {
      expect(parsedElectron.data).toEqual(electronRequest);
    }
    if (parsedBorrowed.success) {
      expect(parsedBorrowed.data).toEqual(borrowedRequest);
    }

    expect(
      browserSessionsServerFrameSchema.safeParse({
        ...electronRequest,
        target: {
          kind: "electron-tab",
          tabId: "tab-1",
          tileInstanceId: "tile-1",
        },
      }).success,
    ).toBe(false);

    const oldTileOnlyRequest = {
      kind: "cdpGetFrameTree",
      hasBinaryPayload: false,
      requestId: "request-legacy",
      tileInstanceId: "tile-1",
      sessionId: null,
    };
    expect(
      browserSessionsServerFrameSchema.safeParse(oldTileOnlyRequest).success,
    ).toBe(false);
  });

  it("rejects a malformed cdpNavigate request missing url", () => {
    const frame = { kind: "cdpNavigate", ...ENVELOPE };
    expect(browserSessionsServerFrameSchema.safeParse(frame).success).toBe(
      false,
    );
  });

  it("rejects a malformed cdpEvaluate request with a non-numeric contextId", () => {
    const frame = {
      kind: "cdpEvaluate",
      ...ENVELOPE,
      expression: "1",
      awaitPromise: false,
      returnByValue: true,
      contextId: "not-a-number",
    };
    expect(browserSessionsServerFrameSchema.safeParse(frame).success).toBe(
      false,
    );
  });

  it("rejects a cdpDescribeNodeResult missing the frameId field entirely", () => {
    const frame = {
      kind: "cdpDescribeNodeResult",
      ...RESULT_ENVELOPE,
      nodeId: 1,
      backendNodeId: 2,
      nodeName: "IFRAME",
    };
    expect(browserSessionsClientFrameSchema.safeParse(frame).success).toBe(
      false,
    );
  });

  it("carries every enumerated CDP frame kind on the collapsed browserSessionsV1 baseline", () => {
    const requiredKinds = [
      "cdpNavigate",
      "cdpCaptureScreenshot",
      "cdpGetFrameTree",
      "cdpCreateIsolatedWorld",
      "cdpEvaluate",
      "cdpCallFunctionOn",
      "cdpReleaseObject",
      "cdpDispatchMouseEvent",
      "cdpInsertText",
      "cdpDispatchKeyEvent",
      "cdpSetDeviceMetricsOverride",
      "cdpSetAutoAttach",
      "cdpDescribeNode",
      "cdpGetFullAXTree",
    ];
    const v1Kinds: ReadonlySet<string> = new Set(
      browserSessionsV1.serverFrameSchema.def.options.map((option): string =>
        String(option.shape.kind.def.values[0]),
      ),
    );
    for (const kind of requiredKinds) {
      expect(
        v1Kinds.has(kind),
        `${kind} must be on the browserSessionsV1 baseline`,
      ).toBe(true);
    }

    const snapshotSample = {
      kind: "snapshot",
      hasBinaryPayload: false,
      sessions: [],
    };
    expect(
      browserSessionsV1.serverFrameSchema.safeParse(snapshotSample).success,
    ).toBe(true);
    expect(
      browserSessionsServerFrameSchema.safeParse(snapshotSample).success,
    ).toBe(true);
  });
});
