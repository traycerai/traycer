import {
  browserCdpResultSchema,
  type BrowserCdpCommand,
  type BrowserCdpError,
  type BrowserCdpFrameInfo,
  type BrowserCdpResult,
  type BrowserCdpTarget,
  type BrowserScreencastServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserViewDebugSnapshotData } from "../../../ipc-contracts/browser-view-types";
import type { PipCaptureIpcPayload } from "../../../ipc-contracts/pip-capture-types";
import type {
  BrowserViewDebugger,
  BrowserViewWebContents,
} from "../browser-view-port";
import { describeLogError, log } from "../../app/logger";
import { dispatchBrowserCdpCommand } from "./browser-cdp-command-dispatch";
import { BrowserDebugTelemetry } from "./browser-debug-telemetry";
import { isRecord } from "../guards";

// ponytail: Polling at 5 fps keeps hidden-tab painting reliable without paying
// full-frame capture cost; raise this ceiling only if PiP motion needs it.
const PIP_CAPTURE_INTERVAL_MS = 200;

interface BrowserDebugSessionOptions {
  readonly webContents: BrowserDebugWebContents;
  readonly onDetached: (reason: string) => void;
}

interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

interface BrowserPipCaptureStartInput {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
  readonly onFrame: (payload: PipCaptureIpcPayload) => void;
}

type ChildFrameRoute = {
  readonly kind: "unresolved" | "same-process";
  readonly parentFrameId: string;
};

type FrameRoute =
  | {
      readonly kind: "root";
      readonly parentFrameId: null;
    }
  | ChildFrameRoute;

interface ChildSession {
  readonly attachmentGeneration: number;
  readonly parentFrameId: string;
  route: FrameRoute;
  state: "attaching" | "ready" | "retiring";
  sessionId: string | null;
  readonly readiness: Promise<string>;
  readonly rejectReadiness: (reason: Error) => void;
  retirement: Promise<boolean> | null;
}

interface ResolvedTargetRoute {
  readonly attachmentGeneration: number;
  readonly topologyRevision: number;
  readonly frameId: string | null;
  readonly frameRoute: FrameRoute | null;
  readonly childTargetId: string | null;
  readonly childSession: ChildSession | null;
  readonly sessionId: string | null;
}

export class BrowserDebugSession {
  private readonly webContents: BrowserDebugWebContents;
  private readonly onDetached: (reason: string) => void;
  private readonly telemetry: BrowserDebugTelemetry;
  private readonly childSessionByTargetId = new Map<string, ChildSession>();
  private readonly frameRouteById = new Map<string, FrameRoute>();
  private readonly bindingCalledListeners = new Set<
    (params: Record<string, unknown>) => void
  >();
  private readonly messageListener = (...args: unknown[]) => {
    this.handleDebuggerMessage(args);
  };
  private readonly detachListener = (...args: unknown[]) => {
    this.handleDebuggerDetach(args);
  };
  private enabled = false;
  private enablePromise: Promise<void> | null = null;
  private attachedBySession = false;
  private listening = false;
  private disposed = false;
  private attachmentGeneration = 0;
  private attachmentEnd = Promise.withResolvers<void>();
  private readonly sessionEnd = Promise.withResolvers<void>();
  private topologyRevision = 0;
  private targetDiscovery: {
    readonly revision: number;
    readonly promise: Promise<ReadonlySet<string>>;
  } | null = null;
  private readonly detachedChildSessionIds = new Set<string>();
  private pipCapture: ActivePipCapture | null = null;

  constructor(options: BrowserDebugSessionOptions) {
    this.webContents = options.webContents;
    this.onDetached = options.onDetached;
    this.telemetry = new BrowserDebugTelemetry(options.webContents.id);
  }

  isAttached(): boolean {
    return !this.disposed && this.webContents.debugger.isAttached();
  }

  isReady(): boolean {
    return this.enabled && this.isAttached();
  }

  /** Internal desktop consumers share this attachment owner. */
  async sendCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): Promise<unknown> {
    if (!this.isReady()) {
      throw new Error("Browser debugger is not ready.");
    }
    try {
      return await this.raceWithAttachmentEnd(
        sendDebuggerCommand(
          this.webContents.debugger,
          method,
          params,
          sessionId,
        ),
        "Browser debugger detached during command",
      );
    } finally {
      this.stopListeningIfIdle();
    }
  }

  onBindingCalled(
    listener: (params: Record<string, unknown>) => void,
  ): () => void {
    if (this.disposed) return () => undefined;
    this.bindingCalledListeners.add(listener);
    if (this.isAttached()) this.startListening();
    return () => {
      this.bindingCalledListeners.delete(listener);
      this.stopListeningIfIdle();
    };
  }

  async dispatch(
    target: BrowserCdpTarget,
    command: BrowserCdpCommand,
  ): Promise<BrowserCdpResult> {
    if (!this.isReady()) {
      return cdpFailure(
        command,
        "not_attached",
        "Browser debugger is not ready.",
        null,
      );
    }
    try {
      const route = await this.resolveTarget(target);
      this.requireCurrentTargetRoute(route, false);
      const result = browserCdpResultSchema.parse(
        await dispatchBrowserCdpCommand(
          this.webContents.debugger,
          route.sessionId ?? undefined,
          command,
        ),
      );
      if (result.ok && result.kind === "cdpGetFrameTree") {
        this.requireCurrentTargetRoute(route, true);
        this.recordFrameTreeRoute(route, result.frames);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        isRecord(error) && typeof error.code === "number" ? error.code : null;
      return cdpFailure(
        command,
        this.isAttached() ? "cdp_error" : "not_attached",
        message,
        code,
      );
    }
  }

  async installScriptBeforeNavigation(source: string): Promise<string> {
    const result = await sendDebuggerCommand(
      this.ensureAttached(),
      "Page.addScriptToEvaluateOnNewDocument",
      { source },
      undefined,
    );
    if (
      result === null ||
      typeof result !== "object" ||
      !("identifier" in result) ||
      typeof result.identifier !== "string"
    ) {
      throw new Error(
        "Browser seed script registration returned no identifier",
      );
    }
    return result.identifier;
  }

  removeScriptBeforeNavigation(identifier: string): Promise<unknown> {
    return this.sendCommand(
      "Page.removeScriptToEvaluateOnNewDocument",
      { identifier },
      undefined,
    );
  }

  enableAfterCommit(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Browser debug session is disposed"));
    }
    if (this.isAttached()) {
      if (this.enabled) return Promise.resolve();
      if (this.enablePromise !== null) return this.enablePromise;
    }
    try {
      this.ensureAttached();
      this.startListening();
    } catch (err) {
      log.warn("[browser-view] debugger attach failed", {
        error: describeLogError(err),
      });
      return Promise.reject(err);
    }

    let enablePromise!: Promise<void>;
    const browserDebugger = this.webContents.debugger;
    enablePromise = this.raceWithDebugSessionEnd(
      Promise.all([
        sendDebuggerCommand(browserDebugger, "Page.enable", {}, undefined),
        sendDebuggerCommand(browserDebugger, "Runtime.enable", {}, undefined),
        sendDebuggerCommand(browserDebugger, "Log.enable", {}, undefined),
        sendDebuggerCommand(browserDebugger, "Network.enable", {}, undefined),
        // DOM.describeNode requires its domain to be enabled first.
        sendDebuggerCommand(browserDebugger, "DOM.enable", {}, undefined),
      ]).then(() => undefined),
      "Browser debugger detached while enabling",
    )
      .then(() => {
        if (
          this.disposed ||
          this.enablePromise !== enablePromise ||
          !browserDebugger.isAttached()
        ) {
          throw new Error("Browser debug session ended while enabling");
        }
        this.enabled = true;
      })
      .catch((err: unknown) => {
        if (this.enablePromise !== enablePromise) throw err;
        this.enablePromise = null;
        this.enabled = false;
        this.clearTargetRoutes();
        if (this.attachedBySession && browserDebugger.isAttached()) {
          try {
            browserDebugger.detach();
          } catch (detachErr) {
            log.warn("[browser-view] debugger detach after enable failed", {
              error: describeLogError(detachErr),
            });
          }
        }
        this.attachedBySession = false;
        this.stopListeningIfIdle();
        log.warn("[browser-view] debugger domain enable failed", {
          error: describeLogError(err),
        });
        throw err;
      });
    this.enablePromise = enablePromise;
    return enablePromise;
  }

  startPipCapture(input: BrowserPipCaptureStartInput): Promise<void> {
    if (this.disposed) throw new Error("Browser debug session is disposed");
    this.stopPipCapture();
    const capture: ActivePipCapture = {
      onFrame: input.onFrame,
      nextSequence: 0,
      timer: null,
    };
    this.pipCapture = capture;
    this.emitPipFrame(
      {
        kind: "started",
        hasBinaryPayload: false,
        frameWidth: input.maxWidth,
        frameHeight: input.maxHeight,
        deviceScaleFactor: 1,
      },
      null,
    );
    void this.capturePipFrame(capture, input.quality);
    return Promise.resolve();
  }

  stopPipCapture(): void {
    this.teardownPipCapture("stop");
  }

  isPipCapturing(): boolean {
    return this.pipCapture !== null;
  }

  snapshot(): BrowserViewDebugSnapshotData {
    return this.telemetry.snapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enablePromise = null;
    this.teardownPipCapture(this.pipCapture === null ? "stop" : "stalled");
    const browserDebugger = this.webContents.debugger;
    this.stopListening();
    this.sessionEnd.resolve();
    this.rejectPendingChildSessions("Browser debug session was disposed");
    this.clearTargetRoutes();
    if (this.attachedBySession || !browserDebugger.isAttached()) {
      this.attachmentEnd.resolve();
    }
    if (this.attachedBySession && browserDebugger.isAttached()) {
      try {
        browserDebugger.detach();
      } catch (err) {
        log.warn("[browser-view] debugger detach failed", {
          error: describeLogError(err),
        });
      }
    }
    this.bindingCalledListeners.clear();
  }

  private handleDebuggerMessage(args: readonly unknown[]): void {
    const event = readCdpEvent(args);
    if (event === null) return;
    if (event.method === "Target.detachedFromTarget") {
      this.handleTargetDetached(event.params);
      return;
    }
    if (event.method === "Page.frameAttached") {
      this.handleFrameAttached(event.params, event.sessionId);
    } else if (event.method === "Page.frameNavigated") {
      this.handleFrameNavigated(event.params, event.sessionId);
    } else if (event.method === "Page.frameDetached") {
      const frameId = stringValue(event.params.frameId);
      if (
        frameId !== null &&
        this.isAuthorizedFrameEvent(frameId, event.sessionId)
      ) {
        this.forgetFrameBranch(frameId);
      }
    }
    if (
      this.telemetry.handleEvent(event.method, event.params, event.sessionId)
    ) {
      return;
    }
    if (event.method === "Runtime.bindingCalled") {
      for (const listener of this.bindingCalledListeners) {
        listener(event.params);
      }
    }
  }

  private handleDebuggerDetach(args: readonly unknown[]): void {
    const reason = args
      .map((value) => (typeof value === "string" ? value : null))
      .find((value) => value !== null);
    this.stopListening();
    this.resetDetachedState();
    this.onDetached(reason ?? "Debugger detached");
  }

  private async capturePipFrame(
    capture: ActivePipCapture,
    quality: number,
  ): Promise<void> {
    try {
      const image = await this.webContents.capturePage();
      if (this.pipCapture !== capture) return;
      const size = image.getSize();
      const jpegBytes = image.toJPEG(quality);
      if (jpegBytes.byteLength > 0) {
        const sequence = capture.nextSequence;
        capture.nextSequence += 1;
        this.emitPipFrame(
          {
            kind: "frame",
            hasBinaryPayload: true,
            sequence,
            metadata: {
              offsetTop: 0,
              pageScaleFactor: 1,
              deviceWidth: size.width,
              deviceHeight: size.height,
              scrollOffsetX: 0,
              scrollOffsetY: 0,
              timestamp: Date.now() / 1_000,
            },
          },
          jpegBytes,
        );
      }
    } catch (err) {
      if (this.pipCapture === capture) {
        log.warn("[browser-view] pip frame capture failed", {
          error: describeLogError(err),
        });
      }
    }
    if (this.pipCapture !== capture) return;
    capture.timer = setTimeout(() => {
      capture.timer = null;
      void this.capturePipFrame(capture, quality);
    }, PIP_CAPTURE_INTERVAL_MS);
  }

  private teardownPipCapture(reason: "stop" | "stalled" | "failed"): void {
    const capture = this.pipCapture;
    if (capture === null) return;
    this.pipCapture = null;
    if (capture.timer !== null) clearTimeout(capture.timer);
    if (reason === "stalled") {
      capture.onFrame({
        frame: { kind: "stalled", hasBinaryPayload: false },
        jpegBytes: null,
      });
    }
  }

  private emitPipFrame(
    frame: BrowserScreencastServerFrame,
    jpegBytes: Uint8Array | null,
  ): void {
    const capture = this.pipCapture;
    if (capture === null) return;
    capture.onFrame({ frame, jpegBytes });
  }

  private resolveTarget(
    target: BrowserCdpTarget,
  ): Promise<ResolvedTargetRoute> {
    const attachmentGeneration = this.attachmentGeneration;
    if (target.kind === "root") {
      return Promise.resolve({
        attachmentGeneration,
        topologyRevision: this.topologyRevision,
        frameId: null,
        frameRoute: null,
        childTargetId: null,
        childSession: null,
        sessionId: null,
      });
    }
    return this.resolveFrameRoute(
      target.frameId,
      target.parentFrameId,
      attachmentGeneration,
    );
  }

  private recordFrameTreeRoute(
    resolvedRoute: ResolvedTargetRoute,
    frames: readonly BrowserCdpFrameInfo[],
  ): void {
    if (
      resolvedRoute.childTargetId !== null &&
      resolvedRoute.childSession !== null
    ) {
      const currentRoute = this.frameRouteById.get(resolvedRoute.childTargetId);
      if (
        currentRoute === undefined ||
        this.childSessionByTargetId.get(resolvedRoute.childTargetId) !==
          resolvedRoute.childSession
      ) {
        throw new Error("Child frame route changed while recording its tree.");
      }
      this.mergeFrameSubtree(
        resolvedRoute.childTargetId,
        this.buildFrameRoutes(
          frames,
          resolvedRoute.childTargetId,
          currentRoute,
        ),
      );
      return;
    }

    const rootFrames = frames.filter((frame) => frame.parentFrameId === null);
    const rootFrame = rootFrames[0];
    if (rootFrame === undefined || rootFrames.length !== 1) {
      throw new Error(
        "Malformed CDP response: Page.getFrameTree must contain one root frame.",
      );
    }
    this.replaceFrameRoutes(
      this.buildFrameRoutes(frames, rootFrame.frameId, {
        kind: "root",
        parentFrameId: null,
      }),
    );
  }

  private async resolveFrameRoute(
    frameId: string,
    parentFrameId: string,
    attachmentGeneration: number,
  ): Promise<ResolvedTargetRoute> {
    const route = this.requireCurrentFrameRoute(
      frameId,
      null,
      attachmentGeneration,
    );
    if (route.parentFrameId !== parentFrameId) {
      throw new Error(
        `Cannot resolve frame ${frameId}: expected parent ${route.parentFrameId ?? "<root>"}, received ${parentFrameId}.`,
      );
    }
    const resolved = await this.resolveRecordedFrameRoute(
      frameId,
      route,
      attachmentGeneration,
    );
    const currentRoute = this.requireCurrentFrameRoute(
      frameId,
      resolved.frameRoute,
      attachmentGeneration,
    );
    if (currentRoute.parentFrameId !== parentFrameId) {
      throw new Error(
        `Cannot resolve frame ${frameId}: expected parent ${currentRoute.parentFrameId ?? "<root>"}, received ${parentFrameId}.`,
      );
    }
    return resolved;
  }

  private async resolveRecordedFrameRoute(
    frameId: string,
    expectedRoute: FrameRoute,
    attachmentGeneration: number,
  ): Promise<ResolvedTargetRoute> {
    let route = this.requireCurrentFrameRoute(
      frameId,
      expectedRoute,
      attachmentGeneration,
    );
    const childSession = this.childSessionByTargetId.get(frameId);
    if (childSession !== undefined) {
      return this.waitForChildSession(
        frameId,
        route,
        attachmentGeneration,
        childSession,
      );
    }
    if (route.kind === "root") {
      return {
        attachmentGeneration,
        topologyRevision: this.topologyRevision,
        frameId,
        frameRoute: route,
        childTargetId: null,
        childSession: null,
        sessionId: null,
      };
    }
    if (route.kind === "same-process") {
      const parentRoute = this.requireCurrentFrameRoute(
        route.parentFrameId,
        null,
        attachmentGeneration,
      );
      const parent = await this.resolveRecordedFrameRoute(
        route.parentFrameId,
        parentRoute,
        attachmentGeneration,
      );
      this.requireCurrentFrameRoute(frameId, route, attachmentGeneration);
      return { ...parent, frameId, frameRoute: route };
    }

    const iframeTargetIds = await this.discoverIframeTargetIds();
    route = this.requireCurrentFrameRoute(frameId, route, attachmentGeneration);
    const discoveredChildSession = this.childSessionByTargetId.get(frameId);
    if (discoveredChildSession !== undefined) {
      return this.waitForChildSession(
        frameId,
        route,
        attachmentGeneration,
        discoveredChildSession,
      );
    }
    if (route.kind === "root") {
      return {
        attachmentGeneration,
        topologyRevision: this.topologyRevision,
        frameId,
        frameRoute: route,
        childTargetId: null,
        childSession: null,
        sessionId: null,
      };
    }
    if (route.kind === "same-process") {
      return this.resolveRecordedFrameRoute(
        frameId,
        route,
        attachmentGeneration,
      );
    }
    if (iframeTargetIds.has(frameId)) {
      return this.ensureChildSession(frameId, route, attachmentGeneration);
    }

    const sameProcessRoute: FrameRoute = {
      kind: "same-process",
      parentFrameId: route.parentFrameId,
    };
    this.frameRouteById.set(frameId, sameProcessRoute);
    this.topologyRevision += 1;
    return this.resolveRecordedFrameRoute(
      frameId,
      sameProcessRoute,
      attachmentGeneration,
    );
  }

  private async waitForChildSession(
    frameId: string,
    route: FrameRoute,
    attachmentGeneration: number,
    childSession: ChildSession,
  ): Promise<ResolvedTargetRoute> {
    if (childSession.state === "retiring") {
      const retirement = childSession.retirement;
      if (retirement === null) {
        throw new Error(`Child debugger session ${frameId} has no retirement.`);
      }
      if (!(await retirement)) {
        throw new Error(`Child debugger session ${frameId} could not retire.`);
      }
      const currentRoute = this.requireCurrentFrameRoute(
        frameId,
        route,
        attachmentGeneration,
      );
      return this.resolveRecordedFrameRoute(
        frameId,
        currentRoute,
        attachmentGeneration,
      );
    }
    if (childSession.parentFrameId !== route.parentFrameId) {
      throw new Error(
        `Cannot resolve frame ${frameId}: expected parent ${childSession.parentFrameId}, received ${route.parentFrameId ?? "<root>"}.`,
      );
    }
    const sessionId = await childSession.readiness;
    this.requireCurrentFrameRoute(frameId, route, attachmentGeneration);
    if (
      this.childSessionByTargetId.get(frameId) !== childSession ||
      childSession.state !== "ready" ||
      childSession.sessionId !== sessionId
    ) {
      throw new Error(
        `Child debugger session ${frameId} changed while enabling.`,
      );
    }
    return {
      attachmentGeneration,
      topologyRevision: this.topologyRevision,
      frameId,
      frameRoute: route,
      childTargetId: frameId,
      childSession,
      sessionId,
    };
  }

  private requireCurrentFrameRoute(
    frameId: string,
    expectedRoute: FrameRoute | null,
    attachmentGeneration: number,
  ): FrameRoute {
    if (
      this.disposed ||
      !this.isReady() ||
      this.attachmentGeneration !== attachmentGeneration
    ) {
      throw new Error(`Frame routes changed while resolving frame ${frameId}.`);
    }
    const route = this.frameRouteById.get(frameId);
    if (route === undefined) {
      throw new Error(
        `Cannot resolve frame ${frameId}: frame is not present in the recorded tree.`,
      );
    }
    if (expectedRoute !== null && route !== expectedRoute) {
      throw new Error(`Frame routes changed while resolving frame ${frameId}.`);
    }
    return route;
  }

  private requireCurrentTargetRoute(
    route: ResolvedTargetRoute,
    requireTopologyRevision: boolean,
  ): void {
    if (
      !this.isReady() ||
      this.attachmentGeneration !== route.attachmentGeneration ||
      (requireTopologyRevision &&
        this.topologyRevision !== route.topologyRevision) ||
      (route.frameId !== null &&
        this.frameRouteById.get(route.frameId) !== route.frameRoute) ||
      (route.childTargetId !== null &&
        (this.childSessionByTargetId.get(route.childTargetId) !==
          route.childSession ||
          route.childSession?.state !== "ready" ||
          route.childSession.sessionId !== route.sessionId))
    ) {
      throw new Error("Browser target route changed before command dispatch.");
    }
  }

  private ensureChildSession(
    targetId: string,
    route: ChildFrameRoute,
    attachmentGeneration: number,
  ): Promise<ResolvedTargetRoute> {
    const existing = this.childSessionByTargetId.get(targetId);
    if (existing !== undefined) {
      return this.waitForChildSession(
        targetId,
        route,
        attachmentGeneration,
        existing,
      );
    }

    const deferred = Promise.withResolvers<string>();
    const childSession: ChildSession = {
      attachmentGeneration,
      parentFrameId: route.parentFrameId,
      route,
      state: "attaching",
      sessionId: null,
      readiness: deferred.promise,
      rejectReadiness: deferred.reject,
      retirement: null,
    };
    this.childSessionByTargetId.set(targetId, childSession);
    void this.attachChildSession(targetId, childSession).then(
      deferred.resolve,
      deferred.reject,
    );
    return this.waitForChildSession(
      targetId,
      route,
      attachmentGeneration,
      childSession,
    );
  }

  private discoverIframeTargetIds(): Promise<ReadonlySet<string>> {
    const revision = this.topologyRevision;
    if (this.targetDiscovery?.revision === revision) {
      return this.targetDiscovery.promise;
    }
    const promise = this.sendCommand("Target.getTargets", {}, undefined).then(
      (value) => {
        const response = requireRecord(value, "Target.getTargets");
        const targetIds = new Set<string>();
        for (const value of requireArray(
          response.targetInfos,
          "Target.getTargets.targetInfos",
        )) {
          const target = recordValue(value);
          const targetId = stringValue(target?.targetId);
          if (targetId !== null && stringValue(target?.type) === "iframe") {
            targetIds.add(targetId);
          }
        }
        return targetIds;
      },
    );
    this.targetDiscovery = { revision, promise };
    void promise.catch(() => {
      if (this.targetDiscovery?.promise === promise) {
        this.targetDiscovery = null;
      }
    });
    return promise;
  }

  private async attachChildSession(
    targetId: string,
    childSession: ChildSession,
  ): Promise<string> {
    let detachedBeforeAttachResponse = false;
    try {
      const attached = requireRecord(
        await this.sendCommand(
          "Target.attachToTarget",
          { targetId, flatten: true },
          undefined,
        ),
        "Target.attachToTarget",
      );
      const sessionId = requireString(
        attached.sessionId,
        "Target.attachToTarget.sessionId",
      );
      detachedBeforeAttachResponse =
        this.detachedChildSessionIds.delete(sessionId);
      childSession.sessionId = sessionId;
      if (
        detachedBeforeAttachResponse ||
        childSession.attachmentGeneration !== this.attachmentGeneration ||
        this.disposed ||
        !this.isAttached() ||
        childSession.state !== "attaching" ||
        this.childSessionByTargetId.get(targetId) !== childSession ||
        this.frameRouteById.get(targetId) !== childSession.route ||
        !this.frameRouteById.has(childSession.parentFrameId)
      ) {
        throw new Error("Child debugger session ended while enabling");
      }
      await this.raceWithDebugSessionEnd(
        Promise.all([
          sendDebuggerCommand(
            this.webContents.debugger,
            "Page.enable",
            {},
            sessionId,
          ),
          sendDebuggerCommand(
            this.webContents.debugger,
            "Runtime.enable",
            {},
            sessionId,
          ),
          sendDebuggerCommand(
            this.webContents.debugger,
            "Log.enable",
            {},
            sessionId,
          ),
          sendDebuggerCommand(
            this.webContents.debugger,
            "Network.enable",
            {},
            sessionId,
          ),
          sendDebuggerCommand(
            this.webContents.debugger,
            "DOM.enable",
            {},
            sessionId,
          ),
        ]).then(() => undefined),
        "Child debugger session ended while enabling",
      );
      if (
        this.disposed ||
        childSession.attachmentGeneration !== this.attachmentGeneration ||
        !this.isAttached() ||
        childSession.state !== "attaching" ||
        this.childSessionByTargetId.get(targetId) !== childSession ||
        this.frameRouteById.get(targetId) !== childSession.route ||
        !this.frameRouteById.has(childSession.parentFrameId)
      ) {
        throw new Error("Child debugger session ended while enabling");
      }
      childSession.state = "ready";
      return sessionId;
    } catch (err) {
      log.warn("[browser-view] child debugger domain enable failed", {
        error: describeLogError(err),
        sessionId: childSession.sessionId,
        targetId,
      });
      const retired =
        detachedBeforeAttachResponse ||
        childSession.sessionId === null ||
        childSession.attachmentGeneration !== this.attachmentGeneration
          ? true
          : await this.retireChildSession(childSession.sessionId);
      if (
        !retired &&
        this.childSessionByTargetId.get(targetId) === childSession
      ) {
        childSession.state = "retiring";
        childSession.retirement = Promise.resolve(false);
      }
      if (
        retired &&
        this.childSessionByTargetId.get(targetId) === childSession
      ) {
        this.childSessionByTargetId.delete(targetId);
      }
      throw err;
    }
  }

  private async retireChildSession(sessionId: string): Promise<boolean> {
    if (!this.webContents.debugger.isAttached()) return true;
    const attachmentGeneration = this.attachmentGeneration;
    try {
      await Promise.race([
        sendDebuggerCommand(
          this.webContents.debugger,
          "Target.detachFromTarget",
          { sessionId },
          undefined,
        ),
        this.attachmentEnd.promise,
      ]);
      return true;
    } catch (error) {
      if (
        !this.webContents.debugger.isAttached() ||
        this.attachmentGeneration !== attachmentGeneration
      ) {
        return true;
      }
      log.warn("[browser-view] failed to retire unusable child target", {
        error: describeLogError(error),
        sessionId,
      });
      return false;
    }
  }

  private handleTargetDetached(params: Record<string, unknown>): void {
    const sessionId = stringValue(params.sessionId);
    if (sessionId !== null) {
      this.detachedChildSessionIds.add(sessionId);
      this.topologyRevision += 1;
      this.forgetChildSession(sessionId, stringValue(params.targetId));
    }
  }

  private handleFrameAttached(
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const frameId = stringValue(params.frameId);
    const parentFrameId = stringValue(params.parentFrameId);
    if (
      frameId === null ||
      parentFrameId === null ||
      frameId === parentFrameId ||
      !this.frameRouteById.has(parentFrameId) ||
      !this.isAuthorizedFrameEvent(parentFrameId, sessionId)
    ) {
      return;
    }
    const currentRoute = this.frameRouteById.get(frameId);
    if (currentRoute?.parentFrameId === parentFrameId) return;
    if (currentRoute !== undefined) this.forgetFrameBranch(frameId);
    this.frameRouteById.set(frameId, {
      kind: "unresolved",
      parentFrameId,
    });
    this.topologyRevision += 1;
  }

  private handleFrameNavigated(
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const frame = recordValue(params.frame);
    const frameId = stringValue(frame?.id);
    if (frameId === null) return;
    const parentFrameId = stringValue(frame?.parentId);
    if (sessionId === undefined && parentFrameId === null) {
      this.clearTargetRoutes();
      this.frameRouteById.set(frameId, {
        kind: "root",
        parentFrameId: null,
      });
      return;
    }
    const currentRoute = this.frameRouteById.get(frameId);
    if (currentRoute === undefined) {
      if (
        parentFrameId !== null &&
        this.frameRouteById.has(parentFrameId) &&
        this.isAuthorizedFrameEvent(parentFrameId, sessionId)
      ) {
        this.frameRouteById.set(frameId, {
          kind: "unresolved",
          parentFrameId,
        });
        this.topologyRevision += 1;
      }
      return;
    }
    if (
      currentRoute.kind === "root" ||
      !this.isAuthorizedFrameEvent(frameId, sessionId)
    ) {
      return;
    }
    const recordedParentFrameId = parentFrameId ?? currentRoute.parentFrameId;
    if (
      this.collectFrameBranch(frameId).has(recordedParentFrameId) ||
      !this.frameRouteById.has(recordedParentFrameId)
    ) {
      this.forgetFrameBranch(frameId);
      return;
    }
    this.refreshFrameBranch(frameId, recordedParentFrameId, sessionId);
  }

  private isAuthorizedFrameEvent(
    frameId: string,
    sessionId: string | undefined,
  ): boolean {
    if (sessionId === undefined) return true;
    for (const [targetId, childSession] of this.childSessionByTargetId) {
      if (
        childSession.state !== "retiring" &&
        childSession.sessionId === sessionId &&
        this.collectFrameBranch(targetId).has(frameId)
      ) {
        return true;
      }
    }
    return false;
  }

  private forgetFrameBranch(rootFrameId: string): void {
    const removedFrameIds = this.collectFrameBranch(rootFrameId);
    if (
      !this.frameRouteById.has(rootFrameId) &&
      !this.childSessionByTargetId.has(rootFrameId)
    ) {
      return;
    }
    this.topologyRevision += 1;
    for (const frameId of removedFrameIds) {
      this.frameRouteById.delete(frameId);
      const childSession = this.childSessionByTargetId.get(frameId);
      if (childSession !== undefined) {
        this.retireChildSessionRecord(frameId, childSession);
      }
    }
  }

  private forgetChildSession(
    sessionId: string,
    detachedTargetId: string | null,
  ): void {
    // ponytail: OOPIFs are page-bounded; add a reverse index only if profiling
    // shows this detach-time scan matters.
    for (const [targetId, childSession] of this.childSessionByTargetId) {
      const matchesKnownSession = childSession.sessionId === sessionId;
      const matchesPendingTarget =
        childSession.state === "attaching" &&
        childSession.sessionId === null &&
        targetId === detachedTargetId;
      if (!matchesKnownSession && !matchesPendingTarget) {
        continue;
      }
      this.childSessionByTargetId.delete(targetId);
      if (matchesKnownSession) {
        this.detachedChildSessionIds.delete(sessionId);
      }
      const route = this.frameRouteById.get(targetId);
      if (route !== undefined && route.kind !== "root") {
        this.frameRouteById.set(targetId, {
          kind: "unresolved",
          parentFrameId: route.parentFrameId,
        });
      }
      return;
    }
  }

  private clearTargetRoutes(): void {
    this.topologyRevision += 1;
    this.frameRouteById.clear();
    for (const [targetId, childSession] of this.childSessionByTargetId) {
      this.retireChildSessionRecord(targetId, childSession);
    }
  }

  private buildFrameRoutes(
    frames: readonly BrowserCdpFrameInfo[],
    rootFrameId: string,
    rootRoute: FrameRoute,
  ): ReadonlyMap<string, FrameRoute> {
    const routes = new Map<string, FrameRoute>();
    for (const frame of frames) {
      if (routes.has(frame.frameId)) {
        throw new Error(
          `Malformed CDP response: duplicate frame ${frame.frameId}.`,
        );
      }
      routes.set(
        frame.frameId,
        frame.frameId === rootFrameId
          ? rootRoute
          : {
              kind: "unresolved",
              parentFrameId: requireString(
                frame.parentFrameId,
                `Page.getFrameTree parent for ${frame.frameId}`,
              ),
            },
      );
    }
    if (!routes.has(rootFrameId)) {
      throw new Error(
        `Malformed CDP response: Page.getFrameTree omitted target frame ${rootFrameId}.`,
      );
    }
    // ponytail: Frame trees are small; a per-frame parent walk is clearer than
    // maintaining another graph index. Replace only if profiling proves otherwise.
    for (const frameId of routes.keys()) {
      const visited = new Set<string>();
      let currentFrameId = frameId;
      while (currentFrameId !== rootFrameId) {
        if (visited.has(currentFrameId)) {
          throw new Error(
            `Malformed CDP response: cyclic frame ancestry at ${currentFrameId}.`,
          );
        }
        visited.add(currentFrameId);
        const route = routes.get(currentFrameId);
        if (route === undefined || route.parentFrameId === null) {
          throw new Error(
            `Malformed CDP response: frame ${currentFrameId} is outside target subtree ${rootFrameId}.`,
          );
        }
        if (!routes.has(route.parentFrameId)) {
          throw new Error(
            `Malformed CDP response: frame ${currentFrameId} has unknown parent ${route.parentFrameId}.`,
          );
        }
        currentFrameId = route.parentFrameId;
      }
    }
    return routes;
  }

  private replaceFrameRoutes(
    nextRoutes: ReadonlyMap<string, FrameRoute>,
  ): void {
    const retainedRoutes = this.retainFrameRoutes(nextRoutes);
    if (!sameRouteMap(this.frameRouteById, retainedRoutes)) {
      this.topologyRevision += 1;
      this.frameRouteById.clear();
      for (const [frameId, route] of retainedRoutes) {
        this.frameRouteById.set(frameId, route);
      }
    }
    for (const [targetId, childSession] of this.childSessionByTargetId) {
      const route = retainedRoutes.get(targetId);
      if (
        childSession.state !== "retiring" &&
        route?.parentFrameId === childSession.parentFrameId
      ) {
        childSession.route = route;
        continue;
      }
      this.retireChildSessionRecord(targetId, childSession);
    }
  }

  private mergeFrameSubtree(
    rootFrameId: string,
    nextRoutes: ReadonlyMap<string, FrameRoute>,
  ): void {
    const previousFrameIds = this.collectFrameBranch(rootFrameId);
    const retainedRoutes = this.retainFrameRoutes(nextRoutes);
    if (
      !sameRouteBranch(previousFrameIds, this.frameRouteById, retainedRoutes)
    ) {
      this.topologyRevision += 1;
      for (const frameId of previousFrameIds) {
        this.frameRouteById.delete(frameId);
      }
      for (const [frameId, route] of retainedRoutes) {
        this.frameRouteById.set(frameId, route);
      }
    }
    for (const [targetId, childSession] of this.childSessionByTargetId) {
      if (!previousFrameIds.has(targetId) && !retainedRoutes.has(targetId)) {
        continue;
      }
      const route = retainedRoutes.get(targetId);
      if (
        childSession.state !== "retiring" &&
        route?.parentFrameId === childSession.parentFrameId
      ) {
        childSession.route = route;
        continue;
      }
      this.retireChildSessionRecord(targetId, childSession);
    }
  }

  private refreshFrameBranch(
    frameId: string,
    parentFrameId: string,
    eventSessionId: string | undefined,
  ): void {
    const descendantFrameIds = this.collectFrameBranch(frameId);
    descendantFrameIds.delete(frameId);
    this.topologyRevision += 1;
    for (const descendantFrameId of descendantFrameIds) {
      this.frameRouteById.delete(descendantFrameId);
      const childSession = this.childSessionByTargetId.get(descendantFrameId);
      if (childSession !== undefined) {
        this.retireChildSessionRecord(descendantFrameId, childSession);
      }
    }
    const nextRoute: FrameRoute = {
      kind: "unresolved",
      parentFrameId,
    };
    this.frameRouteById.set(frameId, nextRoute);
    const childSession = this.childSessionByTargetId.get(frameId);
    if (childSession === undefined || childSession.state === "retiring") {
      return;
    }
    if (
      childSession.parentFrameId === parentFrameId &&
      (eventSessionId === undefined ||
        childSession.sessionId === eventSessionId)
    ) {
      childSession.route = nextRoute;
      return;
    }
    this.retireChildSessionRecord(frameId, childSession);
  }

  private collectFrameBranch(rootFrameId: string): Set<string> {
    const frameIds = new Set([rootFrameId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [frameId, route] of this.frameRouteById) {
        if (
          route.parentFrameId !== null &&
          frameIds.has(route.parentFrameId) &&
          !frameIds.has(frameId)
        ) {
          frameIds.add(frameId);
          changed = true;
        }
      }
    }
    return frameIds;
  }

  private retainFrameRoutes(
    nextRoutes: ReadonlyMap<string, FrameRoute>,
  ): Map<string, FrameRoute> {
    const retainedRoutes = new Map(nextRoutes);
    for (const [frameId, nextRoute] of nextRoutes) {
      const currentRoute = this.frameRouteById.get(frameId);
      if (
        currentRoute !== undefined &&
        currentRoute.parentFrameId === nextRoute.parentFrameId &&
        (currentRoute.kind === nextRoute.kind ||
          (currentRoute.kind === "same-process" &&
            nextRoute.kind === "unresolved"))
      ) {
        retainedRoutes.set(frameId, currentRoute);
      }
    }
    return retainedRoutes;
  }

  private retireChildSessionRecord(
    targetId: string,
    childSession: ChildSession,
  ): void {
    if (
      this.childSessionByTargetId.get(targetId) !== childSession ||
      childSession.state === "retiring"
    ) {
      return;
    }
    const wasReady = childSession.state === "ready";
    childSession.state = "retiring";
    const retirement =
      wasReady && childSession.sessionId !== null
        ? this.retireChildSession(childSession.sessionId)
        : childSession.readiness.then(
            () => this.childSessionByTargetId.get(targetId) !== childSession,
            () => this.childSessionByTargetId.get(targetId) !== childSession,
          );
    childSession.retirement = retirement.then((retired) => {
      if (
        retired &&
        this.childSessionByTargetId.get(targetId) === childSession
      ) {
        this.childSessionByTargetId.delete(targetId);
      }
      return retired;
    });
  }

  private ensureAttached(): BrowserViewDebugger {
    if (this.disposed) throw new Error("Browser debug session is disposed");
    const browserDebugger = this.webContents.debugger;
    if (!browserDebugger.isAttached()) {
      this.resetDetachedState();
      browserDebugger.attach("1.3");
      this.attachedBySession = true;
    }
    return browserDebugger;
  }

  private resetDetachedState(): void {
    this.rejectPendingChildSessions("Browser debugger detached while enabling");
    this.attachmentEnd.resolve();
    this.attachmentEnd = Promise.withResolvers<void>();
    this.enabled = false;
    this.enablePromise = null;
    this.attachedBySession = false;
    this.attachmentGeneration += 1;
    this.topologyRevision += 1;
    this.targetDiscovery = null;
    this.detachedChildSessionIds.clear();
    this.frameRouteById.clear();
    this.childSessionByTargetId.clear();
  }

  private rejectPendingChildSessions(message: string): void {
    const error = new Error(message);
    for (const childSession of this.childSessionByTargetId.values()) {
      childSession.rejectReadiness(error);
    }
  }

  private raceWithDebugSessionEnd<T>(
    work: Promise<T>,
    message: string,
  ): Promise<T> {
    return Promise.race([
      this.raceWithAttachmentEnd(work, message),
      this.sessionEnd.promise.then(() => {
        throw new Error(message);
      }),
    ]);
  }

  private raceWithAttachmentEnd<T>(
    work: Promise<T>,
    message: string,
  ): Promise<T> {
    return Promise.race([
      work,
      this.attachmentEnd.promise.then(() => {
        throw new Error(message);
      }),
    ]);
  }

  private startListening(): void {
    if (this.listening) return;
    const browserDebugger = this.webContents.debugger;
    browserDebugger.on("message", this.messageListener);
    browserDebugger.on("detach", this.detachListener);
    this.listening = true;
  }

  private stopListeningIfIdle(): void {
    if (
      this.enabled ||
      this.enablePromise !== null ||
      this.bindingCalledListeners.size > 0
    ) {
      return;
    }
    this.stopListening();
  }

  private stopListening(): void {
    if (!this.listening) return;
    const browserDebugger = this.webContents.debugger;
    browserDebugger.off("message", this.messageListener);
    browserDebugger.off("detach", this.detachListener);
    this.listening = false;
  }
}

function sameRouteMap(
  current: ReadonlyMap<string, FrameRoute>,
  next: ReadonlyMap<string, FrameRoute>,
): boolean {
  if (current.size !== next.size) return false;
  for (const [frameId, route] of next) {
    if (current.get(frameId) !== route) return false;
  }
  return true;
}

function sameRouteBranch(
  currentFrameIds: ReadonlySet<string>,
  current: ReadonlyMap<string, FrameRoute>,
  next: ReadonlyMap<string, FrameRoute>,
): boolean {
  if (currentFrameIds.size !== next.size) return false;
  for (const [frameId, route] of next) {
    if (!currentFrameIds.has(frameId) || current.get(frameId) !== route) {
      return false;
    }
  }
  return true;
}

type BrowserDebugWebContents = Pick<
  BrowserViewWebContents,
  "id" | "debugger" | "capturePage"
>;

interface ActivePipCapture {
  readonly onFrame: (payload: PipCaptureIpcPayload) => void;
  nextSequence: number;
  timer: NodeJS.Timeout | null;
}

async function sendDebuggerCommand(
  browserDebugger: BrowserViewDebugger,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<unknown> {
  return browserDebugger.sendCommand(method, params, sessionId);
}

function cdpFailure(
  command: BrowserCdpCommand,
  kind: BrowserCdpError["kind"],
  message: string,
  code: number | null,
): BrowserCdpResult {
  return { kind: command.kind, ok: false, error: { kind, message, code } };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidCdpResponse(field);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw invalidCdpResponse(field);
  return value;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalidCdpResponse(field);
  return value;
}

function invalidCdpResponse(field: string): Error {
  return new Error(`Malformed CDP response: ${field}`);
}

function readCdpEvent(args: readonly unknown[]): CdpEvent | null {
  const method = args[1];
  if (typeof method !== "string") return null;
  const params = recordValue(args[2]) ?? {};
  const sessionId = typeof args[3] === "string" ? args[3] : undefined;
  return { method, params, sessionId };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
