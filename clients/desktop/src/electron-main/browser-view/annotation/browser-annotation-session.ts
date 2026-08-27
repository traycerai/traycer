import { randomUUID } from "node:crypto";
import type {
  BrowserAnnotationAttachPayload,
  BrowserAnnotationAttachRequest,
  BrowserAnnotationEndReason,
  BrowserAnnotationSessionEvent,
  BrowserAnnotationStartResult,
} from "../../../ipc-contracts/browser-annotation-types";
import { describeLogError, log } from "../../app/logger";
import {
  cropAnnotationPng,
  deliveredAnnotationCounts,
  originFromPageUrl,
} from "./browser-annotation-crop";
import { ANNOTATION_OVERLAY_GUEST_SOURCE } from "./browser-annotation-overlay-guest.generated";
import { BrowserDebugSession } from "../debug/browser-debug-session";
import { isRecord } from "../guards";
import {
  ANNOTATION_BINDING_NAME,
  ANNOTATION_CANCEL_EXPRESSION,
  ANNOTATION_CAPTURE_FAILED_EXPRESSION,
  ANNOTATION_HIDE_CHROME_EXPRESSION,
  ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION,
  ANNOTATION_VIEWPORT_SIZE_EXPRESSION,
  ANNOTATION_WAIT_FOR_PAINT_EXPRESSION,
  ANNOTATION_WORLD_NAME,
  buildAnnotationSetTargetChatLabelExpression,
  sanitizeAnnotationBindingPayload,
} from "./browser-annotation-overlay-script";
import type { BrowserViewCapturedImage } from "../browser-view-port";

interface BrowserAnnotationWebContents {
  readonly id: number;
  capturePage(): Promise<BrowserViewCapturedImage>;
  getURL(): string;
  getTitle(): string;
}

interface BrowserAnnotationSessionIdentity {
  readonly tabId: string;
  readonly sessionId: string;
}

interface BrowserAnnotationAttachedResult {
  readonly targetChatId: string;
  readonly payload: BrowserAnnotationAttachPayload;
  readonly pngBytes: Uint8Array;
}

interface BrowserAnnotationSessionOptions {
  readonly webContents: BrowserAnnotationWebContents;
  readonly debugSession: BrowserDebugSession;
  readonly identity: BrowserAnnotationSessionIdentity;
  readonly onEvent: (event: BrowserAnnotationSessionEvent) => void;
  readonly onAttached: (
    result: BrowserAnnotationAttachedResult,
  ) => Promise<boolean>;
}

/**
 * Long-lived guest overlay connection. One CDP binding carries events up;
 * named evaluates carry commands down. Unlike the one-shot picker, start()
 * resolves once the overlay is injected and the session stays open until
 * cancel / navigation / crash / tile close / a replacement start.
 */
export class BrowserAnnotationSession {
  private readonly webContents: BrowserAnnotationWebContents;
  private readonly debugSession: BrowserDebugSession;
  private readonly identity: BrowserAnnotationSessionIdentity;
  private readonly onEvent: (event: BrowserAnnotationSessionEvent) => void;
  private readonly onAttached: (
    result: BrowserAnnotationAttachedResult,
  ) => Promise<boolean>;
  private removeBindingListener: (() => void) | null = null;
  private contextId: number | null = null;
  private ended = false;
  private started = false;
  private capturing = false;
  private markCount = 0;

  constructor(options: BrowserAnnotationSessionOptions) {
    this.webContents = options.webContents;
    this.debugSession = options.debugSession;
    this.identity = options.identity;
    this.onEvent = options.onEvent;
    this.onAttached = options.onAttached;
  }

  isActive(): boolean {
    return this.started && !this.ended;
  }

  zoomLocked(): boolean {
    return this.isActive() && this.markCount > 0;
  }

  async start(): Promise<BrowserAnnotationStartResult> {
    if (this.ended) return { ok: false, reason: "inject-failed" };
    try {
      await this.debugSession.enableAfterCommit();
      if (this.ended) return this.abortStart("inject-failed");
      await this.debugSession.sendCommand(
        "Runtime.addBinding",
        {
          name: ANNOTATION_BINDING_NAME,
          executionContextName: ANNOTATION_WORLD_NAME,
        },
        undefined,
      );
      if (this.ended) return this.abortStart("inject-failed");
      const frameTree = await this.debugSession.sendCommand(
        "Page.getFrameTree",
        {},
        undefined,
      );
      if (this.ended) return this.abortStart("inject-failed");
      const frameId = readMainFrameId(frameTree);
      if (frameId === null) {
        return this.abortStart("no-main-frame");
      }
      const world = await this.debugSession.sendCommand(
        "Page.createIsolatedWorld",
        {
          frameId,
          worldName: ANNOTATION_WORLD_NAME,
          grantUniversalAccess: false,
        },
        undefined,
      );
      const contextId = readExecutionContextId(world);
      if (contextId === null) {
        return this.abortStart("no-isolated-world");
      }
      this.contextId = contextId;
      if (this.ended) return this.abortStart("inject-failed");
      this.attachMessageListener();
      const evaluation = await this.debugSession.sendCommand(
        "Runtime.evaluate",
        {
          expression: ANNOTATION_OVERLAY_GUEST_SOURCE,
          contextId,
          awaitPromise: false,
          returnByValue: true,
          userGesture: true,
        },
        undefined,
      );
      if (this.ended) return this.abortStart("inject-failed");
      if (evaluateFailed(evaluation)) {
        return this.abortStart("inject-failed");
      }
      this.started = true;
      return { ok: true };
    } catch (err) {
      if (!this.ended) {
        log.warn("[browser-view] annotation overlay inject failed", {
          error: describeLogError(err),
          webContentsId: this.webContents.id,
        });
      }
      return this.abortStart(
        this.debugSession.isAttached()
          ? "inject-failed"
          : "debugger-not-attached",
      );
    }
  }

  cancel(): void {
    this.end("cancelled");
  }

  dispose(reason: BrowserAnnotationEndReason): void {
    this.end(reason);
  }

  hideChromeForCapture(): Promise<void> {
    return this.evaluateCommand(ANNOTATION_HIDE_CHROME_EXPRESSION, false, true);
  }

  resetAfterAttach(): Promise<void> {
    return this.evaluateCommand(
      ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION,
      false,
      true,
    ).then(() => {
      this.markCount = 0;
    });
  }

  captureFailed(): Promise<void> {
    return this.evaluateCommand(
      ANNOTATION_CAPTURE_FAILED_EXPRESSION,
      false,
      false,
    );
  }

  setTargetChatLabel(
    targets: readonly { readonly chatId: string; readonly label: string }[],
    defaultChatId: string | null,
  ): Promise<void> {
    return this.evaluateCommand(
      buildAnnotationSetTargetChatLabelExpression(targets, defaultChatId),
      false,
      false,
    );
  }

  private abortStart(
    reason:
      | "debugger-not-attached"
      | "inject-failed"
      | "no-main-frame"
      | "no-isolated-world",
  ): BrowserAnnotationStartResult {
    this.teardownListeners();
    this.removeBinding();
    this.contextId = null;
    return { ok: false, reason };
  }

  private end(reason: BrowserAnnotationEndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.markCount = 0;
    this.sendCancel();
    this.teardownListeners();
    this.removeBinding();
    if (!this.started) return;
    if (reason === "cancelled") {
      this.onEvent({ type: "cancelled" });
      return;
    }
    this.onEvent({ type: "ended", reason });
  }

  private attachMessageListener(): void {
    if (this.removeBindingListener !== null) return;
    this.removeBindingListener = this.debugSession.onBindingCalled((params) => {
      this.handleBindingCalled(params);
    });
  }

  private teardownListeners(): void {
    this.removeBindingListener?.();
    this.removeBindingListener = null;
  }

  private handleBindingCalled(params: Record<string, unknown>): void {
    if (this.ended) return;
    if (params.name !== ANNOTATION_BINDING_NAME) return;
    if (
      this.contextId !== null &&
      typeof params.executionContextId === "number" &&
      params.executionContextId !== this.contextId
    ) {
      return;
    }
    const sanitized = sanitizeAnnotationBindingPayload(params.payload);
    if (sanitized === null) return;
    if (sanitized.type === "cancelled") {
      this.end("cancelled");
      return;
    }
    if (sanitized.type === "attachRequested") {
      void this.captureAttach(sanitized.payload);
      return;
    }
    if (sanitized.type === "stateChanged") {
      this.markCount = sanitized.markCount;
    }
    this.onEvent(sanitized);
  }

  private sendCancel(): void {
    void this.evaluateCommand(ANNOTATION_CANCEL_EXPRESSION, false, false);
  }

  private removeBinding(): void {
    if (!this.debugSession.isAttached()) return;
    this.debugSession
      .sendCommand(
        "Runtime.removeBinding",
        { name: ANNOTATION_BINDING_NAME },
        undefined,
      )
      .catch(() => undefined);
  }

  private async captureAttach(
    request: BrowserAnnotationAttachRequest,
  ): Promise<void> {
    if (!this.isActive() || this.capturing) return;
    this.capturing = true;
    try {
      await this.hideChromeForCapture();
      await this.evaluateCommand(
        ANNOTATION_WAIT_FOR_PAINT_EXPRESSION,
        true,
        true,
      );
      const viewport = await this.readViewportCssSize();
      const image = await this.webContents.capturePage();
      if (!this.isActive()) return;
      const pngBytes =
        viewport === null
          ? null
          : cropAnnotationPng(image, request.unionRect, viewport);
      if (pngBytes === null) {
        if (this.isActive()) await this.captureFailed();
        return;
      }
      const pageUrl = this.webContents.getURL();
      const { counts, droppedElementCount } = deliveredAnnotationCounts(
        request.marks,
        request.elements,
      );
      const payload: BrowserAnnotationAttachPayload = {
        annotationId: `ann-${randomUUID()}`,
        tabId: this.identity.tabId,
        sessionId: this.identity.sessionId,
        origin: originFromPageUrl(pageUrl),
        pageUrl,
        pageTitle: this.webContents.getTitle(),
        capturedAt: Date.now(),
        comment: request.comment,
        counts,
        droppedElementCount,
        elements: [...request.elements],
      };
      const delivered = await this.onAttached({
        targetChatId: request.targetChatId,
        payload,
        pngBytes,
      });
      if (!this.isActive()) return;
      if (!delivered) {
        await this.captureFailed();
        return;
      }
      await this.resetAfterAttach();
    } catch (err) {
      log.warn("[browser-view] annotation capture failed", {
        error: describeLogError(err),
        webContentsId: this.webContents.id,
      });
      if (this.isActive()) {
        await this.captureFailed();
      }
    } finally {
      this.capturing = false;
    }
  }

  private async readViewportCssSize(): Promise<{
    readonly width: number;
    readonly height: number;
  } | null> {
    const evaluation = await this.evaluateRaw(
      ANNOTATION_VIEWPORT_SIZE_EXPRESSION,
      false,
    );
    const value = readEvaluateValue(evaluation);
    if (!isRecord(value)) return null;
    const width = value.width;
    const height = value.height;
    if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
      return null;
    }
    if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
      return null;
    }
    return { width, height };
  }

  private async evaluateCommand(
    expression: string,
    awaitPromise: boolean,
    required: boolean,
  ): Promise<void> {
    if (!required) {
      if (this.contextId === null) return;
      if (!this.debugSession.isAttached()) return;
      try {
        await this.debugSession.sendCommand(
          "Runtime.evaluate",
          {
            expression,
            contextId: this.contextId,
            returnByValue: true,
            awaitPromise,
          },
          undefined,
        );
      } catch {
        return;
      }
      return;
    }
    const evaluation = await this.evaluateRaw(expression, awaitPromise);
    if (evaluateFailed(evaluation)) {
      throw new Error("annotation overlay command did not confirm");
    }
  }

  private async evaluateRaw(
    expression: string,
    awaitPromise: boolean,
  ): Promise<unknown> {
    if (this.contextId === null) {
      throw new Error("annotation isolated world is gone");
    }
    if (!this.debugSession.isAttached()) {
      throw new Error("annotation debugger is not attached");
    }
    return this.debugSession.sendCommand(
      "Runtime.evaluate",
      {
        expression,
        contextId: this.contextId,
        returnByValue: true,
        awaitPromise,
      },
      undefined,
    );
  }
}

function readMainFrameId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const frameTree = value.frameTree;
  if (!isRecord(frameTree)) return null;
  const frame = frameTree.frame;
  if (!isRecord(frame)) return null;
  return typeof frame.id === "string" ? frame.id : null;
}

function readExecutionContextId(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const id = value.executionContextId;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

function evaluateFailed(value: unknown): boolean {
  if (!isRecord(value)) return true;
  if (isRecord(value.exceptionDetails)) return true;
  const result = value.result;
  if (!isRecord(result)) return true;
  return result.value !== true;
}

function readEvaluateValue(value: unknown): unknown {
  if (!isRecord(value)) return null;
  if (isRecord(value.exceptionDetails)) return null;
  const result = value.result;
  if (!isRecord(result)) return null;
  return result.value;
}
