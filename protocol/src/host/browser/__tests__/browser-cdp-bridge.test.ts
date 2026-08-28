import { describe, expect, it } from "vitest";
import {
  browserCdpCommandSchema,
  browserSessionsClientFrameSchema,
  browserSessionsServerFrameSchema,
  browserSessionsV1,
  CURATED_CDP_METHOD_BY_KIND,
  CURATED_CDP_METHODS,
  type BrowserCdpCommand,
  type BrowserCdpResult,
} from "@traycer/protocol/host/browser/contracts";

const REQUEST = {
  kind: "cdpRequest" as const,
  hasBinaryPayload: false as const,
  requestId: "request-1",
  tabId: "tab-1",
  registrationId: "registration-1",
  target: { kind: "root" as const },
};

const COMMANDS: readonly BrowserCdpCommand[] = [
  { kind: "cdpNavigate", url: "https://example.com" },
  { kind: "cdpCaptureScreenshot", format: "png", quality: null },
  { kind: "cdpGetFrameTree" },
  {
    kind: "cdpCreateIsolatedWorld",
    frameId: "frame-1",
    worldName: "__traycer_browser_snapshot",
    grantUniversalAccess: true,
  },
  {
    kind: "cdpEvaluate",
    expression: "1 + 1",
    awaitPromise: false,
    returnByValue: true,
    contextId: null,
  },
  {
    kind: "cdpCallFunctionOn",
    target: { kind: "context", executionContextId: 7 },
    functionDeclaration: "function(value) { return value; }",
    arguments: [{ value: null }],
    returnByValue: true,
  },
  { kind: "cdpReleaseObject", objectId: "object-1" },
  {
    kind: "cdpDispatchMouseEvent",
    type: "mouseMoved",
    x: 1,
    y: 1,
    button: null,
    clickCount: null,
    deltaX: null,
    deltaY: null,
  },
  { kind: "cdpInsertText", text: "hello" },
  {
    kind: "cdpDispatchKeyEvent",
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
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  },
  {
    kind: "cdpDescribeNode",
    objectId: "object-1",
    depth: null,
    pierce: false,
  },
];

const SUCCESS_RESULTS: readonly BrowserCdpResult[] = [
  { kind: "cdpNavigate", ok: true, errorText: null },
  { kind: "cdpCaptureScreenshot", ok: true, dataBase64: "aGVsbG8=" },
  {
    kind: "cdpGetFrameTree",
    ok: true,
    frames: [{ frameId: "frame-1", parentFrameId: null, url: "about:blank" }],
  },
  { kind: "cdpCreateIsolatedWorld", ok: true, executionContextId: 7 },
  {
    kind: "cdpEvaluate",
    ok: true,
    value: { kind: "json", value: null },
    objectId: null,
    exceptionDescription: null,
  },
  {
    kind: "cdpCallFunctionOn",
    ok: true,
    value: { kind: "undefined" },
    objectId: null,
    exceptionDescription: null,
  },
  { kind: "cdpReleaseObject", ok: true },
  { kind: "cdpDispatchMouseEvent", ok: true },
  { kind: "cdpInsertText", ok: true },
  { kind: "cdpDispatchKeyEvent", ok: true },
  { kind: "cdpSetDeviceMetricsOverride", ok: true },
  { kind: "cdpDescribeNode", ok: true, frameId: "child-frame-1" },
];

describe("browser.sessions@1.0 CDP bridge", () => {
  it("carries the canonical command union in one request frame", () => {
    for (const command of COMMANDS) {
      const parsed = browserSessionsServerFrameSchema.safeParse({
        ...REQUEST,
        command,
      });
      expect(parsed.success, `expected ${command.kind} to parse`).toBe(true);
    }
    expect(
      browserSessionsServerFrameSchema.safeParse({
        ...REQUEST,
        target: {
          kind: "frame",
          frameId: "child-frame-1",
          parentFrameId: "frame-1",
        },
        command: { kind: "cdpGetFrameTree" },
      }).success,
    ).toBe(true);
  });

  it("carries the canonical result union in one response frame", () => {
    for (const result of SUCCESS_RESULTS) {
      const parsed = browserSessionsClientFrameSchema.safeParse({
        kind: "cdpResult",
        hasBinaryPayload: false,
        requestId: "request-1",
        result,
      });
      expect(parsed.success, `expected ${result.kind} to parse`).toBe(true);
    }

    expect(
      browserSessionsClientFrameSchema.safeParse({
        kind: "cdpResult",
        hasBinaryPayload: false,
        requestId: "request-1",
        result: {
          kind: "cdpGetFrameTree",
          ok: false,
          error: {
            kind: "tab_not_found",
            message: "Native tab is not active.",
            code: null,
          },
        },
      }).success,
    ).toBe(true);
  });

  it("preserves JavaScript undefined separately from JSON null", () => {
    expect(SUCCESS_RESULTS[4]).toMatchObject({
      value: { kind: "json", value: null },
    });
    expect(SUCCESS_RESULTS[5]).toMatchObject({
      value: { kind: "undefined" },
    });
  });

  it("rejects flattened and contradictory frames", () => {
    expect(
      browserSessionsServerFrameSchema.safeParse({
        ...REQUEST,
        kind: "cdpNavigate",
        url: "https://example.com",
      }).success,
    ).toBe(false);
    expect(
      browserSessionsClientFrameSchema.safeParse({
        kind: "cdpResult",
        hasBinaryPayload: false,
        requestId: "request-1",
        result: {
          kind: "cdpNavigate",
          ok: true,
          errorText: null,
          error: { kind: "cdp_error", message: "contradiction", code: null },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects malformed semantic commands", () => {
    expect(
      browserSessionsServerFrameSchema.safeParse({
        ...REQUEST,
        command: { kind: "cdpNavigate" },
      }).success,
    ).toBe(false);
    expect(
      browserSessionsServerFrameSchema.safeParse({
        ...REQUEST,
        command: {
          kind: "cdpCallFunctionOn",
          target: { kind: "context", executionContextId: 7, objectId: "bad" },
          functionDeclaration: "function() {}",
          arguments: null,
          returnByValue: true,
        },
      }).success,
    ).toBe(false);
  });

  it("derives one method and one failure kind per command variant", () => {
    const commandKinds = browserCdpCommandSchema.def.options.map(
      (option): string => String(option.shape.kind.def.values[0]),
    );
    expect(Object.keys(CURATED_CDP_METHOD_BY_KIND).sort()).toEqual(
      [...commandKinds].sort(),
    );
    expect(new Set(CURATED_CDP_METHODS).size).toBe(commandKinds.length);
    expect(COMMANDS.map((command): string => command.kind).sort()).toEqual(
      [...commandKinds].sort(),
    );

    for (const kind of commandKinds) {
      const parsed = browserSessionsClientFrameSchema.safeParse({
        kind: "cdpResult",
        hasBinaryPayload: false,
        requestId: "request-1",
        result: {
          kind,
          ok: false,
          error: { kind: "cdp_error", message: "boom", code: null },
        },
      });
      expect(parsed.success, `expected ${kind} failure to parse`).toBe(true);
    }
  });

  it("defaults the key-event fields a lenient caller omits", () => {
    const sparseKeyEvent = {
      kind: "cdpDispatchKeyEvent",
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      text: null,
    };
    expect(browserCdpCommandSchema.parse(sparseKeyEvent)).toEqual({
      ...sparseKeyEvent,
      modifiers: null,
      unmodifiedText: null,
      windowsVirtualKeyCode: null,
      location: null,
      isKeypad: null,
      autoRepeat: null,
      commands: null,
    });
    expect(
      browserSessionsServerFrameSchema.safeParse({
        ...REQUEST,
        command: sparseKeyEvent,
      }).success,
    ).toBe(true);
  });

  it("keeps the bridge on the single unreleased browser.sessions baseline", () => {
    const serverKinds = browserSessionsV1.serverFrameSchema.def.options.map(
      (option): string => String(option.shape.kind.def.values[0]),
    );
    const clientKinds = browserSessionsV1.clientFrameSchema.def.options.map(
      (option): string => String(option.shape.kind.def.values[0]),
    );
    expect(serverKinds.filter((kind) => kind.startsWith("cdp"))).toEqual([
      "cdpRequest",
    ]);
    expect(clientKinds.filter((kind) => kind.startsWith("cdp"))).toEqual([
      "cdpResult",
    ]);
  });
});
