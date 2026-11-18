import { describe, expect, it } from "vitest";
import { dispatchCuratedCdp } from "@traycer/protocol/host/browser/cdp-dispatch";
import type {
  BrowserCdpCommand,
  BrowserCdpResult,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserViewDebugger } from "../../browser-view-port";
import type { RecordedCommand } from "./browser-debug-session-test-support";

class FakeDebugger implements BrowserViewDebugger {
  readonly commands: RecordedCommand[] = [];
  readonly responses = new Map<string, unknown>();

  isAttached(): boolean {
    return true;
  }

  attach(_protocolVersion: string): void {}

  detach(): void {}

  sendCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): Promise<unknown> {
    this.commands.push({ method, params, sessionId });
    return Promise.resolve(this.responses.get(method) ?? {});
  }

  on(_event: string, _listener: (...args: unknown[]) => void): void {}

  off(_event: string, _listener: (...args: unknown[]) => void): void {}
}

/**
 * The desktop's half of the curated table: `BrowserDebugSession.dispatch`
 * binds the attached debugger and the addressed child session, and this
 * exercises the encode/decode that binding drives.
 */
function dispatchBrowserCdpCommand(
  browserDebugger: BrowserViewDebugger,
  sessionId: string | undefined,
  command: BrowserCdpCommand,
): Promise<BrowserCdpResult> {
  return dispatchCuratedCdp(
    (method, params) => browserDebugger.sendCommand(method, params, sessionId),
    command,
  );
}

describe("curated CDP dispatch over the desktop debugger", () => {
  it("maps navigation and screenshot responses without leaking dead fields", async () => {
    const browserDebugger = new FakeDebugger();
    browserDebugger.responses.set("Page.navigate", {
      frameId: "dead-frame",
      loaderId: "dead-loader",
      errorText: "blocked",
    });
    browserDebugger.responses.set("Page.captureScreenshot", {
      data: "encoded",
    });

    await expect(
      dispatchBrowserCdpCommand(browserDebugger, "child-1", {
        kind: "cdpNavigate",
        url: "https://example.com",
      }),
    ).resolves.toEqual({
      kind: "cdpNavigate",
      ok: true,
      errorText: "blocked",
    });
    await expect(
      dispatchBrowserCdpCommand(browserDebugger, undefined, {
        kind: "cdpCaptureScreenshot",
        format: "jpeg",
        quality: 75,
      }),
    ).resolves.toEqual({
      kind: "cdpCaptureScreenshot",
      ok: true,
      dataBase64: "encoded",
    });
    expect(browserDebugger.commands).toEqual([
      {
        method: "Page.navigate",
        params: { url: "https://example.com" },
        sessionId: "child-1",
      },
      {
        method: "Page.captureScreenshot",
        params: { format: "jpeg", quality: 75 },
        sessionId: undefined,
      },
    ]);
  });

  it("flattens the frame tree and rejects malformed native replies", async () => {
    const browserDebugger = new FakeDebugger();
    browserDebugger.responses.set("Page.getFrameTree", {
      frameTree: {
        frame: { id: "root", url: "https://example.com" },
        childFrames: [
          {
            frame: {
              id: "child",
              parentId: "root",
              url: "https://frame.example.com",
            },
          },
        ],
      },
    });

    await expect(
      dispatchBrowserCdpCommand(browserDebugger, undefined, {
        kind: "cdpGetFrameTree",
      }),
    ).resolves.toEqual({
      kind: "cdpGetFrameTree",
      ok: true,
      frames: [
        {
          frameId: "root",
          parentFrameId: null,
          url: "https://example.com",
        },
        {
          frameId: "child",
          parentFrameId: "root",
          url: "https://frame.example.com",
        },
      ],
    });

    browserDebugger.responses.set("Page.createIsolatedWorld", {
      executionContextId: 7,
    });
    await expect(
      dispatchBrowserCdpCommand(browserDebugger, "child-1", {
        kind: "cdpCreateIsolatedWorld",
        frameId: "child",
        worldName: "traycer",
        grantUniversalAccess: true,
      }),
    ).resolves.toEqual({
      kind: "cdpCreateIsolatedWorld",
      ok: true,
      executionContextId: 7,
    });
    expect(browserDebugger.commands.at(-1)).toEqual({
      method: "Page.createIsolatedWorld",
      params: {
        frameId: "child",
        worldName: "traycer",
        grantUniversalAccess: true,
      },
      sessionId: "child-1",
    });

    browserDebugger.responses.set("Page.createIsolatedWorld", {});
    await expect(
      dispatchBrowserCdpCommand(browserDebugger, undefined, {
        kind: "cdpCreateIsolatedWorld",
        frameId: "root",
        worldName: "traycer",
        grantUniversalAccess: false,
      }),
    ).rejects.toThrow(
      "Malformed CDP response: Page.createIsolatedWorld.executionContextId",
    );
  });

  it("maps both callFunction target arms and preserves JSON arguments", async () => {
    const browserDebugger = new FakeDebugger();
    browserDebugger.responses.set("Runtime.callFunctionOn", {
      result: { value: { ok: true }, objectId: "result-object" },
    });

    await expect(
      dispatchBrowserCdpCommand(browserDebugger, "child-1", {
        kind: "cdpCallFunctionOn",
        target: { kind: "context", executionContextId: 42 },
        functionDeclaration: "function (value) { return value; }",
        arguments: [{ value: null }, { value: "text" }],
        returnByValue: true,
      }),
    ).resolves.toEqual({
      kind: "cdpCallFunctionOn",
      ok: true,
      value: { kind: "json", value: { ok: true } },
      objectId: "result-object",
      exceptionDescription: null,
    });
    browserDebugger.responses.set("Runtime.callFunctionOn", {
      result: { value: undefined },
    });
    await dispatchBrowserCdpCommand(browserDebugger, undefined, {
      kind: "cdpCallFunctionOn",
      target: { kind: "object", objectId: "object-1" },
      functionDeclaration: "function () {}",
      arguments: null,
      returnByValue: false,
    });

    expect(browserDebugger.commands).toEqual([
      {
        method: "Runtime.callFunctionOn",
        params: {
          executionContextId: 42,
          functionDeclaration: "function (value) { return value; }",
          arguments: [{ value: null }, { value: "text" }],
          returnByValue: true,
        },
        sessionId: "child-1",
      },
      {
        method: "Runtime.callFunctionOn",
        params: {
          objectId: "object-1",
          functionDeclaration: "function () {}",
          returnByValue: false,
        },
        sessionId: undefined,
      },
    ]);
  });

  it("maps input commands with only the requested optional fields", async () => {
    const browserDebugger = new FakeDebugger();

    await dispatchBrowserCdpCommand(browserDebugger, "child-1", {
      kind: "cdpDispatchMouseEvent",
      type: "mouseWheel",
      x: 10,
      y: 20,
      button: null,
      clickCount: null,
      deltaX: 1,
      deltaY: -2,
    });
    await dispatchBrowserCdpCommand(browserDebugger, undefined, {
      kind: "cdpDispatchKeyEvent",
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      text: null,
      modifiers: 2,
      unmodifiedText: null,
      windowsVirtualKeyCode: 13,
      location: 0,
      isKeypad: false,
      autoRepeat: false,
      commands: ["insertNewline"],
    });

    expect(browserDebugger.commands).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseWheel",
          x: 10,
          y: 20,
          deltaX: 1,
          deltaY: -2,
        },
        sessionId: "child-1",
      },
      {
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          modifiers: 2,
          windowsVirtualKeyCode: 13,
          location: 0,
          isKeypad: false,
          autoRepeat: false,
          commands: ["insertNewline"],
        },
        sessionId: undefined,
      },
    ]);
  });

  it("returns only the node frame identity used by routing", async () => {
    const browserDebugger = new FakeDebugger();
    browserDebugger.responses.set("DOM.describeNode", {
      node: {
        nodeId: 1,
        backendNodeId: 2,
        nodeName: "DIV",
        frameId: "frame-1",
      },
    });

    await expect(
      dispatchBrowserCdpCommand(browserDebugger, undefined, {
        kind: "cdpDescribeNode",
        objectId: "object-1",
        depth: 1,
        pierce: true,
      }),
    ).resolves.toEqual({
      kind: "cdpDescribeNode",
      ok: true,
      frameId: "frame-1",
    });
    expect(browserDebugger.commands).toEqual([
      {
        method: "DOM.describeNode",
        params: { objectId: "object-1", depth: 1, pierce: true },
        sessionId: undefined,
      },
    ]);
  });
});
