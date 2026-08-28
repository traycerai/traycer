import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type {
  BrowserAnnotationAttachPayload,
  BrowserAnnotationSessionEvent,
  BrowserAnnotationTheme,
} from "../../../../ipc-contracts/browser-annotation-types";
import type { RecordedCommand } from "../../debug/__tests__/browser-debug-session-test-support";
import {
  ANNOTATION_BINDING_NAME,
  ANNOTATION_VIEWPORT_SIZE_EXPRESSION,
  ANNOTATION_WAIT_FOR_PAINT_EXPRESSION,
  ANNOTATION_WORLD_NAME,
  callGuestHook,
} from "../browser-annotation-overlay-script";
import { ANNOTATION_OVERLAY_GUEST_SOURCE } from "../browser-annotation-overlay-guest.generated";
import { BrowserAnnotationSession } from "../browser-annotation-session";
import { BrowserDebugSession } from "../../debug/browser-debug-session";
import type {
  BrowserViewCapturedImage,
  BrowserViewDebugger,
} from "../../browser-view-port";

const ANNOTATION_CANCEL_EXPRESSION = callGuestHook(
  "__traycerAnnotationCancel",
  [],
);
const ANNOTATION_CAPTURE_FAILED_EXPRESSION = callGuestHook(
  "__traycerAnnotationCaptureFailed",
  [],
);
const ANNOTATION_HIDE_CHROME_EXPRESSION = callGuestHook(
  "__traycerAnnotationHideChromeForCapture",
  [],
);
const ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION = callGuestHook(
  "__traycerAnnotationResetAfterAttach",
  [],
);

const TEST_ANNOTATION_THEME: BrowserAnnotationTheme = {
  appearance: "dark",
  background: "#111111",
  foreground: "#eeeeee",
  popover: "#222222",
  popoverForeground: "#eeeeee",
  mutedForeground: "#aaaaaa",
  border: "#444444",
  input: "#333333",
  ring: "#888888",
  primary: "#ffffff",
  primaryForeground: "#000000",
  accent: "#555555",
  accentForeground: "#ffffff",
  destructive: "#ff0000",
  warning: "#ffaa00",
  warningForeground: "#000000",
  fontFamily: "Inter",
};

type BrowserViewCropRect = Parameters<BrowserViewCapturedImage["crop"]>[0];

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  describeLogError: (err: unknown) => String(err),
}));

interface AttachedResult {
  readonly targetChatId: string;
  readonly payload: BrowserAnnotationAttachPayload;
  readonly pngBytes: Uint8Array;
}

class FakeDebugger implements BrowserViewDebugger {
  readonly commands: RecordedCommand[] = [];
  failAttach = false;
  holdFrameTree = false;
  holdAddBinding = false;
  failEvaluate = false;
  missingFrame = false;
  missingWorld = false;
  readonly falseEvaluateExpressions = new Set<string>();
  readonly rejectEvaluateExpressions = new Set<string>();
  private attached: boolean;
  private frameTreeResolve: ((value: unknown) => void) | null = null;
  private addBindingResolve: ((value: unknown) => void) | null = null;
  private readonly events = new EventEmitter();

  constructor(attached: boolean) {
    this.attached = attached;
  }

  isAttached(): boolean {
    return this.attached;
  }

  attach(_protocolVersion: string): void {
    if (this.failAttach) throw new Error("Debugger.attach rejected");
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
  }

  sendCommand(
    method: string,
    commandParams: Record<string, unknown>,
    sessionId: string | undefined,
  ): Promise<unknown> {
    this.commands.push({ method, params: commandParams, sessionId });
    if (method === "Page.getFrameTree") {
      if (this.holdFrameTree) {
        return new Promise((resolve) => {
          this.frameTreeResolve = resolve;
        });
      }
      if (this.missingFrame) {
        return Promise.resolve({ frameTree: { frame: {} } });
      }
      return Promise.resolve({
        frameTree: { frame: { id: "FRAME-1", url: "https://example.test/" } },
      });
    }
    if (method === "Runtime.addBinding") {
      if (this.holdAddBinding) {
        return new Promise((resolve) => {
          this.addBindingResolve = resolve;
        });
      }
      return Promise.resolve({});
    }
    if (method === "Page.createIsolatedWorld") {
      if (this.missingWorld) {
        return Promise.resolve({});
      }
      return Promise.resolve({ executionContextId: 77 });
    }
    if (method === "Runtime.evaluate") {
      const expression =
        typeof commandParams.expression === "string"
          ? commandParams.expression
          : "";
      if (this.rejectEvaluateExpressions.has(expression)) {
        return Promise.reject(new Error("Runtime.evaluate rejected"));
      }
      if (this.falseEvaluateExpressions.has(expression)) {
        return Promise.resolve({ result: { value: false } });
      }
      if (this.failEvaluate) {
        return Promise.resolve({
          exceptionDetails: { text: "inject failed" },
        });
      }
      if (expression.includes("traycerAnnotationViewport")) {
        return Promise.resolve({
          result: { value: { width: 800, height: 600 } },
        });
      }
      return Promise.resolve({ result: { value: true } });
    }
    return Promise.resolve({});
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.events.on(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.events.off(event, listener);
  }

  emitMessage(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    this.events.emit("message", {}, method, params, sessionId);
  }

  resolveFrameTree(): void {
    this.frameTreeResolve?.({
      frameTree: { frame: { id: "FRAME-1", url: "https://example.test/" } },
    });
  }

  resolveAddBinding(): void {
    this.addBindingResolve?.({});
  }

  listenerCount(event: string): number {
    return this.events.listenerCount(event);
  }

  commandMethods(): string[] {
    return this.commands.map((command) => command.method);
  }

  find(method: string): RecordedCommand | undefined {
    return this.commands.find((command) => command.method === method);
  }

  finds(method: string): RecordedCommand[] {
    return this.commands.filter((command) => command.method === method);
  }
}

class FakeCapturedImage implements BrowserViewCapturedImage {
  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly bytes: Uint8Array,
  ) {}

  getSize(): { readonly width: number; readonly height: number } {
    return { width: this.width, height: this.height };
  }

  toJPEG(): Uint8Array {
    return this.bytes;
  }

  toDataURL(): string {
    return "";
  }

  isEmpty(): boolean {
    return this.width <= 0 || this.height <= 0 || this.bytes.byteLength === 0;
  }

  crop(rect: BrowserViewCropRect): BrowserViewCapturedImage {
    return new FakeCapturedImage(rect.width, rect.height, this.bytes);
  }

  toPNG(): Uint8Array {
    return this.bytes;
  }
}

class FakeWebContents {
  readonly id = 9;
  readonly debugger: FakeDebugger;
  captureCount = 0;
  emptyCapture = false;
  failCapture = false;
  expressionsAtCapture: string[] = [];
  constructor(attached: boolean) {
    this.debugger = new FakeDebugger(attached);
  }

  capturePage(): Promise<BrowserViewCapturedImage> {
    this.captureCount += 1;
    this.expressionsAtCapture = evaluateExpressions(this.debugger);
    if (this.failCapture) {
      return Promise.reject(new Error("capture failed"));
    }
    if (this.emptyCapture) {
      return Promise.resolve(new FakeCapturedImage(0, 0, new Uint8Array()));
    }
    return Promise.resolve(
      new FakeCapturedImage(
        800,
        600,
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      ),
    );
  }

  getURL(): string {
    return "https://example.com/";
  }

  getTitle(): string {
    return "Example Domain";
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function evaluateExpressions(debuggerInstance: FakeDebugger): string[] {
  return debuggerInstance
    .finds("Runtime.evaluate")
    .map((command) =>
      typeof command.params.expression === "string"
        ? command.params.expression
        : "",
    );
}

interface SessionHarness {
  readonly session: BrowserAnnotationSession;
  readonly debugSession: BrowserDebugSession;
  readonly webContents: FakeWebContents;
  readonly events: BrowserAnnotationSessionEvent[];
  readonly attached: AttachedResult[];
}

function createHarness(attached: boolean): SessionHarness {
  const webContents = new FakeWebContents(attached);
  const debugSession = createDebugSession(webContents);
  const events: BrowserAnnotationSessionEvent[] = [];
  const attachedEvents: AttachedResult[] = [];
  const session = new BrowserAnnotationSession({
    webContents,
    debugSession,
    theme: TEST_ANNOTATION_THEME,
    identity: { tabId: "tab-1", sessionId: "session-1" },
    onEvent: (event) => {
      events.push(event);
    },
    onAttached: (result) => {
      attachedEvents.push(result);
      return Promise.resolve(true);
    },
  });
  return {
    session,
    debugSession,
    webContents,
    events,
    attached: attachedEvents,
  };
}

function createDebugSession(webContents: FakeWebContents): BrowserDebugSession {
  return new BrowserDebugSession({
    webContents,
    onDetached: () => undefined,
  });
}

const VALID_UNION = { x: 1, y: 2, width: 10, height: 20 };

const TARGET_CHAT_ID = "chat-target-1";

const VALID_ATTACH_PAYLOAD = {
  targetChatId: TARGET_CHAT_ID,
  marks: [
    {
      id: "m1",
      kind: "element" as const,
      bounds: VALID_UNION,
      selector: "button#go",
    },
  ],
  elements: [
    {
      selector: "button#go",
      tagName: "BUTTON",
      elementId: "go",
      classNames: ["primary"],
      outerHtml: "<button>Go</button>",
      outerHtmlTruncated: false,
      textPreview: "Go",
      ariaRole: "button",
      accessibleName: "Go",
      boundingBox: {
        x: 1,
        y: 2,
        width: 10,
        height: 20,
        top: 2,
        right: 11,
        bottom: 22,
        left: 1,
      },
    },
  ],
  comment: "look here",
  unionRect: VALID_UNION,
};

function emitBinding(
  debuggerInstance: FakeDebugger,
  payload: unknown,
  executionContextId: number | undefined,
): void {
  const params: Record<string, unknown> = {
    name: ANNOTATION_BINDING_NAME,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
  if (executionContextId !== undefined) {
    params.executionContextId = executionContextId;
  }
  debuggerInstance.emitMessage("Runtime.bindingCalled", params, undefined);
}

describe("BrowserAnnotationSession annotation overlay", () => {
  it("injects the isolated world and binding once on start", async () => {
    const harness = createHarness(true);
    await expect(harness.session.start()).resolves.toEqual({ ok: true });
    expect(harness.session.isActive()).toBe(true);
    expect(
      evaluateExpressions(harness.webContents.debugger).join("\n"),
    ).toContain(TEST_ANNOTATION_THEME.background);

    expect(harness.webContents.debugger.commandMethods()).toEqual([
      "Page.enable",
      "Runtime.enable",
      "Log.enable",
      "Network.enable",
      "DOM.enable",
      "Runtime.addBinding",
      "Page.getFrameTree",
      "Page.createIsolatedWorld",
      "Runtime.evaluate",
    ]);

    expect(
      harness.webContents.debugger.find("Runtime.addBinding")?.params,
    ).toEqual({
      name: ANNOTATION_BINDING_NAME,
      executionContextName: ANNOTATION_WORLD_NAME,
    });
    expect(
      harness.webContents.debugger.find("Page.createIsolatedWorld")?.params,
    ).toEqual({
      frameId: "FRAME-1",
      worldName: ANNOTATION_WORLD_NAME,
      grantUniversalAccess: false,
    });
    expect(
      harness.webContents.debugger.find("Runtime.evaluate")?.params,
    ).toEqual({
      expression: expect.stringContaining(ANNOTATION_OVERLAY_GUEST_SOURCE),
      contextId: 77,
      awaitPromise: false,
      returnByValue: true,
      userGesture: true,
    });
  });

  it("uses the shared debugger owner to attach and enable before injection", async () => {
    const harness = createHarness(false);
    await expect(harness.session.start()).resolves.toEqual({ ok: true });
    expect(harness.debugSession.isReady()).toBe(true);
    expect(harness.webContents.debugger.listenerCount("message")).toBe(1);
  });

  it("reports debugger-not-attached when the shared owner cannot attach", async () => {
    const harness = createHarness(false);
    harness.webContents.debugger.failAttach = true;
    await expect(harness.session.start()).resolves.toEqual({
      ok: false,
      reason: "debugger-not-attached",
    });
    expect(harness.webContents.debugger.commands).toHaveLength(0);
    expect(harness.webContents.debugger.listenerCount("message")).toBe(0);
  });

  it("returns no-main-frame when the frame tree has no id", async () => {
    const harness = createHarness(true);
    harness.webContents.debugger.missingFrame = true;
    await expect(harness.session.start()).resolves.toEqual({
      ok: false,
      reason: "no-main-frame",
    });
    expect(harness.webContents.debugger.listenerCount("message")).toBe(1);
    expect(
      harness.webContents.debugger.find("Runtime.removeBinding")?.params,
    ).toEqual({
      name: ANNOTATION_BINDING_NAME,
    });
  });

  it("returns no-isolated-world and removes the binding", async () => {
    const harness = createHarness(true);
    harness.webContents.debugger.missingWorld = true;
    await expect(harness.session.start()).resolves.toEqual({
      ok: false,
      reason: "no-isolated-world",
    });
    expect(harness.webContents.debugger.listenerCount("message")).toBe(1);
    expect(
      harness.webContents.debugger.find("Runtime.removeBinding")?.params,
    ).toEqual({
      name: ANNOTATION_BINDING_NAME,
    });
  });

  it("returns inject-failed and removes its binding subscription when evaluate fails", async () => {
    const harness = createHarness(true);
    harness.webContents.debugger.failEvaluate = true;
    await expect(harness.session.start()).resolves.toEqual({
      ok: false,
      reason: "inject-failed",
    });
    expect(harness.webContents.debugger.listenerCount("message")).toBe(1);
    expect(harness.events).toEqual([]);
    expect(evaluateExpressions(harness.webContents.debugger)).toContain(
      ANNOTATION_CANCEL_EXPRESSION,
    );
    expect(
      harness.webContents.debugger.find("Runtime.removeBinding")?.params,
    ).toEqual({
      name: ANNOTATION_BINDING_NAME,
    });
  });

  it("round-trips a binding stateChanged event as a sanitized onEvent", async () => {
    const harness = createHarness(true);
    await harness.session.start();

    emitBinding(
      harness.webContents.debugger,
      { type: "stateChanged", mode: "select", markCount: 0 },
      77,
    );

    expect(harness.events).toEqual([
      { type: "stateChanged", mode: "select", markCount: 0 },
    ]);
  });

  it("ignores a binding from another isolated world", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    emitBinding(
      harness.webContents.debugger,
      { type: "stateChanged", mode: "draw", markCount: 1 },
      99,
    );
    expect(harness.events).toEqual([]);
  });

  it("ignores a binding that is not __traycerAnnotation", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    harness.webContents.debugger.emitMessage(
      "Runtime.bindingCalled",
      {
        name: "__traycerOther",
        payload: JSON.stringify({
          type: "stateChanged",
          mode: "select",
          markCount: 0,
        }),
        executionContextId: 77,
      },
      undefined,
    );
    expect(harness.events).toEqual([]);
  });

  it("drops raw unknown binding types", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    emitBinding(harness.webContents.debugger, { type: "mystery" }, 77);
    emitBinding(
      harness.webContents.debugger,
      { type: "ended", reason: "navigation" },
      77,
    );
    expect(harness.events).toEqual([]);
  });

  it("consumes a valid attachRequested envelope and does not emit it as a session event", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    emitBinding(
      harness.webContents.debugger,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();

    const expressions = evaluateExpressions(harness.webContents.debugger);
    const hideIdx = expressions.indexOf(ANNOTATION_HIDE_CHROME_EXPRESSION);
    const waitIdx = expressions.indexOf(ANNOTATION_WAIT_FOR_PAINT_EXPRESSION);
    const viewportIdx = expressions.indexOf(
      ANNOTATION_VIEWPORT_SIZE_EXPRESSION,
    );
    const resetIdx = expressions.indexOf(
      ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION,
    );
    expect(hideIdx).toBeGreaterThan(-1);
    expect(waitIdx).toBeGreaterThan(hideIdx);
    expect(viewportIdx).toBeGreaterThan(waitIdx);
    expect(resetIdx).toBeGreaterThan(viewportIdx);
    expect(expressions).not.toContain(ANNOTATION_CAPTURE_FAILED_EXPRESSION);

    const waitForPaint = harness.webContents.debugger
      .finds("Runtime.evaluate")
      .find(
        (command) =>
          command.params.expression === ANNOTATION_WAIT_FOR_PAINT_EXPRESSION,
      );
    expect(waitForPaint?.params.awaitPromise).toBe(true);

    expect(harness.webContents.captureCount).toBe(1);
    expect(harness.webContents.expressionsAtCapture).toContain(
      ANNOTATION_HIDE_CHROME_EXPRESSION,
    );
    expect(harness.webContents.expressionsAtCapture).not.toContain(
      ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION,
    );

    expect(harness.session.isActive()).toBe(true);
    expect(harness.events).toEqual([]);
    expect(harness.attached).toHaveLength(1);
    expect(harness.attached[0]?.targetChatId).toBe(TARGET_CHAT_ID);
    const payload = harness.attached[0]?.payload;
    expect(payload?.annotationId.startsWith("ann-")).toBe(true);
    expect(payload?.tabId).toBe("tab-1");
    expect(payload?.sessionId).toBe("session-1");
    expect(payload?.origin).toBe("https://example.com");
    expect(payload?.pageUrl).toBe("https://example.com/");
    expect(payload?.pageTitle).toBe("Example Domain");
    expect(payload?.comment).toBe("look here");
    expect(payload?.counts).toEqual({
      elements: 1,
      regions: 0,
      strokes: 0,
    });
    expect(payload?.counts.elements).toBe(payload?.elements.length);
    expect(payload?.droppedElementCount).toBe(0);
    expect(payload?.elements).toHaveLength(1);
    expect(harness.attached[0]?.pngBytes.byteLength).toBeGreaterThan(0);
  });

  it("keeps the bundle open and skips reset when attach delivery fails", async () => {
    const webContents = new FakeWebContents(true);
    const debugSession = createDebugSession(webContents);
    const attached: AttachedResult[] = [];
    const session = new BrowserAnnotationSession({
      webContents,
      debugSession,
      theme: TEST_ANNOTATION_THEME,
      identity: { tabId: "tab-1", sessionId: "session-1" },
      onEvent: () => undefined,
      onAttached: (result) => {
        attached.push(result);
        return Promise.resolve(false);
      },
    });
    await session.start();
    emitBinding(
      webContents.debugger,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();

    expect(attached).toHaveLength(1);
    expect(attached[0]?.targetChatId).toBe(TARGET_CHAT_ID);
    expect(session.isActive()).toBe(true);
    const expressions = evaluateExpressions(webContents.debugger);
    expect(expressions).toContain(ANNOTATION_CAPTURE_FAILED_EXPRESSION);
    expect(expressions).not.toContain(ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION);
  });

  it("sets counts.elements to delivered captures and reports droppedElementCount when marks outnumber captures", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    emitBinding(
      harness.webContents.debugger,
      {
        type: "attachRequested",
        payload: {
          ...VALID_ATTACH_PAYLOAD,
          marks: [
            ...VALID_ATTACH_PAYLOAD.marks,
            {
              id: "m2",
              kind: "element" as const,
              bounds: VALID_UNION,
              selector: "h1",
            },
            {
              id: "m3",
              kind: "element" as const,
              bounds: VALID_UNION,
              selector: "p",
            },
          ],
        },
      },
      77,
    );
    await flush();

    expect(harness.attached).toHaveLength(1);
    expect(harness.attached[0]?.targetChatId).toBe(TARGET_CHAT_ID);
    const payload = harness.attached[0]?.payload;
    expect(payload?.elements).toHaveLength(1);
    expect(payload?.counts.elements).toBe(1);
    expect(payload?.counts.elements).toBe(payload?.elements.length);
    expect(payload?.droppedElementCount).toBe(2);
  });

  it("keeps the session active and evaluates captureFailed when capturePage returns an empty image", async () => {
    const harness = createHarness(true);
    harness.webContents.emptyCapture = true;
    await harness.session.start();
    emitBinding(
      harness.webContents.debugger,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();

    const expressions = evaluateExpressions(harness.webContents.debugger);
    expect(harness.session.isActive()).toBe(true);
    expect(harness.attached).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(expressions).toContain(ANNOTATION_CAPTURE_FAILED_EXPRESSION);
    expect(expressions).not.toContain(ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION);
  });

  it("keeps the session active and evaluates captureFailed when capturePage throws", async () => {
    const harness = createHarness(true);
    harness.webContents.failCapture = true;
    await harness.session.start();
    emitBinding(
      harness.webContents.debugger,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();

    const expressions = evaluateExpressions(harness.webContents.debugger);
    expect(harness.session.isActive()).toBe(true);
    expect(harness.attached).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(expressions).toContain(ANNOTATION_CAPTURE_FAILED_EXPRESSION);
    expect(expressions).not.toContain(ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION);
  });

  it("rejects a guest-supplied annotationId or screenshot nested under payload", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    emitBinding(
      harness.webContents.debugger,
      {
        type: "attachRequested",
        payload: { ...VALID_ATTACH_PAYLOAD, annotationId: "guest-id" },
      },
      77,
    );
    emitBinding(
      harness.webContents.debugger,
      {
        type: "attachRequested",
        payload: {
          ...VALID_ATTACH_PAYLOAD,
          marks: [
            {
              ...VALID_ATTACH_PAYLOAD.marks[0],
              screenshot: "data:image/png;base64,abc",
            },
          ],
        },
      },
      77,
    );
    expect(harness.events).toEqual([]);
    expect(harness.webContents.captureCount).toBe(0);
    expect(harness.attached).toEqual([]);
  });

  it("rejects a guest-supplied annotationId or screenshot on attachRequested", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    emitBinding(
      harness.webContents.debugger,
      {
        type: "attachRequested",
        annotationId: "guest-id",
        payload: VALID_ATTACH_PAYLOAD,
      },
      77,
    );
    emitBinding(
      harness.webContents.debugger,
      {
        type: "attachRequested",
        screenshot: "data:image/png;base64,abc",
        payload: VALID_ATTACH_PAYLOAD,
      },
      77,
    );
    expect(harness.events).toEqual([]);
    expect(harness.webContents.captureCount).toBe(0);
    expect(harness.attached).toEqual([]);
  });

  it("evaluates the target roster expression while the overlay is active", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    await harness.session.setTargetChatLabel(
      [
        { chatId: TARGET_CHAT_ID, label: "Plan" },
        { chatId: "chat-other", label: "Other" },
      ],
      TARGET_CHAT_ID,
    );
    const expressions = evaluateExpressions(harness.webContents.debugger);
    expect(
      expressions.some(
        (expression) =>
          expression.includes("__traycerAnnotationSetTargetChatLabel") &&
          expression.includes(TARGET_CHAT_ID) &&
          expression.includes("Plan") &&
          expression.includes("chat-other"),
      ),
    ).toBe(true);
  });

  it("drops an attachRequested envelope that is missing targetChatId", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    const { targetChatId: _omitted, ...withoutTarget } = VALID_ATTACH_PAYLOAD;
    emitBinding(
      harness.webContents.debugger,
      { type: "attachRequested", payload: withoutTarget },
      77,
    );
    await flush();
    expect(harness.attached).toEqual([]);
    expect(harness.webContents.captureCount).toBe(0);
  });

  it("cancel evaluates the cancel hook, unsubscribes, and emits cancelled after start", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    expect(harness.webContents.debugger.listenerCount("message")).toBe(1);

    harness.session.cancel();
    await flush();

    expect(harness.session.isActive()).toBe(false);
    expect(harness.events).toEqual([{ type: "cancelled" }]);
    expect(harness.webContents.debugger.listenerCount("message")).toBe(1);
    const cancelEvaluate = harness.webContents.debugger
      .finds("Runtime.evaluate")
      .find(
        (command) => command.params.expression === ANNOTATION_CANCEL_EXPRESSION,
      );
    expect(cancelEvaluate?.params).toMatchObject({ contextId: 77 });
    expect(
      harness.webContents.debugger.find("Runtime.removeBinding")?.params,
    ).toEqual({
      name: ANNOTATION_BINDING_NAME,
    });
  });

  it("cancel after a failed start does not emit cancelled", async () => {
    const harness = createHarness(false);
    harness.webContents.debugger.failAttach = true;
    await harness.session.start();
    harness.session.cancel();
    expect(harness.events).toEqual([]);
    expect(
      harness.webContents.debugger.find("Runtime.removeBinding"),
    ).toBeUndefined();
  });

  it("guest cancelled binding ends the session and unsubscribes", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    emitBinding(harness.webContents.debugger, { type: "cancelled" }, 77);
    await flush();

    expect(harness.session.isActive()).toBe(false);
    expect(harness.events).toEqual([{ type: "cancelled" }]);
    expect(harness.webContents.debugger.listenerCount("message")).toBe(1);
    expect(
      harness.webContents.debugger.find("Runtime.removeBinding")?.params,
    ).toEqual({
      name: ANNOTATION_BINDING_NAME,
    });
  });

  it.each(["navigation", "crash", "tile-close", "replaced"] as const)(
    "dispose(%s) emits ended and unsubscribes",
    async (reason) => {
      const harness = createHarness(true);
      await harness.session.start();
      harness.session.dispose(reason);
      await flush();

      expect(harness.events).toEqual([{ type: "ended", reason }]);
      expect(harness.webContents.debugger.listenerCount("message")).toBe(1);
      expect(harness.session.isActive()).toBe(false);
    },
  );

  it("a second session on the same debugger after dispose has no leftover listeners from the first", async () => {
    const webContents = new FakeWebContents(true);
    const debugSession = createDebugSession(webContents);
    const firstEvents: BrowserAnnotationSessionEvent[] = [];
    const first = new BrowserAnnotationSession({
      webContents,
      debugSession,
      theme: TEST_ANNOTATION_THEME,
      identity: { tabId: "tab-1", sessionId: "session-1" },
      onEvent: (event) => {
        firstEvents.push(event);
      },
      onAttached: () => Promise.resolve(true),
    });
    await first.start();
    expect(webContents.debugger.listenerCount("message")).toBe(1);
    first.dispose("replaced");
    expect(webContents.debugger.listenerCount("message")).toBe(1);

    const secondEvents: BrowserAnnotationSessionEvent[] = [];
    const second = new BrowserAnnotationSession({
      webContents,
      debugSession,
      theme: TEST_ANNOTATION_THEME,
      identity: { tabId: "tab-1", sessionId: "session-1" },
      onEvent: (event) => {
        secondEvents.push(event);
      },
      onAttached: () => Promise.resolve(true),
    });
    await second.start();
    expect(webContents.debugger.listenerCount("message")).toBe(1);

    emitBinding(
      webContents.debugger,
      { type: "stateChanged", mode: "region", markCount: 2 },
      77,
    );
    expect(firstEvents).toEqual([{ type: "ended", reason: "replaced" }]);
    expect(secondEvents).toEqual([
      { type: "stateChanged", mode: "region", markCount: 2 },
    ]);

    second.dispose("tile-close");
    expect(webContents.debugger.listenerCount("message")).toBe(1);
  });

  it("evaluates hideChromeForCapture, resetAfterAttach, and captureFailed", async () => {
    const harness = createHarness(true);
    await harness.session.start();

    await harness.session.hideChromeForCapture();
    await harness.session.resetAfterAttach();
    await harness.session.captureFailed();

    const expressions = harness.webContents.debugger
      .finds("Runtime.evaluate")
      .map((command) => command.params.expression);
    expect(expressions).toContain(ANNOTATION_HIDE_CHROME_EXPRESSION);
    expect(expressions).toContain(ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION);
    expect(expressions).toContain(ANNOTATION_CAPTURE_FAILED_EXPRESSION);
  });

  it("leaves only the shared debugger listener after dispose or cancel", async () => {
    const cancelled = createHarness(true);
    await cancelled.session.start();
    cancelled.session.cancel();
    expect(cancelled.webContents.debugger.listenerCount("message")).toBe(1);

    const disposed = createHarness(true);
    await disposed.session.start();
    disposed.session.dispose("navigation");
    expect(disposed.webContents.debugger.listenerCount("message")).toBe(1);
  });

  it("locks zoom from sanitized markCount and clears it on reset", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    expect(harness.session.zoomLocked()).toBe(false);

    emitBinding(
      harness.webContents.debugger,
      { type: "stateChanged", mode: "select", markCount: 1 },
      77,
    );
    expect(harness.session.zoomLocked()).toBe(true);

    emitBinding(
      harness.webContents.debugger,
      { type: "stateChanged", mode: "erase", markCount: 0 },
      77,
    );
    expect(harness.session.zoomLocked()).toBe(false);

    emitBinding(
      harness.webContents.debugger,
      { type: "stateChanged", mode: "select", markCount: 2 },
      77,
    );
    expect(harness.session.zoomLocked()).toBe(true);
    await harness.session.resetAfterAttach();
    expect(harness.session.zoomLocked()).toBe(false);
  });

  it("does not emit attached when hideChromeForCapture returns false", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    harness.webContents.debugger.falseEvaluateExpressions.add(
      ANNOTATION_HIDE_CHROME_EXPRESSION,
    );
    emitBinding(
      harness.webContents.debugger,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();

    expect(harness.attached).toEqual([]);
    expect(harness.webContents.captureCount).toBe(0);
    expect(evaluateExpressions(harness.webContents.debugger)).toContain(
      ANNOTATION_CAPTURE_FAILED_EXPRESSION,
    );
    expect(evaluateExpressions(harness.webContents.debugger)).not.toContain(
      ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION,
    );
  });

  it("delivers the attach then unlocks the guest when resetAfterAttach is rejected", async () => {
    const harness = createHarness(true);
    await harness.session.start();
    harness.webContents.debugger.rejectEvaluateExpressions.add(
      ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION,
    );
    emitBinding(
      harness.webContents.debugger,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();

    expect(harness.webContents.captureCount).toBe(1);
    expect(harness.attached).toHaveLength(1);
    expect(harness.session.isActive()).toBe(true);
    const expressions = evaluateExpressions(harness.webContents.debugger);
    expect(expressions).toContain(ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION);
    expect(expressions).toContain(ANNOTATION_CAPTURE_FAILED_EXPRESSION);
  });

  it("removes the binding when cancel races a pending addBinding, then a new session starts cleanly", async () => {
    const first = createHarness(true);
    first.webContents.debugger.holdAddBinding = true;
    const startPromise = first.session.start();
    await flush();
    first.session.cancel();
    first.webContents.debugger.resolveAddBinding();
    await expect(startPromise).resolves.toEqual({
      ok: false,
      reason: "inject-failed",
    });
    expect(first.events).toEqual([]);
    expect(first.webContents.debugger.listenerCount("message")).toBe(1);
    expect(
      first.webContents.debugger.find("Runtime.removeBinding")?.params,
    ).toEqual({
      name: ANNOTATION_BINDING_NAME,
    });

    const retryEvents: BrowserAnnotationSessionEvent[] = [];
    const retry = new BrowserAnnotationSession({
      webContents: first.webContents,
      debugSession: first.debugSession,
      theme: TEST_ANNOTATION_THEME,
      identity: { tabId: "tab-1", sessionId: "session-1" },
      onEvent: (event) => {
        retryEvents.push(event);
      },
      onAttached: () => Promise.resolve(true),
    });
    first.webContents.debugger.holdAddBinding = false;
    await expect(retry.start()).resolves.toEqual({ ok: true });
    expect(retry.isActive()).toBe(true);
    expect(retryEvents).toEqual([]);
    retry.dispose("tile-close");
  });
});
